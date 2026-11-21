/**
 * Offline tests for the account store and the daily check-in guard.
 *
 * Both are file-backed, so every case runs against a scratch directory: these
 * must never touch the real account file.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const results = []
const check = async (name, fn) => {
  try {
    await fn()
    results.push(`✓ ${name}`)
  } catch (error) {
    results.push(`✗ ${name}\n    ${error.message}`)
    process.exitCode = 1
  }
}

// Each module reads its directory at import time, so point it at a scratch home
// before importing.
const scratch = mkdtempSync(join(tmpdir(), 'dca-accounts-'))
process.env.APPDATA = scratch
process.env.XDG_CONFIG_HOME = scratch
// The store falls back to the legacy single-pair file when the configured one
// is absent. Without redirecting it too, these tests would read the developer's
// real credential and every isolation assertion would be meaningless.
process.env.DSH_CONNECT_CODEARTS_LEGACY_CREDENTIAL = join(scratch, 'legacy-credentials.json')

// Import paths FIRST so its module-level constants are evaluated against the
// scratch home. Importing it through another module would evaluate it before
// the environment was redirected, and the tests would then run against the real
// config directory.
const { CONFIG_DIR } = await import('../src/paths.js')
const accounts = await import('../src/accounts.js')
const checkin = await import('../src/checkin.js')

assert.ok(CONFIG_DIR.startsWith(scratch), `config dir escaped the scratch home: ${CONFIG_DIR}`)

await check('an empty store has no accounts and no active id', () => {
  const store = accounts.readStore()
  assert.equal(store.accounts.length, 0)
  assert.equal(store.activeId, null)
})

await check('a v1 bare pair is migrated into one account', () => {
  const store = accounts.normaliseStore({ ak: 'AKV1PAIR0000000001', sk: 'skv1' })
  assert.equal(store.version, 2)
  assert.equal(store.accounts.length, 1)
  assert.equal(store.accounts[0].ak, 'AKV1PAIR0000000001')
  assert.equal(store.activeId, store.accounts[0].id)
})

await check('the first account added becomes active, later ones do not steal it', async () => {
  const first = await accounts.addAccount({ ak: 'AKONE0000000000001', sk: 'sk1', label: 'one' })
  assert.equal(first.added, true)
  assert.equal(accounts.readStore().activeId, first.account.id)

  await accounts.addAccount({ ak: 'AKTWO0000000000002', sk: 'sk2', label: 'two' })
  assert.equal(accounts.readStore().activeId, first.account.id, 'adding must not switch')
  assert.equal(accounts.readStore().accounts.length, 2)
})

await check('re-adding the same AK updates in place instead of duplicating', async () => {
  const before = accounts.readStore().accounts.length
  const result = await accounts.addAccount({ ak: 'AKONE0000000000001', sk: 'sk1-rotated' })
  assert.equal(result.added, false)
  assert.equal(accounts.readStore().accounts.length, before)
  const updated = accounts.readStore().accounts.find((a) => a.ak === 'AKONE0000000000001')
  assert.equal(updated.sk, 'sk1-rotated')
})

await check('switching the active account persists', async () => {
  const second = accounts.readStore().accounts.find((a) => a.ak === 'AKTWO0000000000002')
  await accounts.setActiveAccount(second.id)
  assert.equal(accounts.activeAccount()?.id, second.id)
})

await check('removing the active account promotes what is left', async () => {
  const active = accounts.activeAccount()
  await accounts.removeAccount(active.id)
  const store = accounts.readStore()
  assert.equal(store.accounts.some((a) => a.id === active.id), false)
  assert.notEqual(store.activeId, null)
  assert.ok(store.accounts.some((a) => a.id === store.activeId))
})

await check('the public view carries no secret', async () => {
  const store = accounts.readStore()
  const views = store.accounts.map((a) => accounts.publicAccount(a, store))
  const text = JSON.stringify(views)
  for (const account of store.accounts) {
    assert.equal(text.includes(account.sk), false, 'a secret leaked into the public view')
  }
  assert.ok(views[0].akMasked.includes('…'))
})

await check('the store file is written owner-only', () => {
  const mode = statSync(join(CONFIG_DIR, 'credentials.json')).mode & 0o777
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`)
})

// ── import parsing ─────────────────────────────────────────────────────────

await check('a Huawei credentials.csv is parsed by header name', () => {
  const text = 'User Name,Access Key Id,Secret Access Key\nhw001,AKCSV1,skCSV1\nhw002,AKCSV2,skCSV2'
  const { accounts: parsed } = accounts.parseImport(text)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].ak, 'AKCSV1')
  assert.equal(parsed[0].sk, 'skCSV1')
  // The user-name column becomes the label, which is friendlier than an AK.
  assert.equal(parsed[0].label, 'hw001')
})

await check('AK,SK lines parse, including a trailing label', () => {
  const { accounts: parsed } = accounts.parseImport('AKLINE1,skLine1\nAKLINE2,skLine2,工作')
  assert.equal(parsed.length, 2)
  assert.equal(parsed[1].label, '工作')
})

await check('tab-separated and JSON payloads parse', () => {
  assert.equal(accounts.parseImport('AKTAB\tskTab').accounts.length, 1)
  const doc = JSON.stringify({ version: 2, activeId: null, accounts: [{ ak: 'AKJSON', sk: 'skJson' }] })
  assert.equal(accounts.parseImport(doc).accounts.length, 1)
})

await check('unusable lines are counted, not silently dropped', () => {
  const { accounts: parsed, skipped } = accounts.parseImport('AKOK,skOk\nnot-a-pair\n\n')
  assert.equal(parsed.length, 1)
  assert.equal(skipped, 1)
})

await check('an export round-trips back through the importer', async () => {
  const text = accounts.exportStore(accounts.readStore())
  const parsed = accounts.parseImport(text)
  assert.equal(parsed.accounts.length, accounts.readStore().accounts.length)
})

// ── check-in ───────────────────────────────────────────────────────────────

/** A gateway stub whose daily campaign flips to claimed after the first claim. */
function fakeGateway() {
  const state = { claimable: true, claims: 0, items: null }
  const client = {
    getJson: async () => ({
      data: {
        items: [
          // A second login campaign runs at the same time: the daily one must
          // still be the one chosen.
          { campaignId: 40, title: 'Skill创新赛每日签到礼', claimable: true, pendingTotalAmount: 1000, benefitUnit: 'CREDIT', status: 'ELIGIBLE' },
          {
            campaignId: 34,
            title: '每日签到领100积分',
            claimable: state.claimable,
            pendingTotalAmount: state.claimable ? 100 : 0,
            benefitUnit: 'CREDIT',
            status: state.claimable ? 'ELIGIBLE' : 'CONSUMED',
          },
        ],
      },
    }),
    postJson: async () => {
      state.claims += 1
      state.claimable = false
      return { ok: true }
    },
  }
  return { client, state }
}

await check('the daily campaign is picked out of a list with other campaigns', () => {
  const items = [{ campaignId: 40, title: 'other' }, { campaignId: 34, title: '每日签到领100积分' }]
  assert.equal(checkin.dailyCampaignOf(items).campaignId, 34)
  // With no id 34, the title hint still finds it.
  assert.equal(checkin.dailyCampaignOf([{ campaignId: 99, title: '每日签到礼' }]).campaignId, 99)
})

await check('a claim is made once and never repeated the same day', async () => {
  const { client, state } = fakeGateway()
  const day = new Date('2026-11-18T10:00:00+08:00')
  const id = 'acct-daily'

  const first = await checkin.claimDaily(client, { accountId: id, now: day })
  assert.equal(first.claimed, true)
  assert.equal(first.amount, 100)
  assert.equal(state.claims, 1, 'must claim exactly once')

  const second = await checkin.claimDaily(client, { accountId: id, now: day })
  assert.equal(second.claimed, false)
  assert.equal(state.claims, 1, 'a same-day retry must not reach upstream')
})

await check('the day record is per account, not global', async () => {
  const { client, state } = fakeGateway()
  const day = new Date('2026-11-18T10:00:00+08:00')
  const a = await checkin.claimDaily(client, { accountId: 'acct-a', now: day })
  assert.equal(a.claimed, true)
  // A different account on the same day is a different entitlement.
  state.claimable = true
  const b = await checkin.claimDaily(client, { accountId: 'acct-b', now: day })
  assert.equal(b.claimed, true)
  assert.equal(state.claims, 2)
})

await check('a new day allows a new claim', async () => {
  const { client, state } = fakeGateway()
  const first = await checkin.claimDaily(client, { accountId: 'acct-day', now: new Date('2026-11-18T10:00:00+08:00') })
  assert.equal(first.claimed, true)
  state.claimable = true
  const next = await checkin.claimDaily(client, { accountId: 'acct-day', now: new Date('2026-11-19T10:00:00+08:00') })
  assert.equal(next.claimed, true)
})

await check('an already-claimed campaign is not sent to the write endpoint', async () => {
  const { client, state } = fakeGateway()
  state.claimable = false
  const result = await checkin.claimDaily(client, { accountId: 'acct-consumed', now: new Date('2026-11-18T10:00:00+08:00') })
  assert.equal(result.claimed, false)
  assert.equal(state.claims, 0, 'the write endpoint must not be called')
})

await check('a missing campaign is reported, not claimed blindly', async () => {
  const client = { getJson: async () => ({ data: { items: [] } }), postJson: async () => { throw new Error('must not be called') } }
  const result = await checkin.claimDaily(client, { accountId: 'acct-none', now: new Date('2026-11-18T10:00:00+08:00') })
  assert.equal(result.claimed, false)
  assert.match(result.reason, /没有每日签到活动/)
})

await check('the today summary counts only claimed accounts', async () => {
  // `acct-daily` was claimed above on this FIXED day. Asking about the real
  // "today" made this pass on 2026-11-18 and fail on 2026-11-19 — a test that
  // only holds on the day it was written. Pin the day instead.
  const day = new Date('2026-11-18T10:00:00+08:00')
  const summary = checkin.todaySummary([
    { id: 'acct-daily', label: 'a' },
    { id: 'acct-never', label: 'b' },
  ], day)
  assert.equal(summary.total, 2)
  assert.equal(summary.done, 1)
  assert.equal(summary.pending, 1)
})

await check('manual batch claims each eligible account once and continues after a failure', async () => {
  const first = fakeGateway()
  const second = fakeGateway()
  const now = new Date('2026-11-18T10:00:00+08:00')
  const targets = [
    { id: 'batch-first', client: first.client },
    { id: 'batch-error', client: { getJson: async () => { throw new Error('offline mock error') } } },
    { id: 'batch-second', client: second.client },
  ]
  const result = await checkin.claimAllDaily({ targets, now })
  assert.equal(result.claimed, 2)
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].id, 'batch-error')
  assert.equal(first.state.claims, 1)
  assert.equal(second.state.claims, 1)
  const retry = await checkin.claimAllDaily({ targets: [targets[0], targets[2]], now })
  assert.equal(retry.skipped, 2)
  assert.equal(retry.claimed, 0)
  assert.equal(first.state.claims, 1)
  assert.equal(second.state.claims, 1)
})

await check('the day key follows the local calendar, not UTC', () => {
  // 23:30 in +08:00 is still the 18th locally even though UTC has rolled over.
  assert.equal(checkin.todayKey(new Date('2026-11-18T23:30:00+08:00')), '2026-11-18')
  assert.equal(checkin.todayKey(new Date('2026-11-19T00:30:00+08:00')), '2026-11-19')
})

// Clean up the scratch home.
rmSync(scratch, { recursive: true, force: true })
assert.equal(existsSync(scratch), false)

// ── borrowing the CodeArts client's sign-in ───────────────────────────────
{
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  /**
   * Build a stand-in state.vscdb: SQLite noise with the sign-in blob embedded,
   * which is what the real file looks like to a string reader.
   */
  const writeStateDb = (home, blob) => {
    const dir = join(home, '.config', 'codearts-agent', 'User', 'globalStorage')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'state.vscdb'), blob)
  }

  const blobWith = (expiresAt) =>
    'SQLite format 3\u0000' +
    'x'.repeat(300) +
    '{"id":"huawei-cloud-authentication","originData":{"accessKey":"AKBORROW1",' +
    '"secretKey":"skBorrow","securityToken":"tokBorrow","expiresAt":"' +
    expiresAt +
    '","account":{"label":"borrowed"}}}' +
    '\u0000'.repeat(200) +
    'junk { not json }'

  // `readCodeArtsSignIn` resolves candidates through `homedir()`, which caches
  // the first HOME it sees, so point HOME at a scratch dir before importing.
  const scratchHome = mkdtempSync(join(tmpdir(), 'dca-vscdb-'))
  const savedHome = process.env.HOME
  process.env.HOME = scratchHome

  writeStateDb(scratchHome, blobWith(new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()))
  const { readCodeArtsSignIn } = await import('../src/credentials.js')
  const borrowed = readCodeArtsSignIn()

  await check('a live sign-in blob is borrowed from the client state database', () => {
    assert.ok(borrowed !== null, 'the credential should be found')
    assert.equal(borrowed.key.ak, 'AKBORROW1')
    assert.equal(borrowed.key.sk, 'skBorrow')
    assert.equal(borrowed.key.securityToken, 'tokBorrow')
    assert.equal(borrowed.key.account, 'borrowed')
    assert.ok(borrowed.where.endsWith('state.vscdb'), 'reports the file it came from')
  })

  // A token about to die must NOT be adopted: it would fail the first request,
  // and the next source down might still work.
  await check('a nearly expired sign-in blob is skipped, not adopted', () => {
    writeStateDb(scratchHome, blobWith(new Date(Date.now() + 60 * 1000).toISOString()))
    assert.equal(readCodeArtsSignIn(), null)
  })

  // The anchor is what makes reading a binary file safe: without it there is no
  // credential, even when the field names appear elsewhere in the file.
  await check('a database without the sign-in anchor yields nothing', () => {
    writeStateDb(scratchHome, 'SQLite\u0000{"accessKey":"x","secretKey":"y","securityToken":"z"}')
    assert.equal(readCodeArtsSignIn(), null)
  })

  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
}

console.log(results.join('\n'))
if (process.exitCode) console.log('\naccounts: some checks failed')
else console.log('\naccounts: all checks passed')
