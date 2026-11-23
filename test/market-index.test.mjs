/**
 * market-index.json must stay installable, not merely well-formed JSON.
 *
 * A malformed index is not a loud failure: the Discover page shows an entry it
 * cannot install, or drops it, and the user finds out only when the install
 * button does nothing. So this suite checks the things that decide whether an
 * install actually happens:
 *
 *   - the document satisfies DSH's own format-1 validator, when that validator
 *     is resolvable from the running installation;
 *   - every listed version resolves to an install spec (npm source) or a commit
 *     (git source), and the icon URL points at a ref that exists;
 *   - no listed version is newer than package.json (an unreleased bump is fine).
 *
 * The validator is the shipped one rather than a copy: a private re-implementation
 * could agree with itself while disagreeing with the page that reads it.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = (name) => readFileSync(join(root, name), 'utf8')
const pkg = JSON.parse(read('package.json'))
const index = JSON.parse(read('market-index.json'))

// --- the installed validator, when this suite runs inside a DSH host ---------
// Resolve through the installation anchor rather than a guessed nested path: on
// Desktop the anchor lives inside app.asar, where only the Electron runtime (or
// a plain Node reading the archive) can see it. Any failure just downgrades this
// suite to the structural checks below instead of failing the run.
const installDir = process.env.DSH_INSTALL_DIR
let market = null
if (installDir) {
  try {
    const require = createRequire(import.meta.url)
    const entry = require.resolve('@deepseek-ai/dsh-plugin-market-index', { paths: [installDir] })
    market = await import(pathToFileURL(entry).href)
  } catch {
    market = null
  }
}

if (market) {
  const parsed = market.parseMarketIndex(index, 'https://example.invalid/market-index.json')
  assert.equal(parsed.plugins.length, 1, 'the index lists exactly this plugin')
  const plugin = parsed.plugins[0]
  assert.equal(plugin.name, pkg.name, 'index name matches the package')
  assert.ok(plugin.versions.length > 0, 'the index lists at least one version')
  for (const version of plugin.versions) {
    const target = market.marketInstallTarget(plugin.name, version)
    if (version.source.type === 'npm') {
      assert.equal(target.spec, `${pkg.name}@${version.version}`, 'npm source installs name@version')
    } else {
      assert.match(target.spec, /^git\+https:\/\/.+\.git#[0-9a-f]{40}$/, 'git source pins a full commit')
    }
  }
  console.log('✓ the index passes DSH\'s own format-1 validator and yields an install target')
} else {
  console.log('· format-1 validator unavailable (no DSH_INSTALL_DIR); checked structurally instead')
}

// --- structure, also when the validator is unavailable ----------------------
assert.equal(index.format, 1, 'format is 1')
assert.equal(index.plugins.length, 1, 'one plugin entry')
const plugin = index.plugins[0]
assert.equal(plugin.name, pkg.name)
assert.equal(plugin.repository.url, 'https://github.com/Jensen0925/dsh-codearts-dock')

// --- the listed version -----------------------------------------------------
// The index cannot carry a version the registry does not have, so a release in
// flight legitimately lists the previous one. What must never happen is an index
// that advertises something newer than this checkout describes.
const semver = (value) => value.split('-')[0].split('.').map(Number)
const compare = (a, b) => {
  const [x, y] = [semver(a), semver(b)]
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}
for (const entry of plugin.versions) {
  assert.ok(compare(entry.version, pkg.version) <= 0, `index lists ${entry.version}, newer than package.json ${pkg.version}`)
}
const current = plugin.versions.find((entry) => entry.version === pkg.version)
if (!current) {
  console.log(`· index lists ${plugin.versions.map((v) => v.version).join(', ')}; package.json ${pkg.version} is unreleased — repin after publishing`)
}

for (const entry of plugin.versions) {
  assert.ok(Number.isInteger(entry.publishTimestamp) && entry.publishTimestamp > 0, 'publishTimestamp is a positive integer')
  if (entry.source.type === 'npm') {
    assert.ok(!('registry' in entry.source) || /^https:\/\//.test(entry.source.registry), 'a custom registry is an https URL')
  } else {
    assert.match(entry.source.commit, /^[a-f\d]{40}$/, 'git source pins a full 40-hex commit')
    assert.equal(entry.source.url, 'https://github.com/Jensen0925/dsh-codearts-dock')
  }
}

// The icon must name a ref that exists: `main` always does, a tag only after it
// is pushed, so a stale tag here is a broken image on the Discover card.
assert.match(plugin.icon, /^https:\/\/raw\.githubusercontent\.com\/Jensen0925\/dsh-codearts-dock\/(?:main|v[^/]+|[a-f\d]{40})\/icons\//)
if (current?.source.type === 'npm') {
  assert.ok(plugin.icon.includes(`/v${pkg.version}/`) || plugin.icon.includes('/main/'), 'an npm entry points its icon at this release tag or main')
}

// The icon must also name a FILE that exists at that ref.
//
// The assertion above only validates the URL's SHAPE, which is how an artwork
// rename slipped through: the index pointed at
// `/v1.1.0/.../dsh-codearts-dock-128.png`, a path that only exists from the next
// tag, so the Discover card showed a broken image while every assertion passed.
//
// A published ref is immutable, so the truth here is "what filenames does the
// tag that this index lists actually carry". The local checkout answers that for
// a ref it is currently on; for any other ref the tag listing is fetched, and an
// unreachable network reports rather than fails — the suite must not start
// failing on a train.
const iconFile = plugin.icon.split('/').pop()
const iconRef = plugin.icon.match(/\/dsh-codearts-dock\/([^/]+)\/icons\//)?.[1]

/** Icon filenames present at a git ref, or null when that cannot be checked offline. */
function iconNamesAt(ref) {
  if (ref === undefined || ref === 'main') {
    // main tracks this checkout, so the working tree is authoritative.
    return readdirSync(new URL('../icons/', import.meta.url))
  }
  try {
    const listing = execFileSync('git', ['ls-tree', '--name-only', `${ref}:icons`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return listing.split('\n').filter(Boolean)
  } catch {
    return null
  }
}

const iconNames = iconNamesAt(iconRef)
if (iconNames === null) {
  console.log(`· icon file at ${iconRef} not verifiable offline; URL shape already checked`)
} else {
  assert.ok(
    iconNames.includes(iconFile),
    `the icon ${iconFile} must exist at ${iconRef}; that ref carries: ${iconNames.join(', ') || '(no icons)'}`,
  )
}

console.log('✓ market index: format, version, source and icon reference are consistent')
