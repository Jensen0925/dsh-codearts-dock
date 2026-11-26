/** Exercise the shipped model routes with isolated storage and a fake gateway. */
import assert from 'node:assert/strict'
import { afterAll, test, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

const scratch = mkdtempSync(join(tmpdir(), 'dca-model-routes-'))
process.env.APPDATA = scratch
process.env.XDG_CONFIG_HOME = scratch
process.env.DSH_CONNECT_CODEARTS_LEGACY_CREDENTIAL = join(scratch, 'no-legacy.json')
const { CredentialProvider } = await import('../src/credentials.ts')
const { MadaoClient, GatewayError } = await import('../src/gateway.ts')
const { readPreferences } = await import('../src/preferences.ts')
const plugin = await import('../src/index.ts')
const upstream = { model_id: 'test-model', model_name: 'Test Model', context_window: 1048576, max_tokens: 65536, enable: true }
let mode = 'success'
const sent: Array<Record<string, any>> = []
const heartbeats: string[] = []
const testSessions: string[] = []
vi.spyOn(CredentialProvider.prototype, 'resolve').mockImplementation(async () => {
  if (mode === 'credentials') throw new Error('请配置可用凭证')
  return { key: { ak: 'TEST_AK', sk: 'TEST_SK', securityToken: 'TEST_TOKEN' }, label: 'Test', source: 'env' }
})
vi.spyOn(MadaoClient.prototype, 'getJson').mockImplementation(async (path) => path.includes('/model/builtin') ? { builtinModels: [upstream] } : {})
vi.spyOn(MadaoClient.prototype, 'postJson').mockResolvedValue({ variants: { 'test-model': { strengths: ['high', 'max'] } } })
vi.spyOn(MadaoClient.prototype, 'heartbeat').mockImplementation(async (status) => { heartbeats.push(status); return true })
vi.spyOn(MadaoClient.prototype, 'streamChat').mockImplementation(async function* (this: { defaultSessionId: string }, request) {
  sent.push(request)
  testSessions.push(this.defaultSessionId)
  if (mode === 'gateway') throw Object.assign(new GatewayError('测试网关限流，请稍后重试'), { status: 429 })
  if (mode === 'empty') { yield { done: true }; return }
  if (mode === 'timeout') {
    await new Promise<void>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    return
  }
  yield { text: 'OK' }
  yield { done: true }
})

const disposers: Array<() => unknown> = []
const routes = new Map<string, (req: any, res: any) => void>()
const effect = (fn) => {
  const dispose = fn()
  if (typeof dispose === 'function') disposers.push(dispose)
  return typeof dispose === 'function' ? dispose : () => {}
}
plugin.apply({
  effect, get: () => undefined, emit() {},
  inject: (_deps, callback) => callback({ effect, webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {} } } }),
}, { registerProvider: false })
const request = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<{ status: number; body: Record<string, any> }> => new Promise((resolve) => {
  const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), {
    method, url: `/plugins/dsh-codearts-dock${path}`, headers: {}, socket: { remoteAddress: '127.0.0.1' },
  })
  let status = 0
  routes.get(req.url)!(req, { setHeader() {}, writeHead: (value) => { status = value }, end: (text) => resolve({ status, body: JSON.parse(text) }) })
})

test('context selection persists and the catalog preserves its upstream default', async () => {
  assert.equal((await request('/refresh')).body.ok, true)
  const overrides = { 'test-model': { context: 262144, images: true } }
  assert.equal((await request('/models/select', { enabledIds: null, overrides })).status, 200)
  assert.deepEqual(readPreferences().modelOverrides, overrides)
  const model = (await request('/models')).body.models[0]
  assert.equal(model.context, 262144)
  assert.equal(model.maxOutput, 32768)
  assert.deepEqual(model.defaults, { context: 1048576 })
})

test('draft model tests use the requested values without saving or enabling a model', async () => {
  const before = readPreferences()
  const result = await request('/models/test', { modelId: 'test-model', overrides: { context: 32768 } })
  assert.equal(result.body.ok, true)
  assert.ok(result.body.elapsedMs >= 0)
  assert.equal(sent.at(-1)?.model, 'test-model')
  assert.equal(sent.at(-1)?.maxTokens, 8192, 'a 32K context leaves room for the prompt')
  assert.equal(sent.at(-1)?.reasoningEffort, 'high', 'missing upstream defaults use the first supported reasoning level')
  assert.match(testSessions.at(-1)!, /^codearts-test-/)
  assert.deepEqual(readPreferences(), before)
  assert.deepEqual(heartbeats.slice(-2), ['busy', 'idle'])
})

test('clearing context restores the default while retaining capability settings', async () => {
  const result = await request('/models/select', { enabledIds: null, overrides: { 'test-model': { context: null, images: true } } })
  assert.equal(result.status, 200)
  assert.deepEqual(readPreferences().modelOverrides, { 'test-model': { images: true } })
  const model = (await request('/models')).body.models[0]
  assert.equal(model.context, 1048576)
  assert.equal(model.maxOutput, 32768)
})

test('invalid model requests reject before calling the gateway or modifying preferences', async () => {
  const before = readPreferences()
  const requestsBefore = sent.length
  assert.equal((await request('/models/test')).status, 405)
  for (const body of [null, [], {}, { modelId: 'missing' }, { modelId: 'test-model', overrides: [] }, { modelId: 'test-model', overrides: { context: '65536' } }, { modelId: 'test-model', overrides: { context: 2097153 } }]) {
    assert.equal((await request('/models/test', body)).status, 400, JSON.stringify(body))
  }
  assert.equal((await request('/models/select', { enabledIds: null, overrides: { 'test-model': { context: 1023 } } })).status, 400)
  assert.equal(sent.length, requestsBefore)
  assert.deepEqual(readPreferences(), before)
})

test('each model ceiling protects selection saves, preferences saves and draft tests', async () => {
  const before = readPreferences()
  const requestsBefore = sent.length
  const overrides = { 'test-model': { context: 2097152 } }
  for (const [path, body] of [
    ['/models/select', { enabledIds: null, overrides }],
    ['/preferences/save', { modelOverrides: overrides }],
    ['/models/test', { modelId: 'test-model', overrides: overrides['test-model'] }],
  ] as const) {
    const result = await request(path, body)
    assert.equal(result.status, 400, path)
    assert.match(result.body.error, /不能超过模型上限 1048576/)
  }
  assert.equal(sent.length, requestsBefore, 'invalid drafts never reach the gateway')
  assert.deepEqual(readPreferences(), before, 'invalid saves leave persisted selections intact')

  const legal = { 'test-model': { context: 131072 } }
  assert.equal((await request('/preferences/save', { modelOverrides: legal })).status, 200)
  assert.equal((await request('/models')).body.models[0].context, 131072)
  assert.deepEqual(readPreferences().modelOverrides, legal)
  assert.equal((await request('/models/select', { enabledIds: before.enabledModelIds ?? null, overrides: before.modelOverrides ?? {} })).status, 200)
})

test('model tests expose gateway, missing text and credential failures without changing settings', async () => {
  const before = readPreferences()
  try {
    for (const [failure, pattern] of [['gateway', /限流/], ['empty', /未返回正文/], ['credentials', /凭证/]] as const) {
      mode = failure
      const result = await request('/models/test', { modelId: 'test-model', overrides: {} })
      assert.equal(result.body.ok, false)
      assert.match(result.body.error, pattern)
      assert.ok(result.body.elapsedMs >= 0)
    }
  } finally { mode = 'success' }
  assert.deepEqual(readPreferences(), before)
})

test('a stalled model test times out and aborts its upstream stream', async () => {
  vi.useFakeTimers()
  mode = 'timeout'
  try {
    const result = request('/models/test', { modelId: 'test-model' })
    await vi.advanceTimersByTimeAsync(30000)
    const response = await result
    assert.equal(response.body.ok, false)
    assert.match(response.body.error, /超时/)
    assert.equal(sent.at(-1)?.signal.aborted, true)
    assert.equal(heartbeats.at(-1), 'idle')
  } finally {
    mode = 'success'
    vi.useRealTimers()
  }
})

afterAll(async () => {
  for (const dispose of disposers.reverse()) await dispose()
  vi.restoreAllMocks()
  rmSync(scratch, { recursive: true, force: true })
})
