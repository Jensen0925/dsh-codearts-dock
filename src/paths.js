/**
 * Paths and environment names this plugin reads and writes.
 *
 * Extracted so the account store and the credential resolver can both use them
 * without importing each other: the resolver needs the store to find the active
 * account, and the store needs these paths to find its file. Keeping the
 * constants here makes that a one-way dependency instead of a cycle.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** Configuration directory for this plugin. */
export const CONFIG_DIR = join(
  process.env.APPDATA || join(homedir(), '.config'),
  'dsh-codearts-dock',
)

/**
 * Where this plugin kept its files under its pre-1.2 name.
 *
 * Read-only: every loader consults this after {@link CONFIG_DIR}, and the first
 * successful save writes the new location, so a user who upgrades keeps their
 * accounts, preferences and check-in record without doing anything. Nothing is
 * ever written back into it — moving is a copy, and leaving the original in
 * place means a downgrade still finds its own files.
 *
 * Overridable so a test can run against a scratch home.
 */
export const LEGACY_CONFIG_DIR =
  process.env.DSH_CODEARTS_LEGACY_CONFIG_DIR ||
  join(process.env.APPDATA || join(homedir(), '.config'), 'dsh-connect-codearts')

/** Where the settings page writes the account store. */
export const CREDENTIAL_PATH = join(CONFIG_DIR, 'credentials.json')

/** Where the account store used to live; read when the new one is absent. */
export const LEGACY_CONFIG_CREDENTIAL_PATH = join(LEGACY_CONFIG_DIR, 'credentials.json')

/**
 * Where builds before the account store wrote a single pair; read for migration.
 *
 * Overridable so a test can run against a scratch home: the store consults this
 * file whenever the configured one is absent, and without an override a test
 * would silently read the developer's real credential.
 */
export const LEGACY_CREDENTIAL_PATH =
  process.env.DSH_CONNECT_CODEARTS_LEGACY_CREDENTIAL ||
  join(homedir(), '.dsh-connect-codearts', 'credentials.json')

/**
 * Candidate files for one plugin file, newest location first.
 *
 * Every reader funnels through this so the migration order is stated once
 * instead of being re-derived at each call site.
 *
 * @param {string} name file name inside the config directory.
 * @returns {string[]} absolute paths, most current first.
 */
export function configCandidates(name) {
  return [join(CONFIG_DIR, name), join(LEGACY_CONFIG_DIR, name)]
}

/** Environment variable names, checked first. */
export const ENV_AK = 'CODEARTS_AK'
export const ENV_SK = 'CODEARTS_SK'
export const ENV_TOKEN = 'CODEARTS_SECURITY_TOKEN'
