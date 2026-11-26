/** A bounded local history of fixed actions and non-sensitive outcome counts. */
import { randomUUID } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { CONFIG_DIR } from './paths.js'

export const ACTIVITY_LIMIT = 200
const MAX_READ_BYTES = 256 * 1024
const MAX_TIMESTAMP = 8_640_000_000_000_000 // Largest timestamp supported by JavaScript Date.
const ACTIONS = new Set([
  'account.add', 'account.update', 'account.import', 'account.remove',
  'account.activate', 'account.rename', 'account.export', 'account.check',
  'credentials.save', 'credentials.clear', 'models.save', 'models.request', 'models.test',
  'settings.save', 'checkin.enable', 'checkin.disable',
  'checkin.manual', 'checkin.auto', 'catalog.update', 'catalog.refresh',
  'connection.test',
])
const COUNT_KEYS = ['added', 'updated', 'skipped', 'total', 'enabled', 'claimed', 'failed', 'available', 'unavailable', 'attempted'] as const
const REASONS = new Set(['credentials', 'network', 'rate_limited', 'insufficient', 'gateway', 'unknown'])
const STATUSES = new Set(['success', 'warning', 'error'])

export type ActivityStatus = 'success' | 'warning' | 'error'
export type ActivityCategory = 'account' | 'models' | 'checkin' | 'system'
export type ActivityRecord = {
  id: string
  at: number
  action: string
  category: ActivityCategory
  status: ActivityStatus
  details: Record<string, number | string>
}

const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

function categoryOf(action: string): ActivityCategory {
  const group = action.split('.')[0]
  if (group === 'account' || group === 'credentials') return 'account'
  if (group === 'models' || group === 'catalog') return 'models'
  if (group === 'checkin') return 'checkin'
  return 'system'
}

/** Copy only explicitly allowed scalar values; never persist caller text. */
function cleanDetails(input: unknown): ActivityRecord['details'] {
  const out: ActivityRecord['details'] = {}
  if (!plain(input)) return out
  for (const key of COUNT_KEYS) {
    if (!Object.hasOwn(input, key)) continue
    const value = input[key]
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) out[key] = value
  }
  if (Object.hasOwn(input, 'reason') && typeof input.reason === 'string' && REASONS.has(input.reason)) out.reason = input.reason
  return out
}

function cleanRecord(value: unknown): ActivityRecord | null {
  if (!plain(value) || typeof value.id !== 'string' || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value.id)) return null
  if (typeof value.at !== 'number' || !Number.isSafeInteger(value.at) || value.at < 0 || value.at > MAX_TIMESTAMP) return null
  if (typeof value.action !== 'string' || !ACTIONS.has(value.action) || value.category !== categoryOf(value.action)) return null
  if (typeof value.status !== 'string' || !STATUSES.has(value.status) || !plain(value.details)) return null
  return {
    id: value.id, at: value.at, action: value.action,
    category: categoryOf(value.action), status: value.status as ActivityStatus,
    details: cleanDetails(value.details),
  }
}

/** Bounded reads also cover malformed or unexpectedly large files. */
function load(path: string): ActivityRecord[] {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_READ_BYTES) return []
    const buffer = Buffer.alloc(MAX_READ_BYTES + 1)
    let size = 0
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null)
      if (count === 0) break
      size += count
    }
    if (size > MAX_READ_BYTES) return []
    const parsed: unknown = JSON.parse(buffer.subarray(0, size).toString('utf8'))
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    return parsed.map(cleanRecord).filter((record): record is ActivityRecord => {
      if (!record || seen.has(record.id)) return false
      seen.add(record.id)
      return true
    }).sort((a, b) => b.at - a.at).slice(0, ACTIVITY_LIMIT)
  } catch {
    return []
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function createActivityStore({ path = join(CONFIG_DIR, 'activity.json') }: { path?: string } = {}) {
  let records = load(path)
  let pending = Promise.resolve(true)

  const write = async (next: ActivityRecord[]): Promise<boolean> => {
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(temp, `${JSON.stringify(next)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(temp, path)
      records = next
      return true
    } catch {
      // History must never turn a successful account/model operation into an error.
      return false
    } finally {
      await unlink(temp).catch(() => {})
    }
  }
  const serial = (operation: () => Promise<boolean>) => {
    const result = pending.then(operation, operation)
    pending = result.catch(() => false)
    return pending
  }

  return {
    read(): ActivityRecord[] {
      return records.map((record) => ({ ...record, details: { ...record.details } }))
    },
    record(action: string, status: ActivityStatus = 'success', details: unknown = {}): Promise<boolean> {
      if (!ACTIONS.has(action) || !STATUSES.has(status)) return Promise.resolve(false)
      const safeDetails = cleanDetails(details)
      return serial(() => write([{
        id: randomUUID(), at: Math.max(Date.now(), records[0]?.at ?? 0), action,
        category: categoryOf(action), status, details: safeDetails,
      }, ...records].slice(0, ACTIVITY_LIMIT)))
    },
    clear(): Promise<boolean> {
      return serial(() => write([]))
    },
  }
}
