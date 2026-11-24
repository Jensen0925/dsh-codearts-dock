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
assert.equal(pkg.engines?.node, '^22.19.0 || >=24.9.0', 'package.json must declare the supported Node.js range')
assert.equal(pkg.exports?.['.'], `./${pkg.main}`, 'the package root export must match main')
assert.ok(pkg.files?.includes('dist'), 'the compiled runtime files must be packed')
assert.ok(existsSync(resolve(root, pkg.dsh.bundle.patch)))
for (const name of ['README.md', 'CHANGELOG.md', 'DISCLAIMER.md', 'SECURITY.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'docs/compatibility.md', 'client.js', pkg.main]) assert.ok(existsSync(resolve(root, name)), `Missing ${name}`)
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
const ci = read('.github/workflows/ci.yml')
assert.ok(existsSync(resolve(root, 'pnpm-lock.yaml')), 'pnpm-lock.yaml must be committed for reproducible installs')
assert.doesNotMatch(read('.gitignore'), /^pnpm-lock\.yaml$/m, '.gitignore must not hide pnpm-lock.yaml')
for (const [name, workflow] of [['CI', ci], ['release', release]]) {
  assert.match(workflow, /pnpm install --frozen-lockfile/, `${name} must install from the frozen pnpm lockfile`)
  assert.doesNotMatch(workflow, /(?:^|\s)npm install(?:\s|$)/m, `${name} must not resolve dependencies with npm install`)
}
assert.match(release, /id-token: write/, 'the release job needs id-token: write for trusted publishing')
assert.match(release, /npm publish --access public/, 'the release job publishes the package')
assert.match(release, /^name: Release$/m, 'the release workflow keeps the name')

// The published filename is what `npm trust --file` must name. A renamed workflow
// silently breaks publishing: the trust entry still points at the old name, the
// registry refuses the OIDC exchange, and npm falls back to an anonymous publish
// that fails with a bare 404. Keep the documented command naming this exact file.
const publishingDoc = read('docs/PUBLISHING.md')
assert.match(
  publishingDoc,
  /npm trust github dsh-codearts-dock --file release\.yml/,
  'docs/PUBLISHING.md must name release.yml (the bare filename) in the npm trust command',
)
// The registry flag is not optional on a machine whose configured registry is a
// mirror: `npm trust` posts to whatever `npm config get registry` returns, so
// without it the binding is attempted against the mirror, which answers 400 and
// leaves no trust entry behind. `npm login --registry` does not change that
// default, so "I logged in to npmjs" is not enough.
assert.match(
  publishingDoc,
  /npm trust github dsh-codearts-dock --file release\.yml --allow-publish --registry=https:\/\/registry\.npmjs\.org\//,
  'docs/PUBLISHING.md: the npm trust command must pass --registry, or a configured mirror receives the request',
)

console.log('release: package metadata, bundle, locale, index and documentation links passed')
