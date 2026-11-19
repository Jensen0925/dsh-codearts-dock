/**
 * Model catalog discovery.
 *
 * The gateway publishes two rosters that have to be merged:
 *
 *   1. `GET  /v1/model/builtin`          — id, name, context window, output
 *                                          cap, image support, credit ratio
 *   2. `POST /v1/model/thinking-variants` — the thinking levels each model
 *                                          accepts, and its default
 *
 * The merged result feeds three consumers: the adapter's catalog, the
 * settings page's model table, and the diagnostics view. Discovered fresh on
 * each refresh, because the upstream adds models and changes multipliers
 * without notice; the fallback table exists only for the case where the
 * gateway is unreachable on a first start.
 */

import { MODELS_PATH, THINKING_VARIANTS_PATH } from './gateway.js'

/**
 * How much of a model's output cap is reported to the Host.
 *
 * The gateway advertises 65536 for every model. The Host's compaction
 * reserves `maxTokens` out of the context window and subtracts a headroom
 * allowance on top, so reporting 65536 leaves a 202752-token model with only
 * about 71k of usable conversation — switching to it then fails with
 * `compaction still above threshold`. 32768 is roughly 24k Chinese
 * characters, ample for one reply, and hands the rest back to the context.
 */
const MAX_OUTPUT_CAP = 32768

/**
 * @typedef {object} ModelInfo
 * @property {string} id gateway model id.
 * @property {string} name display name.
 * @property {number} context context window in tokens.
 * @property {number} maxOutput output cap reported to the Host.
 * @property {string} [ratio] credit multiplier text, for display only.
 * @property {boolean} supportsImages whether the model accepts images.
 * @property {string[]} strengths accepted thinking levels; empty when none.
 * @property {string} [defaultStrength] the upstream default level.
 * @property {string} [description] one-line description.
 */

/**
 * The fallback roster, used only when the gateway cannot be reached.
 *
 * These are the models observed on a live account; they carry no thinking
 * metadata, so a fallback model offers no level selection at all. A working
 * credential always replaces this table with the live one.
 * @type {ModelInfo[]}
 */
export const FALLBACK_MODELS = [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', context: 1048576, maxOutput: 32768, ratio: '0.18x', supportsImages: true, strengths: [] },
  { id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek-V4.1-Flash-1017', context: 1048576, maxOutput: 32768, ratio: '0.18x', supportsImages: true, strengths: [] },
  { id: 'glm-5.3', name: 'GLM-5.3', context: 1048576, maxOutput: 32768, ratio: '0.79x', supportsImages: false, strengths: [] },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', context: 1048576, maxOutput: 32768, ratio: '0.08x', supportsImages: true, strengths: [] },
  { id: 'GLM-5.2', name: 'GLM-5.2', context: 202752, maxOutput: 32768, ratio: '0.7x', supportsImages: false, strengths: ['high', 'max'], defaultStrength: 'high' },
  { id: 'glm-5.2-sft-harmony', name: 'GLM-5.2-ArkTS-SPARK', context: 202752, maxOutput: 32768, ratio: '0.7x', supportsImages: false, strengths: ['high', 'max'], defaultStrength: 'high' },
  { id: 'kimi-k3', name: 'Kimi-K3', context: 1048576, maxOutput: 32768, ratio: '2.38x', supportsImages: true, strengths: [] },
  { id: 'kimi-k3.1-pro', name: 'Kimi-K3.1-Pro', context: 1048576, maxOutput: 32768, ratio: '1.63x', supportsImages: true, strengths: [] },
  { id: 'openpangu-2.0-pro', name: 'OpenPangu-2.0-Pro', context: 524288, maxOutput: 32768, ratio: '0.7x', supportsImages: false, strengths: [] },
  { id: 'openpangu-2.0-flash', name: 'OpenPangu-2.0-Flash', context: 524288, maxOutput: 32768, ratio: '0.32x', supportsImages: false, strengths: [] },
  { id: 'speed', name: '智速模式', context: 1048576, maxOutput: 32768, ratio: '0.18x', supportsImages: false, strengths: [] },
]

/**
 * Clamp an advertised output cap to what the Host should reserve.
 * @param {number|undefined} fromGateway advertised value.
 * @param {number|undefined} fallback value to use when the gateway omits one.
 * @returns {number} the reported cap.
 */
function clampMaxOutput(fromGateway, fallback) {
  const base = fromGateway && fromGateway > 0 ? fromGateway : (fallback ?? MAX_OUTPUT_CAP)
  return Math.min(base, MAX_OUTPUT_CAP)
}

/**
 * Read and merge the live catalog.
 *
 * The thinking roster is optional: when that call fails the models still
 * load, they simply declare no levels. Failing the whole refresh because a
 * secondary endpoint is down would hide every model.
 *
 * @param {import('./gateway.js').MadaoClient} client an authenticated client.
 * @returns {Promise<{models: ModelInfo[], source: 'gateway'|'fallback', error?: string}>} the catalog.
 */
export async function discoverModels(client) {
  try {
    const raw = await client.getJson(MODELS_PATH)
    const list = raw?.builtinModels ?? raw?.data?.builtinModels ?? []
    if (!Array.isArray(list) || list.length === 0) {
      return { models: FALLBACK_MODELS, source: 'fallback', error: '网关返回了空模型清单' }
    }

    let variants = {}
    try {
      const reply = await client.postJson(THINKING_VARIANTS_PATH, {
        model_names: list.map((model) => model.model_id).filter(Boolean),
      })
      variants = reply?.variants ?? reply?.data?.variants ?? {}
    } catch {
      // Thinking levels are an optional capability; their absence must not
      // remove the models.
    }

    const models = list
      .filter((model) => model?.model_id && model.enable !== false)
      .map((model) => {
        const variant = variants[model.model_id]
        const fallback = FALLBACK_MODELS.find((entry) => entry.id === model.model_id)
        return {
          id: model.model_id,
          name: model.model_name || model.model_id,
          context: model.context_window ?? fallback?.context ?? 0,
          maxOutput: clampMaxOutput(model.max_tokens, fallback?.maxOutput),
          ratio: model.credit?.[0]?.ratio_display,
          supportsImages: model.supports_images === true,
          strengths: Array.isArray(variant?.strengths) ? variant.strengths : [],
          defaultStrength: variant?.default_strength || undefined,
          description: model.model_desc,
        }
      })

    return { models, source: 'gateway' }
  } catch (error) {
    return {
      models: FALLBACK_MODELS,
      source: 'fallback',
      error: error?.message ?? String(error),
    }
  }
}

/**
 * Merge discovered metadata over the fallback table.
 *
 * Used when a refresh fails after a successful one: the previous live
 * catalog stays in service rather than being replaced by the stale static
 * table.
 * @param {ModelInfo[]} previous the catalog currently in use.
 * @param {ModelInfo[]} discovered the newest discovery result.
 * @returns {ModelInfo[]} the catalog to keep.
 */
export function preferLive(previous, discovered) {
  return discovered.length > 0 ? discovered : previous
}
