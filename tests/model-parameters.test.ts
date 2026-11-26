/** Context selection updates the Host budget without modifying upstream data. */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { InputError, validateSelection } from '../src/preferences.ts'
import { Catalog, validateContextOverrides } from '../src/catalog.ts'
import { createCodeArtsAdapter, PROVIDER_ID } from '../src/adapter.ts'

const model = { id: 'model', name: 'Model', context: 1048576, maxOutput: 32768, supportsImages: false, strengths: [] }

test('context overrides validate without coercion and null restores defaults', () => {
  const selection = (context: unknown) => validateSelection({ enabledModelIds: null, modelOverrides: { model: { context } } })
  for (const context of [1024, 32768, 131072, 2097152]) {
    assert.deepEqual(selection(context).modelOverrides, { model: { context } })
  }
  assert.deepEqual(selection(null).modelOverrides, {})
  for (const context of [0, 1023, 2097153, 1024.5, '65536', NaN, Infinity, false]) {
    assert.throws(() => selection(context), String(context))
  }
})

test('selected context reaches Host metadata and leaves room for conversation', async () => {
  const catalog = new Catalog()
  catalog.current = [{ ...model }]
  const adapter = createCodeArtsAdapter({ catalog })
  catalog.configure({ overrides: { model: { context: 32768 } } })
  const resolved = await adapter.resolveModel(PROVIDER_ID, model.id)
  assert.ok('context' in resolved && 'defaultMaxTokens' in resolved)
  assert.deepEqual(resolved.context, { contextWindow: 32768 })
  assert.equal(resolved.defaultMaxTokens, 8192)
  assert.equal(catalog.find(model.id)?.context, model.context, 'upstream context remains available for reset')
  assert.equal(catalog.find(model.id)?.maxOutput, model.maxOutput)

  catalog.configure({ overrides: { model: { context: 262144 } } })
  assert.equal(catalog.effective(model).context, 262144)
  assert.equal(catalog.effective(model).maxOutput, model.maxOutput, 'larger contexts retain the upstream output limit')

  catalog.configure({ overrides: {} })
  assert.equal(catalog.effective(model).context, model.context)
  assert.equal(catalog.effective(model).maxOutput, model.maxOutput)
  catalog.configure({ overrides: { model: { context: -1 } } })
  assert.equal(catalog.effective(model).context, model.context, 'malformed saved values cannot change the Host budget')
  assert.equal(catalog.effective(model).maxOutput, model.maxOutput)
})

test('known models reject new context increases and clamp older saved increases', () => {
  const catalog = new Catalog()
  catalog.current = [{ ...model, context: 202752 }]
  assert.throws(() => validateContextOverrides(catalog, { model: { context: 262144 } }), InputError)
  assert.doesNotThrow(() => validateContextOverrides(catalog, { model: { context: 131072 } }))
  catalog.configure({ overrides: { model: { context: 2097152 } } })
  assert.equal(catalog.effective(catalog.find(model.id)).context, 202752)
  assert.equal(catalog.effective(catalog.find(model.id)).maxOutput, model.maxOutput)
  assert.equal(catalog.find(model.id)?.context, 202752, 'clamping does not overwrite the upstream ceiling')

  catalog.current = [{ ...model, context: 0 }]
  assert.doesNotThrow(() => validateContextOverrides(catalog, { model: { context: 262144 }, unavailable: { context: 262144 } }))
  assert.equal(catalog.effective(catalog.find(model.id)).context, 2097152, 'an unknown upstream ceiling cannot establish a smaller limit')
})
