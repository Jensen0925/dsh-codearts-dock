// @ts-nocheck
/** Feature routes kept separate from protocol/credential handling. */
import { InputError, persistPreferences, portablePreferences, validatePreferences } from './preferences.js'
import { accountHealth } from './health.js'
import { validateContextOverrides } from './catalog.js'

/** Store only a fixed failure category, never the exception or upstream text. */
export function activityReason(error) {
  if (!error || error instanceof InputError || [400, 404, 413].includes(error.status)) return 'unknown'
  const state = accountHealth({ error }).state
  return state === 'available' ? 'unknown' : state
}

/** History is best-effort and cannot change an operation's outcome. */
export async function recordActivity(deps, action, status = 'success', details = {}) {
  try { await deps.activity?.record(action, status, details) } catch {}
}

/** Apply only to explicit business actions after the route's access checks. */
export async function recordOperation(deps, action, operation, summarize = () => ({})) {
  let result
  try {
    result = await operation()
  } catch (error) {
    await recordActivity(deps, action, 'error', { reason: activityReason(error) })
    throw error
  }
  let outcome = {}
  try { outcome = summarize(result) } catch {}
  const status = outcome.status ?? (result?.ok === false ? 'error' : 'success')
  const details = outcome.details ?? (status === 'error' ? { reason: activityReason(result.error || result.reason ? { message: result.error ?? result.reason } : null) } : {})
  await recordActivity(deps, outcome.action ?? action, status, details)
  return result
}

export async function applyPreferences(deps, patch) {
  const validated = validatePreferences(patch)
  if ('modelOverrides' in validated) validateContextOverrides(deps.catalog, validated.modelOverrides)
  const wasDailyCheckinEnabled = deps.settings.dailyCheckinEnabled === true
  await persistPreferences(validated)
  Object.assign(deps.settings, validated)
  if ('refreshIntervalMs' in validated) deps.rescheduleCatalog?.()
  if ('dailyCheckinEnabled' in validated && validated.dailyCheckinEnabled !== wasDailyCheckinEnabled) {
    deps.rescheduleDailyCheckin?.(validated.dailyCheckinEnabled)
  }
  if ('enabledModelIds' in validated || 'modelOverrides' in validated) {
    deps.catalog.configure({ enabledIds: deps.settings.enabledModelIds, overrides: deps.settings.modelOverrides })
    deps.ctx.emit('llm/models-updated', 'codearts')
  }
  return { ok: true, preferences: portablePreferences(deps.settings) }
}
export function registerFeatureRoutes(route, deps, readBody) {
  let mutation = Promise.resolve()
  const serial = (fn) => {
    const result = mutation.then(fn)
    mutation = result.catch(() => {})
    return result
  }
  route('/preferences', () => ({ ok: true, preferences: portablePreferences(deps.settings) }))
  route('/preferences/save', async (req) => {
    const body = await readBody(req)
    const action = typeof body.dailyCheckinEnabled === 'boolean'
      ? (body.dailyCheckinEnabled ? 'checkin.enable' : 'checkin.disable')
      : ('enabledModelIds' in body || 'modelOverrides' in body) ? 'models.save' : 'settings.save'
    return recordOperation(deps, action, () => serial(() => applyPreferences(deps, body)))
  })
}
