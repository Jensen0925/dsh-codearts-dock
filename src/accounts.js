/**
 * The account store: many credential pairs, one of them active.
 *
 * A 码道 user commonly has more than one Huawei Cloud account — a personal one
 * and a work one, or several teammates' keys for a shared machine. Holding
 * exactly one pair forced a delete-and-retype whenever they switched, which is
 * also how a key gets lost.
 *
 * The file is one JSON document:
 *
 *   { "version": 2,
 *     "activeId": "…",
 *     "accounts": [ { "id": "…", "ak": "…", "sk": "…", "label": "…" } ] }
 *
 * A v1 file (a bare `{ak, sk}`) is migrated into a single-account document on
 * first read, so an existing install keeps working without the user noticing.
 *
 * SECURITY: this file holds permanent keys in plain text, exactly as the v1
 * layout did. It is written mode 0600 inside the user's config directory, and
 * the settings page never returns a full key to the browser — only a mask.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { CONFIG_DIR, CREDENTIAL_PATH, LEGACY_CREDENTIAL_PATH } from './paths.js'

/** Current on-disk schema version. */
export const STORE_VERSION = 2

/**
 * @typedef {object} Account
 * @property {string} id stable local id, derived from the AK.
 * @property {string} ak access key id.
 * @property {string} sk secret access key.
 * @property {string} [label] user-supplied name, else derived from the AK.
 * @property {string} [accountName] the Huawei account name, once resolved.
 * @property {number} [addedAt] epoch ms.
 */

/**
 * @typedef {object} StoreDocument
 * @property {number} version
 * @property {string|null} activeId
 * @property {Account[]} accounts
 */

/**
 * A stable id for an account, so re-importing the same key updates that entry
 * rather than stacking a duplicate. Derived from the AK only: the secret may be
 * rotated in place and the account is still the same account.
 * @param {string} ak access key id.
 * @returns {string} the id.
 */
export function accountIdOf(ak) {
  return createHash('sha256').update(String(ak).trim()).digest('hex').slice(0, 16)
}

/** A short display label when the user has not named the account. */
export function defaultLabel(ak) {
  const text = String(ak ?? '')
  return text.length > 8 ? `${text.slice(0, 4)}…${text.slice(-4)}` : text
}

/** Mask a key for display: enough to recognise, not enough to reuse. */
export function maskKey(value) {
  if (!value) return ''
  const text = String(value)
  if (text.length <= 8) return `${text.slice(0, 2)}****`
  return `${text.slice(0, 4)}…${text.slice(-4)}`
}

/** An empty document. */
export function emptyStore() {
  return { version: STORE_VERSION, activeId: null, accounts: [] }
}

/**
 * Normalise anything read from disk into a v2 document.
 *
 * Accepts a v2 document, a v1 `{ak, sk}` pair, or an array of pairs, so
 * hand-written files and older layouts both load.
 *
 * @param {unknown} parsed whatever JSON.parse produced.
 * @returns {StoreDocument} a valid document.
 */
export function normaliseStore(parsed) {
  if (parsed === null || typeof parsed !== 'object') return emptyStore()

  if (Array.isArray(parsed)) {
    const accounts = parsed.map(accountFrom).filter(Boolean)
    return { version: STORE_VERSION, activeId: accounts[0]?.id ?? null, accounts }
  }

  const record = parsed
  if (Array.isArray(record.accounts)) {
    const accounts = record.accounts.map(accountFrom).filter(Boolean)
    const activeId =
      typeof record.activeId === 'string' && accounts.some((a) => a.id === record.activeId)
        ? record.activeId
        : (accounts[0]?.id ?? null)
    return { version: STORE_VERSION, activeId, accounts }
  }

  // v1: a bare pair. Promote it.
  const single = accountFrom(record)
  return single
    ? { version: STORE_VERSION, activeId: single.id, accounts: [single] }
    : emptyStore()
}

/**
 * Turn one raw entry into an account, tolerating the field spellings a user may
 * paste from the Huawei console or a CSV export.
 * @returns {Account|null} the account, or null when it carries no usable pair.
 */
function accountFrom(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const ak = raw.ak ?? raw.accessKeyId ?? raw.access_key_id ?? raw['Access Key Id']
  const sk = raw.sk ?? raw.secretAccessKey ?? raw.secret_access_key ?? raw['Secret Access Key']
  if (!ak || !sk) return null
  const trimmedAk = String(ak).trim()
  const trimmedSk = String(sk).trim()
  if (trimmedAk === '' || trimmedSk === '') return null
  const label = typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label.trim() : undefined
  const accountName =
    typeof raw.accountName === 'string' && raw.accountName.trim() !== ''
      ? raw.accountName.trim()
      : typeof raw.account === 'string' && raw.account.trim() !== ''
        ? raw.account.trim()
        : undefined
  return {
    id: accountIdOf(trimmedAk),
    ak: trimmedAk,
    sk: trimmedSk,
    ...(label ? { label } : {}),
    ...(accountName ? { accountName } : {}),
    ...(typeof raw.addedAt === 'number' ? { addedAt: raw.addedAt } : {}),
  }
}

/**
 * Read the store, migrating a v1 file when that is what is there.
 *
 * Remembers which file answered, because reporting the configured path while
 * silently reading the legacy one makes every path-based diagnosis wrong.
 * @returns {StoreDocument} the document.
 */
export function readStore() {
  const located = locateStore()
  return located.store
}

/**
 * Find and parse the store file, reporting where it came from.
 * @returns {{store: StoreDocument, path: string|null}} the document and its source file.
 */
export function locateStore() {
  for (const path of [CREDENTIAL_PATH, LEGACY_CREDENTIAL_PATH]) {
    if (!existsSync(path)) continue
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      return { store: normaliseStore(parsed), path }
    } catch {
      // A corrupt file is reported by the settings page rather than thrown at
      // load time; another source may still work.
    }
  }
  return { store: emptyStore(), path: null }
}

/** Write the store atomically, with owner-only permissions. */
async function writeStore(document) {
  await mkdir(CONFIG_DIR, { recursive: true })
  const body = `${JSON.stringify(document, null, 2)}\n`
  const temp = `${CREDENTIAL_PATH}.tmp`
  await writeFile(temp, body, { encoding: 'utf8', mode: 0o600 })
  await rename(temp, CREDENTIAL_PATH)
  try {
    // rename preserves the temp file's mode, but be explicit: an existing file
    // with looser permissions would otherwise keep them.
    const mode = statSync(CREDENTIAL_PATH).mode & 0o777
    if (mode !== 0o600) await writeFile(CREDENTIAL_PATH, body, { encoding: 'utf8', mode: 0o600 })
  } catch {
    // Permission tightening is best-effort.
  }
  return document
}

// Account checks and imports can overlap; serialize the complete read-modify-write.
let accountMutation = Promise.resolve()
function mutateAccounts(operation) {
  const result = accountMutation.then(operation)
  accountMutation = result.catch(() => {})
  return result
}
export const addAccount = (...args) => mutateAccounts(() => addAccountUnlocked(...args))
export const addAccounts = (...args) => mutateAccounts(() => addAccountsUnlocked(...args))
export const removeAccount = (...args) => mutateAccounts(() => removeAccountUnlocked(...args))
export const setActiveAccount = (...args) => mutateAccounts(() => setActiveAccountUnlocked(...args))
export const renameAccount = (...args) => mutateAccounts(() => renameAccountUnlocked(...args))
export const rememberAccountName = (...args) => mutateAccounts(() => rememberAccountNameUnlocked(...args))

/**
 * Add one account, or update it when the AK is already present.
 * @param {object} input the pair plus optional label.
 * @param {string} input.ak access key id.
 * @param {string} input.sk secret access key.
 * @param {string} [input.label] display name.
 * @returns {Promise<{account: Account, added: boolean, store: StoreDocument}>} the outcome.
 */
async function addAccountUnlocked({ ak, sk, label }) {
  const candidate = accountFrom({ ak, sk, label, addedAt: Date.now() })
  if (!candidate) throw new Error('Access Key ID 和 Secret Access Key 都要填。')

  const store = readStore()
  const existing = store.accounts.findIndex((account) => account.id === candidate.id)
  const added = existing < 0
  if (added) {
    store.accounts.push(candidate)
  } else {
    // Same AK: refresh the secret and let an explicit new label win.
    store.accounts[existing] = {
      ...store.accounts[existing],
      sk: candidate.sk,
      ...(candidate.label ? { label: candidate.label } : {}),
    }
  }
  // The first account added becomes active; adding more never steals focus.
  store.activeId ??= candidate.id
  await writeStore(store)
  return { account: store.accounts[added ? store.accounts.length - 1 : existing], added, store }
}

/**
 * Add several accounts at once, as an import does.
 *
 * @param {Array<object>} entries raw pairs, in the order supplied.
 * @returns {Promise<{added: number, updated: number, skipped: number, store: StoreDocument}>} the outcome.
 */
async function addAccountsUnlocked(entries) {
  const store = readStore()
  let added = 0
  let updated = 0
  let skipped = 0

  for (const entry of entries ?? []) {
    const candidate = accountFrom({ ...entry, addedAt: Date.now() })
    if (!candidate) {
      skipped += 1
      continue
    }
    const existing = store.accounts.findIndex((account) => account.id === candidate.id)
    if (existing < 0) {
      store.accounts.push(candidate)
      added += 1
    } else {
      store.accounts[existing] = {
        ...store.accounts[existing],
        sk: candidate.sk,
        ...(candidate.label ? { label: candidate.label } : {}),
      }
      updated += 1
    }
  }

  store.activeId ??= store.accounts[0]?.id ?? null
  if (added > 0 || updated > 0) await writeStore(store)
  return { added, updated, skipped, store }
}

/**
 * Remove one account.
 * @param {string} id account id.
 * @returns {Promise<StoreDocument>} the store after removal.
 */
async function removeAccountUnlocked(id) {
  const store = readStore()
  store.accounts = store.accounts.filter((account) => account.id !== id)
  // Removing the active account promotes whatever is left, so the plugin never
  // points at an id that no longer exists.
  if (store.activeId !== null && !store.accounts.some((account) => account.id === store.activeId)) {
    store.activeId = store.accounts[0]?.id ?? null
  }
  await writeStore(store)
  return store
}

/**
 * Choose which account requests use.
 * @param {string} id account id.
 * @returns {Promise<StoreDocument>} the updated store.
 */
async function setActiveAccountUnlocked(id) {
  const store = readStore()
  if (!store.accounts.some((account) => account.id === id)) {
    throw new Error(`没有这个账号：${id}`)
  }
  store.activeId = id
  await writeStore(store)
  return store
}

/**
 * Give an account a display name.
 * @param {string} id account id.
 * @param {string} label the new name; an empty string clears it.
 * @returns {Promise<StoreDocument>} the updated store.
 */
async function renameAccountUnlocked(id, label) {
  const store = readStore()
  const account = store.accounts.find((entry) => entry.id === id)
  if (!account) throw new Error(`没有这个账号：${id}`)
  const trimmed = String(label ?? '').trim()
  if (trimmed === '') delete account.label
  else account.label = trimmed
  await writeStore(store)
  return store
}

/**
 * Record the Huawei account name once the gateway reveals it, so the pool can
 * show `hw045…` instead of a masked AK.
 * @param {string} id account id.
 * @param {string} accountName the name from the STS token.
 * @returns {Promise<void>} resolves when written.
 */
async function rememberAccountNameUnlocked(id, accountName) {
  if (!accountName) return
  const store = readStore()
  const account = store.accounts.find((entry) => entry.id === id)
  if (!account || account.accountName === accountName) return
  account.accountName = accountName
  await writeStore(store)
}

/** The active account, or null when none is configured. */
export function activeAccount(store = readStore()) {
  if (store.activeId === null) return null
  return store.accounts.find((account) => account.id === store.activeId) ?? null
}

/**
 * Parse an import payload into credential pairs.
 *
 * Accepts the shapes a user actually has:
 *   - a JSON document (a v2 store, an array, a single pair, or `accounts`)
 *   - a Huawei `credentials.csv` with the Access Key Id / Secret Access Key headers
 *   - `AK,SK` lines, or `AK<TAB>SK`, with an optional trailing label
 *
 * @param {string} text the pasted or uploaded text.
 * @returns {{accounts: Array<{ak: string, sk: string, label?: string}>, skipped: number}} parsed pairs and how many lines were unusable.
 */
export function parseImport(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return { accounts: [], skipped: 0 }

  // JSON first: it is unambiguous when it parses.
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw)
      const store = normaliseStore(parsed)
      return {
        accounts: store.accounts.map(({ ak, sk, label }) => ({ ak, sk, ...(label ? { label } : {}) })),
        skipped: 0,
      }
    } catch {
      // Fall through to the line formats.
    }
  }

  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  if (lines.length === 0) return { accounts: [], skipped: 0 }

  // A CSV header tells us which column is which; without it, assume AK first.
  let akIndex = 0
  let skIndex = 1
  let labelIndex = 2
  let start = 0
  const header = lines[0].toLowerCase()
  if (header.includes('access key') || header.includes('secret') || header.includes('ak')) {
    const cells = splitLine(lines[0]).map((cell) => cell.toLowerCase())
    const akAt = cells.findIndex((cell) => cell.includes('access key') || cell === 'ak')
    const skAt = cells.findIndex((cell) => cell.includes('secret') || cell === 'sk')
    if (akAt >= 0 && skAt >= 0) {
      akIndex = akAt
      skIndex = skAt
      // A "User Name,Access Key Id,Secret Access Key" export names the account
      // in an earlier column, which makes a far better label than a masked AK.
      // Looking for it here rather than only in an `else` branch is what makes
      // that worksheet import labelled.
      const nameAt = cells.findIndex(
        (cell) => cell.includes('user name') || cell.includes('username') || cell.includes('account'),
      )
      labelIndex = nameAt >= 0 ? nameAt : -1
      start = 1
    }
  }

  const accounts = []
  let skipped = 0
  for (const line of lines.slice(start)) {
    const cells = splitLine(line)
    const ak = (cells[akIndex] ?? '').trim()
    const sk = (cells[skIndex] ?? '').trim()
    const label = labelIndex >= 0 ? (cells[labelIndex] ?? '').trim() : ''
    if (ak === '' || sk === '') {
      skipped += 1
      continue
    }
    accounts.push({ ak, sk, ...(label ? { label } : {}) })
  }
  return { accounts, skipped }
}

/** Split one delimiter-separated line, honouring simple quoting. */
function splitLine(line) {
  const text = String(line)
  if (text.includes('\t')) return text.split('\t')
  if (text.includes(',')) {
    const cells = []
    let current = ''
    let quoted = false
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]
      if (ch === '"') {
        if (quoted && text[i + 1] === '"') {
          current += '"'
          i += 1
        } else {
          quoted = !quoted
        }
      } else if (ch === ',' && !quoted) {
        cells.push(current)
        current = ''
      } else {
        current += ch
      }
    }
    cells.push(current)
    return cells
  }
  return text.split(/\s+/)
}

/**
 * Render the store as text a user can paste into another install.
 *
 * Deliberately the export format and the import format are the same document,
 * so a round trip through the clipboard keeps labels and the active choice.
 * @param {StoreDocument} [store] the store to export.
 * @returns {string} JSON text.
 */
export function exportStore(store = readStore()) {
  return `${JSON.stringify(store, null, 2)}\n`
}

/** A public view of one account: no secret material. */
export function publicAccount(account, store) {
  return {
    id: account.id,
    // `renameable: false` means the label shown is the derived fallback rather
    // than a name the user chose — the editor uses that to start empty instead
    // of prefilling a placeholder the user would have to delete.
    renameable: typeof account.label === 'string' && account.label !== '',
    label: account.label ?? defaultLabel(account.ak),
    akMasked: maskKey(account.ak),
    accountName: account.accountName ?? null,
    active: store.activeId === account.id,
  }
}

/** Where a new save would write, for the settings page. */
export function storeWritePath() {
  return CREDENTIAL_PATH
}

/** A fresh local id for a file that has none. */
export function newLocalId() {
  return randomUUID()
}
