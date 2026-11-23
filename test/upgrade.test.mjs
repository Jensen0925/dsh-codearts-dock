/**
 * Upgrading from the pre-1.2 name keeps the user's data.
 *
 * The package was renamed to `dsh-codearts-dock`; the config directory, the
 * backup format ids and the settings namespace followed. That makes exactly one
 * thing dangerous: an install that upgrades must not come up looking empty.
 * "No accounts, no preferences, no claim history" is indistinguishable from a
 * first run, so nothing would report the bug — the user would simply be told to
 * enter their AK/SK again.
 *
 * Every reader therefore consults the new location first and the old one after.
 * This suite writes ONLY the old files and asserts the new build reads them,
 * then asserts the new location wins once it exists, so a later save cannot be
 * shadowed by a stale file left behind by the migration.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const results = []
const check = async (name, fn) => {
  try {
    await fn()
    results.push(`✓ ${name}`)
  } catch (error) {
    results.push(`✗ ${name}\n${error.stack}`)
    process.exitCode = 1
  }
}

// Point every directory at a scratch home BEFORE importing the modules: they
// evaluate their path constants at import time, and without this the suite
// would read — and, worse, could overwrite — the developer's real config.
const scratch = mkdtempSync(join(tmpdir(), 'dca-upgrade-'))
process.env.APPDATA = scratch
process.env.XDG_CONFIG_HOME = scratch
process.env.DSH_CONNECT_CODEARTS_LEGACY_CREDENTIAL = join(scratch, 'absent-pair.json')
delete process.env.CODEARTS_AK
delete process.env.CODEARTS_SK
delete process.env.CODEARTS_SECURITY_TOKEN
process.env.DSH_CODEARTS_LEGACY_CONFIG_DIR = join(scratch, 'dsh-connect-codearts')

const {
  CONFIG_DIR,
  LEGACY_CONFIG_DIR,
  configCandidates,
} = await import('../src/paths.js')
const accounts = await import('../src/accounts.js')
const { readPreferences } = await import('../src/preferences.js')
const preferences = await import('../src/preferences.js')
const checkin = await import('../src/checkin.js')
const { decodeBackup, encodeBackup } = await import('../src/backup.js')

assert.ok(CONFIG_DIR.endsWith('dsh-codearts-dock'), `current dir uses the new name: ${CONFIG_DIR}`)
assert.ok(LEGACY_CONFIG_DIR.endsWith('dsh-connect-codearts'), `legacy dir uses the old name: ${LEGACY_CONFIG_DIR}`)
assert.ok(!existsSync(CONFIG_DIR), 'the scratch home starts with no current directory at all')

await check('the candidates list states the migration order once', () => {
  const candidates = configCandidates('preferences.json')
  assert.equal(candidates.length, 2)
  assert.ok(candidates[0].startsWith(CONFIG_DIR), 'the current directory is tried first')
  assert.ok(candidates[1].startsWith(LEGACY_CONFIG_DIR), 'the old directory is the fallback')
})

await check('an account store written under the old name is still read', () => {
  mkdirSync(LEGACY_CONFIG_DIR, { recursive: true })
  // No `id` in the fixture on purpose: the store derives it from the AK, so a
  // real pre-rename file is what this exercises rather than a hand-made id.
  const document = {
    version: 2,
    accounts: [{ ak: 'AKFROMOLDNAME00001', sk: 'sk-old', label: '旧账号' }],
  }
  writeFileSync(join(LEGACY_CONFIG_DIR, 'credentials.json'), JSON.stringify(document))

  const located = accounts.locateStore()
  assert.equal(located.path, join(LEGACY_CONFIG_DIR, 'credentials.json'), 'reports the file it actually read')
  assert.equal(located.store.accounts.length, 1, 'the account survived the rename')
  assert.equal(located.store.accounts[0].ak, 'AKFROMOLDNAME00001')
  assert.equal(located.store.accounts[0].label, '旧账号', 'the user-supplied name survived too')
  assert.equal(accounts.readStore().activeId, located.store.accounts[0].id, 'the sole account becomes active')
})

await check('preferences written under the old name are still read', () => {
  writeFileSync(
    join(LEGACY_CONFIG_DIR, 'preferences.json'),
    JSON.stringify({ composerChip: false, refreshIntervalMs: 120000, favoriteModelIds: ['kept-model'] }),
  )
  const read = readPreferences()
  assert.equal(read.composerChip, false)
  assert.equal(read.refreshIntervalMs, 120000)
  assert.deepEqual(read.favoriteModelIds, ['kept-model'])
})

await check('the check-in record written under the old name is still read', () => {
  writeFileSync(
    join(LEGACY_CONFIG_DIR, 'checkin-state.json'),
    JSON.stringify({ accounts: { oldaccount: { 34: { day: '2026-11-23', claimed: true, at: 1795400000000 } } } }),
  )
  const state = checkin.readCheckinState()
  assert.ok(state.accounts.oldaccount, 'the claim history follows the rename')
  assert.equal(state.accounts.oldaccount['34'].claimed, true, 'the recorded outcome is intact')
})

await check('the current directory wins once it exists, so a stale old file cannot shadow a save', async () => {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(
    join(CONFIG_DIR, 'preferences.json'),
    JSON.stringify({ composerChip: true, refreshIntervalMs: 300000 }),
  )
  // The old file still says composerChip:false — it must not win.
  assert.equal(readPreferences().composerChip, true, 'the newer file is authoritative')
  assert.equal(readPreferences().refreshIntervalMs, 300000)

  // And a save lands in the new directory, leaving the old file untouched.
  await preferences.persistPreferences({ refreshIntervalMs: 600000 })
  const stored = JSON.parse(readFileSync(join(CONFIG_DIR, 'preferences.json'), 'utf8'))
  assert.equal(stored.refreshIntervalMs, 600000)
  const legacy = JSON.parse(readFileSync(join(LEGACY_CONFIG_DIR, 'preferences.json'), 'utf8'))
  assert.equal(legacy.refreshIntervalMs, 120000, 'the old file is never rewritten')
})

await check('a backup exported under the old format id still decrypts', async () => {
  // Hand-build a pre-rename envelope: old format id AND the old AAD, because the
  // seal authenticates the id it was written with. Reusing the current encoder
  // would test the new path against itself and prove nothing.
  const { randomBytes, scrypt, createCipheriv } = await import('node:crypto')
  const { promisify } = await import('node:util')
  const derive = promisify(scrypt)
  const payload = {
    format: 'dsh-connect-codearts-backup',
    version: 1,
    createdAt: '2026-11-20T00:00:00.000Z',
    preferences: { composerChip: false },
    accounts: [{ ak: 'AKFROMOLDBACKUP01', sk: 'sk-backup', label: '备份账号' }],
    // The store's own id derivation: sha256(ak) truncated. Writing any other
    // value would be rejected as an inconsistent file rather than exercising
    // the legacy-format path this check is about.
    activeAccountId: (await import('node:crypto')).createHash('sha256').update('AKFROMOLDBACKUP01').digest('hex').slice(0, 16),
  }
  const data = Buffer.from(JSON.stringify(payload))
  const password = 'old-backup-password'
  const salt = randomBytes(16), iv = randomBytes(12)
  const key = await derive(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  let envelope
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from('dsh-connect-codearts-encrypted:1'))
    const sealed = Buffer.concat([cipher.update(data), cipher.final()])
    envelope = {
      format: 'dsh-connect-codearts-encrypted',
      version: 1,
      cipher: 'aes-256-gcm',
      kdf: 'scrypt',
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: sealed.toString('base64'),
    }
  } finally {
    key.fill(0)
  }

  const decoded = await decodeBackup(JSON.stringify(envelope), password)
  assert.equal(decoded.accounts.length, 1, 'the old backup restores its account')
  assert.equal(decoded.accounts[0].ak, 'AKFROMOLDBACKUP01')
  assert.equal(decoded.format, 'dsh-codearts-dock-backup', 'normalised to the new id on the way in')

  // The wrong password must still fail: the old-AAD path is not a bypass of the
  // seal, it only names the id that was authenticated.
  await assert.rejects(decodeBackup(JSON.stringify(envelope), 'wrong-password'), /密码错误/)
})

await check('a backup exported now uses the new ids and still round-trips', async () => {
  const exported = await encodeBackup({
    preferences: { composerChip: true },
    accounts: [{ ak: 'AKNEWBACKUP000001', sk: 'sk-new' }],
    includeCredentials: true,
    password: 'new-backup-password',
  })
  assert.equal(exported.format, 'dsh-codearts-dock-encrypted')
  const decoded = await decodeBackup(JSON.stringify(exported), 'new-backup-password')
  assert.equal(decoded.accounts[0].ak, 'AKNEWBACKUP000001')
})

const failed = results.filter((line) => line.startsWith('✗'))
for (const line of results) console.log(line)
if (failed.length > 0) {
  console.error(`\nupgrade: ${failed.length} check(s) failed`)
} else {
  console.log('\nupgrade: all checks passed')
}
