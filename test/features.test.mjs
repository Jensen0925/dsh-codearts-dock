/** Account health, model presets and encrypted migration against isolated local storage. */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises'
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
const { encodeBackup, decodeBackup } = await import('../src/backup.ts')
const { accountHealth } = await import('../src/health.ts')
const { readCredit } = await import('../src/account.ts')
const accounts = await import('../src/accounts.ts')
const check = (name, fn) => test(name, fn)
const settings = { ...FEATURE_DEFAULTS, enabledModelIds: null, modelOverrides: {}, composerChip: true, refreshIntervalMs: 300000 }
const preferences = portablePreferences(settings)
const secretAccount = { ak: 'TEST_BACKUP_AK_123456789', sk: 'TEST_BACKUP_SK_987654321', label: 'Example' }

await check('preferences validate retained settings and ignore retired fields', async () => {
  for (const invalid of [-1, 0, '60000', 86400001]) assert.throws(() => validatePreferences({ refreshIntervalMs: invalid }))
  assert.throws(() => validatePreferences({ composerChip: 'true' }))
  assert.deepEqual(validatePreferences({ favoriteModelIds: ['legacy-pin'] }), {})
  assert.throws(() => validatePreferences({ enabledModelIds: [], modelOverrides: {} }))
  assert.throws(() => validatePreferences(JSON.parse('{"modelOverrides":{"__proto__":{"images":true}}}')))
  assert.throws(() => validatePreferences({ modelPresets: Array(21).fill({}) }))
  assert.deepEqual(validatePreferences({ lowBalanceEnabled: true, lowBalanceThreshold: 500, usageEnabled: true, autoCheckin: true, composerChip: true }), { composerChip: true })
  const portable = portablePreferences({ ...settings, lowBalanceEnabled: true, usageEnabled: true, autoCheckin: true })
  assert.ok(!('lowBalanceEnabled' in portable))
  assert.ok(!('usageEnabled' in portable))
  assert.ok(!('autoCheckin' in portable))
})
await check('concurrent preference writes are atomic, private, and do not lose other keys', async () => {
  await Promise.all([persistPreferences({ refreshIntervalMs: 120000 }), persistPreferences({ composerChip: false }), persistPreferences({ modelPresets: [] })])
  assert.equal(readPreferences().refreshIntervalMs, 120000)
  assert.equal(readPreferences().composerChip, false)
  await persistPreferences({ favoriteModelIds: ['legacy-pin'] })
  assert.ok(!('favoriteModelIds' in readPreferences()), 'saving drops the retired pin field from an old config')
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
await check('plain backups contain only preferences, encrypted backups round-trip credentials and reject tampering', async () => {
  const plain = await encodeBackup({ preferences, accounts: [secretAccount] })
  assert.equal(plain.accounts, undefined)
  assert.ok(!JSON.stringify(plain).includes(secretAccount.ak))
  assert.deepEqual((await decodeBackup(JSON.stringify(plain))).preferences, preferences)
  const legacy = { ...plain, preferences: { ...plain.preferences, lowBalanceEnabled: true, lowBalanceThreshold: 500, usageEnabled: true, autoCheckin: true, favoriteModelIds: ['legacy-pin'] } }
  assert.deepEqual((await decodeBackup(JSON.stringify(legacy))).preferences, preferences)
  await assert.rejects(encodeBackup({ preferences, accounts: [secretAccount], includeCredentials: true, password: '' }))
  await assert.rejects(encodeBackup({ preferences, accounts: [secretAccount, { ...secretAccount, ak: ` ${secretAccount.ak} ` }], includeCredentials: true, password: 'test-password-123' }), /重复账号/)
  const encrypted = await encodeBackup({ preferences, accounts: [secretAccount], activeAccountId: accounts.accountIdOf(secretAccount.ak), includeCredentials: true, password: 'test-password-123' })
  assert.ok(!JSON.stringify(encrypted).includes(secretAccount.sk))
  const decoded = await decodeBackup(JSON.stringify(encrypted), 'test-password-123')
  assert.deepEqual(decoded.accounts, [secretAccount])
  assert.equal(decoded.activeAccountId, accounts.accountIdOf(secretAccount.ak))
  await assert.rejects(decodeBackup(JSON.stringify(encrypted), 'wrong-password'), /密码错误/)
  const data = Buffer.from(encrypted.data, 'base64'); data[0] ^= 1
  await assert.rejects(decodeBackup(JSON.stringify({ ...encrypted, data: data.toString('base64') }), 'test-password-123'), /密码错误/)
  await assert.rejects(decodeBackup(JSON.stringify({ ...plain, accounts: [secretAccount] })), /必须为加密/)
  await assert.rejects(decodeBackup(JSON.stringify({ ...plain, version: 99 })))
})
await check('concurrent account imports and name discovery cannot overwrite other accounts', async () => {
  const [one] = await Promise.all([accounts.addAccount(secretAccount), accounts.addAccount({ ak: 'SECOND_TEST_AK', sk: 'SECOND_TEST_SK' })])
  await Promise.all([accounts.rememberAccountName(one.account.id, 'Example name'), accounts.addAccount({ ak: 'THIRD_TEST_AK', sk: 'THIRD_TEST_SK' })])
  assert.equal(accounts.readStore().accounts.length, 3)
  assert.equal(accounts.readStore().accounts.find((entry) => entry.id === one.account.id).accountName, 'Example name')
})

const originalFetch = globalThis.fetch
const disposers = []
let creditStatus = 200
let creditReads = 0
let creditGate = null
let creditRemain = 50
let iamReads = 0
let benefitReads = 0
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status })
globalThis.fetch = async (input) => {
  const url = String(input)
  if (url.includes('iam.cn-north-4.myhuaweicloud.com')) {
    iamReads += 1
    return jsonResponse({ credential: { access: 'TEMP_TEST_AK', secret: 'TEMP_TEST_SK', securitytoken: 'TEMP_TEST_TOKEN', expires_at: new Date(Date.now() + 3600000).toISOString() } })
  }
  if (url.includes('/statistics/plugin')) {
    creditReads += 1
    const remain = creditRemain
    await creditGate
    if (creditStatus !== 200) return jsonResponse({ message: 'mock failure' }, creditStatus)
    return jsonResponse({ metrics: [{ name: 'usageTotalPackageCredit', package_credit_amount: 1000, package_credit_used: 950, package_credit_remain: remain }] })
  }
  if (url.includes('/v1/model/builtin') || url.includes('/v1/model/thinking-variants')) return jsonResponse([])
  if (url.includes('/v1/ops/delivery')) { benefitReads += 1; return jsonResponse([]) }
  if (url.includes('/member/roles')) return jsonResponse([])
  throw new Error('Offline test blocked an unexpected gateway request')
}
const routes = new Map()
const plugin = await import('../src/index.ts')
const effect = (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose }
plugin.apply({ effect, get: () => undefined, emit() {}, inject: (_, callback) => callback({ effect, webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {} } } }) }, { registerProvider: false, autoCheckin: true })
for (const path of ['/usage', '/usage/clear', '/checkin/auto']) assert.ok(!routes.has(`/plugins/dsh-codearts-dock${path}`), `Retired route registered: ${path}`)
const request = (path, body, method = body === undefined ? 'GET' : 'POST', options = {}) => new Promise((resolve, reject) => {
  const handler = routes.get(`/plugins/dsh-codearts-dock${path}`)
  if (!handler) return reject(new Error(`Unknown route ${path}`))
  const req = Readable.from(options.raw !== undefined ? [Buffer.from(options.raw)] : body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  Object.assign(req, { method, url: `/plugins/dsh-codearts-dock${path}`, socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' }, headers: options.headers ?? {} })
  let status
  handler(req, { setHeader() {}, writeHead: (value) => { status = value }, end: (text) => resolve({ status, body: JSON.parse(text) }) })
})
await check('legacy automatic check-in settings cause no background benefit requests', async () => {
  await new Promise(setImmediate)
  assert.equal(benefitReads, 0, 'legacy autoCheckin=true must not run a claim sweep on startup')
  const result = await request('/preferences')
  assert.ok(!('autoCheckin' in result.body.preferences))
  assert.equal((await request('/checkin/claim-all', {})).status, 200, 'manual batch route remains available')
  assert.ok(benefitReads > 0, 'the manual request checks upstream eligibility')
})
await check('feature routes enforce POST, validate preferences, and persist presets without changing the live selection', async () => {
  for (const path of ['/preferences/save', '/presets', '/backup/export', '/backup/preview', '/backup/restore', '/accounts/check', '/checkin/claim-all']) assert.equal((await request(path)).status, 405)
  assert.equal((await request('/preferences/save', { refreshIntervalMs: -1 })).status, 400)
  const preferenceSave = await request('/preferences/save', { refreshIntervalMs: 75000, composerChip: true })
  assert.equal(preferenceSave.body.preferences.refreshIntervalMs, 75000)
  const preset = await request('/presets', { action: 'save', name: 'Daily', enabledModelIds: ['test-model'], modelOverrides: { 'test-model': { images: true, defaultStrength: 'high' } } })
  assert.equal(preset.status, 200)
  assert.equal(preset.body.presets.length, 1)
  assert.equal((await request('/models')).body.enabledIds, null)
  const id = preset.body.presets[0].id
  assert.equal((await request('/presets', { action: 'delete', id })).body.presets.length, 0)
})
await check('retired model pins are ignored by preferences and backups', async () => {
  const before = (await request('/models')).body.enabledIds
  const saved = await request('/preferences/save', { favoriteModelIds: ['test-model', 'temporarily-unavailable'] })
  assert.ok(!('favoriteModelIds' in saved.body.preferences))
  assert.ok(!('favoriteModelIds' in readPreferences()))
  assert.ok(!('favoriteModelIds' in (await request('/models')).body))
  assert.deepEqual((await request('/models')).body.enabledIds, before)
  const exported = await request('/backup/export', {})
  assert.ok(!('favoriteModelIds' in exported.body.backup.preferences))
  const oldBackup = { format: 'dsh-codearts-dock-backup', version: 1, preferences: { ...(await request('/preferences')).body.preferences, favoriteModelIds: ['legacy-pin'] } }
  const restored = await request('/backup/restore', { text: JSON.stringify(oldBackup) })
  assert.equal(restored.status, 200)
  assert.ok(!('favoriteModelIds' in restored.body.preferences))
  assert.ok(!('favoriteModelIds' in (await request('/models')).body))
})
await check('malformed, non-object, oversized and remote feature requests are rejected without mutations', async () => {
  const before = JSON.stringify((await request('/preferences')).body)
  for (const path of ['/preferences/save', '/presets', '/backup/export', '/backup/preview', '/backup/restore', '/accounts/check', '/checkin/claim-all']) {
    for (const body of [null, [], 42, 'invalid']) {
      assert.equal((await request(path, body)).status, 400, `${path} must reject ${JSON.stringify(body)}`)
    }
    assert.equal((await request(path, {}, 'POST', { raw: '{bad-json' })).status, 400)
  }
  assert.equal((await request('/preferences/save', { ignored: 'x'.repeat(65536) })).status, 413)
  assert.equal((await request('/backup/preview', { text: 'x'.repeat(1024 * 1024) })).status, 413)
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
await check('backup preview writes nothing; restore merges accounts, preferences and presets, while wrong passwords do not mutate', async () => {
  const exportResponse = await request('/backup/export', { includeCredentials: true, password: 'test-password-123' })
  assert.equal(exportResponse.status, 200)
  const text = JSON.stringify(exportResponse.body.backup)
  const before = JSON.stringify(accounts.readStore())
  assert.equal((await request('/backup/preview', { text, password: 'wrong-password' })).status, 400)
  assert.equal(JSON.stringify(accounts.readStore()), before)
  const preview = await request('/backup/preview', { text, password: 'test-password-123' })
  assert.equal(preview.body.accounts.updated, 3)
  assert.equal(JSON.stringify(accounts.readStore()), before)
  assert.ok(!JSON.stringify(preview.body).includes(secretAccount.sk))
  await request('/preferences/save', { refreshIntervalMs: 999000 })
  const preservedId = accounts.readStore().accounts.at(-1).id
  await accounts.setActiveAccount(preservedId)
  const restore = await request('/backup/restore', { text, password: 'test-password-123' })
  assert.equal(restore.status, 200)
  assert.equal(restore.body.updated, 3)
  assert.equal((await request('/preferences')).body.preferences.refreshIntervalMs, 75000)
  assert.equal(accounts.readStore().accounts.length, 3)
  assert.equal(accounts.readStore().activeId, preservedId)

  // Simulate a new installation using only this suite's temporary account store.
  for (const account of accounts.readStore().accounts) await accounts.removeAccount(account.id)
  const fresh = await request('/backup/restore', { text, password: 'test-password-123' })
  assert.equal(fresh.status, 200)
  assert.equal(fresh.body.added, 3)
  assert.equal(accounts.readStore().activeId, accounts.accountIdOf(secretAccount.ak))
})

// ── cross-site fence ────────────────────────────────────────────────────────
//
// These routes read credentials and one of them exports them. Loopback is not a
// fence: a page on any site can fetch http://127.0.0.1:PORT/... and the request
// arrives over the loopback socket. The Host half ships no server-side
// authentication, so a plugin route has to refuse cross-site callers itself.
await check('cross-site requests are refused even over loopback', async () => {
  const blocked = [
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


test('cleanup scratch data', async () => {
  for (const dispose of disposers.reverse()) dispose()
  globalThis.fetch = originalFetch
  await rm(scratch, { recursive: true, force: true })
})
