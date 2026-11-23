/**
 * Credential resolution and the STS cache.
 *
 * The gateway needs three values — AK, SK, and a security token. What a user
 * actually has falls into one of three cases:
 *
 *   A. a permanent AK/SK pair      -> exchanged for STS at runtime, renewed
 *   B. an already-exchanged triple -> used directly, refreshed when it expires
 *   C. nothing configured          -> borrowed from the CodeArts client's
 *                                    local sign-in state
 *
 * Sources are tried in that order, and each candidate is *verified* before
 * it is adopted: a file that still exists but whose key was disabled would
 * otherwise leave the user stuck on a source that can never work.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getSts, StsError } from './sts.js'
import { activeAccount, defaultLabel, locateStore } from './accounts.js'
import {
  CONFIG_DIR,
  CREDENTIAL_PATH,
  ENV_AK,
  ENV_SK,
  ENV_TOKEN,
  LEGACY_CONFIG_CREDENTIAL_PATH,
  LEGACY_CREDENTIAL_PATH,
} from './paths.js'

// Re-exported so callers that imported these from here keep working.
export {
  CONFIG_DIR,
  CREDENTIAL_PATH,
  ENV_AK,
  ENV_SK,
  ENV_TOKEN,
  LEGACY_CONFIG_CREDENTIAL_PATH,
  LEGACY_CREDENTIAL_PATH,
}

/** A user-facing credential failure with actionable text. */
export class CredentialError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CredentialError'
  }
}

/**
 * @typedef {object} StoredKey
 * @property {string} ak access key id.
 * @property {string} sk secret access key.
 * @property {string} [securityToken] a pre-exchanged token, when the source supplies one.
 * @property {string|number} [expiresAt] token expiry.
 * @property {string} [account] account name, when known.
 */

/**
 * @typedef {object} CredentialCandidate
 * @property {StoredKey} key the credential values.
 * @property {'env'|'file'|'legacy-file'|'codearts'|'config'} source which source produced it.
 * @property {string} label human-readable description for the settings page.
 */

/**
 * Read the plugin's saved credentials, tolerating every field spelling.
 * @param {string} [path] file to read.
 * @returns {StoredKey|null} the parsed key, or null when absent.
 */
export function readSavedCredentials(path = CREDENTIAL_PATH) {
  const candidates = [path, LEGACY_CONFIG_CREDENTIAL_PATH, LEGACY_CREDENTIAL_PATH]
  for (const candidate of [...new Set(candidates)]) {
    if (!existsSync(candidate)) continue
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8'))
      const key = normaliseKey(parsed)
      if (key) return key
    } catch {
      // A corrupt file is reported by the settings page, not fatal at load
      // time: another source may still work.
    }
  }
  return null
}

/** Accept the field spellings a user may paste from the Huawei console. */
function normaliseKey(parsed) {
  if (parsed === null || typeof parsed !== 'object') return null
  const ak = parsed.ak ?? parsed.accessKeyId ?? parsed.access_key_id ?? parsed['Access Key Id']
  const sk = parsed.sk ?? parsed.secretAccessKey ?? parsed.secret_access_key ?? parsed['Secret Access Key']
  if (!ak || !sk) return null
  const securityToken = parsed.securityToken ?? parsed.security_token ?? parsed.token
  return {
    ak: String(ak).trim(),
    sk: String(sk).trim(),
    ...(securityToken ? { securityToken: String(securityToken) } : {}),
    ...(parsed.expiresAt ? { expiresAt: parsed.expiresAt } : {}),
    ...(parsed.account ? { account: String(parsed.account) } : {}),
  }
}

/** Which sources exist, most durable first. */
export function listCandidates() {
  /** @type {CredentialCandidate[]} */
  const candidates = []

  const envAk = process.env[ENV_AK]?.trim()
  const envSk = process.env[ENV_SK]?.trim()
  if (envAk && envSk) {
    const token = process.env[ENV_TOKEN]?.trim()
    candidates.push({
      key: { ak: envAk, sk: envSk, ...(token ? { securityToken: token } : {}) },
      source: 'env',
      label: `环境变量 ${ENV_AK} / ${ENV_SK}`,
    })
  }

  // The account store: the active account is the one requests use. Naming it
  // in the label is what lets a user see which of several accounts is live.
  // The path comes from the store itself rather than from CREDENTIAL_PATH: on a
  // profile that has not saved since the rename it is still the old file, and
  // naming a file that does not exist sends the user to the wrong place.
  const located = locateStore()
  const active = activeAccount(located.store)
  if (active) {
    candidates.push({
      key: { ak: active.ak, sk: active.sk, ...(active.accountName ? { account: active.accountName } : {}) },
      source: 'file',
      label: `账号「${active.label ?? defaultLabel(active.ak)}」（${located.path ?? CREDENTIAL_PATH}）`,
      accountId: active.id,
    })
  }

  const borrowed = readCodeArtsSignIn()
  if (borrowed) {
    candidates.push({
      key: borrowed.key,
      source: 'codearts',
      label: `码道客户端登录态（${borrowed.where}）`,
    })
  }

  return candidates
}

/**
 * Read the signed-in credential the CodeArts client keeps on this machine.
 *
 * The VS Code-derived client stores its global state in a SQLite database
 * (`state.vscdb`). Reading SQLite properly would need a native module the Host
 * does not carry — but the credential blob sits inside that file as plain JSON
 * text, so this reads the file as a string and pulls the fields out of the one
 * region that matters.
 *
 * The anchor is what makes that safe. The file is mostly binary, and brace
 * matching from an arbitrary `{` walks into unrelated data; the known marker
 * `"id":"huawei-cloud-authentication"` says "the sign-in JSON starts just after
 * here", so a short window past it is enough.
 *
 * Adopted from dsh-connect-madao (MIT, Copyright (c) 2026 XLNC-L): the anchor
 * approach, the field spellings, and the min-remaining guard are that project's.
 *
 * @param {number} [minRemainingMs] treat a token that expires sooner as absent.
 * @returns {{key: StoredKey, where: string, expiresAtMs: number|null}|null} the borrowed credential.
 */
export function readCodeArtsSignIn(minRemainingMs = 5 * 60 * 1000) {
  for (const path of candidateStateFiles()) {
    if (!existsSync(path)) continue
    let raw
    try {
      // Large file, but read whole: the anchor's offset is not predictable and a
      // chunked scan would have to stitch JSON across chunk boundaries.
      raw = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    const found = parseSignInBlob(raw, path)
    if (!found) continue
    // Found but nearly dead: skip rather than adopt a credential that will fail
    // on the first request. The next candidate may still work.
    if (found.expiresAtMs !== null && found.expiresAtMs - Date.now() < minRemainingMs) continue
    return found
  }
  return null
}

/** The known sign-in marker inside the client's state database. */
const SIGN_IN_ANCHOR = '"id":"huawei-cloud-authentication"'

/**
 * Pull the credential out of the region that follows the anchor.
 * @param {string} raw the whole state database as text.
 * @param {string} where the file it came from, for the settings page.
 * @returns {{key: StoredKey, where: string, expiresAtMs: number|null}|null} the credential.
 */
function parseSignInBlob(raw, where) {
  const at = raw.indexOf(SIGN_IN_ANCHOR)
  if (at < 0) return null
  // Fixed window rather than brace matching: the surrounding bytes are SQLite
  // pages, and a brace walk from here can wander into an unrelated object.
  const segment = raw.slice(at, at + 8192)
  const grab = (key) => {
    const match = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(segment)
    return match?.[1] || undefined
  }
  const ak = grab('accessKey')
  const sk = grab('secretKey')
  const securityToken = grab('securityToken')
  if (!ak || !sk || !securityToken) return null
  const expires = grab('expiresAt')
  const expiresAtMs = expires ? Date.parse(expires) : NaN
  const account = /"account"\s*:\s*\{[^}]*"label"\s*:\s*"([^"]+)"/.exec(segment)?.[1]
  return {
    key: {
      ak,
      sk,
      securityToken,
      ...(Number.isFinite(expiresAtMs) ? { expiresAt: expiresAtMs } : {}),
      ...(account ? { account } : {}),
    },
    where,
    expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : null,
  }
}

/** The locations the CodeArts client has used for its state database. */
function candidateStateFiles() {
  const home = homedir()
  const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
  const roots = [
    appData,
    join(home, '.config'),
    join(home, 'Library', 'Application Support'),
    join(home, 'AppData', 'Roaming'),
  ]
  const names = ['codearts-agent', 'CodeArts Agent', 'codearts']
  const files = []
  for (const root of roots) {
    for (const name of names) {
      files.push(join(root, name, 'User', 'globalStorage', 'state.vscdb'))
    }
  }
  return [...new Set(files)]
}

/**
 * Save a permanent AK/SK pair so it survives a restart.
 * @param {string} ak access key id.
 * @param {string} sk secret access key.
 * @returns {Promise<StoredKey>} the saved key.
 */
export async function saveCredentials(ak, sk) {
  const trimmedAk = (ak ?? '').trim()
  const trimmedSk = (sk ?? '').trim()
  if (!trimmedAk || !trimmedSk) {
    throw new CredentialError('Access Key ID 和 Secret Access Key 都要填。')
  }

  await mkdir(CONFIG_DIR, { recursive: true })
  const key = { ak: trimmedAk, sk: trimmedSk }
  // Write-then-rename so an interrupted save cannot leave a half file that
  // the next start would read as credentials.
  const temp = `${CREDENTIAL_PATH}.tmp`
  await writeFile(temp, `${JSON.stringify(key, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temp, CREDENTIAL_PATH)
  return key
}

/**
 * Remove the saved credentials.
 * @returns {Promise<void>} resolves when the file is gone.
 */
export async function clearCredentials() {
  const { rm } = await import('node:fs/promises')
  await rm(CREDENTIAL_PATH, { force: true })
}

/** Mask a key for display: enough to recognise, not enough to reuse. */
export function maskKey(value) {
  if (!value) return ''
  const text = String(value)
  if (text.length <= 8) return `${text.slice(0, 2)}****`
  return `${text.slice(0, 4)}…${text.slice(-4)}`
}

/**
 * A credential provider that resolves a usable triple and renews it before
 * expiry, so a long session never signs with a dead token.
 */
export class CredentialProvider {
  /**
   * @param {object} [options] provider options.
   * @param {number} [options.renewMarginMs] renew this early; 10 minutes default.
   */
  constructor(options = {}) {
    this.renewMarginMs = options.renewMarginMs ?? 600_000
    this.cached = null
    this.resolvedFrom = null
    this.pending = null
    this.renewTimer = null
    this.lastError = null
  }

  /**
   * Resolve a credential triple, using a cached one while it is fresh.
   * Concurrent callers share one resolution.
   * @returns {Promise<{key: StoredKey, source: string, label: string}>} the credential.
   */
  async resolve() {
    if (this.cached && this.#isFresh()) return this.cached
    if (this.pending) return this.pending
    this.pending = this.#resolveUncached().finally(() => {
      this.pending = null
    })
    return this.pending
  }

  /** Whether the cached triple is still usable with margin. */
  #isFresh() {
    if (!this.cached) return false
    if (this.cached.expiresAtMs === undefined) return true
    return Date.now() < this.cached.expiresAtMs - this.renewMarginMs
  }

  /** Try each source in order, adopting the first that verifies. */
  async #resolveUncached() {
    const candidates = listCandidates()
    if (candidates.length === 0) {
      throw new CredentialError(
        '未找到码道凭证。任选其一：\n' +
          `  A) 环境变量 ${ENV_AK} / ${ENV_SK}\n` +
          `  B) 在「设置 → 码道」填写永久 AK/SK（写入 ${CREDENTIAL_PATH}）\n` +
          '  C) 打开一次码道客户端并确认已登录 —— 插件会自动借用它的登录态\n' +
          'ak/sk 是华为云 IAM 访问密钥（控制台 → 我的凭证 → 访问密钥）；STS 临时令牌由插件自动换取。',
      )
    }

    const failures = []
    for (const candidate of candidates) {
      try {
        const resolved = await this.#verify(candidate)
        this.cached = resolved
        this.resolvedFrom = candidate
        this.lastError = null
        this.#scheduleRenewal()
        return resolved
      } catch (error) {
        failures.push(`${candidate.label} → ${error?.message ?? error}`)
      }
    }

    this.lastError = `所有凭证来源都不可用：\n${failures.map((line) => `  ${line}`).join('\n')}`
    throw new CredentialError(this.lastError)
  }

  /** Exchange (or accept) one candidate's credentials. */
  async #verify(candidate) {
    const key = candidate.key

    // A pre-exchanged triple is used as-is; nothing to verify offline.
    if (key.securityToken) {
      return {
        key,
        source: candidate.source,
        label: candidate.label,
        expiresAtMs: toEpochMs(key.expiresAt) ?? undefined,
      }
    }

    // A permanent pair is exchanged now, which both verifies it and yields
    // the token every later request signs with.
    const sts = await getSts(key.ak, key.sk)
    return {
      key: { ak: sts.ak, sk: sts.sk, securityToken: sts.securityToken, account: key.account },
      source: candidate.source,
      label: candidate.label,
      expiresAtMs: toEpochMs(sts.expiresAt) ?? Date.now() + 3600_000,
    }
  }

  /** Renew the cached triple before it expires. */
  #scheduleRenewal() {
    if (this.renewTimer) {
      clearTimeout(this.renewTimer)
      this.renewTimer = null
    }
    if (!this.cached?.expiresAtMs) return
    const delay = Math.max(60_000, this.cached.expiresAtMs - Date.now() - this.renewMarginMs)
    // `unref` keeps a pending renewal from holding the Host process open.
    this.renewTimer = setTimeout(() => {
      this.cached = null
      void this.resolve().catch(() => {
        // A failed renewal is retried on the next request instead of
        // surfacing here, where nothing could act on it.
      })
    }, delay)
    this.renewTimer.unref?.()
  }

  /** Drop the cached credential, forcing the next call to re-resolve. */
  invalidate() {
    this.cached = null
    if (this.renewTimer) {
      clearTimeout(this.renewTimer)
      this.renewTimer = null
    }
  }

  /** Stop the renewal timer; call when the plugin unloads. */
  dispose() {
    if (this.renewTimer) {
      clearTimeout(this.renewTimer)
      this.renewTimer = null
    }
    this.cached = null
  }

  /** The last resolution failure, for the settings page. */
  get errorText() {
    return this.lastError
  }

  /** The store id of the account now serving, when it came from the store. */
  get accountId() {
    return this.resolvedFrom?.accountId
  }

  /** Which source produced the current credential. */
  get source() {
    return this.resolvedFrom?.source
  }

  /** A description of the current source, for the settings page. */
  get sourceLabel() {
    return this.resolvedFrom?.label
  }
}

/** Accept an ISO-8601 string or a number as epoch milliseconds. */
function toEpochMs(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value
  const parsed = Date.parse(String(value))
  return Number.isNaN(parsed) ? null : parsed
}
