/**
 * Promotional & discount badge resolution for CodeArts models.
 *
 * Evaluates promotional tags dynamically against the wall clock (Date.now())
 * so that off-peak/night discount windows activate and deactivate automatically
 * without requiring a restart.
 *
 * Supported badge types:
 *   1. Off-peak discount (错峰折扣): 21:00 - 08:00 (Asia/Shanghai) for models with off_peak schedule (e.g. deepseek-v4.1-flash, speed)
 *   2. Limited trial (限时体验): models marked with 【限时体验】 in description (e.g. glm-5.3, glm-5.3-flash, kimi-k3, kimi-k3.1-pro)
 *   3. Retiring soon (即将下线): models marked with 【...下线】 in description (e.g. openpangu-2.0-flash, openpangu-2.0-pro)
 *   4. Limited half-price (限时半价): only when the upstream description or
 *      promotion metadata says so explicitly.
 *   5. Special offer (限时特惠): models with high discount / low multiplier (e.g. openpangu-2.1-pro 0.07x)
 */

export interface ModelPromoBadge {
  label: string
  labelEn: string
  tone: 'success' | 'info' | 'warning' | 'neutral'
  color?: string
}

/** Check if the current wall clock is within off-peak hours (21:00 - 08:00 Beijing time). */
export function isOffPeakHour(nowMs: number = Date.now()): boolean {
  // Asia/Shanghai is UTC+8
  const date = new Date(nowMs)
  const beijingHour = (date.getUTCHours() + 8) % 24
  return beijingHour >= 21 || beijingHour < 8
}

/**
 * Resolve the active promotional badge for a model, if any holds right now.
 *
 * @param model catalog model object.
 * @param nowMs epoch millisecond timestamp for clock check.
 * @returns promo badge or undefined.
 */
export function resolveModelPromo(
  model: {
    id?: string
    name?: string
    description?: string
    ratio?: string
    time_slots?: Record<string, any>
    promotion?: unknown
    limitedTimeHalfPrice?: boolean
    limited_time_half_price?: boolean
  },
  nowMs: number = Date.now(),
): ModelPromoBadge | undefined {
  if (!model) return undefined

  const desc = model.description ?? ''
  const promoText = promotionText(model.promotion)
  const id = (model.id ?? '').toLowerCase()
  const ratio = (model.ratio ?? '').toLowerCase()

  // Half-price is an activity label, not a price tier: a model's normal 0.5x
  // multiplier alone is not evidence that a temporary campaign is running.
  if (
    model.limitedTimeHalfPrice === true ||
    model.limited_time_half_price === true ||
    /限时.{0,12}(?:半价|五折|5\s*折)|(?:半价|五折|5\s*折).{0,12}(?:限时|优惠|活动)/i.test(`${desc} ${promoText}`)
  ) {
    return {
      label: '限时半价',
      labelEn: 'Limited-time half price',
      tone: 'success',
      color: '#ef4444',
    }
  }

  // 1. Off-peak discount
  const hasOffPeak =
    model.time_slots?.off_peak ||
    id === 'deepseek-v4.1-flash' ||
    id === 'speed'

  if (hasOffPeak) {
    if (isOffPeakHour(nowMs)) {
      return {
        label: '错峰折扣',
        labelEn: 'Off-peak',
        tone: 'success',
        color: '#10b981',
      }
    }
    return {
      label: '夜间特惠',
      labelEn: 'Night Offer',
      tone: 'info',
      color: '#3b82f6',
    }
  }

  // 2. Retiring soon notice
  if (desc.includes('下线') || desc.includes('即将下线')) {
    return {
      label: '即将下线',
      labelEn: 'Retiring',
      tone: 'warning',
      color: '#f59e0b',
    }
  }

  // 3. Limited-time trial
  if (desc.includes('限时体验') || desc.includes('限免') || desc.includes('公测')) {
    return {
      label: '限时体验',
      labelEn: 'Trial',
      tone: 'info',
      color: '#3b82f6',
    }
  }

  // 4. Special promotion / discount (e.g. OpenPangu-2.1-Pro at 0.07x)
  if (
    id.includes('openpangu-2.1') ||
    ratio === '0.07x' ||
    ratio === '0.08x' ||
    ratio === '0.05x'
  ) {
    return {
      label: '限时特惠',
      labelEn: 'Special Offer',
      tone: 'success',
      color: '#10b981',
    }
  }

  return undefined
}

/** Pull displayable labels from the loose metadata shapes used by model feeds. */
function promotionText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(promotionText).filter(Boolean).join(' ')
  if (typeof value !== 'object' || value === null) return ''
  const record = value as Record<string, unknown>
  return [record.label, record.title, record.name, record.text, record.description, record.badge]
    .map(promotionText)
    .filter(Boolean)
    .join(' ')
}
