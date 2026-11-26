/**
 * The live model catalog.
 *
 * The adapter, the settings page, and the diagnostics view all read the same
 * catalog, so it is one object with one refresh path. A refresh that fails
 * keeps the previous live catalog in service rather than replacing it with
 * the static fallback table, which would silently downgrade a working
 * session to models with no thinking metadata.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { discoverModels, FALLBACK_MODELS } from './models.js'
import { errorMessage } from './errors.js'
import { InputError } from './preferences.js'

type ModelInfo = {
  id: string
  name: string
  context: number
  maxOutput: number
  ratio?: string
  supportsImages: boolean
  strengths: string[]
  defaultStrength?: string
  allowOff?: boolean
  description?: string
  busyLevel?: import('./busy.js').BusyLevel
  time_slots?: Record<string, unknown>
  promotion?: unknown
  limitedTimeHalfPrice?: boolean
}

type ModelOverride = { images?: boolean; allowOff?: boolean; defaultStrength?: string; context?: number }

/** Only a positive token count provides a known upstream context ceiling. */
const contextLimit = (model) => Number.isSafeInteger(model?.context) && model.context > 0 ? model.context : undefined

/** Validate newly submitted selections against each known model's own limit. */
export function validateContextOverrides(catalog, overrides: Record<string, ModelOverride>) {
  for (const [id, override] of Object.entries(overrides)) {
    if (override.context === undefined) continue
    const model = catalog.find(id)
    const limit = contextLimit(model)
    if (limit !== undefined && override.context > limit) throw new InputError(`${model.name}：上下文长度不能超过模型上限 ${limit}`)
  }
}

export class Catalog {
  log: (line: string) => void
  current: ModelInfo[]
  source: string
  lastError: string | undefined
  refreshedAt: number | undefined
  pending: Promise<{ changed: boolean; source: string; error?: string }> | null
  enabledIds: string[] | null
  overrides: Record<string, ModelOverride>
  listeners: Set<() => void>

  constructor(options: { log?: (line: string) => void } = {}) {
    this.log = options.log ?? (() => {})
    this.current = FALLBACK_MODELS
    this.source = 'fallback'
    this.lastError = undefined
    this.refreshedAt = undefined
    this.pending = null
    this.enabledIds = null
    this.overrides = {}
    this.listeners = new Set()
  }

  /**
   * Load the last catalog persisted on disk, if any.
   *
   * A restart otherwise begins on the static fallback table and shows a stale
   * model list (or none) until the first refresh lands. Persisting the last good
   * catalog means the picker is correct the moment the plugin loads, and the
   * refresh only confirms it.
   *
   * @param {string} path file to read.
   * @returns {boolean} whether a usable catalog was loaded.
   */
  loadPersisted(path) {
    try {
      const saved = JSON.parse(readFileSync(path, 'utf8'))
      const models = Array.isArray(saved?.models) ? saved.models : []
      // Only accept a shape the rest of the plugin can actually use: a partial
      // file must not replace a working catalog with something unreadable.
      if (models.length === 0) return false
      if (!models.every((model) => typeof model?.id === 'string' && model.id !== '')) return false
      // Congestion is a live, short-lived fact. Old cache entries may contain
      // it from a prior version; never present that stale value as current.
      this.current = models.map((model) => ({ ...model, busyLevel: 'unknown' }))
      this.source = 'cache'
      this.refreshedAt = typeof saved.refreshedAt === 'number' ? saved.refreshedAt : undefined
      this.#notify()
      return true
    } catch {
      return false
    }
  }

  /**
   * Persist the current catalog.
   *
   * Best-effort: a read-only profile must not break a working session, so a
   * failure here is logged and dropped rather than thrown.
   *
   * @param {string} path file to write.
   */
  persist(path) {
    if (this.source === 'fallback') return
    try {
      mkdirSync(dirname(path), { recursive: true })
      const models = this.current.map(({ busyLevel: _busyLevel, ...model }) => model)
      writeFileSync(
        path,
        `${JSON.stringify({ version: 1, source: this.source, refreshedAt: this.refreshedAt, models }, null, 2)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )
    } catch (error) {
      this.log(`模型清单落盘失败（不影响使用）：${errorMessage(error)}`)
    }
  }

  /** The catalog the rest of the plugin reads. */
  models() {
    return this.current
  }

  /**
   * Apply the user's selection and capability overrides.
   *
   * `enabledIds` null means "everything" — a user who never opened the card must
   * see the whole catalog, not an empty picker. A non-null list is authoritative:
   * it keeps models the upstream withdrew (the user is still running them) and
   * withholds ones the upstream added (so a new upstream model appears only once
   * the user ticks it).
   *
   * @param {object} selection the saved selection.
   * @param {string[]|null} [selection.enabledIds] ids to offer, or null for all.
   * @param {Record<string, {images?: boolean, allowOff?: boolean, defaultStrength?: string}>} [selection.overrides] per-model overrides.
   */
  configure(selection) {
    this.enabledIds = selection?.enabledIds ?? null
    this.overrides = selection?.overrides ?? {}
    this.#notify()
  }

  /** The models the rest of the plugin may offer, after the selection. */
  visible() {
    const models = this.current
    if (this.enabledIds === null) return models
    const wanted = new Set(this.enabledIds)
    return models.filter((model) => wanted.has(model.id))
  }

  /** Whether a model is enabled under the current selection. */
  isEnabled(id) {
    return this.enabledIds === null || this.enabledIds.includes(id)
  }

  /** One model after capability and context overrides have been applied. */
  effective(model) {
    if (!model) return model
    const override = this.overrides?.[model.id]
    if (!override) return model
    const requestedContext = override.context
    const hasContextOverride = typeof requestedContext === 'number' && Number.isInteger(requestedContext) && requestedContext >= 1024 && requestedContext <= 2097152
    const limit = contextLimit(model)
    const context = hasContextOverride
      ? (limit === undefined ? requestedContext : Math.min(requestedContext, limit))
      : model.context
    return {
      ...model,
      context,
      // Reserve conversation space when a smaller context is selected.
      maxOutput: hasContextOverride ? Math.min(model.maxOutput, Math.floor(context / 4)) : model.maxOutput,
      supportsImages: typeof override.images === 'boolean' ? override.images : model.supportsImages,
      allowOff: typeof override.allowOff === 'boolean' ? override.allowOff : model.allowOff,
      // Only honour a level the model actually offers: a stale or hand-edited
      // preference must not become a request the upstream will reject.
      defaultStrength:
        typeof override.defaultStrength === 'string' &&
        (model.strengths ?? []).includes(override.defaultStrength)
          ? override.defaultStrength
          : model.defaultStrength,
    }
  }

  /** Look up one model by id. */
  find(id) {
    return this.current.find((model) => model.id === id)
  }

  /**
   * Resolve whatever a caller named into the gateway's model id.
   *
   * The selector displays `name · ratio` (for example `GLM-5.2 · 0.7x`), and a
   * surface can hand that display string back as the model. The gateway does
   * NOT recognise it: it answers HTTP 200 with an empty body and no error,
   * which the Host can only report as "returned a completed response with no
   * content". Verified against the live gateway.
   *
   * Falls back through id → display string → name → id/name with the ` · ratio`
   * tail stripped, and finally returns the input unchanged so a genuinely
   * unknown id still reaches the gateway rather than being silently dropped.
   *
   * @param {string} value the model as named by a caller.
   * @returns {string} the id to put on the wire.
   */
  resolveId(value) {
    const raw = String(value ?? '').trim()
    if (raw === '') return raw
    const low = raw.toLowerCase()
    const display = (model) => (model.ratio ? `${model.name} · ${model.ratio}` : model.name)

    const byId = this.current.find((model) => model.id.toLowerCase() === low)
    if (byId) return byId.id

    const byDisplay = this.current.find(
      (model) => display(model) === raw || display(model).toLowerCase() === low,
    )
    if (byDisplay) return byDisplay.id

    const byName = this.current.find((model) => model.name.toLowerCase() === low)
    if (byName) return byName.id

    const stripped = raw.split('·')[0].trim().toLowerCase()
    if (stripped !== '' && stripped !== low) {
      const byStrippedId = this.current.find((model) => model.id.toLowerCase() === stripped)
      if (byStrippedId) return byStrippedId.id
      const byStrippedName = this.current.find((model) => model.name.toLowerCase() === stripped)
      if (byStrippedName) return byStrippedName.id
    }

    // Unknown: pass it through so the gateway's own answer reaches the user.
    return raw
  }

  /**
   * Re-read the catalog from the gateway.
   *
   * Concurrent callers share one refresh: the settings page and the adapter
   * can ask at the same time without doubling the requests.
   *
   * @param {import('./gateway.js').MadaoClient} client an authenticated client.
   * @returns {Promise<{changed: boolean, source: string, error?: string}>} the outcome.
   */
  async refresh(client) {
    if (this.pending) return this.pending
    this.pending = this.#refresh(client).finally(() => {
      this.pending = null
    })
    return this.pending
  }

  async #refresh(client) {
    const before = this.current
    const result = await discoverModels(client)

    if (result.error) {
      this.lastError = result.error
      this.log(`模型清单刷新失败：${result.error}`)
    } else {
      this.lastError = undefined
    }

    // A fallback result never replaces a live catalog: the static table is a
    // first-start courtesy, not a downgrade path.
    if (result.source === 'gateway') {
      this.current = result.models
      this.source = 'gateway'
      this.refreshedAt = Date.now()
    } else if (this.source !== 'gateway') {
      this.current = result.models
      this.source = 'fallback'
    }

    const changed = !sameCatalog(before, this.current)
    if (changed) this.#notify()
    return { changed, source: this.source, error: this.lastError }
  }

  /** Subscribe to catalog changes; returns the disposer. */
  onChange(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  #notify() {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        this.log(`目录变更监听器抛错：${errorMessage(error)}`)
      }
    }
  }
}

/** Cheap structural comparison: ids, names, and the capabilities that matter. */
function sameCatalog(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const left = a[i]
    const right = b[i]
    if (left.id !== right.id || left.name !== right.name) return false
    if (left.ratio !== right.ratio || left.context !== right.context) return false
    if (left.supportsImages !== right.supportsImages) return false
    if (left.busyLevel !== right.busyLevel) return false
    if (left.strengths.length !== right.strengths.length) return false
  }
  return true
}
