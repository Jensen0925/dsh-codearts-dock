/** Bounded local request metadata. No prompts, responses, tool arguments, or account identities. */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { CONFIG_DIR } from './paths.js'
export const USAGE_LIMIT = 200
const finite = (n) => Number.isFinite(n) && n >= 0 ? Math.round(n) : null
const statuses = ['success', 'error', 'aborted']
export function sanitizeUsage(row) {
  return {
    id: typeof row.id === 'string' && /^[a-f\d-]{36}$/.test(row.id) ? row.id : randomUUID(),
    at: finite(row.at) ?? Date.now(),
    model: typeof row.model === 'string' ? row.model.slice(0, 200) : 'unknown',
    durationMs: finite(row.durationMs) ?? 0,
    inputTokens: finite(row.inputTokens), outputTokens: finite(row.outputTokens),
    status: statuses.includes(row.status) ? row.status : 'error',
  }
}
export function createUsageStore({ directory = CONFIG_DIR, enabled = () => true } = {}) {
  const path = join(directory, 'usage.json')
  let rows
  let epoch = 0
  let pending = Promise.resolve()
  function read() {
    if (!rows) {
      try {
        const raw = JSON.parse(readFileSync(path, 'utf8'))
        rows = Array.isArray(raw) ? raw.filter((row) => row && typeof row === 'object').slice(-USAGE_LIMIT).map(sanitizeUsage) : []
      } catch { rows = [] }
    }
    return rows
  }
  function write() {
    const snapshot = JSON.stringify(read())
    const next = pending.then(async () => {
      await mkdir(directory, { recursive: true })
      const temp = `${path}.${randomUUID()}.tmp`
      await writeFile(temp, `${snapshot}\n`, { mode: 0o600 })
      await rename(temp, path)
    })
    pending = next.catch(() => {})
    return next
  }
  return {
    generation: () => enabled() ? epoch : null,
    list: () => ({ ok: true, enabled: enabled(), limit: USAGE_LIMIT, records: read().slice().reverse() }),
    record: (entry, startedEpoch = epoch) => {
      if (!enabled() || startedEpoch !== epoch) return Promise.resolve()
      rows = [...read(), sanitizeUsage(entry)].slice(-USAGE_LIMIT)
      return write()
    },
    clear: () => { epoch += 1; rows = []; return write() },
  }
}
