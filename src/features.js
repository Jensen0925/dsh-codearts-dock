/** Feature routes kept separate from protocol/credential handling. */
import { randomUUID } from 'node:crypto'
import { InputError, persistPreferences, portablePreferences, validatePreferences, validateSelection } from './preferences.js'
import { encodeBackup, decodeBackup, backupSummary } from './backup.js'
import { readStore, addAccounts, setActiveAccount } from './accounts.js'

export async function applyPreferences(deps, patch) {
  const validated = validatePreferences(patch)
  await persistPreferences(validated)
  Object.assign(deps.settings, validated)
  if ('refreshIntervalMs' in validated) deps.rescheduleCatalog?.()
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
    return serial(() => applyPreferences(deps, body))
  })
  route('/presets', async (req) => {
    const body = await readBody(req)
    return serial(async () => {
      let presets = [...deps.settings.modelPresets]
      if (body.action === 'delete') {
        if (typeof body.id !== 'string' || !presets.some((entry) => entry.id === body.id)) throw new InputError('预设不存在')
        presets = presets.filter((entry) => entry.id !== body.id)
      } else if (body.action === 'save') {
        const selection = validateSelection(body)
        const preset = { id: body.id || randomUUID(), name: body.name, ...selection }
        const index = presets.findIndex((entry) => entry.id === preset.id)
        if (index < 0) presets.push(preset)
        else presets[index] = preset
      } else throw new InputError('未知预设操作')
      await applyPreferences(deps, { modelPresets: presets })
      return { ok: true, presets: deps.settings.modelPresets }
    })
  })
  route('/backup/export', async (req) => {
    const body = await readBody(req)
    const store = body.includeCredentials === true ? readStore() : null
    const backup = await encodeBackup({
      preferences: portablePreferences(deps.settings),
      activeAccountId: store?.activeId,
      accounts: body.includeCredentials === true ? store.accounts.map(({ ak, sk, label }) => ({ ak, sk, ...(label ? { label } : {}) })) : undefined,
      includeCredentials: body.includeCredentials === true,
      password: body.password,
    })
    return { ok: true, backup }
  })
  route('/backup/preview', async (req) => {
    const body = await readBody(req)
    const payload = await decodeBackup(body.text, body.password)
    return { ok: true, ...backupSummary(payload, portablePreferences(deps.settings), readStore().accounts) }
  })
  route('/backup/restore', async (req) => {
    const body = await readBody(req)
    const payload = await decodeBackup(body.text, body.password)
    return serial(async () => {
      const preserveActive = Boolean(readStore().activeId)
      const result = payload.accounts?.length ? await addAccounts(payload.accounts) : { added: 0, updated: 0 }
      if (!preserveActive && payload.activeAccountId) await setActiveAccount(payload.activeAccountId)
      await applyPreferences(deps, payload.preferences)
      deps.invalidateAccounts?.()
      deps.credentials.invalidate()
      void deps.refresh()
      return { ok: true, added: result.added, updated: result.updated, preferences: portablePreferences(deps.settings) }
    })
  })
}
