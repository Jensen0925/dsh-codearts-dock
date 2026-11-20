/** All five features against real local storage and fake gateway/host boundaries. */
import assert from 'node:assert/strict'
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
const { FEATURE_DEFAULTS, validatePreferences, persistPreferences, readPreferences, portablePreferences } = await import('../src/preferences.js')
const { encodeBackup, decodeBackup } = await import('../src/backup.js')
const { createUsageStore, USAGE_LIMIT } = await import('../src/usage.js')
const { accountHealth, isLowBalance } = await import('../src/health.js')
const { readCredit } = await import('../src/account.js')
const accounts = await import('../src/accounts.js')
const { createCodeArtsAdapter } = await import('../src/adapter.js')
const { Catalog } = await import('../src/catalog.js')
const results = []
const check = async (name, fn) => {
  try { await fn(); results.push(`✓ ${name}`) } catch (error) { results.push(`✗ ${name}\n${error.stack}`); process.exitCode = 1 }
}
const settings = { ...FEATURE_DEFAULTS, enabledModelIds: null, modelOverrides: {}, autoCheckin: false, composerChip: true, refreshIntervalMs: 300000 }
const preferences = portablePreferences(settings)
const secretAccount = { ak: 'TEST_BACKUP_AK_123456789', sk: 'TEST_BACKUP_SK_987654321', label: 'Example' }

await check('alert thresholds reject invalid data and distinguish unknown from zero balance', async () => {
  assert.equal(isLowBalance({ remain: 10 }, { ...settings, lowBalanceThreshold: 20 }), true)
  assert.equal(isLowBalance({ remain: 20 }, { ...settings, lowBalanceThreshold: 20 }), false)
  assert.equal(isLowBalance({ remain: 0 }, settings), true)
  assert.equal(isLowBalance(null, settings), false)
  assert.equal(isLowBalance({ remain: 10 }, { ...settings, lowBalanceEnabled: false }), false)
  for (const invalid of [-1, NaN, Infinity, '500', 1e10]) assert.throws(() => validatePreferences({ lowBalanceThreshold: invalid }))
  assert.throws(() => validatePreferences({ enabledModelIds: [], modelOverrides: {} }))
  assert.throws(() => validatePreferences(JSON.parse('{"modelOverrides":{"__proto__":{"images":true}}}')))
  assert.throws(() => validatePreferences({ modelPresets: Array(21).fill({}) }))
})
await check('concurrent preference writes are atomic, private, and do not lose other keys', async () => {
  await Promise.all([persistPreferences({ lowBalanceThreshold: 250 }), persistPreferences({ usageEnabled: false }), persistPreferences({ autoCheckin: false })])
  assert.equal(readPreferences().lowBalanceThreshold, 250)
  assert.equal(readPreferences().usageEnabled, false)
  const mode = (await stat(join(scratch, 'dsh-connect-codearts', 'preferences.json'))).mode & 0o777
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
await check('usage is bounded and stores only metadata, with disable and in-flight clear guards', async () => {
  let enabled = true
  const usage = createUsageStore({ directory: join(scratch, 'usage-tests'), enabled: () => enabled })
  const epoch = usage.generation()
  await usage.record({ at: Date.now(), model: 'test-model', status: 'success', durationMs: 50, inputTokens: 10, outputTokens: 2, prompt: 'PRIVATE_PROMPT', account: 'PRIVATE_ACCOUNT', sk: 'PRIVATE_SK' }, epoch)
  const saved = await readFile(join(scratch, 'usage-tests', 'usage.json'), 'utf8')
  assert.ok(!saved.includes('PRIVATE'))
  assert.equal((await stat(join(scratch, 'usage-tests', 'usage.json'))).mode & 0o777, 0o600)
  enabled = false
  const disabledEpoch = usage.generation()
  await usage.record({ model: 'not-recorded' }, epoch)
  assert.equal(usage.list().records.length, 1)
  enabled = true
  await usage.record({ model: 'started-while-disabled' }, disabledEpoch)
  assert.equal(usage.list().records.length, 1)
  await usage.clear()
  await usage.record({ model: 'stale-in-flight' }, epoch)
  assert.equal(usage.list().records.length, 0)
  // Queue several writes together to exercise disk ordering without a gateway.
  await Promise.all(Array.from({ length: USAGE_LIMIT + 3 }, (_, i) => usage.record({ model: `model-${i}`, status: 'success' })))
  assert.equal(usage.list().records.length, USAGE_LIMIT)
  assert.equal(usage.list().records[0].model, `model-${USAGE_LIMIT + 2}`)
  assert.equal(createUsageStore({ directory: join(scratch, 'usage-tests') }).list().records.length, USAGE_LIMIT)
})
await check('real adapter records success, upstream failure, credential failure and cancellation without contents', async () => {
  const catalog = new Catalog(); catalog.current = [{ id: 'm', name: 'Model', strengths: [] }]
  async function run(chunks, failCredentials = false, cancel = false) {
    const recorded = []
    const adapter = createCodeArtsAdapter({
      catalog, credentials: { resolve: async () => { if (failCredentials) throw new Error('PRIVATE_CREDENTIAL'); return { key: { ak: 'TEST', sk: 'TEST' } } } },
      createClient: () => ({ heartbeat: async () => {}, streamChat: async function* () { for (const chunk of chunks) { if (chunk instanceof Error) throw chunk; yield chunk } } }),
      usage: { generation: () => 0, record: async (row) => recorded.push(row) },
    })
    try {
      for await (const chunk of adapter.stream({ model: 'm', provider: 'codearts', messages: [{ role: 'user', content: [{ type: 'text', text: 'PRIVATE_PROMPT' }] }] })) { if (cancel) break }
    } catch {}
    return recorded
  }
  const success = await run([{ text: 'PRIVATE_OUTPUT' }, { usage: { inputTokens: 8, outputTokens: 2 } }, { finish: 'stop' }])
  assert.equal(success[0].status, 'success')
  assert.equal(success[0].inputTokens, 8)
  assert.ok(!JSON.stringify(success).includes('PRIVATE'))
  assert.equal((await run([new Error('PRIVATE_UPSTREAM')]))[0].status, 'error')
  assert.equal((await run([], true))[0].status, 'error')
  assert.equal((await run([{ text: 'x' }], false, true))[0].status, 'aborted')
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
  if (url.includes('/v1/ops/delivery')) return jsonResponse([])
  if (url.includes('/member/roles')) return jsonResponse([])
  throw new Error('Offline test blocked an unexpected gateway request')
}
const routes = new Map()
const plugin = await import('../src/index.js')
const effect = (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return dispose }
plugin.apply({ effect, get: () => undefined, emit() {}, inject: (_, callback) => callback({ effect, webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {} } } }) }, { registerProvider: false })
const request = (path, body, method = body === undefined ? 'GET' : 'POST', options = {}) => new Promise((resolve, reject) => {
  const handler = routes.get(`/plugins/dsh-connect-codearts${path}`)
  if (!handler) return reject(new Error(`Unknown route ${path}`))
  const req = Readable.from(options.raw !== undefined ? [Buffer.from(options.raw)] : body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  Object.assign(req, { method, url: `/plugins/dsh-connect-codearts${path}`, socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' } })
  let status
  handler(req, { setHeader() {}, writeHead: (value) => { status = value }, end: (text) => resolve({ status, body: JSON.parse(text) }) })
})
await check('feature routes enforce POST, validate preferences, and persist presets without changing the live selection', async () => {
  for (const path of ['/preferences/save', '/usage/clear', '/presets', '/backup/export', '/backup/preview', '/backup/restore', '/accounts/check']) assert.equal((await request(path)).status, 405)
  assert.equal((await request('/preferences/save', { lowBalanceThreshold: -1 })).status, 400)
  const preferenceSave = await request('/preferences/save', { lowBalanceThreshold: 75, usageEnabled: true })
  assert.equal(preferenceSave.body.preferences.lowBalanceThreshold, 75)
  const preset = await request('/presets', { action: 'save', name: 'Daily', enabledModelIds: ['test-model'], modelOverrides: { 'test-model': { images: true, defaultStrength: 'high' } } })
  assert.equal(preset.status, 200)
  assert.equal(preset.body.presets.length, 1)
  assert.equal((await request('/models')).body.enabledIds, null)
  const id = preset.body.presets[0].id
  assert.equal((await request('/presets', { action: 'delete', id })).body.presets.length, 0)
})
await check('malformed, non-object, oversized and remote feature requests are rejected without mutations', async () => {
  const before = JSON.stringify((await request('/preferences')).body)
  for (const path of ['/preferences/save', '/presets', '/backup/export', '/backup/preview', '/backup/restore', '/accounts/check']) {
    for (const body of [null, [], 42, 'invalid']) {
      assert.equal((await request(path, body)).status, 400, `${path} must reject ${JSON.stringify(body)}`)
    }
    assert.equal((await request(path, {}, 'POST', { raw: '{bad-json' })).status, 400)
  }
  assert.equal((await request('/preferences/save', { ignored: 'x'.repeat(65536) })).status, 413)
  assert.equal((await request('/backup/preview', { text: 'x'.repeat(1024 * 1024) })).status, 413)
  assert.equal((await request('/preferences/save', { lowBalanceThreshold: 123 }, 'POST', { remoteAddress: '192.0.2.1' })).status, 403)
  assert.equal(JSON.stringify((await request('/preferences')).body), before)
})
await check('account checks use one probe for concurrent clicks, expose actionable status, and report low balances', async () => {
  const id = accounts.readStore().accounts[0].id
  await new Promise(setImmediate)
  const creditsBefore = creditReads, iamBefore = iamReads
  const [a, b] = await Promise.all([request('/accounts/check', { id }), request('/accounts/check', { id })])
  assert.equal(a.body.account.health.state, 'available')
  assert.equal(b.body.account.lowBalance, true)
  assert.equal(creditReads - creditsBefore, 1)
  assert.equal(iamReads - iamBefore, 1)
  creditStatus = 429
  assert.equal((await request('/accounts/check', { id })).body.account.health.state, 'rate_limited')
  creditStatus = 200
  const active = (await request('/account')).body
  assert.equal(active.lowBalance, true)
  assert.equal(active.lowBalanceThreshold, 75)
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
  await request('/preferences/save', { lowBalanceThreshold: 999 })
  const preservedId = accounts.readStore().accounts.at(-1).id
  await accounts.setActiveAccount(preservedId)
  const restore = await request('/backup/restore', { text, password: 'test-password-123' })
  assert.equal(restore.status, 200)
  assert.equal(restore.body.updated, 3)
  assert.equal((await request('/preferences')).body.preferences.lowBalanceThreshold, 75)
  assert.equal(accounts.readStore().accounts.length, 3)
  assert.equal(accounts.readStore().activeId, preservedId)

  // Simulate a new installation using only this suite's temporary account store.
  for (const account of accounts.readStore().accounts) await accounts.removeAccount(account.id)
  const fresh = await request('/backup/restore', { text, password: 'test-password-123' })
  assert.equal(fresh.status, 200)
  assert.equal(fresh.body.added, 3)
  assert.equal(accounts.readStore().activeId, accounts.accountIdOf(secretAccount.ak))
})

for (const dispose of disposers.reverse()) dispose()
globalThis.fetch = originalFetch
await rm(scratch, { recursive: true, force: true })
console.log(results.join('\n'))
console.log(process.exitCode ? '\nfeatures: checks failed' : '\nfeatures: all checks passed')
