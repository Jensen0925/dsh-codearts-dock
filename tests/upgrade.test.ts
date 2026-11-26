/**
 * Upgrading from the pre-1.2 name keeps the user's data.
 *
 * The package was renamed to `dsh-codearts-dock`; the config directory and
 * settings namespace followed. That makes exactly one
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
import { test } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const check = (name: string, fn: () => void | Promise<void>) => test(name, fn)

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
} = await import('../src/paths.ts')
const accounts = await import('../src/accounts.ts')
const { readPreferences } = await import('../src/preferences.ts')
const preferences = await import('../src/preferences.ts')
const checkinModule = await import('../src/checkin.ts')
const checkin = checkinModule as unknown as {
  readCheckinState(): { accounts: Record<string, Record<string, { claimed: boolean }>> }
}
await check('configuration paths prefer the current name and include the legacy fallback', () => {
  assert.ok(CONFIG_DIR.endsWith('dsh-codearts-dock'), `current dir uses the new name: ${CONFIG_DIR}`)
  assert.ok(LEGACY_CONFIG_DIR.endsWith('dsh-connect-codearts'), `legacy dir uses the old name: ${LEGACY_CONFIG_DIR}`)
  assert.ok(!existsSync(CONFIG_DIR), 'the scratch home starts with no current directory at all')
})

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
    JSON.stringify({ composerChip: false, refreshIntervalMs: 120000, favoriteModelIds: ['kept-model'], modelPresets: [{ id: 'legacy-preset', name: 'Legacy', enabledModelIds: ['old-preset-model'], modelOverrides: {} }], enabledModelIds: ['kept-model'], modelOverrides: { 'kept-model': { images: true } } }),
  )
  const read = readPreferences()
  assert.equal(read.composerChip, false)
  assert.equal(read.refreshIntervalMs, 120000)
  assert.deepEqual(read.favoriteModelIds, ['kept-model'])
  assert.deepEqual(preferences.validatePreferences(read), { composerChip: false, refreshIntervalMs: 120000, enabledModelIds: ['kept-model'], modelOverrides: { 'kept-model': { images: true } } })
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

test('cleanup scratch data', () => {
  rmSync(scratch, { recursive: true, force: true })
})
