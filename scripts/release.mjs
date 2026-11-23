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

// Rebuild the index in npm mode. The index records the registry's publish time,
// so this can only succeed once the version is actually published.
//
// The failure is reported, not thrown: `--repin` is normally run right after a
// release, and the failure it hits is not a bug in this script but the fact that
// the publish did not land. A stack trace buries that.
try {
  execFileSync(process.execPath, ['scripts/build-market-index.mjs', '--npm'], {
    cwd: root,
    stdio: 'inherit',
  })
} catch {
  const listed = await registryVersions(version)
  console.error(
    `\n${pkg.name}@${version} is not on the registry, so the index cannot record its publish time.${
      listed ? `\n  published versions: ${listed.join(', ')}` : ''
    }\n\n` +
      'If you just pushed the tag, the release run must have failed; a successful publish\n' +
      'would have put the version there. Check it before repinning:\n' +
      '  gh run list --workflow=release.yml --limit 1\n' +
      '  gh run view <id> --log-failed\n',
  )
  process.exit(1)
}

/** Versions already on the registry, or undefined when it cannot be read. */
async function registryVersions(version) {
  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) return undefined
    const body = await response.json()
    const versions = Object.keys(body.versions ?? {}).sort()
    return versions.includes(version) ? undefined : versions
  } catch {
    return undefined
  }
}

console.log(
  `\nnext:\n` +
    `  git add -A && git commit -m "chore: release v${version}"\n` +
    `  git tag -a v${version} -m "v${version}" && git push origin main --follow-tags\n` +
    `  # after CI publishes:\n` +
    `  node scripts/release.mjs --repin && git commit -am "chore: repin index for v${version}" && git push`,
)
