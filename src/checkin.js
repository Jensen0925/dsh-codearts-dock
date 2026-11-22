/**
 * Welfare check-in.
 *
 * The gateway's welfare list is not a fixed set of daily campaigns. Reading it
 * live (November 2026) showed six campaigns of four different kinds:
 *
 *   - 34 每日签到领100积分        USER_LOGIN,        MANUAL_CLAIM, 100/day
 *   - 40 Skill创新赛每日签到礼    USER_LOGIN,        MANUAL_CLAIM, 1000/day
 *   - 42 Skill创新赛报名礼        USER_LOGIN,        MANUAL_CLAIM, 2000 once
 *   - 39 2026年学生专属福利       STUDENT_CERTIFIED, MANUAL_CLAIM, 5000/month
 *   - 2  学生认证领积分           STUDENT_CERTIFIED, MANUAL_CLAIM, 4000 once
 *   - 4  新用户注册送 4000 积分   NEW_USER_REGISTER, AUTO_GRANT
 *
 * So the eligible set is discovered from the list rather than hardcoded: a
 * hardcoded id goes stale the moment the operator renumbers a campaign, and a
 * hardcoded allowlist silently misses new ones. Discovery is fenced by the
 * rules the endpoint itself implies:
 *
 *   - `claimable === true` is required. It is the upstream's own word that a
 *     claim would succeed for this account right now, and it is false for
 *     campaigns whose prerequisites (student certification) are unmet;
 *   - `triggerMode === 'MANUAL_CLAIM'` is required. `AUTO_GRANT` campaigns are
 *     granted by the system and must never be posted to the claim endpoint;
 *   - one calendar day per campaign, tracked locally, so a refresh loop cannot
 *     double-claim even when upstream is ambiguous.
 *
 * Rewards are one-off as well as daily, so the local record is a *claim* record
 * keyed by campaign, not by day: "claimed 2026-11-22" and "claimed 2026-10-01"
 * both mean a once-only reward is gone, while a daily campaign becomes eligible
 * again on the next day. The distinction is made by re-reading upstream each
 * time rather than by assuming which is which.
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CONFIG_DIR } from './paths.js'
import { claimBenefit, listBenefits } from './account.js'

/** File holding the per-account claim record. */
export const CHECKIN_STATE_PATH = join(CONFIG_DIR, 'checkin-state.json')

/**
 * The two long-running daily campaigns.
 *
 * Used only to order and caption the list so the familiar ones stay first; the
 * eligible set itself comes from {@link claimableCampaigns}. An id that vanishes
 * upstream simply stops matching.
 */
const KNOWN_DAILY_CAMPAIGNS = [
  { campaignId: 34, label: '每日签到领100积分', hint: '每日签到' },
  { campaignId: 40, label: 'Skill创新赛每日签到礼', hint: 'Skill创新赛' },
]

/** Backwards-compatible name for the primary daily campaign. */
const DAILY_CAMPAIGN_HINT = KNOWN_DAILY_CAMPAIGNS[0].hint

/**
 * @typedef {object} CheckinAttempt
 * @property {string} day local date key of the attempt, `YYYY-MM-DD`.
 * @property {number} at epoch milliseconds of the attempt.
 * @property {boolean} claimed whether the claim succeeded.
 * @property {number} [amount] credits granted.
 * @property {string} [error] why it did not succeed.
 */

/**
 * @typedef {object} CheckinState
 * @property {Record<string, Record<string, CheckinAttempt>>} accounts
 *   account id → campaign key → attempt. Older records stored a single attempt
 *   per account, or keyed campaigns by `credits` / `skill`; `readCheckinState`
 *   lifts both onto their current campaign id.
 */

/** The local calendar day key, `YYYY-MM-DD`, in the user's own zone. */
export function todayKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** The record key for a campaign id. Ids are stable; titles are not. */
export function campaignKey(campaignId) {
  return String(campaignId)
}

/** Whether a stored entry is a bare attempt (the pre-discovery shape). */
function isAttempt(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.day === 'string' &&
    typeof value.claimed === 'boolean' &&
    value.campaignId === undefined &&
    value.key === undefined
  )
}

/**
 * Normalise one account's record to `campaignKey → attempt`.
 *
 * Two older shapes exist and both are lifted, because forgetting a claim is
 * what causes a second real claim:
 *
 *   - a single bare attempt per account (the original one-campaign code), which
 *     belonged to campaign 34;
 *   - campaign keys `credits` / `skill` (the two-campaign code), which map to
 *     campaign 34 and campaign 40.
 *
 * Anything else is kept as-is when it already looks like a campaign-id key.
 */
function normaliseAccountEntry(entry) {
  if (entry === null || typeof entry !== 'object') return {}
  if (isAttempt(entry)) return { [campaignKey(34)]: entry }
  const result = {}
  for (const [key, attempt] of Object.entries(entry)) {
    if (!isAttempt(attempt)) continue
    if (key === 'credits') result[campaignKey(34)] = attempt
    else if (key === 'skill') result[campaignKey(40)] = attempt
    else result[key] = attempt
  }
  return result
}

/** Read the record; a missing or corrupt file is an empty record. */
export function readCheckinState() {
  if (!existsSync(CHECKIN_STATE_PATH)) return { accounts: {} }
  try {
    const parsed = JSON.parse(readFileSync(CHECKIN_STATE_PATH, 'utf8'))
    if (parsed && typeof parsed === 'object' && typeof parsed.accounts === 'object') {
      const accounts = {}
      for (const [accountId, entry] of Object.entries(parsed.accounts)) {
        const normalised = normaliseAccountEntry(entry)
        if (Object.keys(normalised).length > 0) accounts[accountId] = normalised
      }
      return { accounts }
    }
  } catch {
    // Fall through: an unreadable record means "no attempts recorded", and the
    // upstream `claimable` flag still prevents a blind claim.
  }
  return { accounts: {} }
}

/** Write the record atomically. */
async function writeCheckinState(state) {
  await mkdir(CONFIG_DIR, { recursive: true })
  const temp = `${CHECKIN_STATE_PATH}.tmp`
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temp, CHECKIN_STATE_PATH)
}

/** The attempt recorded for one account and campaign today, if any. */
export function attemptToday(state, accountId, campaignId, now = new Date()) {
  const entry = state.accounts[accountId]?.[campaignKey(campaignId)]
  return entry !== undefined && entry.day === todayKey(now) ? entry : undefined
}

/** Whether this account already attempted a claim for a campaign today. */
export function attemptedToday(state, accountId, campaignId, now = new Date()) {
  return attemptToday(state, accountId, campaignId, now) !== undefined
}

/**
 * Whether a campaign may be posted to the claim endpoint.
 *
 * Both guards are the endpoint's own contract, not a policy invented here:
 * `AUTO_GRANT` campaigns are system-granted and `claimable` already folds in
 * unmet prerequisites such as student certification.
 * @param {object} item a campaign from {@link listBenefits}.
 * @returns {boolean} whether claiming it is allowed.
 */
export function isManuallyClaimable(item) {
  return item?.claimable === true && item?.triggerMode !== 'AUTO_GRANT'
}

/**
 * The campaigns worth showing and claiming for this account, best first.
 *
 * Ordering keeps the familiar daily campaigns on top and the larger one-off
 * rewards after them, so the list reads the way the operator's page does.
 * @param {Array<object>} items campaigns from {@link listBenefits}.
 * @returns {Array<object>} the eligible campaigns.
 */
export function claimableCampaigns(items) {
  const list = Array.isArray(items) ? items : []
  const dailyOrder = new Map(KNOWN_DAILY_CAMPAIGNS.map((campaign, index) => [campaign.campaignId, index]))
  return list
    .filter((item) => isManuallyClaimable(item))
    .sort((a, b) => {
      const rankA = dailyOrder.get(a.campaignId)
      const rankB = dailyOrder.get(b.campaignId)
      // Known daily campaigns first, in their declared order.
      if (rankA !== undefined && rankB !== undefined) return rankA - rankB
      if (rankA !== undefined) return -1
      if (rankB !== undefined) return 1
      // Then the rest by value, so the biggest reward is never buried.
      return (b.pendingAmount || b.amount || 0) - (a.pendingAmount || a.amount || 0)
    })
}

/**
 * The primary daily campaign in a benefit list.
 *
 * Kept for callers that only ask about the classic daily bonus.
 * @param {Array<object>} items campaigns from {@link listBenefits}.
 * @returns {object|undefined} the daily campaign.
 */
export function dailyCampaignOf(items) {
  const list = Array.isArray(items) ? items : []
  return (
    list.find((item) => item.campaignId === 34) ??
    list.find((item) => typeof item.title === 'string' && item.title.includes(DAILY_CAMPAIGN_HINT))
  )
}

/**
 * Read one account's claim state for every eligible campaign, claiming nothing.
 *
 * @param {import('./gateway.js').MadaoClient} client an authenticated client.
 * @param {object} [options] read options.
 * @param {Date} [options.now] clock, for tests.
 * @param {CheckinState} [options.state] the record to consult.
 * @param {string} [options.accountId] whose record to consult.
 * @returns {Promise<object>} aggregate state plus the per-campaign breakdown.
 */
export async function readCheckin(client, options = {}) {
  const now = options.now ?? new Date()
  const state = options.state ?? readCheckinState()

  let items
  try {
    items = await listBenefits(client)
  } catch (error) {
    return failedRead(`读取福利列表失败：${error?.message ?? error}`)
  }

  const eligible = claimableCampaigns(items)
  const campaigns = eligible.map((item) => {
    const attempt = options.accountId ? attemptToday(state, options.accountId, item.campaignId, now) : undefined
    // The upstream flag is authoritative about *today*; the local record only
    // covers the window between a successful claim and upstream catching up.
    const locallyClaimed = attempt?.claimed === true
    return {
      key: campaignKey(item.campaignId),
      campaignId: item.campaignId,
      label: item.title,
      type: item.type,
      description: item.description,
      available: true,
      claimable: !locallyClaimed,
      status: item.status ?? null,
      amount: item.pendingAmount || item.amount || 0,
      title: item.title,
      claimedToday: locallyClaimed,
      expireAt: item.expireAt,
    }
  })

  // Everything left on the table, so the pool row matches the button beside it.
  const pendingTotal = campaigns.reduce((sum, campaign) => sum + (campaign.claimable ? campaign.amount : 0), 0)
  return {
    available: campaigns.length > 0,
    claimable: campaigns.some((campaign) => campaign.claimable),
    claimedToday: campaigns.length > 0 && campaigns.every((campaign) => campaign.claimedToday),
    amount: pendingTotal,
    title: campaigns[0]?.title ?? null,
    campaigns,
    // Campaigns that exist but are not claimable right now. Surfaced so the UI
    // can say why they are missing instead of silently dropping them.
    unavailable: (Array.isArray(items) ? items : [])
      .filter((item) => !isManuallyClaimable(item))
      .map((item) => ({
        campaignId: item.campaignId,
        label: item.title,
        status: item.status ?? null,
        triggerMode: item.triggerMode,
        reason: exclusionReason(item, state, options.accountId, now),
      })),
  }
}

/**
 * Why a campaign is not in the claimable set.
 *
 * The distinction matters to the reader: "already claimed" is done and needs no
 * action, while "needs a prerequisite" is something they could still unlock.
 * @param {object} item a campaign from the upstream list.
 * @param {CheckinState} state the local claim record.
 * @param {string} [accountId] whose record to consult.
 * @param {Date} now clock, for tests.
 * @returns {'claimed'|'auto'|'condition'} the reason.
 */
function exclusionReason(item, state, accountId, now) {
  // A system-granted campaign is never a manual claim, whatever its status.
  if (item.triggerMode === 'AUTO_GRANT') return 'auto'
  const attempt = accountId ? attemptToday(state, accountId, item.campaignId, now) : undefined
  if (attempt?.claimed === true) return 'claimed'
  // `CONFIRMED` / `CLAIMED` / `CONSUMED` upstream all mean the reward is gone.
  if (['CONFIRMED', 'CLAIMED', 'CONSUMED'].includes(item.status)) return 'claimed'
  return 'condition'
}

/** Every campaign failed to read; keep the same shape so callers do not branch. */
function failedRead(reason) {
  return {
    available: false,
    claimable: false,
    claimedToday: false,
    amount: 0,
    title: null,
    reason,
    campaigns: [],
    unavailable: [],
  }
}

/**
 * Claim every eligible campaign for one account, once each.
 *
 * Campaigns are independent entitlements: one already claimed, or one that
 * fails, must not stop the rest.
 *
 * @param {import('./gateway.js').MadaoClient} client an authenticated client.
 * @param {object} options claim options.
 * @param {string} options.accountId whose record to update.
 * @param {Date} [options.now] clock, for tests.
 * @param {boolean} [options.force] claim even when the local record says it was attempted today (never used by the batch action).
 * @returns {Promise<{claimed: boolean, amount: number, reasons: string[], campaigns: Array<{key: string, claimed: boolean, amount?: number, reason?: string}>}>} the outcome.
 */
export async function claimDaily(client, options) {
  const now = options.now ?? new Date()
  const state = readCheckinState()

  let items
  try {
    items = await listBenefits(client)
  } catch (error) {
    return { claimed: false, amount: 0, reasons: [`读取福利列表失败：${error?.message ?? error}`], campaigns: [] }
  }

  const eligible = claimableCampaigns(items)
  if (eligible.length === 0) {
    return { claimed: false, amount: 0, reasons: ['上游当前没有可领取的福利活动'], campaigns: [] }
  }

  const results = []
  for (const item of eligible) {
    results.push(await claimOne(client, { now, state, item, accountId: options.accountId, force: options.force }))
  }

  const successful = results.filter((result) => result.claimed)
  return {
    claimed: successful.length > 0,
    amount: successful.reduce((sum, result) => sum + (result.amount ?? 0), 0),
    reasons: results.filter((result) => !result.claimed && result.reason).map((result) => result.reason),
    campaigns: results,
  }
}

/** Claim one campaign for one account, honouring the local record. */
async function claimOne(client, options) {
  const { now, state, item, accountId } = options
  const label = item.title || `campaign ${item.campaignId}`
  const existing = attemptToday(state, accountId, item.campaignId, now)

  if (!options.force && existing !== undefined) {
    return {
      key: campaignKey(item.campaignId),
      claimed: false,
      reason: existing.claimed
        ? `「${label}」今天已经领过了（本地记录）`
        : `「${label}」今天已经尝试过（${existing.error ?? '上次未成功'}），不重复领取`,
    }
  }

  // Re-check immediately before the write: another client may have claimed it
  // between the list read and now.
  const amount = item.pendingAmount || item.amount || 0
  const result = await claimBenefit(client, item.campaignId)
  if (!result.ok) {
    await recordAttempt(state, accountId, item.campaignId, now, false, undefined, result.reason)
    return { key: campaignKey(item.campaignId), claimed: false, reason: result.reason }
  }

  await recordAttempt(state, accountId, item.campaignId, now, true, amount)
  return { key: campaignKey(item.campaignId), claimed: true, amount, label }
}

/** Record one attempt for one account and campaign, replacing that entry. */
async function recordAttempt(state, accountId, campaignId, now, claimed, amount, error) {
  const account = (state.accounts[accountId] ??= {})
  account[campaignKey(campaignId)] = {
    day: todayKey(now),
    at: now.getTime(),
    claimed,
    ...(amount === undefined ? {} : { amount }),
    ...(error === undefined ? {} : { error }),
  }
  await writeCheckinState(state)
}

/**
 * Claim once across every stored account after an explicit user action.
 *
 * Sequential on purpose: the gateway counts concurrent sessions with a small
 * ceiling, and a burst of parallel claims is the fastest way to hit it. One
 * account failing never stops the rest.
 *
 * @param {object} options run options.
 * @param {Array<{id: string, client: import('./gateway.js').MadaoClient}>} options.targets accounts to check, in order.
 * @param {Date} [options.now] clock, for tests.
 * @returns {Promise<{attempted: number, claimed: number, skipped: number, failures: Array<{id: string, reason: string}>}>} the summary.
 */
export async function claimAllDaily({ targets, now = new Date() }) {
  const summary = { attempted: 0, claimed: 0, skipped: 0, failures: [] }

  for (const target of targets ?? []) {
    summary.attempted += 1
    try {
      const result = await claimDaily(target.client, { accountId: target.id, now, force: false })
      if (result.claimed) summary.claimed += 1
      else if (result.reasons.length === 0) summary.skipped += 1
      for (const reason of result.reasons) summary.failures.push({ id: target.id, reason })
    } catch (error) {
      summary.failures.push({ id: target.id, reason: error?.message ?? String(error) })
    }
  }

  return summary
}

/**
 * What check-in has done today, for the settings page.
 *
 * An account counts as done only when every campaign it could claim has been
 * dealt with; a half-signed account is still pending.
 * @param {Array<{id: string, label: string}>} accounts the pool, in display order.
 * @param {Date} [now] clock, for tests.
 * @returns {{total: number, done: number, pending: number, lastError?: string}} today's progress.
 */
export function todaySummary(accounts, now = new Date()) {
  const state = readCheckinState()
  const today = todayKey(now)
  let done = 0
  let lastError
  for (const account of accounts ?? []) {
    const entry = state.accounts[account.id] ?? {}
    const attempts = Object.values(entry).filter((attempt) => isAttempt(attempt) && attempt.day === today)
    if (attempts.length === 0) continue
    if (attempts.every((attempt) => attempt.claimed)) done += 1
    else {
      const failure = attempts.find((attempt) => !attempt.claimed && attempt.error !== undefined)
      if (failure !== undefined) lastError ??= `${account.label}：${failure.error}`
    }
  }
  const total = (accounts ?? []).length
  return {
    total,
    done,
    pending: Math.max(0, total - done),
    ...(lastError === undefined ? {} : { lastError }),
  }
}
