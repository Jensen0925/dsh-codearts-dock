/** Account health and preferences against isolated local storage. */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, stat, rm, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const scratch = await mkdtemp(join(tmpdir(), 'dca-features-'))
process.env.APPDATA = scratch
process.env.DSH_CONNECT_CODEARTS_LEGACY_CREDENTIAL = join(scratch, 'no-legacy.json')
delete process.env.CODEARTS_AK
delete process.env.CODEARTS_SK
delete process.env.CODEARTS_SECURITY_TOKEN
const { FEATURE_DEFAULTS, validatePreferences, persistPreferences, readPreferences, portablePreferences } = await import('../src/preferences.ts')
const { accountHealth } = await import('../src/health.ts')
const { readCredit } = await import('../src/account.ts')
const accountModule = await import('../src/accounts.ts')
type TestAccount = { id: string; ak: string; sk: string; label?: string; accountName?: string }
const accounts = {
  ...accountModule,
  addAccount: accountModule.addAccount as unknown as (input: { ak: string; sk: string; label?: string }) => Promise<{ account: TestAccount; added: boolean }>,
}
const check = (name: string, fn: () => void | Promise<void>) => test(name, fn)
const settings = { ...FEATURE_DEFAULTS, enabledModelIds: null, modelOverrides: {}, composerChip: true, dailyCheckinEnabled: false, refreshIntervalMs: 300000 }
const secretAccount = { ak: 'TEST_BACKUP_AK_123456789', sk: 'TEST_BACKUP_SK_987654321', label: 'Example' }

await check('preferences validate retained settings and ignore retired fields', async () => {
  for (const invalid of [-1, 0, '60000', 86400001]) assert.throws(() => validatePreferences({ refreshIntervalMs: invalid }))
  assert.throws(() => validatePreferences({ composerChip: 'true' }))
  assert.ok(!('accountPoolEnabled' in FEATURE_DEFAULTS))
  assert.ok(!('accountPoolMemberIds' in FEATURE_DEFAULTS))
  assert.deepEqual(validatePreferences({ accountPoolEnabled: true, accountPoolMemberIds: ['legacy-account'] }), {})
  assert.throws(() => validatePreferences({ dailyCheckinEnabled: 'true' }))
  assert.deepEqual(validatePreferences({ dailyCheckinEnabled: true }), { dailyCheckinEnabled: true })
  assert.deepEqual(validatePreferences({ favoriteModelIds: ['legacy-pin'] }), {})
  assert.throws(() => validatePreferences({ enabledModelIds: [], modelOverrides: {} }))
  assert.throws(() => validatePreferences(JSON.parse('{"modelOverrides":{"__proto__":{"images":true}}}')))
  assert.deepEqual(validatePreferences({ modelPresets: Array(21).fill({}) }), {})
  assert.ok(!('modelPresets' in FEATURE_DEFAULTS))
  assert.deepEqual(validatePreferences({ lowBalanceEnabled: true, lowBalanceThreshold: 500, usageEnabled: true, autoCheckin: true, composerChip: true }), { composerChip: true })
  const portable = portablePreferences({ ...settings, lowBalanceEnabled: true, usageEnabled: true, autoCheckin: true, dailyCheckinEnabled: true, modelPresets: [{ id: 'legacy-preset', name: 'Legacy' }] })
  assert.ok(!('lowBalanceEnabled' in portable))
  assert.ok(!('usageEnabled' in portable))
  assert.ok(!('autoCheckin' in portable))
  assert.ok(!('modelPresets' in portable))
  assert.equal((portable as Record<string, unknown>).dailyCheckinEnabled, true)
  const retiredPool = portablePreferences({ accountPoolEnabled: true, accountPoolMemberIds: ['legacy-account'] })
  assert.ok(!('accountPoolEnabled' in retiredPool))
  assert.ok(!('accountPoolMemberIds' in retiredPool))
})
await check('concurrent preference writes are atomic, private, and do not lose other keys', async () => {
  await Promise.all([persistPreferences({ refreshIntervalMs: 120000 }), persistPreferences({ composerChip: false }), persistPreferences({ dailyCheckinEnabled: false })])
  assert.equal(readPreferences().refreshIntervalMs, 120000)
  assert.equal(readPreferences().composerChip, false)
  await persistPreferences({ favoriteModelIds: ['legacy-pin'], modelPresets: [{ id: 'legacy-preset', name: 'Legacy' }], accountPoolEnabled: true, accountPoolMemberIds: [] })
  assert.ok(!('favoriteModelIds' in readPreferences()), 'saving drops the retired pin field from an old config')
  assert.ok(!('modelPresets' in readPreferences()), 'saving drops the retired preset field from an old config')
  assert.ok(!('accountPoolEnabled' in readPreferences()), 'saving drops the retired automatic selection field')
  assert.ok(!('accountPoolMemberIds' in readPreferences()), 'saving drops the retired membership field')
  const mode = (await stat(join(scratch, 'dsh-codearts-dock', 'preferences.json'))).mode & 0o777
  assert.equal(mode, 0o600)
})
await check('account health separates credentials, throttling, quota, network, and upstream failures', async () => {
  assert.equal(accountHealth({ credit: { remain: 10 } }).state, 'available')
  assert.equal(accountHealth({ credit: { remain: 0 } }).state, 'insufficient')
  assert.equal(accountHealth().state, 'unknown')
  for (const [error, state] of [[{ status: 401 }, 'credentials'], [{ status: 403 }, 'credentials'], [{ status: 429 }, 'rate_limited'], [{ status: 402 }, 'insufficient'], [{ code: 'ECONNRESET' }, 'network'], [{ status: 503 }, 'gateway'], [{ name: 'StsError', message: '无法连接华为云 IAM' }, 'network']]) {
    assert.equal(accountHealth({ error }).state, state)
  }
  const failing = { getJson: async () => { throw new Error('network test') } }
  assert.equal(await readCredit(failing), null)
  await assert.rejects(readCredit(failing, { strict: true }), /network test/)
})
await check('concurrent account imports and name discovery cannot overwrite other accounts', async () => {
  const [one] = await Promise.all([accounts.addAccount(secretAccount), accounts.addAccount({ ak: 'SECOND_TEST_AK', sk: 'SECOND_TEST_SK' })])
  await Promise.all([accounts.rememberAccountName(one.account.id, 'Example name'), accounts.addAccount({ ak: 'THIRD_TEST_AK', sk: 'THIRD_TEST_SK' })])
  assert.equal(accounts.readStore().accounts.length, 3)
  assert.equal(accounts.readStore().accounts.find((entry) => entry.id === one.account.id).accountName, 'Example name')
})

const originalFetch = globalThis.fetch
const disposers: Array<() => unknown> = []
let creditStatus = 200
let creditReads = 0
let creditGate: Promise<void> | null = null
let creditRemain = 50
let iamReads = 0
let benefitReads = 0
let rejectedAk = ''
let catalogModels: Array<{ model_id: string; model_name: string }> = []
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status })
globalThis.fetch = async (input, init) => {
  const url = String(input)
  if (url.includes('iam.cn-north-4.myhuaweicloud.com')) {
    iamReads += 1
    if (rejectedAk && new Headers(init?.headers).get('authorization')?.includes(`Access=${rejectedAk},`)) return jsonResponse({ error: 'PRIVATE_IAM_ERROR_TOKEN' }, 401)
    return jsonResponse({ credential: { access: 'TEMP_TEST_AK', secret: 'TEMP_TEST_SK', securitytoken: 'TEMP_TEST_TOKEN', expires_at: new Date(Date.now() + 3600000).toISOString() } })
  }
  if (url.includes('/statistics/plugin')) {
    creditReads += 1
    const remain = creditRemain
    await creditGate
    if (creditStatus !== 200) return jsonResponse({ message: 'mock failure' }, creditStatus)
    return jsonResponse({ metrics: [{ name: 'usageTotalPackageCredit', package_credit_amount: 1000, package_credit_used: 950, package_credit_remain: remain }] })
  }
  if (url.includes('/v1/model/builtin')) return jsonResponse({ builtinModels: catalogModels })
  if (url.includes('/v1/model/thinking-variants')) return jsonResponse([])
  if (url.includes('/v1/ops/delivery')) { benefitReads += 1; return jsonResponse([]) }
  if (url.includes('/member/roles')) return jsonResponse([])
  throw new Error('Offline test blocked an unexpected gateway request')
}
type JsonBody = Record<string, any>
type RouteResponse = { status: number | undefined; body: JsonBody }
type TestRequest = AsyncIterable<Buffer> & {
  method: string
  url: string
  socket: { remoteAddress: string }
  headers: Record<string, string>
}
type TestResponse = {
  setHeader(name: string, value: string): void
  writeHead(status: number): void
  end(text: string): void
}
type TestRoute = { path: string; handler(request: TestRequest, response: TestResponse): void }
type InjectedContext = {
  effect(fn: () => unknown): () => void
  webServer: { register(route: TestRoute): () => void }
}
const routes = new Map<string, TestRoute['handler']>()
const plugin = await import('../src/index.ts')
const effect = (fn: () => unknown): (() => void) => {
  const dispose = fn()
  if (typeof dispose === 'function') {
    const cleanup = dispose as () => void
    disposers.push(cleanup)
    return cleanup
  }
  return () => {}
}
plugin.apply({ effect, get: () => undefined, emit() {}, inject: (_deps: unknown, callback: (ctx: InjectedContext) => void) => callback({ effect, webServer: { register: (route: TestRoute) => { routes.set(route.path, route.handler); return () => {} } } }) }, { registerProvider: false, autoCheckin: true, accountPoolEnabled: true, accountPoolMemberIds: [] })
await check('retired routes stay absent and legacy autoCheckin does not opt in', () => {
  for (const path of ['/usage', '/usage/clear', '/checkin/auto', '/backup/export', '/backup/preview', '/backup/restore', '/presets']) assert.ok(!routes.has(`/plugins/dsh-codearts-dock${path}`), `Retired route registered: ${path}`)
})
type RequestOptions = { raw?: string; remoteAddress?: string; headers?: Record<string, string> }
const request = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', options: RequestOptions = {}): Promise<RouteResponse> => new Promise((resolve, reject) => {
  const handler = routes.get(`/plugins/dsh-codearts-dock${path}`)
  if (!handler) return reject(new Error(`Unknown route ${path}`))
  const req = Object.assign(Readable.from(options.raw !== undefined ? [Buffer.from(options.raw)] : body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method,
    url: `/plugins/dsh-codearts-dock${path}`,
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    headers: options.headers ?? {},
  })
  let status: number | undefined
  handler(req, { setHeader() {}, writeHead: (value) => { status = value }, end: (text) => resolve({ status, body: JSON.parse(text) }) })
})
await check('legacy autoCheckin stays ignored and manual check-in remains available', async () => {
  await new Promise(setImmediate)
  assert.equal(benefitReads, 0, 'legacy autoCheckin=true must not enable scheduled claims')
  const result = await request('/preferences')
  assert.equal(result.body.preferences.dailyCheckinEnabled, false, 'the new switch is opt-in')
  assert.ok(!('autoCheckin' in result.body.preferences), 'the retired field is never restored')
  assert.equal((await request('/checkin/claim-all', {})).status, 200, 'manual batch route remains available')
  assert.ok(benefitReads > 0, 'the manual request checks upstream eligibility')
})
await check('feature routes enforce POST and validate retained preferences', async () => {
  for (const path of ['/preferences/save', '/accounts/check', '/accounts/check-all', '/checkin/claim-all']) assert.equal((await request(path)).status, 405)
  assert.equal((await request('/preferences/save', { refreshIntervalMs: -1 })).status, 400)
  assert.equal((await request('/preferences/save', { dailyCheckinEnabled: 'yes' })).status, 400)
  const preferenceSave = await request('/preferences/save', { refreshIntervalMs: 75000, composerChip: true })
  assert.equal(preferenceSave.body.preferences.refreshIntervalMs, 75000)
  const readsBeforeAutoEnable = benefitReads
  const checkinSave = await request('/preferences/save', { dailyCheckinEnabled: true })
  assert.equal(checkinSave.body.preferences.dailyCheckinEnabled, true, 'the automatic check-in switch persists')
  for (let attempt = 0; attempt < 10 && benefitReads === readsBeforeAutoEnable; attempt += 1) await new Promise(setImmediate)
  assert.ok(benefitReads > readsBeforeAutoEnable, 'enabling the preference starts a daily-only background check')
  assert.equal((await request('/models')).body.enabledIds, null)
})
await check('retired model pins and presets are ignored by preferences and model status', async () => {
  const before = (await request('/models')).body.enabledIds
  const saved = await request('/preferences/save', { favoriteModelIds: ['test-model', 'temporarily-unavailable'], modelPresets: [{ id: 'legacy-preset', name: 'Legacy', enabledModelIds: ['test-model'], modelOverrides: {} }] })
  assert.ok(!('favoriteModelIds' in saved.body.preferences))
  assert.ok(!('modelPresets' in saved.body.preferences))
  assert.ok(!('favoriteModelIds' in readPreferences()))
  assert.ok(!('modelPresets' in readPreferences()))
  assert.ok(!('favoriteModelIds' in (await request('/models')).body))
  assert.ok(!('presets' in (await request('/models')).body))
  assert.deepEqual((await request('/models')).body.enabledIds, before)
})
await check('retired pool settings are ignored and manual account choices remain in force', async () => {
  const previous = accounts.readStore().activeId
  const selected = accounts.readStore().accounts.find((entry) => entry.id !== previous)!
  const saved = await request('/preferences/save', { accountPoolEnabled: true, accountPoolMemberIds: [] })
  assert.equal(saved.status, 200)
  for (const value of [saved.body.preferences, readPreferences(), (await request('/status')).body.settings]) {
    assert.ok(!('accountPoolEnabled' in value))
    assert.ok(!('accountPoolMemberIds' in value))
  }
  assert.equal((await request('/accounts/activate', { id: 'missing-account' })).status, 404)
  assert.equal(accounts.readStore().activeId, previous, 'an invalid choice preserves the current account')
  const switched = await request('/accounts/activate', { id: selected.id })
  assert.equal(switched.status, 200)
  assert.equal(accounts.readStore().activeId, selected.id)
  assert.equal((await request('/account')).body.accountId, selected.id, 'the next read uses the selected account')
  await request('/accounts/activate', { id: previous })
})
await check('higher balances and account checks do not change the manually selected account', async () => {
  const previous = accounts.readStore().activeId
  const selected = accounts.readStore().accounts.find((entry) => entry.id !== previous)!
  try {
    creditRemain = 50
    await request('/accounts/check-all', {})
    creditRemain = 500
    await request('/accounts/check', { id: selected.id })
    await request('/preferences/save', { accountPoolEnabled: true })
    const result = await request('/account')
    assert.equal(result.status, 200)
    assert.equal(result.body.accountId, previous)
    assert.equal(accounts.readStore().activeId, previous)
    const pool = (await request('/accounts')).body
    assert.equal(pool.activeId, previous)
    assert.deepEqual(pool.accounts.filter((entry) => entry.active).map((entry) => entry.id), [previous])
    assert.ok(!('memberAccountIds' in pool))
  } finally {
    creditRemain = 50
    await request('/accounts/activate', { id: previous })
  }
})
await check('malformed, non-object, oversized and remote feature requests are rejected without mutations', async () => {
  const before = JSON.stringify((await request('/preferences')).body)
  for (const path of ['/preferences/save', '/accounts/check', '/accounts/check-all', '/checkin/claim-all']) {
    for (const body of [null, [], 42, 'invalid']) {
      assert.equal((await request(path, body)).status, 400, `${path} must reject ${JSON.stringify(body)}`)
    }
    assert.equal((await request(path, {}, 'POST', { raw: '{bad-json' })).status, 400)
  }
  assert.equal((await request('/preferences/save', { ignored: 'x'.repeat(65536) })).status, 413)
  assert.equal((await request('/preferences/save', { refreshIntervalMs: 123000 }, 'POST', { remoteAddress: '192.0.2.1' })).status, 403)
  assert.equal(JSON.stringify((await request('/preferences')).body), before)
})
await check('account checks use one probe for concurrent clicks, expose actionable status, and keep the credit overview', async () => {
  const id = accounts.readStore().accounts[0].id
  await new Promise(setImmediate)
  const creditsBefore = creditReads, iamBefore = iamReads
  const [a, b] = await Promise.all([request('/accounts/check', { id }), request('/accounts/check', { id })])
  assert.equal(a.body.account.health.state, 'available')
  assert.equal(b.body.account.credit.remain, 50)
  assert.ok(b.body.account.creditCheckedAt > 0)
  assert.equal(typeof b.body.account.creditIdentity, 'string')
  assert.ok(!('lowBalance' in b.body.account))
  assert.equal(creditReads - creditsBefore, 1)
  assert.equal(iamReads - iamBefore, 1)
  creditStatus = 429
  assert.equal((await request('/accounts/check', { id })).body.account.health.state, 'rate_limited')
  creditStatus = 200
  const active = (await request('/account')).body
  assert.equal(active.credit.remain, 50)
  assert.ok(!('lowBalanceThreshold' in active))
})
await check('check-all refreshes health and credits for every account without claiming benefits', async () => {
  const count = accounts.readStore().accounts.length
  const readsBefore = creditReads
  const result = await request('/accounts/check-all', {})
  assert.equal(result.status, 200)
  assert.equal(result.body.accounts.length, count)
  assert.ok(result.body.accounts.every((entry) => entry.health?.checkedAt > 0))
  assert.ok(creditReads - readsBefore >= count, 'each account is force-checked despite a recent cache entry')
})
await check('an invalidated in-flight health probe cannot repopulate stale account state', async () => {
  const account = accounts.readStore().accounts[0]
  let release
  creditGate = new Promise((resolve) => { release = resolve })
  const oldProbe = request('/accounts/check', { id: account.id })
  await new Promise(setImmediate)
  assert.equal((await request('/accounts/add', { ak: account.ak, sk: account.sk, label: account.label })).status, 200)
  creditRemain = 500
  creditGate = null
  release()
  await oldProbe
  const pool = await request('/accounts')
  assert.equal(pool.body.accounts.find((entry) => entry.id === account.id).credit.remain, 500)
  creditRemain = 50
})
// ── cross-site fence ────────────────────────────────────────────────────────
//
// These routes read credentials and one of them exports them. Loopback is not a
// fence: a page on any site can fetch http://127.0.0.1:PORT/... and the request
// arrives over the loopback socket. The Host half ships no server-side
// authentication, so a plugin route has to refuse cross-site callers itself.
await check('cross-site requests are refused even over loopback', async () => {
  const blocked: RequestOptions[] = [
    { headers: { 'sec-fetch-site': 'cross-site' } },
    { headers: { origin: 'https://evil.example' } },
    { headers: { referer: 'https://evil.example/page' } },
    { headers: { origin: 'null' } },
    // A different port on loopback is this machine but not this Host.
    { headers: { origin: 'http://127.0.0.1:1' } },
  ]
  for (const options of blocked) {
    const result = await request('/status', undefined, 'GET', options)
    assert.equal(result.status, 403, `expected 403 for ${JSON.stringify(options.headers)}`)
  }

  // The Host's own page is allowed, and so is a non-browser client that sends
  // no origin at all (the user on their own machine).
  const own = await request('/status', undefined, 'GET', { headers: { host: '127.0.0.1:52427', origin: 'http://127.0.0.1:52427', 'sec-fetch-site': 'same-origin' } })
  assert.equal(own.status, 200)
  const bare = await request('/status', undefined, 'GET', { headers: { host: '127.0.0.1:52427' } })
  assert.equal(bare.status, 200)
})
await check('the export route that returns plaintext keys refuses GET', async () => {
  // It answers data, not a mutation, but a GET can be triggered by a link, a
  // prefetch, or an <img> and would hand over every account's AK/SK.
  assert.equal((await request('/accounts/export')).status, 405)
  const posted = await request('/accounts/export', {})
  assert.equal(posted.status, 200)
})

await check('activity routes are private, clearing is POST-only, and read polling creates no records', async () => {
  await request('/preferences/save', { dailyCheckinEnabled: false })
  await request('/refresh')
  await request('/checkin/claim-all', {})
  assert.equal((await request('/activities/clear', {})).status, 200)
  assert.deepEqual((await request('/activities')).body, { ok: true, records: [], limit: 200 })
  for (const path of ['/status', '/account', '/accounts', '/models', '/checkin', '/preferences', '/activities']) assert.equal((await request(path)).status, 200)
  assert.equal((await request('/activities/clear')).status, 405)
  assert.equal((await request('/activities/clear', null)).status, 400)
  assert.equal((await request('/activities/clear', {}, 'POST', { raw: '{bad-json' })).status, 400)
  assert.equal((await request('/activities', undefined, 'GET', { remoteAddress: '192.0.2.1' })).status, 403)
  assert.equal((await request('/activities/clear', {}, 'POST', { headers: { origin: 'https://evil.example' } })).status, 403)
  assert.equal((await request('/accounts/rename')).status, 405)
  assert.equal((await request('/accounts/rename', {}, 'POST', { remoteAddress: '192.0.2.1' })).status, 403)
  assert.deepEqual((await request('/activities')).body.records, [], 'reads and rejected access/methods are not business actions')
})

await check('business activities record success and failure without account, model, credential or error text', async () => {
  const account = accounts.readStore().accounts[0]
  assert.equal((await request('/accounts/rename', { id: account.id, label: 'PRIVATE_ACCOUNT_NAME' })).status, 200)
  assert.equal((await request('/preferences/save', { enabledModelIds: null, modelOverrides: { PRIVATE_MODEL_ID: { images: true } } })).status, 200)
  assert.equal((await request('/accounts/import', { text: 'PRIVATE_INVALID_IMPORT' })).status, 400)
  const records = (await request('/activities')).body.records
  assert.deepEqual(records.map((entry) => [entry.action, entry.status]), [['account.import', 'error'], ['models.save', 'success'], ['account.rename', 'success']])
  assert.equal(records[0].details.reason, 'unknown')
  const persisted = await readFile(join(scratch, 'dsh-codearts-dock', 'activity.json'), 'utf8')
  for (const text of ['PRIVATE_ACCOUNT_NAME', 'PRIVATE_MODEL_ID', 'PRIVATE_INVALID_IMPORT', account.id, account.ak, account.sk]) assert.ok(!persisted.includes(text), `activity must omit ${text}`)
})

await check('catalog activity records transitions and actual changes without repeated polling failures', async () => {
  await request('/activities/clear', {})
  await request('/refresh')
  await request('/refresh')
  assert.deepEqual((await request('/activities')).body.records, [], 'the existing failure has already been recorded')
  catalogModels = [{ model_id: 'PRIVATE_CATALOG_ID', model_name: 'PRIVATE_CATALOG_NAME' }]
  await request('/refresh')
  await request('/refresh')
  let records = (await request('/activities')).body.records
  assert.deepEqual(records.map((entry) => [entry.action, entry.status]), [['catalog.update', 'success']])
  assert.deepEqual(records[0].details, { total: 1, enabled: 1 })
  catalogModels = [{ ...catalogModels[0], model_name: 'PRIVATE_CHANGED_NAME' }]
  await request('/refresh')
  catalogModels = []
  await request('/refresh')
  await request('/refresh')
  records = (await request('/activities')).body.records
  assert.deepEqual(records.map((entry) => [entry.action, entry.status]), [['catalog.refresh', 'error'], ['catalog.update', 'success'], ['catalog.update', 'success']])
  assert.ok(!JSON.stringify(records).includes('PRIVATE_'))
})

await check('automatic and manual check-in summaries count accounts whose STS exchange fails', async () => {
  await request('/activities/clear', {})
  rejectedAk = 'ACTIVITY_REJECTED_TEST_AK'
  await request('/accounts/add', { ak: rejectedAk, sk: 'TEST_PRIVATE_REJECTED_SK', label: 'PRIVATE_FAILED_ACCOUNT' })
  await request('/preferences/save', { dailyCheckinEnabled: true })
  let automatic
  for (let attempt = 0; attempt < 100; attempt += 1) {
    automatic = (await request('/activities')).body.records.find((entry) => entry.action === 'checkin.auto')
    if (automatic) break
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.ok(automatic, 'the automatic batch records one completed summary')
  assert.equal(automatic.status, 'warning')
  assert.equal(automatic.details.attempted, accounts.readStore().accounts.length)
  assert.equal(automatic.details.failed, 1)
  assert.equal(automatic.details.reason, 'credentials')
  await request('/preferences/save', { dailyCheckinEnabled: false })
  const manual = await request('/checkin/claim-all', {})
  assert.ok(manual.body.summary.failures.some((failure) => failure.reason.includes('HTTP 401')), 'credential failures remain visible instead of being silently skipped')
  const records = (await request('/activities')).body.records
  const summary = records.find((entry) => entry.action === 'checkin.manual')
  assert.equal(summary.details.failed, 1)
  assert.equal(summary.details.skipped, accounts.readStore().accounts.length - 1, 'accounts without available welfare are skipped in history')
  assert.equal(summary.details.reason, 'credentials')
  assert.equal(summary.status, 'warning')
  assert.ok(!JSON.stringify(records).includes('PRIVATE_'))
  const single = await request('/checkin/claim', { id: accounts.readStore().accounts[0].id })
  assert.equal(single.body.claimed, false)
  assert.deepEqual(single.body.reasons, ['上游当前没有可领取的福利活动'], 'the original HTTP result remains unchanged')
  const singleActivity = (await request('/activities')).body.records[0]
  assert.equal(singleActivity.action, 'checkin.manual')
  assert.equal(singleActivity.status, 'success')
  assert.deepEqual(singleActivity.details, { attempted: 1, claimed: 0, skipped: 1, failed: 0 })
  rejectedAk = ''
})

await check('failed history writes preserve business results and clear reports a retryable error', async () => {
  const path = join(scratch, 'dsh-codearts-dock', 'activity.json')
  const before = (await request('/activities')).body.records
  await rm(path)
  await mkdir(path)
  const cleared = await request('/activities/clear', {})
  assert.equal(cleared.status, 500)
  assert.match(cleared.body.error, /无法清空活动记录/)
  assert.deepEqual((await request('/activities')).body.records, before)
  const saved = await request('/preferences/save', { composerChip: true })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.preferences.composerChip, true)
  await rm(path, { recursive: true })
  assert.equal((await request('/activities/clear', {})).status, 200)
  assert.deepEqual((await request('/activities')).body.records, [])
})


test('cleanup scratch data', async () => {
  for (const dispose of disposers.reverse()) await dispose()
  globalThis.fetch = originalFetch
  await rm(scratch, { recursive: true, force: true })
})
