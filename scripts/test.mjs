/**
 * Run each offline suite in its own process so test environment overrides stay isolated.
 *
 * Every suite also runs twice on a foreign clock. A suite that reads the local
 * calendar — the check-in day key is exactly that — passes on the machine it was
 * written on and fails on a CI runner in another zone, which is a defect in the
 * test rather than in the code: it asserts the developer's timezone instead of
 * the behaviour. Running one extra pass under UTC turns that class of failure
 * into something visible locally, before a push.
 *
 *   node scripts/test.mjs            # each suite once, then once under each zone
 *   node scripts/test.mjs --once     # skip the extra zone passes
 */
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))

// Suites that assert on the local clock must still be correct here; UTC and a
// zone on the other side of the date line disagree with each other about "today"
// for most of the day, so a suite that only works in one of them is caught.
const ZONES = ['UTC', 'Pacific/Kiritimati']
const once = process.argv.includes('--once')

const files = readdirSync(new URL('../test/', import.meta.url)).filter((name) => name.endsWith('.test.mjs')).sort()
const run = (file, env) =>
  spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', `test/${file}`, '--reporter=dot'], { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } })

for (const file of files) {
  const result = run(file, {})
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (once) process.exit(0)

for (const TZ of ZONES) {
  for (const file of files) {
    // Silence the passing output: this pass exists to catch zone dependence, and
    // repeating every line twice would bury the one failure that matters.
    const result = run(file, { TZ })
    if (result.error) throw result.error
    if (result.status !== 0) {
      console.error(`\n${file} fails under TZ=${TZ}. Fix the suite to assert behaviour, not the host timezone.`)
      process.exit(result.status ?? 1)
    }
  }
  console.log(`timezone ${TZ}: every suite passed`)
}
