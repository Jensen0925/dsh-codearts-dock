/**
 * Offline tests for the account store and the daily check-in guard.
 *
 * Both are file-backed, so every case runs against a scratch directory: these
 * must never touch the real account file.
 */

import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const check = (name: string, fn: () => void | Promise<void>) => test(name, fn)

// Each module reads its directory at import time, so point it at a scratch home
// before importing.
const scratch = mkdtempSync(join(tmpdir(), 'dca-accounts-'))
process.env.APPDATA = scratch
process.env.XDG_CONFIG_HOME = scratch
// The store falls back to the legacy single-pair file when the configured one
// is absent. Without redirecting it too, these tests would read the developer's
// real credential and every isolation assertion would be meaningless.
process.env.DSH_CONNECT_CODEARTS_LEGACY_CREDENTIAL = join(scratch, 'legacy-credentials.json')
// Keep the runner's timezone: the day-key checks below compare against the
// local calendar and must remain valid in UTC and on the other side of the date line.

// Import paths FIRST so its module-level constants are evaluated against the
// scratch home. Importing it through another module would evaluate it before
// the environment was redirected, and the tests would then run against the real
// config directory.
const { CONFIG_DIR } = await import('../src/paths.ts')
type Account = { id: string; ak: string; sk: string; label?: string; accountName?: string }
type AccountStore = { version: number; activeId: string | null; accounts: Account[] }
const accountModule = await import('../src/accounts.ts')
const accounts = {
  ...accountModule,
  // The serialized wrapper in accounts.ts currently erases the result type;
  // keep the contract used by the store tests explicit at this module boundary.
  addAccount: accountModule.addAccount as unknown as (input: { ak: string; sk: string; label?: string }) => Promise<{
    account: Account
    added: boolean
    store: AccountStore
  }>,
}
type Benefit = {
  campaignId: number
  title: string
  type: string
  claimable: boolean
  pendingTotalAmount: number
  benefitAmount: number
  benefitUnit: string
  status: string | null
  description: string | null
  extra: { triggerMode: string; endTime?: string }
}
type CheckinCampaign = { key: string; label?: string; claimed: boolean; reason?: string }
type CheckinApi = {
  dailyCampaignOf(items: Array<{ campaignId: number; title?: string }>): { campaignId: number; title?: string } | undefined
  readCheckin(client: unknown, options: { now?: Date; accountId?: string }): Promise<{
    campaigns: Array<{ campaignId: number; label: string; claimable: boolean }>
    unavailable: Array<{ campaignId: number; reason: string; triggerMode?: string }>
    claimable: boolean
    amount: number
  }>
  claimDaily(client: unknown, options: { accountId: string; now?: Date }): Promise<{
    claimed: boolean
    amount: number
    campaigns: CheckinCampaign[]
    reasons: string[]
  }>
  claimAllDaily(options: { targets: Array<{ id: string; client: unknown }>; now?: Date }): Promise<{
    attempted: number
    claimed: number
    failures: Array<{ id: string }>
  }>
  todaySummary(accounts: Array<{ id: string; label: string }>, now?: Date): { total: number; done: number; pending: number }
  todayKey(now?: Date): string
  readCheckinState(): { accounts: Record<string, Record<string, { claimed: boolean; amount?: number }>> }
  attemptedToday(state: unknown, accountId: string, campaignId: number): boolean
  CHECKIN_STATE_PATH: string
}
const checkin = await import('../src/checkin.ts') as unknown as CheckinApi

await check('config paths stay inside the scratch home', () => {
  assert.ok(CONFIG_DIR.startsWith(scratch), `config dir escaped the scratch home: ${CONFIG_DIR}`)
})

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

/**
 * A gateway stub shaped like the live welfare list, with each campaign's
 * claimable flag flipping independently on its first claim.
 *
 * The roster mirrors what the real endpoint returned: two daily campaigns, a
 * one-off Skill registration reward, two student-only campaigns that are not
 * claimable without certification, and an auto-granted new-user reward that
 * must never be posted to the claim endpoint.
 */
type GatewayState = { claims: number[]; claimable: Record<number, boolean> }
function fakeGateway(overrides: Partial<GatewayState> = {}) {
  const state: GatewayState = {
    claims: [],
    claimable: { 34: true, 40: true, 42: true, 39: false, 2: false, 4: false },
    ...overrides,
  }
  const items = (): Benefit[] => [
    { campaignId: 42, title: 'Skill创新赛报名礼', type: 'USER_LOGIN', claimable: state.claimable[42],
      pendingTotalAmount: state.claimable[42] ? 2000 : 0, benefitAmount: 2000, benefitUnit: 'CREDIT',
      status: state.claimable[42] ? 'ELIGIBLE' : 'CONFIRMED', description: '报名参赛一次性领取2000积分',
      extra: { triggerMode: 'MANUAL_CLAIM', endTime: '2026-12-05T16:00:00Z' } },
    { campaignId: 40, title: 'Skill创新赛每日签到礼', type: 'USER_LOGIN', claimable: state.claimable[40],
      pendingTotalAmount: state.claimable[40] ? 1000 : 0, benefitAmount: 1000, benefitUnit: 'CREDIT',
      status: state.claimable[40] ? 'ELIGIBLE' : 'CONFIRMED', description: '参加Skill创新赛，每日签到领取1000积分',
      extra: { triggerMode: 'MANUAL_CLAIM', endTime: '2026-12-05T16:00:00Z' } },
    { campaignId: 39, title: '2026年学生专属福利', type: 'STUDENT_CERTIFIED', claimable: false,
      pendingTotalAmount: 0, benefitAmount: 5000, benefitUnit: 'CREDIT', status: null,
      description: '在校大学生每月可领取 5000 积分', extra: { triggerMode: 'MANUAL_CLAIM' } },
    { campaignId: 34, title: '每日签到领100积分', type: 'USER_LOGIN', claimable: state.claimable[34],
      pendingTotalAmount: state.claimable[34] ? 100 : 0, benefitAmount: 100, benefitUnit: 'CREDIT',
      status: state.claimable[34] ? 'ELIGIBLE' : 'CONFIRMED', description: null,
      extra: { triggerMode: 'MANUAL_CLAIM', endTime: '2026-12-31T15:59:59Z' } },
    { campaignId: 4, title: '新用户注册送 4000 积分', type: 'NEW_USER_REGISTER', claimable: false,
      pendingTotalAmount: 0, benefitAmount: 4000, benefitUnit: 'CREDIT', status: 'CLAIMED',
      description: null, extra: { triggerMode: 'AUTO_GRANT' } },
    { campaignId: 2, title: '学生认证领积分', type: 'STUDENT_CERTIFIED', claimable: false,
      pendingTotalAmount: 0, benefitAmount: 4000, benefitUnit: 'CREDIT', status: null,
      description: '完成学生认证领取 4000 积分', extra: { triggerMode: 'MANUAL_CLAIM' } },
  ]
  const client = {
    getJson: async () => ({ data: { items: items() } }),
    postJson: async (_path, body) => {
      state.claims.push(body.campaignId)
      state.claimable[body.campaignId] = false
      return { ok: true }
    },
  }
  return { client, state }
}

await check('the daily campaign is still matched by id, then by title', () => {
  const items = [{ campaignId: 40, title: 'Skill创新赛每日签到礼' }, { campaignId: 34, title: '每日签到领100积分' }]
  const byId = checkin.dailyCampaignOf(items)
  assert.ok(byId)
  assert.equal(byId.campaignId, 34)
  const byTitle = checkin.dailyCampaignOf([{ campaignId: 99, title: '每日签到礼' }])
  assert.ok(byTitle)
  assert.equal(byTitle.campaignId, 99)
})

await check('eligible campaigns are discovered from the live list, not hardcoded', async () => {
  const { client } = fakeGateway()
  const state = await checkin.readCheckin(client, { now: new Date('2026-11-18T10:00:00+08:00'), accountId: 'acct-read' })
  // Only the three MANUAL_CLAIM campaigns the account can actually claim.
  assert.deepEqual(state.campaigns.map((c) => c.campaignId), [34, 40, 42])
  assert.equal(state.claimable, true)
  assert.equal(state.amount, 3100, '100 + 1000 + 2000 are all still on the table')
  const skill = state.campaigns.find((campaign) => campaign.campaignId === 40)
  assert.ok(skill)
  assert.equal(skill.label, 'Skill创新赛每日签到礼')
  assert.equal(skill.claimable, true)
  // Daily campaigns lead; the bigger one-off follows them.
  assert.equal(state.campaigns[0].campaignId, 34)
})

await check('student-only and auto-granted campaigns are never claimed', async () => {
  const { client, state: gateway } = fakeGateway()
  await checkin.claimDaily(client, { accountId: 'acct-guard', now: new Date('2026-11-18T10:00:00+08:00') })
  // 39 and 2 need student certification; 4 is AUTO_GRANT, not a manual claim.
  assert.ok(!gateway.claims.includes(39), 'an uncertified student offer must not be claimed')
  assert.ok(!gateway.claims.includes(2), 'an uncertified student offer must not be claimed')
  assert.ok(!gateway.claims.includes(4), 'an auto-granted campaign must never be posted')
  assert.deepEqual(gateway.claims, [34, 40, 42])
})

await check('ineligible campaigns are reported so the UI can explain them', async () => {
  const { client } = fakeGateway()
  const state = await checkin.readCheckin(client, { now: new Date('2026-11-18T10:00:00+08:00'), accountId: 'acct-why' })
  assert.equal(state.unavailable.length, 3)
  const ids = state.unavailable.map((item) => item.campaignId)
  assert.deepEqual(ids, [39, 4, 2])
  const auto = state.unavailable.find((item) => item.campaignId === 4)
  assert.ok(auto)
  assert.equal(auto.triggerMode, 'AUTO_GRANT')
})

await check('an excluded campaign says why, not just that it is excluded', async () => {
  // Upstream marks a claimed reward CONFIRMED, and the local record knows too;
  // both mean "done", which is different from "needs certification".
  const { client } = fakeGateway()
  const clock = new Date('2026-11-18T10:00:00+08:00')
  await checkin.claimDaily(client, { accountId: 'acct-reason', now: clock })
  const after = await checkin.readCheckin(client, { now: clock, accountId: 'acct-reason' })
  // Everything claimable was just claimed, so all six report an exclusion.
  const byId = new Map(after.unavailable.map((item) => [item.campaignId, item.reason] as const))
  assert.equal(byId.get(4), 'auto', 'an auto-granted reward is never a manual claim')
  assert.equal(byId.get(39), 'condition', 'student offers need certification')
  assert.equal(byId.get(2), 'condition')
  // Claimed this run: the local record explains it.
  for (const id of [34, 40, 42]) assert.equal(byId.get(id), 'claimed', `campaign ${id} was just claimed`)
})

await check('a campaign claimed elsewhere still reads as already claimed', async () => {
  // No local record: the upstream CONFIRMED status has to carry the meaning.
  const { client } = fakeGateway({ claimable: { 34: false, 40: false, 42: false, 39: false, 2: false, 4: false } })
  const state = await checkin.readCheckin(client, { now: new Date('2026-11-18T10:00:00+08:00'), accountId: 'acct-fresh' })
  const byId = new Map(state.unavailable.map((item) => [item.campaignId, item.reason] as const))
  assert.equal(byId.get(42), 'claimed')
  assert.equal(byId.get(39), 'condition', 'a campaign with no status is a prerequisite gap')
})

await check('a claim is made once per campaign and never repeated the same day', async () => {
  const { client, state: gateway } = fakeGateway()
  const day = new Date('2026-11-18T10:00:00+08:00')
  const id = 'acct-daily'

  const first = await checkin.claimDaily(client, { accountId: id, now: day })
  assert.equal(first.claimed, true)
  assert.equal(first.amount, 3100, 'all three claimable entitlements granted')
  assert.deepEqual(gateway.claims, [34, 40, 42], 'one write per campaign, in display order')

  const second = await checkin.claimDaily(client, { accountId: id, now: day })
  assert.equal(second.claimed, false)
  assert.equal(gateway.claims.length, 3, 'a same-day retry must not reach upstream')
})

await check('one campaign already claimed does not block the others', async () => {
  const { client, state: gateway } = fakeGateway({ claimable: { 34: false, 40: true, 42: true, 39: false, 2: false, 4: false } })
  const day = new Date('2026-11-18T10:00:00+08:00')
  const result = await checkin.claimDaily(client, { accountId: 'acct-half', now: day })
  assert.equal(result.claimed, true)
  assert.equal(result.amount, 3000, '1000 + 2000 still claimable')
  assert.deepEqual(gateway.claims, [40, 42])
})

await check('the record is per account, not global', async () => {
  const { client, state: gateway } = fakeGateway()
  const day = new Date('2026-11-18T10:00:00+08:00')
  const a = await checkin.claimDaily(client, { accountId: 'acct-a', now: day })
  assert.equal(a.claimed, true)
  // A different account on the same day is a different entitlement.
  gateway.claimable = { 34: true, 40: true, 42: true, 39: false, 2: false, 4: false }
  const b = await checkin.claimDaily(client, { accountId: 'acct-b', now: day })
  assert.equal(b.claimed, true)
  assert.equal(gateway.claims.length, 6, 'three campaigns for each of two accounts')
})

await check('a new day allows a new claim', async () => {
  const { client, state: gateway } = fakeGateway()
  const first = await checkin.claimDaily(client, { accountId: 'acct-day', now: new Date('2026-11-18T10:00:00+08:00') })
  assert.equal(first.claimed, true)
  gateway.claimable = { 34: true, 40: true, 42: true, 39: false, 2: false, 4: false }
  const next = await checkin.claimDaily(client, { accountId: 'acct-day', now: new Date('2026-11-19T10:00:00+08:00') })
  assert.equal(next.claimed, true)
})

await check('nothing claimable upstream means no write at all', async () => {
  const { client, state: gateway } = fakeGateway({ claimable: { 34: false, 40: false, 42: false, 39: false, 2: false, 4: false } })
  const result = await checkin.claimDaily(client, { accountId: 'acct-consumed', now: new Date('2026-11-18T10:00:00+08:00') })
  assert.equal(result.claimed, false)
  assert.equal(gateway.claims.length, 0, 'the write endpoint must not be called')
  assert.match(result.reasons[0], /没有可领取/)
})

await check('an empty welfare list is reported, not claimed blindly', async () => {
  const client = { getJson: async () => ({ data: { items: [] } }), postJson: async () => { throw new Error('must not be called') } }
  const result = await checkin.claimDaily(client, { accountId: 'acct-none', now: new Date('2026-11-18T10:00:00+08:00') })
  assert.equal(result.claimed, false)
  assert.match(result.reasons[0], /没有可领取/)
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

await check('manual batch claims every eligible account and continues after a failure', async () => {
  const first = fakeGateway()
  const second = fakeGateway()
  const now = new Date('2026-11-18T10:00:00+08:00')
  const targets = [
    { id: 'batch-first', client: first.client },
    { id: 'batch-error', client: { getJson: async () => { throw new Error('offline mock error') } } },
    { id: 'batch-second', client: second.client },
  ]
  const result = await checkin.claimAllDaily({ targets, now })
  assert.equal(result.attempted, 3)
  assert.equal(result.claimed, 2, 'the two healthy accounts were claimed')
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0].id, 'batch-error')
  assert.deepEqual(first.state.claims, [34, 40, 42])
  assert.deepEqual(second.state.claims, [34, 40, 42])
  // A second sweep finds nothing left to claim and writes nothing.
  const retry = await checkin.claimAllDaily({ targets: [targets[0], targets[2]], now })
  assert.equal(retry.claimed, 0)
  assert.equal(first.state.claims.length, 3)
  assert.equal(second.state.claims.length, 3)
})
await check('the day key follows the local calendar, not UTC', () => {
  const localDayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  for (const instant of ['2026-11-18T23:30:00+08:00', '2026-11-19T00:30:00+08:00']) {
    const date = new Date(instant)
    assert.equal(checkin.todayKey(date), localDayKey(date))
  }
})

// ── check-in state migration ───────────────────────────────────────────────

await check('an original single-campaign record is lifted onto campaign 34', async () => {
  // The shape shipped before the Skill campaign existed: one bare attempt per
  // account. Treating it as "nothing recorded" would let the 100-credit campaign
  // be claimed twice on upgrade day.
  writeFileSync(
    checkin.CHECKIN_STATE_PATH,
    JSON.stringify({
      accounts: { 'acct-legacy': { day: checkin.todayKey(), at: Date.now(), claimed: true, amount: 100 } },
    }),
  )
  const state = checkin.readCheckinState()
  assert.equal(state.accounts['acct-legacy']['34'].claimed, true)
  assert.equal(state.accounts['acct-legacy']['34'].amount, 100)
  assert.equal(state.accounts['acct-legacy']['40'], undefined, 'campaign 40 was never attempted')
  assert.equal(checkin.attemptedToday(state, 'acct-legacy', 34), true)
  assert.equal(checkin.attemptedToday(state, 'acct-legacy', 40), false)
})

await check('the credits/skill keyed record is lifted onto campaign ids', async () => {
  // The intermediate shape keyed campaigns by name instead of id.
  writeFileSync(
    checkin.CHECKIN_STATE_PATH,
    JSON.stringify({
      accounts: {
        'acct-named': {
          credits: { day: checkin.todayKey(), at: Date.now(), claimed: true, amount: 100 },
          skill: { day: checkin.todayKey(), at: Date.now(), claimed: true, amount: 1000 },
        },
      },
    }),
  )
  const state = checkin.readCheckinState()
  assert.equal(state.accounts['acct-named']['34'].claimed, true)
  assert.equal(state.accounts['acct-named']['40'].claimed, true)
  assert.equal(checkin.attemptedToday(state, 'acct-named', 34), true)
  assert.equal(checkin.attemptedToday(state, 'acct-named', 40), true)
})

await check('a migrated record still blocks a duplicate claim, and only for that campaign', async () => {
  const { client, state: gateway } = fakeGateway()
  writeFileSync(
    checkin.CHECKIN_STATE_PATH,
    JSON.stringify({
      accounts: { 'acct-legacy': { day: checkin.todayKey(), at: Date.now(), claimed: true, amount: 100 } },
    }),
  )
  const result = await checkin.claimDaily(client, { accountId: 'acct-legacy' })
  // Campaign 34 is remembered as claimed today, so the other two are written.
  assert.equal(result.claimed, true)
  assert.equal(result.amount, 3000, '1000 + 2000 still claimable')
  assert.deepEqual(gateway.claims, [40, 42])
  const credits = result.campaigns.find((campaign) => campaign.key === '34')
  assert.ok(credits)
  assert.ok(credits.reason)
  assert.equal(credits.claimed, false)
  assert.match(credits.reason, /今天已经领过/)
})

await check('the record round-trips through disk keyed by campaign id', async () => {
  const { client } = fakeGateway()
  await checkin.claimDaily(client, { accountId: 'acct-roundtrip', now: new Date('2026-11-18T10:00:00+08:00') })
  const raw = JSON.parse(readFileSync(checkin.CHECKIN_STATE_PATH, 'utf8'))
  for (const id of [34, 40, 42]) {
    assert.equal(raw.accounts['acct-roundtrip'][String(id)].claimed, true, `campaign ${id} recorded`)
  }
  assert.equal(raw.accounts['acct-roundtrip']['4'], undefined, 'the auto-granted campaign is never recorded')
  // And the file stays owner-only, like the account store.
  assert.equal(statSync(checkin.CHECKIN_STATE_PATH).mode & 0o777, 0o600)
})

await check('an unreadable record does not crash and does not suppress a claim', async () => {
  writeFileSync(checkin.CHECKIN_STATE_PATH, '{ not json')
  const state = checkin.readCheckinState()
  assert.deepEqual(state.accounts, {})
  const { client } = fakeGateway()
  const result = await checkin.claimDaily(client, { accountId: 'acct-corrupt' })
  assert.equal(result.claimed, true)
})

// Clean up the scratch home.

// ── borrowing the CodeArts client's sign-in ───────────────────────────────
const savedHome = process.env.HOME
const scratchHome = mkdtempSync(join(tmpdir(), 'dca-vscdb-'))
process.env.HOME = scratchHome
{
  const { mkdirSync, writeFileSync } = await import('node:fs')

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
  writeStateDb(scratchHome, blobWith(new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()))
  const { readCodeArtsSignIn } = await import('../src/credentials.ts')
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

}


test('cleanup scratch data', () => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  rmSync(scratch, { recursive: true, force: true })
  rmSync(scratchHome, { recursive: true, force: true })
  assert.equal(existsSync(scratch), false)
  assert.equal(existsSync(scratchHome), false)
})
