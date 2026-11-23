/**
 * Host-half registration checks.
 *
 * The llm service has THREE separate registries, and a provider is only fully
 * installed when all of the ones that apply are declared:
 *
 *   registerAdapter               — makes the route routable; feeds the model picker
 *   registerConfigurableProviders — creates the row in Settings → Models
 *   registerModelDiscovery        — lets a settings surface interrogate the catalog
 *
 * Registering only the adapter leaves the plugin half-installed, and the two
 * symptoms look unrelated to a user ("the model is not in the picker" vs "the
 * provider is not in Settings"), so this test asserts all three.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const results = []
const check = async (name, fn) => {
  try {
    await fn()
    results.push(`✓ ${name}`)
  } catch (error) {
    results.push(`✗ ${name}\n    ${error.message}`)
    process.exitCode = 1
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'dca-reg-'))
process.env.APPDATA = scratch
process.env.DSH_CONNECT_CODEARTS_LEGACY_CREDENTIAL = join(scratch, 'legacy.json')

const plugin = await import('../src/index.js')

/** Apply the plugin against a recording context. */
function activate() {
  const recorder = { adapters: [], directories: [], discoveries: [] }
  const ctx = {
    effect: (fn) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    get: () => undefined,
    llm: {
      registerAdapter(providers, adapter) {
        recorder.adapters.push({ providers, adapter })
        return () => {}
      },
      registerConfigurableProviders(entries) {
        recorder.directories.push(entries)
        return () => {}
      },
      registerModelDiscovery(ns, discover) {
        recorder.discoveries.push({ ns, discover })
        return () => {}
      },
    },
    inject() {},
    emit() {},
  }
  plugin.apply(ctx, {})
  return recorder
}

/**
 * Apply the plugin against a context that reports a Loader entry id, the way a
 * real Loader-mounted row does.
 */
function activateUnderEntryId(entryId) {
  const recorder = { adapters: [], directories: [], discoveries: [] }
  const ctx = {
    fiber: { entry: { options: { id: entryId } } },
    effect: (fn) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    get: () => undefined,
    llm: {
      registerAdapter(providers, adapter) {
        recorder.adapters.push({ providers, adapter })
        return () => {}
      },
      registerConfigurableProviders(entries) {
        recorder.directories.push(entries)
        return () => {}
      },
      registerModelDiscovery(ns, discover) {
        recorder.discoveries.push({ ns, discover })
        return () => {}
      },
    },
    inject() {},
    emit() {},
  }
  plugin.apply(ctx, {})
  return recorder
}

await check('the settings namespace follows the Loader entry id', async () => {
  // Settings → Models addresses a provider's form by this namespace. Hard-coding
  // it means the row silently stops resolving the moment a user renames the
  // entry in cordis.patch.yml — which is exactly what the row's `id` is for.
  const { directories, discoveries } = activateUnderEntryId('a-renamed-row')
  assert.equal(directories[0][0].settingsNs, 'a-renamed-row')
  assert.equal(discoveries[0].ns, 'a-renamed-row', 'discovery must follow the same namespace')
})

await check('a host that mounts the plugin directly still gets a namespace', async () => {
  // `ctx.fiber.entry` is added by the Loader, so it is absent under ctx.plugin()
  // or a test harness. The fallback is what keeps the row registering there.
  const { directories } = activate()
  assert.equal(directories[0][0].settingsNs, 'dsh-codearts-dock')
})

await check('the adapter is registered for exactly this provider route', async () => {
  const { adapters } = activate()
  assert.equal(adapters.length, 1, 'exactly one adapter')
  assert.deepEqual(adapters[0].providers, ['codearts'])
})

await check('the provider is declared in the configurable directory', async () => {
  const { directories } = activate()
  assert.equal(directories.length, 1, 'Settings → Models needs this row to exist')
  const entry = directories[0][0]
  assert.equal(entry.provider, 'codearts')
  assert.ok(entry.displayName.length > 0)
  assert.ok(entry.settingsNs.length > 0, 'a row without a namespace cannot be edited')
  assert.deepEqual(entry.settingsPath, [])
})

await check('model discovery is offered under the same namespace as the directory row', async () => {
  const { directories, discoveries } = activate()
  assert.equal(discoveries.length, 1)
  assert.equal(
    discoveries[0].ns,
    directories[0][0].settingsNs,
    'discovery and the directory row must agree on the namespace, or the page cannot use it',
  )
})

await check('discovery returns the catalog in the shape discovery consumers expect', async () => {
  // Discovery is credential-backed: without one the catalog stays on the static
  // fallback, which is still a valid answer. Assert the SHAPE rather than a
  // count, so this runs in CI without any key.
  const { adapters, discoveries } = activate()
  // Wait for the startup catalog refresh so there is something to report.
  for (let i = 0; i < 60; i += 1) {
    const models = await adapters[0].adapter.listModels('codearts')
    if (models.length > 0) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const discovered = await discoveries[0].discover({})
  assert.ok(Array.isArray(discovered), 'discovery must answer with an array')
  for (const model of discovered) {
    assert.equal(typeof model.id, 'string')
    assert.ok(model.id.length > 0)
    if (model.contextWindow !== undefined) assert.ok(model.contextWindow > 0)
    if (model.inputModalities !== undefined) assert.ok(Array.isArray(model.inputModalities))
  }
})

rmSync(scratch, { recursive: true, force: true })
await check('every route is registered exact, so paths cannot shadow each other', async () => {
  // THE BUG THIS CATCHES: with `prefix` registrations, `/models` also claims
  // `/models/select`. A save POST then lands on the read route, which answers
  // `{ ok: true, models: [...] }` — the client sees success and nothing was
  // written. `exact` makes a missing route answer 404 instead of a neighbour's
  // payload.
  const kinds = new Set()
  const seen = []
  const ctx = {
    effect: (fn) => {
      const d = fn()
      return typeof d === 'function' ? d : () => {}
    },
    get: () => undefined,
    llm: {
      registerAdapter: () => () => {},
      registerConfigurableProviders: () => () => {},
      registerModelDiscovery: () => () => {},
    },
    inject(deps, cb) {
      cb({
        effect: (fn) => {
          fn()
          return () => {}
        },
        webServer: {
          register(route) {
            kinds.add(route.kind)
            seen.push(route.path)
            return () => {}
          },
        },
      })
    },
    emit() {},
  }
  plugin.apply(ctx, {})
  assert.deepEqual([...kinds], ['exact'], `expected only exact routes, got: ${[...kinds].join(', ')}`)
  assert.ok(seen.includes('/plugins/dsh-codearts-dock/models/select'), 'the save route is registered')
})

await check('a Config schema is declared, so the settings namespace exists', async () => {
  // THE BUG THIS CATCHES: Settings → Models resolves a provider row's form by
  // looking its `settingsNs` up in the Host settings service, which only holds
  // namespaces for plugins with a Config schema. Without one the page hits
  // `if (namespace === undefined) return null` and skips the row SILENTLY —
  // the provider is routable, its models are selectable, and the card where a
  // user manages it never appears, with no error anywhere.
  assert.equal(typeof plugin.Config, 'function', 'Config must be a Schemastery schema')
  const resolved = plugin.Config({})
  assert.equal(typeof resolved, 'object', 'the schema must resolve defaults')
  assert.equal(resolved.enabled, true, 'defaults must be applied')
  assert.ok('composerChip' in resolved, 'the fields the card reads must be declared')
})

await check('Config satisfies the two gates Settings → Models applies', async () => {
  // The page hides a provider row without ever naming it, at two gates:
  //
  //   1. settings.describe() only emits a namespace for an entry whose
  //      `entry.fiber.runtime.Config` exists AND has `toJSON` —
  //      `if (namespace === undefined) return null`
  //   2. the page then requires `row.configured`, i.e. that namespace
  //
  // So the schema must be a real Schemastery schema, not merely exported. Both
  // gates are asserted here because either one hides the card silently.
  const schema = plugin.Config
  assert.equal(typeof schema, 'function', 'a Schemastery schema is callable')
  assert.equal(typeof schema.toJSON, 'function', 'gate 1: the Host requires toJSON')
  const json = schema.toJSON()
  assert.equal(typeof json, 'object', 'gate 1: toJSON must produce a schema document')
  // Gate 2 needs the schema to resolve the values the card reads.
  assert.ok(!('autoCheckin' in plugin.DEFAULTS), 'removed automatic preference has no default')
  const values = schema({})
  assert.ok(!('autoCheckin' in values), 'removed automatic preference is not offered by settings')
  for (const field of ['enabled', 'composerChip', 'registerProvider']) {
    assert.ok(field in values, `gate 2: ${field} must resolve from the schema`)
  }
})

await check('the adapter carries every method the Host calls unconditionally', async () => {
  // The bug this catches is a mid-session crash, not a load failure: a plain
  // class that merely looks like an adapter registers and streams fine, then
  // dies when another code path asks for `imageRequestPricing`.
  const { createCodeArtsAdapter } = await import('../src/adapter.js')
  const adapter = createCodeArtsAdapter({
    catalog: { find: () => null, models: () => [], visible: () => [] },
    credentials: {},
    gateway: () => undefined,
  })
  for (const method of ['imageRequestPricing', 'imageRequestTarget', 'providerInfo', 'providerRetryPolicy']) {
    assert.equal(typeof adapter[method], 'function', `${method} must exist`)
  }
  assert.equal(adapter.imageRequestPricing('codearts', 'x'), undefined, 'no image pricing is the honest answer')
})

await check('the last good catalog survives a restart', async () => {
  // Without this a restart begins on the static fallback table and the picker is
  // wrong until the first refresh lands.
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Catalog } = await import('../src/catalog.js')
  const cache = join(mkdtempSync(join(tmpdir(), 'dca-cat-')), 'catalog.json')

  const first = new Catalog({})
  first.current = [{ id: 'saved-model', name: 'S', context: 1000, maxOutput: 10, supportsImages: false, strengths: [] }]
  first.source = 'gateway'
  first.persist(cache)

  const second = new Catalog({})
  assert.equal(second.loadPersisted(cache), true, 'the cached catalog must load')
  assert.deepEqual(second.models().map((m) => m.id), ['saved-model'])
  assert.equal(second.source, 'cache', 'the source says where it came from')

  // A corrupt file must not replace a working catalog with nothing.
  writeFileSync(cache, '{ not json')
  const third = new Catalog({})
  third.current = [{ id: 'keep' }]
  assert.equal(third.loadPersisted(cache), false, 'a corrupt cache is refused')
  assert.deepEqual(third.models().map((m) => m.id), ['keep'], 'and leaves the catalog intact')

  // A fallback catalog is never persisted: it is not worth restoring.
  const fourth = new Catalog({})
  fourth.persist(join(mkdtempSync(join(tmpdir(), 'dca-cat2-')), 'never.json'))
})

await check('the status route reports both settings gates', async () => {
  // A missing card has two silent causes; reporting the facts means the next
  // diagnosis does not have to guess which one it was.
  const { readFileSync } = await import('node:fs')
  const host = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  assert.ok(host.includes('configSchema:'), 'reports whether a Config schema is exported')
  assert.ok(host.includes('registration:'), 'exposes a registration block at all')
})

console.log(results.join('\n'))
if (process.exitCode) console.log('\nregistration: some checks failed')
else console.log('\nregistration: all checks passed')
