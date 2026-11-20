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
console.log('release: package metadata, bundle, locale and documentation links passed')
