/** Run each offline suite in its own process so test environment overrides stay isolated. */
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const root = fileURLToPath(new URL('../', import.meta.url))
const files = readdirSync(new URL('../test/', import.meta.url)).filter((name) => name.endsWith('.test.mjs')).sort()
for (const file of files) {
  const result = spawnSync(process.execPath, ['--no-warnings', `test/${file}`], { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
