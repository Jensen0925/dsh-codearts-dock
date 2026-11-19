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
  'dsh-connect-codearts',
)

/** Where the settings page writes the account store. */
export const CREDENTIAL_PATH = join(CONFIG_DIR, 'credentials.json')

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

/** Environment variable names, checked first. */
export const ENV_AK = 'CODEARTS_AK'
export const ENV_SK = 'CODEARTS_SK'
export const ENV_TOKEN = 'CODEARTS_SECURITY_TOKEN'
