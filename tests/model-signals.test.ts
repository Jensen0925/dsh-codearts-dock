/** Busy-level and promotion metadata stay explicit, optional, and short-lived. */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BUSY_BATCH_SIZE,
  batchModelIds,
  normalizeBusyLevel,
  parseBusyLevels,
} from '../src/busy.ts'
import { resolveModelPromo } from '../src/promo.ts'
import { discoverModels, fetchBusyLevels } from '../src/models.ts'
import { MODEL_BUSY_PATH, MODELS_PATH, THINKING_VARIANTS_PATH } from '../src/gateway.ts'
import { Catalog } from '../src/catalog.ts'

const check = (name: string, fn: () => void | Promise<void>) => test(name, fn)

await check('busy levels accept known values and map malformed or prototype keys to unknown', () => {
  assert.equal(normalizeBusyLevel('congested'), 'congested')
  assert.equal(normalizeBusyLevel('idle'), 'idle')
  assert.equal(normalizeBusyLevel('toString'), 'unknown')
  assert.equal(normalizeBusyLevel('__proto__'), 'unknown')
  assert.equal(normalizeBusyLevel(undefined), 'unknown')

  const parsed = parseBusyLevels([
    { model: 'busy-model', busy_level: 'busy' },
    { model: 'new-enum', busy_level: 'overloaded' },
    { model: '', busy_level: 'idle' },
    null,
  ])
  assert.deepEqual([...parsed], [['busy-model', 'busy'], ['new-enum', 'unknown']])
})

await check('model ids are deduplicated and split at the upstream limit', () => {
  const ids = Array.from({ length: BUSY_BATCH_SIZE + 2 }, (_, index) => `model-${index}`)
  const batches = batchModelIds([...ids, ids[0], ''])
  assert.deepEqual(batches.map((batch) => batch.length), [BUSY_BATCH_SIZE, 2])
  assert.equal(new Set(batches.flat()).size, BUSY_BATCH_SIZE + 2)
})

await check('busy probe sends batches and accepts the upstream data envelope', async () => {
  const requested: Array<{ path: string; body: { models: string[] }; options: unknown }> = []
  const client = {
    async postJson(path: string, body: { models: string[] }, options: unknown) {
      requested.push({ path, body, options })
      return { data: body.models.map((model) => ({ model, busy_level: model === 'm0' ? 'congested' : 'normal' })) }
    },
  }
  const ids = Array.from({ length: BUSY_BATCH_SIZE + 1 }, (_, index) => `m${index}`)
  const levels = await fetchBusyLevels(client, ids)
  assert.equal(requested.length, 2)
  assert.ok(requested.every((entry) => entry.path === MODEL_BUSY_PATH))
  assert.equal(requested[0].body.models.length, BUSY_BATCH_SIZE)
  assert.equal(requested[1].body.models.length, 1)
  assert.equal(levels.get('m0'), 'congested')
  assert.equal(levels.get('m50'), 'normal')
})

await check('optional busy probe failures and missing rows do not hide discovered models', async () => {
  const catalog = [{ model_id: 'm1', model_name: 'Model 1', enable: true }]
  const variantCalls: string[] = []
  const client = {
    async getJson(path: string) {
      assert.equal(path, MODELS_PATH)
      return { builtinModels: catalog }
    },
    async postJson(path: string) {
      if (path === THINKING_VARIANTS_PATH) {
        variantCalls.push(path)
        return { variants: { m1: { strengths: ['high'], default_strength: 'high' } } }
      }
      assert.equal(path, MODEL_BUSY_PATH)
      throw new Error('busy endpoint unavailable')
    },
  }
  const result = await discoverModels(client)
  assert.equal(result.source, 'gateway')
  assert.equal(result.models.length, 1)
  assert.equal(result.models[0].id, 'm1')
  const firstResult = result.models[0] as (typeof result.models[number] & { busyLevel?: string }) | undefined
  assert.ok(firstResult)
  assert.equal(firstResult.busyLevel, 'unknown')
  assert.deepEqual(result.models[0].strengths, ['high'])
  assert.equal(variantCalls.length, 1)

  const missing = await discoverModels({
    async getJson() { return { builtinModels: catalog } },
    async postJson(path: string) {
      return path === THINKING_VARIANTS_PATH ? { variants: {} } : { data: [{ model: 'other', busy_level: 'idle' }] }
    },
  })
  const missingFirst = missing.models[0] as (typeof missing.models[number] & { busyLevel?: string }) | undefined
  assert.ok(missingFirst)
  assert.equal(missingFirst.busyLevel, 'unknown')
})

await check('a non-zero busy probe response is rejected by the helper and degraded by discovery', async () => {
  const client = {
    async postJson() { return { code: 1001, msg: 'not supported' } },
  }
  await assert.rejects(fetchBusyLevels(client, ['m1']), /not supported/)

  const result = await discoverModels({
    async getJson() { return { builtinModels: [{ model_id: 'm1', enable: true }] } },
    async postJson(path: string) {
      return path === THINKING_VARIANTS_PATH ? { variants: {} } : { code: 1001, msg: 'not supported' }
    },
  })
  assert.equal(result.source, 'gateway')
  const firstResult = result.models[0] as (typeof result.models[number] & { busyLevel?: string }) | undefined
  assert.ok(firstResult)
  assert.equal(firstResult.busyLevel, 'unknown')
})

await check('limited half-price requires explicit promotion evidence', () => {
  const active = resolveModelPromo({ id: 'm1', description: '限时半价活动进行中' })
  assert.ok(active)
  assert.equal(active.label, '限时半价')
  assert.equal(active.labelEn, 'Limited-time half price')
  const promoted = resolveModelPromo({ id: 'm2', promotion: { title: '限时五折' } })
  assert.ok(promoted)
  assert.equal(promoted.label, '限时半价')
  const explicit = resolveModelPromo({ id: 'm3', limited_time_half_price: true })
  assert.ok(explicit)
  assert.equal(explicit.label, '限时半价')
  assert.equal(resolveModelPromo({ id: 'm4', ratio: '0.5x' })?.label, undefined)
  assert.equal(resolveModelPromo({ id: 'm5', description: '当前价格为五折' })?.label, undefined)
})

await check('busy values never persist and cached congestion is invalidated on load', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dca-model-signals-'))
  const path = join(directory, 'catalog.json')
  try {
    const catalog = new Catalog()
    catalog.current = [{
      id: 'm1', name: 'Model 1', context: 1024, maxOutput: 256,
      supportsImages: false, strengths: [], busyLevel: 'congested',
    }]
    catalog.source = 'gateway'
    catalog.refreshedAt = Date.now()
    catalog.persist(path)

    const saved = JSON.parse(readFileSync(path, 'utf8'))
    assert.ok(!('busyLevel' in saved.models[0]))

    saved.models[0].busyLevel = 'congested'
    writeFileSync(path, JSON.stringify(saved))
    const restored = new Catalog()
    assert.equal(restored.loadPersisted(path), true)
    assert.equal(restored.current[0].busyLevel, 'unknown')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
