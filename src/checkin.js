/**
 * Daily check-in.
 *
 * The gateway runs its daily bonus as a campaign in the same welfare list the
 * settings page already reads: `campaignId: 34`, titled 「每日签到领100积分」,
 * `triggerMode: MANUAL_CLAIM`. Claiming is a real, irreversible write
 * (`POST /v1/ops/claim`) that spends the day's one entitlement, so everything
 * here is built around never doing it twice and never doing it unasked.
 *
 * Auto check-in is therefore opt-in, off by default, and guarded three ways:
 *
 *   1. it re-reads campaign state immediately before claiming, so an account
 *      already claimed today by any client is skipped, not retried;
 *   2. it records the local date of the last attempt per account, so a refresh
 *      loop cannot re-claim within one day even if the upstream answer is
 *      ambiguous;
 *   3. it never claims when the campaign does not report itself claimable.
 *
 * The record lives beside the account store so a restart does not forget it.
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CONFIG_DIR } from './paths.js'
import { claimBenefit, listBenefits } from './account.js'

/** File holding the per-account check-in record. */
export const CHECKIN_STATE_PATH = join(CONFIG_DIR, 'checkin-state.json')

/** The daily-bonus campaign, by name rather than only id: the id is stable but the title is what makes a mismatch obvious. */
export const DAILY_CAMPAIGN_HINT = '签到'

/**
 * @typedef {object} CheckinState
 * @property {Record<string, {day: string, at: number, claimed: boolean, amount?: number, error?: string}>} accounts
 */

/** The local calendar day key, `YYYY-MM-DD`, in the user's own zone. */
export function todayKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** Read the record; a missing or corrupt file is an empty record. */
export function readCheckinState() {
  if (!existsSync(CHECKIN_STATE_PATH)) return { accounts: {} }
  try {
    const parsed = JSON.parse(readFileSync(CHECKIN_STATE_PATH, 'utf8'))
    if (parsed && typeof parsed === 'object' && typeof parsed.accounts === 'object') {
      return { accounts: parsed.accounts }
    }
  } catch {
    // Fall through: an unreadable record means "no attempts recorded", and the
    // re-read before claiming still prevents a double claim.
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

/** Whether this account already attempted a claim today. */
export function attemptedToday(state, accountId, now = new Date()) {
  const entry = state.accounts[accountId]
  return entry !== undefined && entry.day === todayKey(now)
}

/**
 * The daily campaign in a benefit list.
 *
 * Chosen by its `USER_LOGIN` type plus the 签到 hint, because several login
 * campaigns can be active at once (there is a second one running right now).
 * @param {Array<object>} items benefits from the gateway.
 * @returns {object|undefined} the daily campaign.
 */
export function dailyCampaignOf(items) {
  const list = Array.isArray(items) ? items : []
  // Prefer the exact, long-standing campaign; fall back to a title match.
  return (
    list.find((item) => item.campaignId === 34) ??
    list.find((item) => typeof item.title === 'string' && item.title.includes(DAILY_CAMPAIGN_HINT))
  )
}

/**
 * Read one account's daily check-in state without claiming anything.
 *
 * @param {import('./gateway.js').MadaoClient} client an authenticated client.
 * @param {object} [options] read options.
 * @param {Date} [options.now] clock, for tests.
 * @param {CheckinState} [options.state] the record to consult.
 * @param {string} [options.accountId] whose record to consult.
 * @returns {Promise<{available: boolean, claimable: boolean, status: string|null, amount: number, title: string|null, claimedToday: boolean, reason?: string}>} the state.
 */
export async function readCheckin(client, options = {}) {
  const now = options.now ?? new Date()
  const state = options.state ?? readCheckinState()
  const attempt = options.accountId ? state.accounts[options.accountId] : undefined

  let items
  try {
    items = await listBenefits(client)
  } catch (error) {
    return {
      available: false,
      claimable: false,
      status: null,
      amount: 0,
      title: null,
      claimedToday: false,
      reason: `读取福利列表失败：${error?.message ?? error}`,
    }
  }

  const campaign = dailyCampaignOf(items)
  if (!campaign) {
    return {
      available: false,
      claimable: false,
      status: null,
      amount: 0,
      title: null,
      claimedToday: false,
      reason: '上游的福利列表里没有每日签到活动',
    }
  }

  // The upstream status is authoritative about today; the local record only
  // covers the window between a successful claim and the upstream catching up.
  const locallyClaimed =
    attempt !== undefined && attempt.day === todayKey(now) && attempt.claimed === true
  const claimable = campaign.claimable === true && !locallyClaimed

  return {
    available: true,
    claimable,
    status: campaign.status ?? null,
    amount: campaign.pendingAmount || campaign.amount || 0,
    title: campaign.title ?? null,
    claimedToday: locallyClaimed || campaign.claimable !== true,
  }
}

/**
 * Claim the daily bonus for one account, once.
 *
 * @param {import('./gateway.js').MadaoClient} client an authenticated client.
 * @param {object} options claim options.
 * @param {string} options.accountId whose record to update.
 * @param {Date} [options.now] clock, for tests.
 * @param {boolean} [options.force] claim even when the local record says it was attempted today (never used by auto mode).
 * @returns {Promise<{claimed: boolean, amount?: number, reason?: string}>} the outcome.
 */
export async function claimDaily(client, options) {
  const now = options.now ?? new Date()
  const state = readCheckinState()

  if (!options.force && attemptedToday(state, options.accountId, now)) {
    const entry = state.accounts[options.accountId]
    return {
      claimed: false,
      reason: entry?.claimed
        ? '今天已经签过了（本地记录）'
        : `今天已经尝试过（${entry?.error ?? '上次未成功'}），不重复领取`,
    }
  }

  const before = await readCheckin(client, { now, state, accountId: options.accountId })
  if (!before.available) return { claimed: false, reason: before.reason }
  if (!before.claimable) {
    await recordAttempt(state, options.accountId, now, false, undefined, '上游显示今天不可领取')
    return { claimed: false, reason: '上游显示今天已经领过或当前不可领取' }
  }

  const items = await listBenefits(client)
  const campaign = dailyCampaignOf(items)
  if (!campaign) return { claimed: false, reason: '上游的福利列表里没有每日签到活动' }

  const result = await claimBenefit(client, campaign.campaignId)
  if (!result.ok) {
    await recordAttempt(state, options.accountId, now, false, undefined, result.reason)
    return { claimed: false, reason: result.reason }
  }

  await recordAttempt(state, options.accountId, now, true, before.amount)
  return { claimed: true, amount: before.amount }
}

/** Record one attempt for one account, replacing that account's entry. */
async function recordAttempt(state, accountId, now, claimed, amount, error) {
  state.accounts[accountId] = {
    day: todayKey(now),
    at: now.getTime(),
    claimed,
    ...(amount === undefined ? {} : { amount }),
    ...(error === undefined ? {} : { error }),
  }
  await writeCheckinState(state)
}

/**
 * Run auto check-in across the accounts that should be checked.
 *
 * Sequential on purpose: the gateway counts concurrent sessions with a small
 * ceiling, and a burst of parallel claims on one account is the fastest way to
 * hit it. One account failing never stops the rest.
 *
 * @param {object} options run options.
 * @param {Array<{id: string, client: import('./gateway.js').MadaoClient}>} options.targets accounts to check, in order.
 * @param {Date} [options.now] clock, for tests.
 * @returns {Promise<{attempted: number, claimed: number, skipped: number, failures: Array<{id: string, reason: string}>}>} the summary.
 */
export async function runAutoCheckin({ targets, now = new Date() }) {
  const summary = { attempted: 0, claimed: 0, skipped: 0, failures: [] }
  const state = readCheckinState()

  for (const target of targets ?? []) {
    if (attemptedToday(state, target.id, now)) {
      summary.skipped += 1
      continue
    }
    summary.attempted += 1
    try {
      const result = await claimDaily(target.client, {
        accountId: target.id,
        now,
        force: false,
      })
      if (result.claimed) summary.claimed += 1
      else if (result.reason) summary.failures.push({ id: target.id, reason: result.reason })
      state.accounts[target.id] = readCheckinState().accounts[target.id] ?? state.accounts[target.id]
    } catch (error) {
      summary.failures.push({ id: target.id, reason: error?.message ?? String(error) })
    }
  }

  return summary
}

/**
 * What auto check-in has done today, for the settings page.
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
    const entry = state.accounts[account.id]
    if (entry !== undefined && entry.day === today) {
      if (entry.claimed) done += 1
      else if (entry.error !== undefined) lastError ??= `${account.label}：${entry.error}`
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
