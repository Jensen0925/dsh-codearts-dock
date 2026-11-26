/** Offline manual credential selection, caching, and concurrent switch coverage. */
import assert from 'node:assert/strict'
import { afterAll, afterEach, beforeEach, test, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Reading fallback sign-in state must stay inside this test's scratch home.
vi.mock('node:os', async (original) => ({
  ...await original<typeof import('node:os')>(),
  homedir: () => process.env.APPDATA!,
}))

const scratch = mkdtempSync(join(tmpdir(), 'dca-credentials-'))
process.env.APPDATA = scratch
process.env.DSH_CODEARTS_LEGACY_CONFIG_DIR = join(scratch, 'old')
process.env.DSH_CONNECT_CODEARTS_LEGACY_CREDENTIAL = join(scratch, 'legacy.json')
const { CredentialProvider, listCandidates, ENV_AK, ENV_SK, ENV_TOKEN } = await import('../src/credentials.ts')
const { addAccount, readStore, removeAccount, setActiveAccount } = await import('../src/accounts.ts')
const originalFetch = globalThis.fetch
const originalEnv = new Map([ENV_AK, ENV_SK, ENV_TOKEN].map((key) => [key, process.env[key]]))
const a = (await addAccount({ ak: 'CREDENTIAL_TEST_A', sk: 'test-secret-a', label: 'A' })).account
const b = (await addAccount({ ak: 'CREDENTIAL_TEST_B', sk: 'test-secret-b', label: 'B' })).account
const providers: InstanceType<typeof CredentialProvider>[] = []
const iamKeys: string[] = []
const temporary = (ak: string) => new Response(JSON.stringify({ credential: {
  access: `TEMP_${ak}`, secret: 'test-temp-secret', securitytoken: `TOKEN_${ak}`,
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
} }), { status: 200 })
const accessKey = (init?: RequestInit) => new Headers(init?.headers).get('authorization')?.match(/Access=([^,]+),/)?.[1] ?? ''
const provider = () => {
  const instance = new CredentialProvider()
  providers.push(instance)
  return instance
}
const saveBorrowedSignIn = () => {
  const stateDir = join(scratch, 'codearts-agent', 'User', 'globalStorage')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'state.vscdb'), JSON.stringify({
    id: 'huawei-cloud-authentication', accessKey: 'BORROWED_TEST_AK', secretKey: 'borrowed-test-secret',
    securityToken: 'borrowed-test-token', expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  }))
}

beforeEach(async () => {
  for (const key of originalEnv.keys()) delete process.env[key]
  await addAccount({ ak: a.ak, sk: a.sk, label: a.label })
  await setActiveAccount(a.id)
  iamKeys.length = 0
  globalThis.fetch = async (_input, init) => {
    const ak = accessKey(init)
    iamKeys.push(ak)
    return temporary(ak)
  }
})
afterEach(() => {
  for (const instance of providers.splice(0)) instance.dispose()
  rmSync(join(scratch, 'codearts-agent'), { recursive: true, force: true })
  vi.restoreAllMocks()
})
afterAll(() => {
  globalThis.fetch = originalFetch
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(scratch, { recursive: true, force: true })
})

test('credential sources retain environment, selected account, and desktop sign-in priority', async () => {
  saveBorrowedSignIn()
  process.env[ENV_AK] = 'ENV_TEST_AK'
  process.env[ENV_SK] = 'env-test-secret'
  process.env[ENV_TOKEN] = 'env-test-token'
  const candidates = listCandidates()
  assert.deepEqual(candidates.map(({ source }) => source), ['env', 'file', 'codearts'])
  assert.deepEqual(candidates.filter(({ accountId }) => accountId).map(({ accountId }) => accountId), [a.id])
  const resolved = await provider().resolve()
  assert.equal(resolved.source, 'env')
  assert.equal(resolved.accountId, undefined)
  assert.deepEqual(iamKeys, [])
})

test('a selected account failure never tries another saved account', async () => {
  globalThis.fetch = async (_input, init) => {
    iamKeys.push(accessKey(init))
    return new Response('invalid credentials', { status: 401 })
  }
  const credentials = provider()
  await assert.rejects(credentials.resolve(), /所有凭证来源都不可用/)
  assert.equal(readStore().activeId, a.id)
  assert.deepEqual(iamKeys, [a.ak])
})

test('a rejected selected account retains the desktop sign-in fallback', async () => {
  saveBorrowedSignIn()
  globalThis.fetch = async (_input, init) => {
    iamKeys.push(accessKey(init))
    return new Response('invalid credentials', { status: 401 })
  }
  const resolved = await provider().resolve()
  assert.equal(resolved.source, 'codearts')
  assert.equal(resolved.key.ak, 'BORROWED_TEST_AK')
  assert.deepEqual(iamKeys, [a.ak])
  assert.equal(readStore().activeId, a.id)
})

test('concurrent resolutions share the verified credential and reuse its cache', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  globalThis.fetch = async (_input, init) => {
    const ak = accessKey(init)
    iamKeys.push(ak)
    await gate
    return temporary(ak)
  }
  const credentials = provider()
  const first = credentials.resolve()
  const second = credentials.resolve()
  assert.deepEqual(iamKeys, [a.ak])
  release()
  const [one, two] = await Promise.all([first, second])
  assert.equal(one, two)
  assert.equal(one.accountId, a.id)
  assert.equal(await credentials.resolve(), one)
  assert.deepEqual(iamKeys, [a.ak])
})

test('a manual switch replaces the cached account without explicit invalidation', async () => {
  const credentials = provider()
  assert.equal((await credentials.resolve()).accountId, a.id)
  await setActiveAccount(b.id)
  assert.equal((await credentials.resolve()).accountId, b.id)
  assert.equal(credentials.accountId, b.id)
  assert.deepEqual(iamKeys, [a.ak, b.ak])
})

test('deleting the current account cannot reuse its cached credential', async () => {
  const c = (await addAccount({ ak: 'CREDENTIAL_TEST_C', sk: 'test-secret-c' })).account
  await setActiveAccount(c.id)
  const credentials = provider()
  assert.equal((await credentials.resolve()).accountId, c.id)
  await removeAccount(c.id)
  const current = readStore().activeId
  assert.notEqual(current, c.id)
  assert.equal((await credentials.resolve()).accountId, current)
  assert.notEqual(credentials.accountId, c.id)
  assert.equal(iamKeys.length, 2)
})

test('an invalidated in-flight IAM resolution cannot overwrite a newer manual switch', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  globalThis.fetch = async (_input, init) => {
    const ak = accessKey(init)
    iamKeys.push(ak)
    if (ak === a.ak) await gate
    return temporary(ak)
  }
  const credentials = provider()
  const old = credentials.resolve()
  await new Promise(setImmediate)
  await setActiveAccount(b.id)
  credentials.invalidate()
  const current = await credentials.resolve()
  release()
  assert.equal(current.accountId, b.id)
  assert.equal((await old).accountId, b.id)
  assert.equal(credentials.accountId, b.id)
  assert.equal((await credentials.resolve()).accountId, b.id)
  assert.deepEqual(iamKeys, [a.ak, b.ak])
})

test('an in-flight IAM resolution observes a manual switch even without invalidation', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  globalThis.fetch = async (_input, init) => {
    const ak = accessKey(init)
    iamKeys.push(ak)
    if (ak === a.ak) await gate
    return temporary(ak)
  }
  const credentials = provider()
  const pending = credentials.resolve()
  await new Promise(setImmediate)
  await setActiveAccount(b.id)
  release()
  assert.equal((await pending).accountId, b.id)
  assert.equal(credentials.accountId, b.id)
  assert.deepEqual(iamKeys, [a.ak, b.ak])
})

test('rotating a saved secret replaces its cached credential', async () => {
  const credentials = provider()
  await credentials.resolve()
  await addAccount({ ak: a.ak, sk: 'rotated-test-secret' })
  await credentials.resolve()
  assert.deepEqual(iamKeys, [a.ak, a.ak])
})

test('disposing an in-flight provider prevents its credential from becoming current', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  globalThis.fetch = async (_input, init) => {
    const ak = accessKey(init)
    await gate
    return temporary(ak)
  }
  const credentials = provider()
  const pending = credentials.resolve()
  const rejected = assert.rejects(pending, /凭证服务已停止/)
  credentials.dispose()
  release()
  await rejected
  assert.equal(credentials.accountId, undefined)
})
