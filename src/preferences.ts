// @ts-nocheck
/** Validated, atomic, serialized preferences shared by settings and migration. */
import { readFileSync } from 'node:fs'
import { mkdir, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CONFIG_DIR, configCandidates } from './paths.js'

export class InputError extends Error {}
export const FEATURE_DEFAULTS = Object.freeze({ modelPresets: [] })
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = (message) => { throw new InputError(message) }
const safeId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 200 && !['__proto__', 'constructor', 'prototype'].includes(id)
export function validateSelection(value) {
  if (!plain(value)) fail('模型配置格式不正确')
  const ids = value.enabledModelIds
  if (ids !== null && (!Array.isArray(ids) || ids.length > 500 || !ids.every(safeId) || !ids.length)) fail('至少启用一个模型；全部启用请使用 null')
  if (!plain(value.modelOverrides) || Object.keys(value.modelOverrides).length > 500) fail('模型覆盖配置格式不正确')
  const modelOverrides = {}
  for (const [id, patch] of Object.entries(value.modelOverrides)) {
    if (!safeId(id) || !plain(patch)) fail('模型覆盖配置格式不正确')
    const entry = {}
    for (const key of ['images', 'allowOff']) {
      if (key in patch) {
        if (typeof patch[key] !== 'boolean') fail('模型开关必须为布尔值')
        entry[key] = patch[key]
      }
    }
    if ('defaultStrength' in patch) {
      if (typeof patch.defaultStrength !== 'string' || (!patch.defaultStrength.trim() || patch.defaultStrength.length > 64)) fail('推理强度不正确')
      entry.defaultStrength = patch.defaultStrength
    }
    if (Object.keys(entry).length) modelOverrides[id] = entry
  }
  return { enabledModelIds: ids === null ? null : [...new Set(ids)], modelOverrides }
}
export function validatePreferences(input) {
  if (!plain(input)) fail('偏好设置格式不正确')
  const out = {}
  if ('composerChip' in input) {
    if (typeof input.composerChip !== 'boolean') fail('composerChip 必须为布尔值')
    out.composerChip = input.composerChip
  }
  // `favoriteModelIds` belonged to the retired model pinning UI. Ignore it so
  // old preferences and backups remain readable, but never carry it forward.
  if ('refreshIntervalMs' in input) {
    if (!Number.isInteger(input.refreshIntervalMs) || input.refreshIntervalMs < 60000 || input.refreshIntervalMs > 86400000) fail('刷新间隔必须在 1 分钟到 24 小时之间')
    out.refreshIntervalMs = input.refreshIntervalMs
  }
  if ('enabledModelIds' in input || 'modelOverrides' in input) Object.assign(out, validateSelection({ enabledModelIds: input.enabledModelIds ?? null, modelOverrides: input.modelOverrides ?? {} }))
  if ('modelPresets' in input) {
    if (!Array.isArray(input.modelPresets) || input.modelPresets.length > 20) fail('最多保存 20 套模型预设')
    const ids = new Set()
    out.modelPresets = input.modelPresets.map((preset) => {
      if (!plain(preset) || !safeId(preset.id) || preset.id.startsWith('builtin:') || ids.has(preset.id) || typeof preset.name !== 'string' || !preset.name.trim() || preset.name.trim().length > 48) fail('模型预设格式不正确或名称重复')
      ids.add(preset.id)
      return { id: preset.id, name: preset.name.trim(), ...validateSelection(preset) }
    })
  }
  return out
}
export const PREFERENCES_PATH = join(CONFIG_DIR, 'preferences.json')
export function readPreferences() {
  // Newest location first: a user upgrading from the pre-1.2 name keeps the
  // model selection and presets they already had.
  for (const path of configCandidates('preferences.json')) {
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'))
      return plain(value) ? value : {}
    } catch {
      // Absent or corrupt: try the older name, then fall back to defaults.
    }
  }
  return {}
}
let pending = Promise.resolve()
export function persistPreferences(patch) {
  const write = pending.then(async () => {
    await mkdir(CONFIG_DIR, { recursive: true })
    const path = `${PREFERENCES_PATH}.${randomUUID()}.tmp`
    const next = { ...readPreferences(), ...patch }
    delete next.favoriteModelIds
    await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    await rename(path, PREFERENCES_PATH)
    return next
  })
  pending = write.catch(() => {})
  return write
}
export function portablePreferences(settings) {
  return validatePreferences({
    composerChip: settings.composerChip !== false,
    modelPresets: settings.modelPresets ?? [],
    enabledModelIds: settings.enabledModelIds ?? null, modelOverrides: settings.modelOverrides ?? {},
    refreshIntervalMs: Math.max(60000, Math.min(86400000, Number(settings.refreshIntervalMs) || 300000)),
  })
}
