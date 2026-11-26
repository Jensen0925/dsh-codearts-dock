/** Activity persistence, ordering and the strict boundary around caller data. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { ACTIVITY_LIMIT, createActivityStore } from '../src/activity.ts'

const scratch = mkdtempSync(join(tmpdir(), 'dca-activity-'))

test('activity history reloads newest first with private permissions and detached reads', async () => {
  const path = join(scratch, 'reload', 'activity.json')
  const store = createActivityStore({ path })
  assert.deepEqual(store.read(), [])
  assert.equal(await store.record('account.add', 'success', { added: 1 }), true)
  assert.equal(await store.record('catalog.refresh', 'warning', { reason: 'network' }), true)
  assert.deepEqual(store.read().map((record) => record.category), ['models', 'account'])
  assert.deepEqual(createActivityStore({ path }).read(), store.read())
  assert.equal(statSync(path).mode & 0o777, 0o600)
  const copy = store.read()
  copy[0].details.reason = 'CHANGED'
  copy.splice(1)
  assert.equal(store.read().length, 2)
  assert.equal(store.read()[0].details.reason, 'network')
})

test('concurrent appends and clear execute in invocation order and persist that order', async () => {
  const path = join(scratch, 'concurrent.json')
  const store = createActivityStore({ path })
  const operations = [
    store.record('account.add'), store.record('account.update'), store.clear(),
    store.record('models.save', 'success', { enabled: 2 }),
    store.record('checkin.manual', 'success', { claimed: 1 }),
  ]
  assert.ok((await Promise.all(operations)).every(Boolean))
  assert.deepEqual(store.read().map((record) => record.action), ['checkin.manual', 'models.save'])
  assert.deepEqual(createActivityStore({ path }).read(), store.read())
  assert.equal(await store.clear(), true)
  assert.deepEqual(createActivityStore({ path }).read(), [])
})

test('history retains only the latest 200 records across concurrent writes and reload', async () => {
  const path = join(scratch, 'bounded.json')
  const store = createActivityStore({ path })
  await Promise.all(Array.from({ length: ACTIVITY_LIMIT + 5 }, (_, total) => store.record('account.check', 'success', { total })))
  const records = store.read()
  assert.equal(records.length, ACTIVITY_LIMIT)
  assert.equal(new Set(records.map((record) => record.id)).size, ACTIVITY_LIMIT)
  assert.equal(records[0].details.total, ACTIVITY_LIMIT + 4)
  assert.equal(records.at(-1)?.details.total, 5)
  assert.deepEqual(createActivityStore({ path }).read(), records)
})

test('unknown actions, raw reasons, sensitive properties and malformed counts never persist', async () => {
  const path = join(scratch, 'sanitized.json')
  const store = createActivityStore({ path })
  const sensitive = 'OFFLINE_SENSITIVE_KEY'
  const details = {
    added: 0, updated: 2, total: -1, failed: Infinity, claimed: 1.5,
    enabled: Number.MAX_SAFE_INTEGER + 1, skipped: '3', available: 1,
    reason: sensitive, ak: sensitive, sk: sensitive, token: sensitive,
    accountName: sensitive, accountId: sensitive, gateway: sensitive,
    path: sensitive, error: sensitive,
  }
  assert.equal(await store.record('account.import', 'success', details), true)
  assert.equal(await store.record(sensitive), false)
  assert.equal(await store.record('constructor'), false)
  assert.equal(await store.record('account.add', 'INVALID' as 'success'), false)
  assert.deepEqual(store.read()[0].details, { added: 0, updated: 2, available: 1 })
  assert.equal(readFileSync(path, 'utf8').includes(sensitive), false)
  await store.record('connection.test', 'error', { reason: 'credentials', failed: 1 })
  assert.deepEqual(store.read()[0].details, { failed: 1, reason: 'credentials' })
})

test('loading filters malformed records and caller fields and rejects corrupt or oversized files', () => {
  const path = join(scratch, 'read-validation.json')
  const valid = { id: randomUUID(), at: 1, action: 'account.check', category: 'account', status: 'warning', details: { reason: 'network', total: 3, ak: 'OFFLINE_SECRET' } }
  writeFileSync(path, JSON.stringify([
    null, valid, { ...valid, id: 'RAW_ACCOUNT_NAME' },
    { ...valid, id: randomUUID(), action: 'arbitrary' },
    { ...valid, id: randomUUID(), category: 'system' },
    { ...valid, id: randomUUID(), status: 'invalid' },
    { ...valid, id: randomUUID(), at: -1 },
    { ...valid, id: randomUUID(), at: 8_640_000_000_000_001 },
    { ...valid, id: randomUUID(), details: [] }, valid,
  ]))
  assert.deepEqual(createActivityStore({ path }).read(), [{ ...valid, details: { total: 3, reason: 'network' } }])
  writeFileSync(path, '{broken')
  assert.deepEqual(createActivityStore({ path }).read(), [])
  writeFileSync(path, ' '.repeat(256 * 1024 + 1))
  assert.deepEqual(createActivityStore({ path }).read(), [])
})

test('storage failures resolve safely and later writes still work', async () => {
  const parent = join(scratch, 'blocked-parent')
  const path = join(parent, 'activity.json')
  writeFileSync(parent, 'a file cannot contain an activity file')
  const store = createActivityStore({ path })
  assert.equal(await store.record('account.add'), false)
  assert.equal(await store.clear(), false)
  assert.deepEqual(store.read(), [])
  rmSync(parent)
  assert.equal(await store.record('account.add'), true)
  assert.equal(createActivityStore({ path }).read().length, 1)
})

test('cleanup activity scratch data', () => {
  rmSync(scratch, { recursive: true, force: true })
})
