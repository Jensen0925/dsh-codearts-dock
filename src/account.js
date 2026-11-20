/**
 * Read-only account facts: credit balance, identity, and the daily check-in.
 *
 * Everything here is a plain (unsealed) gateway read. None of it changes
 * account state except `claimBenefit`, which spends one real entitlement and
 * therefore runs only when a user clicks it.
 */

import { BENEFITS_PATH, BENEFIT_CLAIM_PATH, CREDIT_STATISTICS_PATH, ROLES_PATH } from './gateway.js'

/**
 * @typedef {object} CreditInfo
 * @property {number} total granted credits.
 * @property {number} used consumed credits.
 * @property {number} remain available credits.
 * @property {{amount: number, used: number, remain: number}} [basic] the base package.
 * @property {{amount: number, used: number, remain: number}} [bonus] the promotional package.
 * @property {{amount: number, used: number, remain: number}} [onDemand] pay-as-you-go.
 * @property {number} [totalTokens] lifetime chat tokens.
 */

/**
 * Read the credit balance.
 *
 * The gateway reports it as a flat list of named metrics, so the numbers have
 * to be selected by name rather than by position. The metric key is `name` —
 * reading `metric_name` yields a list of `undefined` and silently reports no
 * balance at all.
 *
 * @param {import('./gateway.js').MadaoClient} client an authenticated client.
 * @returns {Promise<CreditInfo|null>} the balance, or null when unreadable.
 */
export async function readCredit(client, { strict = false } = {}) {
  try {
    const reply = await client.getJson(CREDIT_STATISTICS_PATH)
    const metrics = reply?.metrics ?? reply?.data?.metrics ?? []
    if (!Array.isArray(metrics)) return null

    const pick = (name) => metrics.find((metric) => metric?.name === name)
    const totals = pick('usageTotalPackageCredit')
    if (!totals) return null

    const packageOf = (metric) =>
      metric
        ? {
            amount: Number(metric.package_credit_amount ?? 0),
            used: Number(metric.package_credit_used ?? 0),
            remain: Number(metric.package_credit_remain ?? 0),
          }
        : undefined

    const tokens = pick('usageTokenChatMessages')
    const plan = reply?.package
    return {
      total: Number(totals.package_credit_amount ?? 0),
      used: Number(totals.package_credit_used ?? 0),
      remain: Number(totals.package_credit_remain ?? 0),
      basic: packageOf(pick('usageBasicPackageCredit')),
      bonus: packageOf(pick('usageBonusPackageCredit')),
      onDemand: packageOf(pick('usageOnDemandPackageCredit')),
      totalTokens: tokens ? Number(tokens.usage_token_num ?? 0) : undefined,
      // Summed across packages: the headline number the card reports.
      expiringTotal:
        Number(totals.package_credit_expiring_amount ?? 0) ||
        ['usageBasicPackageCredit', 'usageBonusPackageCredit', 'usageOnDemandPackageCredit'].reduce(
          (sum, name) => sum + Number(pick(name)?.package_credit_expiring_amount ?? 0),
          0,
        ),
      ...(plan?.package_name_cn || plan?.package_name_en
        ? { plan: plan.package_name_cn ?? plan.package_name_en }
        : {}),
    }
  } catch (error) {
    if (strict) throw error
    return null
  }
}

/**
 * Read enterprise role names, when the account belongs to an enterprise.
 * @param {import('./gateway.js').MadaoClient} client an authenticated client.
 * @returns {Promise<string[]>} role names; empty for a personal account.
 */
export async function readRoles(client) {
  try {
    const reply = await client.getJson(ROLES_PATH)
    const roles = reply?.enterprise_roles ?? reply?.data?.enterprise_roles ?? []
    return Array.isArray(roles) ? roles.filter((role) => typeof role === 'string') : []
  } catch {
    return []
  }
}

/**
 * Decode the identity a security token carries.
 *
 * The token is a Base64 JSON document followed by a binary signature. A naive
 * "find the last `}`" slices the signature back into the JSON, because the
 * trailing bytes can contain that character, so this pairs braces instead.
 *
 * @param {string|undefined} securityToken the token from the credential.
 * @returns {{accountName?: string, domainId?: string, userId?: string, userType?: number}} identity facts.
 */
export function parseIdentity(securityToken) {
  if (!securityToken) return {}
  try {
    const raw = Buffer.from(securityToken, 'base64').toString('utf8')
    const start = raw.indexOf('{')
    if (start < 0) return {}
    const end = findJsonEnd(raw, start)
    if (end < 0) return {}
    const parsed = JSON.parse(raw.slice(start, end + 1))
    const user = parsed?.user ?? {}
    const domain = user.domain ?? {}
    return {
      accountName: domain.name ?? user.name,
      domainId: domain.id,
      userId: user.id,
      userType: typeof user.user_type === 'number' ? user.user_type : undefined,
    }
  } catch {
    return {}
  }
}

/** Find the index of the brace that closes the object opened at `start`. */
function findJsonEnd(raw, start) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * @typedef {object} BenefitItem
 * @property {number} campaignId campaign identifier.
 * @property {string} title campaign title.
 * @property {string|null} status upstream status text.
 * @property {boolean} claimable whether it can be claimed right now.
 * @property {number} pendingAmount credits on offer.
 * @property {string} unit benefit unit.
 * @property {string|null} expireAt ISO expiry, when one is declared.
 */

/**
 * List the campaigns this account can see, annotating which are claimable.
 *
 * This is a read: no claim is attempted. Displaying what *can* be claimed is
 * the whole point of the list.
 * @param {import('./gateway.js').MadaoClient} client an authenticated client.
 * @returns {Promise<BenefitItem[]>} the campaigns.
 */
export async function listBenefits(client) {
  const reply = await client.getJson(BENEFITS_PATH)
  const items = reply?.data?.items ?? reply?.items ?? []
  if (!Array.isArray(items)) return []
  return items.map((item) => ({
    campaignId: Number(item.campaignId ?? 0),
    title: String(item.title ?? ''),
    status: item.status ?? null,
    claimable: item.claimable === true,
    pendingAmount: Number(item.pendingTotalAmount ?? 0),
    unit: String(item.benefitUnit ?? 'CREDIT'),
    expireAt: item.expireAt ?? null,
  }))
}

/**
 * Claim one campaign.
 *
 * One campaign per call, by design: a single click spends one real,
 * irreversible entitlement, so there is no "claim all" path.
 * @param {import('./gateway.js').MadaoClient} client an authenticated client.
 * @param {number} campaignId the campaign to claim.
 * @returns {Promise<{ok: true, reply: unknown} | {ok: false, reason: string}>} the outcome.
 */
export async function claimBenefit(client, campaignId) {
  if (!Number.isInteger(campaignId) || campaignId <= 0) {
    return { ok: false, reason: '缺少有效的 campaignId' }
  }
  try {
    // Re-read immediately before claiming: an already-claimed or expired
    // campaign must not be sent to the write endpoint.
    const items = await listBenefits(client)
    const target = items.find((item) => item.campaignId === campaignId)
    if (!target) return { ok: false, reason: `上游列表里没有 campaignId=${campaignId}` }
    if (!target.claimable) {
      return { ok: false, reason: `「${target.title}」当前不可领取（status=${target.status ?? '未知'}）` }
    }

    const reply = await client.postJson(BENEFIT_CLAIM_PATH, {
      campaignId,
      // A deterministic key makes a retried request idempotent rather than
      // a second claim.
      idempotentKey: `codearts-claim-${campaignId}-${new Date().toISOString().slice(0, 10)}`,
      channel: 'IDE',
    })
    return { ok: true, reply }
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) }
  }
}
