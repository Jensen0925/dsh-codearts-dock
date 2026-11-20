/** Versioned portable configuration; credential-bearing files are always authenticated encryption. */
import { randomBytes, scrypt, createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { InputError, validatePreferences } from './preferences.js'
const derive = promisify(scrypt)
const FORMAT = 'dsh-connect-codearts-backup'
const ENCRYPTED = 'dsh-connect-codearts-encrypted'
const MAX_BYTES = 512 * 1024
const invalid = (message = '备份格式或版本不受支持') => { throw new InputError(message) }
function passwordCheck(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 256) invalid('备份密码需为 8 到 256 个字符')
}
function validatePayload(value) {
  if (!value || value.format !== FORMAT || value.version !== 1 || !value.preferences) invalid()
  const preferences = validatePreferences(value.preferences)
  const result = { format: FORMAT, version: 1, preferences }
  if ('accounts' in value) {
    if (!Array.isArray(value.accounts) || value.accounts.length > 100) invalid('备份最多包含 100 个账号')
    const knownKeys = new Set()
    result.accounts = value.accounts.map((account) => {
      if (!account || typeof account.ak !== 'string' || typeof account.sk !== 'string' || !account.ak.trim() || !account.sk.trim() || account.ak.length > 512 || account.sk.length > 512 || (account.label !== undefined && (typeof account.label !== 'string' || account.label.length > 100))) invalid('备份包含不合法的账号')
      const ak = account.ak.trim()
      if (knownKeys.has(ak)) invalid('备份包含重复账号')
      knownKeys.add(ak)
      return { ak, sk: account.sk.trim(), ...(account.label ? { label: account.label } : {}) }
    })
  }
  if (value.activeAccountId !== undefined) {
    if (typeof value.activeAccountId !== 'string' || !result.accounts?.some((entry) => createHash('sha256').update(entry.ak).digest('hex').slice(0, 16) === value.activeAccountId)) invalid('备份的当前账号不合法')
    result.activeAccountId = value.activeAccountId
  }
  return result
}
export async function encodeBackup({ preferences, accounts, activeAccountId, includeCredentials = false, password = '' }) {
  const payload = { format: FORMAT, version: 1, createdAt: new Date().toISOString(), preferences: validatePreferences(preferences) }
  if (includeCredentials) {
    payload.accounts = accounts ?? []
    if (activeAccountId) payload.activeAccountId = activeAccountId
  }
  validatePayload(payload)
  const data = Buffer.from(JSON.stringify(payload))
  if (data.length > MAX_BYTES) invalid('备份内容过大')
  if (!includeCredentials && !password) return payload
  passwordCheck(password)
  const salt = randomBytes(16), iv = randomBytes(12)
  const key = await derive(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(`${ENCRYPTED}:1`))
    const sealed = Buffer.concat([cipher.update(data), cipher.final()])
    return { format: ENCRYPTED, version: 1, cipher: 'aes-256-gcm', kdf: 'scrypt', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: sealed.toString('base64') }
  } finally { key.fill(0) }
}
export async function decodeBackup(text, password = '') {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES * 1.5) invalid('备份文件过大或内容不正确')
  let raw
  try { raw = JSON.parse(text) } catch { invalid('备份不是合法 JSON') }
  if (raw?.format === FORMAT) {
    if ('accounts' in raw || 'activeAccountId' in raw) invalid('含凭证的备份必须为加密文件')
    return validatePayload(raw)
  }
  if (raw?.format !== ENCRYPTED || raw.version !== 1 || raw.cipher !== 'aes-256-gcm' || raw.kdf !== 'scrypt') invalid()
  passwordCheck(password)
  const bytes = (field, size) => {
    const encoded = raw[field]
    if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) invalid()
    const value = Buffer.from(encoded, 'base64')
    if ((size && value.length !== size) || (!size && value.length > MAX_BYTES)) invalid()
    return value
  }
  const salt = bytes('salt', 16), iv = bytes('iv', 12), tag = bytes('tag', 16), data = bytes('data')
  const key = await derive(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  let payload
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(Buffer.from(`${ENCRYPTED}:1`))
    decipher.setAuthTag(tag)
    payload = JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'))
  } catch { invalid('密码错误，或备份文件已损坏') } finally { key.fill(0) }
  return validatePayload(payload)
}
export function backupSummary(payload, currentSettings, knownAccounts = []) {
  const known = new Set(knownAccounts.map((entry) => entry.ak))
  return {
    preferences: payload.preferences,
    changes: Object.keys(payload.preferences).filter((key) => JSON.stringify(currentSettings[key]) !== JSON.stringify(payload.preferences[key])),
    accounts: { total: payload.accounts?.length ?? 0, added: payload.accounts?.filter((entry) => !known.has(entry.ak)).length ?? 0, updated: payload.accounts?.filter((entry) => known.has(entry.ak)).length ?? 0 },
  }
}
