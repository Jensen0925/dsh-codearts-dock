/**
 * Model load / busy levels for CodeArts models, matching WorkBuddy semantics.
 *
 * Levels:
 *   - idle: 空闲 (Rocket / green)
 *   - normal: 正常 (1 person / green-yellow)
 *   - busy: 轻微拥堵 (2 people / orange)
 *   - congested: 极度拥堵 (3 people / red)
 *   - unavailable: 不可用 (crossed out / gray)
 */

export type BusyLevel = 'idle' | 'normal' | 'busy' | 'congested' | 'unavailable' | 'unknown'

export const BUSY_TITLES_ZH: Record<BusyLevel, string> = {
  idle: '空闲',
  normal: '正常',
  busy: '轻微拥堵',
  congested: '极度拥堵',
  unavailable: '不可用',
  unknown: '未知',
}

export const BUSY_TITLES_EN: Record<BusyLevel, string> = {
  idle: 'Idle',
  normal: 'Normal',
  busy: 'Slightly congested',
  congested: 'Extremely congested',
  unavailable: 'Unavailable',
  unknown: 'Unknown',
}

export const BUSY_COLORS: Record<BusyLevel, string> = {
  idle: '#10b981',
  normal: '#3b82f6',
  busy: '#f59e0b',
  congested: '#ef4444',
  unavailable: '#8a8f98',
  unknown: '#6b7280',
}

/** Compact symbols for the model picker, where the host renders badge text only. */
export const BUSY_SYMBOLS: Record<Exclude<BusyLevel, 'unknown'>, string> = {
  idle: '🚀',
  normal: '🧍',
  busy: '🧍🧍',
  congested: '🧍🧍🧍',
  unavailable: '🚫',
}

/** The upstream's batch limit for the read-only load probe. */
export const BUSY_BATCH_SIZE = 50

/** Normalize the exact enum returned by the upstream probe. */
export function normalizeBusyLevel(value: unknown): BusyLevel {
  return typeof value === 'string' && Object.hasOwn(BUSY_TITLES_ZH, value)
    ? value as BusyLevel
    : 'unknown'
}

/** Parse `{ model, busy_level }` probe rows into a model-id map. */
export function parseBusyLevels(entries: unknown): Map<string, BusyLevel> {
  const levels = new Map<string, BusyLevel>()
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    if (typeof row.model !== 'string' || row.model === '') continue
    levels.set(row.model, normalizeBusyLevel(row.busy_level))
  }
  return levels
}

/** Split and de-duplicate model ids without changing their order. */
export function batchModelIds(ids: readonly string[], size = BUSY_BATCH_SIZE): string[][] {
  const unique = [...new Set(ids.filter((id) => id !== ''))]
  const batches: string[][] = []
  for (let index = 0; index < unique.length; index += size) {
    batches.push(unique.slice(index, index + size))
  }
  return batches
}

/** Format the busy level as an icon and label for LlmModelInfo.badge. */
export function resolveBusyBadge(level: BusyLevel) {
  if (level === 'unknown') return undefined
  return {
    symbol: BUSY_SYMBOLS[level],
    text: {
      zh: BUSY_TITLES_ZH[level],
      en: BUSY_TITLES_EN[level],
    },
    tone: level === 'idle'
      ? 'success' as const
      : level === 'busy' || level === 'congested' || level === 'unavailable'
        ? 'warning' as const
        : 'info' as const,
  }
}
