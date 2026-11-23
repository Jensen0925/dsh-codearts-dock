#!/usr/bin/env node
/**
 * Prepare a release commit: bump the version, regenerate the index from npm, and
 * report the tag to push. Publishing itself happens in CI, not here.
 *
 *   node scripts/release.mjs 1.1.0
 *
 * Order matters. The index records the registry's publish time, which does not
 * exist until the version is published; so this script prepares the commit, and
 * the index is regenerated after the publish lands (`--repin` does just that).
 * Running it twice on the same version is harmless: every step is idempotent.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const manifestPath = new URL('../package.json', import.meta.url)
const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))

const requested = process.argv.slice(2).find((a) => !a.startsWith('-'))
const repin = process.argv.includes('--repin')

if (!requested && !repin) {
  throw new Error('Usage: node scripts/release.mjs <version>   |   node scripts/release.mjs --repin')
}

if (requested) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(requested)) {
    throw new Error(`"${requested}" is not a SemVer version`)
  }
  const [major, minor, patch] = pkg.version.split('.').map(Number)
  const [nextMajor, nextMinor] = requested.split('.').map(Number)
  const regressed =
    nextMajor < major || (nextMajor === major && nextMinor < minor)
  if (regressed) throw new Error(`${requested} is lower than the current ${pkg.version}`)
  if (requested !== pkg.version) {
    writeFileSync(manifestPath, `${JSON.stringify({ ...pkg, version: requested }, null, 2)}\n`)
    console.log(`version: ${pkg.version} -> ${requested}`)
  } else {
    console.log(`version: already ${requested}`)
  }
}

const version = JSON.parse(readFileSync(manifestPath, 'utf8')).version

// Rebuild the index in npm mode. This fails loudly when the version is not on the
// registry yet, which is the correct state for a release commit: run --repin
// after the publish, so the index carries the real publish time.
try {
  execFileSync(process.execPath, ['scripts/build-market-index.mjs', '--npm'], {
    cwd: root,
    stdio: 'inherit',
  })
} catch (error) {
  if (requested) {
    console.log(
      `\n${version} is not on npm yet, so the index cannot record its publish time.\n` +
        'Expected order: commit, tag, push (CI publishes), then `node scripts/release.mjs --repin`.',
    )
    process.exit(error.status ?? 1)
  }
  throw error
}

console.log(
  `\nnext:\n` +
    `  git add -A && git commit -m "chore: release v${version}"\n` +
    `  git tag -a v${version} -m "v${version}" && git push origin main --follow-tags\n` +
    `  # after CI publishes:\n` +
    `  node scripts/release.mjs --repin && git commit -am "chore: repin index for v${version}" && git push`,
)
