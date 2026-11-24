#!/usr/bin/env node
/**
 * Prepare a release commit or repin the market index after publishing.
 *
 *   node scripts/release.mjs 1.1.0
 *
 * Publishing happens in GitHub Actions when the matching version tag is pushed.
 * The index records the registry's real publish time, so it is repinned only
 * after that publish succeeds.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const manifestPath = new URL('../package.json', import.meta.url)
const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))

const args = process.argv.slice(2)
const requested = args.find((a) => !a.startsWith('-'))
const repin = args.includes('--repin')

function parseVersion(value) {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/)
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] }
}

function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) return Number.NaN
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] - b[key]
  }
  if (a.prerelease === b.prerelease) return 0
  if (a.prerelease === undefined) return 1
  if (b.prerelease === undefined) return -1
  return a.prerelease.localeCompare(b.prerelease)
}

if (!requested && !repin) {
  throw new Error('Usage: node scripts/release.mjs <version>   |   node scripts/release.mjs --repin')
}
if ((requested && repin) || args.some((a) => a !== requested && a !== '--repin')) {
  throw new Error('Choose either a release version or --repin')
}

if (requested) {
  if (!parseVersion(requested)) {
    throw new Error(`"${requested}" is not a SemVer version`)
  }
  if (!parseVersion(pkg.version)) throw new Error(`Current package version is invalid: ${pkg.version}`)
  if (compareVersions(requested, pkg.version) <= 0) {
    throw new Error(`${requested} must be newer than the current ${pkg.version}`)
  }
  if (requested !== pkg.version) {
    writeFileSync(manifestPath, `${JSON.stringify({ ...pkg, version: requested }, null, 2)}\n`)
    console.log(`version: ${pkg.version} -> ${requested}`)
  }

  console.log(
    `\nnext:\n` +
      `  pnpm test && pnpm run check:release && pnpm run check:package && pnpm pack\n` +
      `  git add package.json CHANGELOG.md && git commit -m "chore: release v${requested}"\n` +
      `  git tag -a v${requested} -m "v${requested}" && git push origin main --follow-tags\n` +
      `  # after CI publishes:\n` +
      `  node scripts/release.mjs --repin`,
  )
  process.exit(0)
}

const version = JSON.parse(readFileSync(manifestPath, 'utf8')).version

// Rebuild the index in npm mode. This only succeeds after the version is on the
// registry because the index records npm's real publish time.
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
      '  gh run view <id> --log-failed\n\n' +
      'A `404 Not Found - PUT ...` there means the registry did not accept the run as\n' +
      'the trusted publisher, not that the package is missing. Confirm the binding:\n' +
      `  npm trust list ${pkg.name} --registry=https://registry.npmjs.org/\n` +
      'The --registry flag is required whenever the configured registry is a mirror.\n',
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

console.log(`\nReview market-index.json, then commit and push it:\n  git add market-index.json && git commit -m "chore: repin index for v${version}" && git push`)
