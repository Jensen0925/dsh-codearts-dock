#!/usr/bin/env node
/** Verify declared package entry artifacts and import the built runtime entry. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifestPath = resolve(root, 'package.json')
const pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))

function declaredEntries(manifest) {
  const entries = []
  const add = (label, value) => {
    if (typeof value !== 'string') return
    const relative = value.replace(/^\.\//, '').trim()
    if (!relative || relative.includes('*')) return
    entries.push({ label, relative })
  }

  add('main', manifest.main)
  add('types', manifest.types)
  if (typeof manifest.bin === 'string') add('bin', manifest.bin)
  else if (manifest.bin && typeof manifest.bin === 'object') {
    for (const [name, value] of Object.entries(manifest.bin)) add(`bin[${name}]`, value)
  }
  if (typeof manifest.exports === 'string') add('exports', manifest.exports)
  else if (manifest.exports && typeof manifest.exports === 'object') {
    for (const [subpath, value] of Object.entries(manifest.exports)) {
      if (typeof value === 'string') add(`exports[${subpath}]`, value)
      else if (value && typeof value === 'object') {
        for (const [condition, target] of Object.entries(value)) add(`exports[${subpath}].${condition}`, target)
      }
    }
  }
  add('dsh.bundle.patch', manifest.dsh?.bundle?.patch)
  return [...new Map(entries.map((entry) => [entry.relative, entry])).values()]
}

const entries = declaredEntries(pkg)
assert.ok(entries.length > 0, `${pkg.name} declares no entry artifacts`)
for (const { label, relative } of entries) {
  assert.ok(existsSync(resolve(root, relative)), `${label} is missing: ${relative}`)
}

const mainPath = resolve(root, pkg.main)
const loaded = await import(`${pathToFileURL(mainPath).href}?entry-smoke=${Date.now()}`)
assert.equal(typeof loaded, 'object', 'the package entry must import as an ES module')
assert.equal(typeof loaded.apply, 'function', 'the package entry must expose the Harness apply hook')
assert.equal(typeof loaded.meta, 'object', 'the package entry must expose plugin metadata')
console.log(`entry: ${pkg.main} exists and imports successfully`)
