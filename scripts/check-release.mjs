/** Check the public package metadata and file references before an npm release. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url))
const read = (name) => readFileSync(resolve(root, name), 'utf8')
const pkg = JSON.parse(read('package.json'))
assert.equal(pkg.name, 'dsh-codearts-dock')
assert.notEqual(pkg.private, true)
assert.equal(pkg.license, 'MIT')
assert.equal(pkg.repository.url, 'git+https://github.com/Jensen0925/dsh-codearts-dock.git')
assert.equal(pkg.publishConfig.registry, 'https://registry.npmjs.org/')
assert.ok(existsSync(resolve(root, pkg.dsh.bundle.patch)))
for (const name of ['README.md', 'DISCLAIMER.md', 'SECURITY.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'client.js', pkg.main]) assert.ok(existsSync(resolve(root, name)), `Missing ${name}`)
for (const name of ['README.md', 'DISCLAIMER.md', 'SECURITY.md', 'docs/PUBLISHING.md', 'docs/DETAIL.md', 'docs/DETAIL.zh.md']) {
  const content = read(name)
  for (const match of content.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const path = match[1].split('#')[0]
    if (!path || /^[a-z][a-z\d+.-]*:/i.test(path)) continue
    assert.ok(existsSync(resolve(root, dirname(name), path)), `${name}: missing linked file ${path}`)
  }
}
for (const lang of ['en', 'zh']) {
  const locale = JSON.parse(read(`locale/${lang}.json`))
  assert.ok(locale.meta.title.includes('CodeArts Dock'))
  assert.ok(existsSync(resolve(root, locale.meta.detail)))
}

// The index is what the Discover page installs from. It cannot name a version
// that is not on the registry yet, so the valid states are "lists this version"
// (repinned after publishing) and "lists an older one" (release in flight). What
// it must never do is advertise a version newer than the manifest, because that
// entry installs something this checkout does not describe.
const index = JSON.parse(read('market-index.json'))
assert.equal(index.format, 1)
assert.equal(index.plugins.length, 1)
assert.equal(index.plugins[0].name, pkg.name)
assert.ok(index.plugins[0].versions.length > 0, 'market-index.json lists no versions')
const compare = (a, b) => {
  const parse = (v) => v.split('-')[0].split('.').map(Number)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}
for (const version of index.plugins[0].versions) {
  assert.ok(
    compare(version.version, pkg.version) <= 0,
    `market-index.json lists ${version.version}, which is newer than package.json ${pkg.version}`,
  )
}
const listed = index.plugins[0].versions.map((version) => version.version)
if (!listed.includes(pkg.version)) {
  console.log(
    `note: market-index.json lists ${listed.join(', ')} but package.json is ${pkg.version}.` +
      ' Run `node scripts/release.mjs --repin` after the publish so the Discover entry tracks this version.',
  )
}

// The release workflow must publish the same version the tag names, and it can
// only do that if it is present. Absent here means releases silently fall back to
// whatever a maintainer runs by hand, which is the situation this file guards.
assert.ok(existsSync(resolve(root, '.github/workflows/release.yml')), 'Missing .github/workflows/release.yml')
const release = read('.github/workflows/release.yml')
assert.match(release, /id-token: write/, 'the release job needs id-token: write for trusted publishing')
assert.match(release, /npm publish --access public/, 'the release job publishes the package')

console.log('release: package metadata, bundle, locale, index and documentation links passed')
