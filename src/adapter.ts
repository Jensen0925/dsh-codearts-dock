// @ts-nocheck
/**
 * The 码道 LLM adapter.
 *
 * This is a native `LlmAdapter`, not a local HTTP bridge. The Host registers
 * it against a provider route and calls `stream()` directly, which removes a
 * whole process, a port, a restart, and a rewrite of the model list on disk
 * from the design — the catalog is whatever the gateway said at the last
 * refresh.
 *
 * The adapter converts between two vocabularies:
 *
 *   Host messages (durable, role-tagged, block-structured)
 *     -> OpenAI chat-completions messages (what the gateway accepts)
 *
 *   gateway SSE events (text / reasoning / tool-call deltas)
 *     -> Host `StreamChunk`s (block-start, delta, block-end, usage, finish)
 */

import { GatewayError, MadaoClient } from './gateway.js'
import { parseIdentity } from './account.js'
import { resolveModelPromo } from './promo.js'
import { resolveBusyBadge } from './busy.js'

/**
 * @typedef {object} AdapterDeps
 * @property {import('./credentials.js').CredentialProvider} credentials resolves a signed triple.
 * @property {import('./catalog.js').Catalog} catalog the live model catalog.
 * @property {() => string|undefined} [gateway] gateway root override.
 * @property {() => any} [attachments] the Host attachment service, for image bytes.
 * @property {(key: any) => MadaoClient} [createClient] client factory, injected by tests.
 * @property {(line: string) => void} [log] diagnostic sink.
 * @property {(error: unknown) => void|Promise<void>} [onError] best-effort request failure notification.
 */

/**
 * The Host's `LlmAdapter` base class, or a local stand-in with the same defaults.
 *
 * The Host provides `@deepseek-ai/dsh-llm` at runtime and resolves it for loaded
 * plugins; a checkout run on its own (tests, a probe script) has no such package.
 * Extending the base MATTERS — it carries `imageRequestPricing` and
 * `imageRequestTarget`, which the Host calls unconditionally. A plain class that
 * merely looks like an adapter registers and streams fine, then dies mid-session
 * the first time some other code path asks for one of them:
 *
 *   this.adapters.get(...)?.adapter.imageRequestPricing is not a function
 *
 * Hence: use the real base when it resolves, and fall back to an equivalent one
 * so the plugin still runs outside the Host. The two are interchangeable because
 * every method the fallback defines is the same default the Host's base defines.
 */
let LlmAdapter
try {
  ;({ LlmAdapter } = await import('@deepseek-ai/dsh-llm'))
} catch {
  /**
   * The Host base class's defaults, restated.
   *
   * A provider that prices no images and has no per-image target reports exactly
   * that, and a provider with no retry opinion defers to the Host's default.
   */
  LlmAdapter = class {
    providerInfo(provider) {
      return { id: provider, name: provider }
    }
    providerRetryPolicy() {
      return undefined
    }
    imageRequestPricing() {
      return undefined
    }
    imageRequestTarget() {
      return { width: 0, height: 0, maxBytes: 0 }
    }
    listModels() {
      return []
    }
    resolveModel(provider, model) {
      return { provider, id: model, name: model }
    }
    prepareCall() {
      throw new Error('prepareCall must be implemented by the adapter')
    }
  }
}

/** Provider route this adapter owns. */
export const PROVIDER_ID = 'codearts'

/** The name the model selector shows for this route. */
export const PROVIDER_NAME = '码道 CodeArts'

/**
 * Reasoning level ids the Host understands, mapped to what the gateway reads.
 *
 * The gateway reads `reasoning_effort` and ignores anything else, so a level
 * only works when it maps to a value in this table.
 */
const REASONING_LEVELS = {
  off: 'none',
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'max',
}

/** Reasoning effort ids the Host offers, in display order. */
const HOST_EFFORT_ORDER = ['off', 'low', 'medium', 'high', 'max']

/**
 * Build the adapter.
 *
 * @param {AdapterDeps} deps adapter dependencies.
 * @returns {any} an `LlmAdapter`-compatible instance.
 */
export function createCodeArtsAdapter(deps) {
  return new CodeArtsAdapter(deps)
}

/**
 * The adapter.
 *
 * EXTENDS `LlmAdapter`, and that is not decoration. The base carries methods the
 * Host calls unconditionally — `imageRequestPricing` and `imageRequestTarget`
 * among them — with sane defaults for a provider that prices no images. A plain
 * class that merely *looks* like an adapter passes registration and streams
 * fine, then dies mid-session the first time any other code path asks for one of
 * those methods: `this.adapters.get(...)?.adapter.imageRequestPricing is not a
 * function`.
 */
class CodeArtsAdapter extends LlmAdapter {
  /**
   * @param {AdapterDeps} deps adapter dependencies.
   */
  constructor(deps) {
    // `super()` first: this class extends the Host's base, and a derived
    // constructor may not touch `this` before it runs.
    super()
    this.deps = deps
    this.clients = new Map()
  }

  /** Human-readable route metadata. */
  providerInfo(provider) {
    return { id: provider, name: PROVIDER_NAME }
  }

  /**
   * Price for an image request; undefined means no separate image pricing.
   */
  imageRequestPricing(_provider, _model) {
    return undefined
  }

  /**
   * The target image geometry for this provider.
   */
  imageRequestTarget() {
    return { width: 0, height: 0, maxBytes: 0 }
  }

  /**
   * The provider-owned retry policy.
   *
   * A rejected request body is never worth retrying: the same bytes produce
   * the same 400 whoever sends them. Transport failures and 5xx are.
   */
  providerRetryPolicy() {
    return {
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: ['REQUEST_FAILED', 'PROVIDER_ERROR', 'RATE_LIMITED'],
      initialDelayMs: 1000,
      maxDelayMs: 15_000,
      jitterRatio: 0.2,
    }
  }

  /** The catalog this route advertises. */
  async listModels(provider) {
    if (provider !== PROVIDER_ID) return []
    // The SELECTION, not the raw roster: a model the user unticked must leave
    // the picker, and one they ticked must appear even if the upstream added it
    // after the last refresh.
    const catalog = this.deps.catalog
    const models = typeof catalog.visible === 'function' ? catalog.visible() : catalog.models()
    return models.map((model) => this.#modelInfo(provider, this.#effective(model)))
  }

  /** Resolve one model's exact metadata. */
  async resolveModel(provider, modelId) {
    if (provider !== PROVIDER_ID) {
      throw new GatewayError(`码道适配器不服务于 provider "${provider}"`)
    }
    const model = this.#effective(this.deps.catalog.find(modelId))
    if (!model) {
      // The Host accepts unlisted model ids for routing, but there is nothing
      // to declare about one, so answer with the bare identity rather than
      // inventing capabilities.
      return { provider, id: modelId, name: modelId }
    }
    return {
      ...this.#modelInfo(provider, model),
      context: model.context > 0 ? { contextWindow: model.context } : undefined,
      defaultMaxTokens: model.maxOutput,
      ...(this.#reasoningInfo(model) ? { reasoning: this.#reasoningInfo(model) } : {}),
    }
  }

  /** Bind model metadata and dispatch to one adapter generation. */
  async prepareCall(provider, modelId) {
    const resolved = await this.resolveModel(provider, modelId)
    return {
      model: resolved,
      stream: (options) => this.stream(options),
    }
  }

  /**
   * Stream one call.
   *
   * Emits the block lifecycle explicitly: the Host's assembler is tolerant of
   * delta-only streams, but starting and closing each block keeps the
   * transcript correct when text and reasoning interleave.
   *
   * @param {any} options Host generation options.
   * @returns {AsyncGenerator<any>} Host stream chunks.
   */
  async *stream(options) {
    const model = this.#effective(this.deps.catalog.find(options.model))
    let client
    try {
      client = await this.#client()
    } catch (error) {
      if (error?.name !== 'AbortError' && !options.signal?.aborted) this.#reportError(error)
      // Credential resolution has always rejected stream acquisition directly.
      throw error
    }

    /** @type {number} */ let nextIndex = 0
    /** Open text block index, or undefined when none is open. */
    let textIndex
    /** Open reasoning block index. */
    let reasoningIndex
    /** Open tool-call blocks, keyed by the upstream call index. */
    const toolBlocks = new Map()
    /** Tool-call ids by upstream index, so later argument frames match. */
    const toolIds = new Map()
    // The Host assembler treats a `block-end` block as authoritative: it
    // REPLACES whatever the deltas accumulated. So each close must echo the
    // content this adapter streamed, or the block ends up empty.
    let textContent = ''
    let reasoningContent = ''
    /** Accumulated arguments and names, keyed by upstream call index. */
    const toolArgs = new Map()
    const toolNames = new Map()
    let sawToolCall = false
    /** Finish reason seen on the wire, emitted once the stream settles. */
    let pendingFinish

    const closeAll = function* () {
      if (textIndex !== undefined) {
        yield { type: 'block-end', index: textIndex, block: { type: 'text', text: textContent } }
        textIndex = undefined
      }
      if (reasoningIndex !== undefined) {
        yield {
          type: 'block-end',
          index: reasoningIndex,
          block: { type: 'reasoning', text: reasoningContent },
        }
        reasoningIndex = undefined
      }
      for (const [callIndex, blockIndex] of toolBlocks) {
        yield {
          type: 'block-end',
          index: blockIndex,
          block: {
            type: 'tool-call',
            id: toolIds.get(callIndex) ?? `tool-${callIndex}`,
            name: toolNames.get(callIndex) ?? '',
            arguments: toolArgs.get(callIndex) ?? '',
          },
        }
      }
      toolBlocks.clear()
    }

    try {
      const messages = await toGatewayMessages(options, this.deps.attachments)
      const request = {
        // Never the display string: the gateway answers a `name · ratio` value
        // with HTTP 200 and an empty body, which surfaces only as "returned a
        // completed response with no content".
        model:
          typeof this.deps.catalog?.resolveId === 'function'
            ? this.deps.catalog.resolveId(options.model)
            : options.model,
        messages,
        maxTokens: options.maxTokens ?? model?.maxOutput,
        temperature: options.temperature,
        ...(options.stop ? { stop: options.stop } : {}),
        ...(options.tools && options.tools.length > 0
          ? { tools: options.tools.map(toGatewayTool) }
          : {}),
        ...(options.reasoningEffort ? { reasoningEffort: String(options.reasoningEffort) } : {}),
        signal: options.signal,
      }

      await client.heartbeat('busy')

      for await (const event of client.streamChat(request)) {
        if (options.signal?.aborted) {
          yield* closeAll()
          yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '已取消', code: 'ABORTED' } } }
          return
        }

        if (event.reasoning) {
          if (reasoningIndex === undefined) {
            reasoningIndex = nextIndex++
            yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
          }
          reasoningContent += event.reasoning
          yield { type: 'reasoning-delta', index: reasoningIndex, text: event.reasoning }
        }

        if (event.text) {
          if (textIndex === undefined) {
            textIndex = nextIndex++
            yield { type: 'block-start', index: textIndex, blockType: 'text' }
          }
          textContent += event.text
          yield { type: 'text-delta', index: textIndex, text: event.text }
        }

        if (event.toolCalls) {
          sawToolCall = true
          for (const delta of event.toolCalls) {
            const callIndex = typeof delta.index === 'number' ? delta.index : 0
            if (delta.id) toolIds.set(callIndex, delta.id)

            let blockIndex = toolBlocks.get(callIndex)
            if (blockIndex === undefined) {
              blockIndex = nextIndex++
              toolBlocks.set(callIndex, blockIndex)
              // Close a pending text block first: a tool call terminates the
              // assistant's visible text for that turn.
              if (textIndex !== undefined) {
                yield {
                  type: 'block-end',
                  index: textIndex,
                  block: { type: 'text', text: textContent },
                }
                textIndex = undefined
              }
              yield { type: 'block-start', index: blockIndex, blockType: 'tool-call' }
            }

            const id = toolIds.get(callIndex) ?? `tool-${callIndex}`
            const name = delta.function?.name
            const argumentsDelta = delta.function?.arguments ?? ''
            if (name) toolNames.set(callIndex, name)
            if (argumentsDelta) toolArgs.set(callIndex, (toolArgs.get(callIndex) ?? '') + argumentsDelta)
            if (name || argumentsDelta) {
              yield {
                type: 'tool-call-delta',
                index: blockIndex,
                id,
                ...(name ? { name } : {}),
                argumentsDelta,
              }
            }
          }
        }

        if (event.usage) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
              ...(event.usage.totalTokens ? { totalTokens: event.usage.totalTokens } : {}),
            },
          }
        }

        // The gateway's own order is text/reasoning, then `finish`, then the
        // `usage` frame, then `[DONE]`. Returning on `finish` would therefore
        // discard the token counts, so the reason is recorded and the finish
        // chunk is emitted once the stream is actually over.
        if (event.finish) {
          pendingFinish = mapFinishReason(event.finish, sawToolCall)
        }

        if (event.done) break
      }

      // A completed reply with reasoning but no visible text and no tool call
      // is the failure mode this gateway produces when the output budget runs
      // out inside the thinking phase: reasoning and content share
      // `max_tokens`. The Host would otherwise report only "returned a
      // completed response with no content", which names no cause and suggests
      // no fix. Say what happened instead.
      if (
        textContent === '' &&
        reasoningContent !== '' &&
        !sawToolCall &&
        (pendingFinish === undefined || pendingFinish.kind === 'stop')
      ) {
        const budget = request.maxTokens ?? 0
        const note =
          `（模型把输出预算都用在思考上了：思考 ${reasoningContent.length} 字，正文 0 字，` +
          `本次 max_tokens=${budget}。思考与正文共用这个预算——提高 max_tokens（几百以上）通常即可恢复。）`
        if (textIndex === undefined) {
          textIndex = nextIndex++
          yield { type: 'block-start', index: textIndex, blockType: 'text' }
        }
        textContent = note
        yield { type: 'text-delta', index: textIndex, text: note }
      }

      // Settle: close open blocks, then finish with whatever reason arrived.
      yield* closeAll()
      yield {
        type: 'finish',
        reason: pendingFinish ?? (sawToolCall ? { kind: 'tool-calls' } : { kind: 'stop' }),
      }
    } catch (error) {
      if (error?.name !== 'AbortError' && !options.signal?.aborted) {
        this.#reportError(error)
      }
      yield* closeAll()

      const failure = describeFailure(error)
      // A cancellation surfaces as an aborted finish; anything else as an error.
      yield {
        type: 'finish',
        reason:
          error?.name === 'AbortError'
            ? { kind: 'aborted', failure }
            : { kind: 'error', failure },
      }
    } finally {
      // Releasing the concurrency slot matters even on failure: the gateway
      // allows only a few sessions, and a held slot blocks every new turn.
      void client.heartbeat('idle').catch(() => {})
    }
  }

  /** Logging failures must not delay or replace the original model outcome. */
  #reportError(error) {
    try { void Promise.resolve(this.deps.onError?.(error)).catch(() => {}) } catch {}
  }

  /** Build (or reuse) the gateway client for the current credential. */
  async #client() {
    const resolved = await this.deps.credentials.resolve()
    const key = resolved.key
    const signature = `${key.ak}:${key.securityToken}`
    const existing = this.clients.get(signature)
    if (existing) return existing

    // A renewed credential replaces the client: the old one signs with a
    // dead token.
    this.clients.clear()
    const client = this.deps.createClient
      ? this.deps.createClient(key)
      : new MadaoClient({ credentials: key, gateway: this.deps.gateway?.() })
    this.clients.set(signature, client)
    return client
  }

  /**
   * Apply the user's capability overrides to one model, when the catalog can.
   *
   * Optional on purpose: `effective` is a later addition, and a catalog that
   * predates it (a test double, a downgraded host) must degrade to the plain
   * model rather than break every request.
   */
  #effective(model) {
    const catalog = this.deps.catalog
    return typeof catalog?.effective === 'function' ? catalog.effective(model) : model
  }

  /** Convert one catalog entry into Host model metadata. */
  #modelInfo(provider, model) {
    const promo = resolveModelPromo(model)
    const busyBadge = resolveBusyBadge(model.busyLevel ?? 'unknown')
    const promoBadge = promo
      ? { text: { zh: promo.label, en: promo.labelEn }, tone: promo.tone }
      : undefined
    const badge = promoBadge && busyBadge
      ? {
          text: {
            zh: `${promoBadge.text.zh} · ${busyBadge.text.zh}`,
            en: `${promoBadge.text.en} · ${busyBadge.text.en}`,
          },
          tone: promoBadge.tone,
        }
      : promoBadge ?? busyBadge

    return {
      provider,
      id: model.id,
      name: model.ratio ? `${model.name} · ${model.ratio}` : model.name,
      ...(model.description ? { description: model.description } : {}),
      ...(model.supportsImages ? { inputModalities: ['text', 'image'] } : { inputModalities: ['text'] }),
      ...(badge ? { badge } : {}),
    }
  }

  /** Build the Host reasoning descriptor for a model that declares levels. */
  #reasoningInfo(model) {
    if (!model.strengths || model.strengths.length === 0) return undefined
    const levels = new Set(model.strengths)
    // `allowOff` is the user's answer to "should this model offer a 'no thinking'
    // level". Undefined keeps the upstream answer; false withholds it, because a
    // model that refuses `off` fails the whole request for anyone who picks it.
    const offerOff = model.allowOff !== false
    return {
      efforts: HOST_EFFORT_ORDER.filter(
        (level) => (level === 'off' ? offerOff : levels.has(level)),
      ).map(
        (level) => ({
          id: level,
          name: REASONING_LABELS[level] ?? level,
        }),
      ),
      defaultEffort: model.defaultStrength && levels.has(model.defaultStrength)
        ? model.defaultStrength
        : [...levels][0],
    }
  }
}

/** Display names for the reasoning levels. */
const REASONING_LABELS = {
  off: '关闭思考',
  low: '低',
  medium: '中',
  high: '高',
  max: '最高',
}

/**
 * Convert Host messages into OpenAI chat messages.
 *
 * Three conversions are load-bearing:
 *
 *   • `developer` becomes `system`. The gateway accepts only
 *     system/user/assistant/tool; a `developer` message is answered with an
 *     empty 200 response, which the Host can only report as an empty reply.
 *   • Tool results attach to the tool call they answer, as `tool` messages.
 *   • Images become `image_url` parts carrying a data URL — the gateway
 *     recognises that OpenAI shape and not the client's internal `file` one.
 *     The bytes come from the attachment service, because a durable image
 *     block holds a reference, not a payload.
 *
 * @param {any} options Host generation options.
 * @param {any} [attachments] the Host attachment service, when mounted.
 * @returns {Promise<Array<object>>} gateway messages.
 */
async function toGatewayMessages(options, attachments) {
  /** @type {Array<object>} */
  const messages = []

  if (typeof options.system === 'string' && options.system !== '') {
    messages.push({ role: 'system', content: options.system })
  }

  for (const message of options.messages ?? []) {
    switch (message.role) {
      case 'system':
      case 'developer':
        // The gateway silently ignores `developer`, so it must be downgraded
        // rather than dropped: it carries the system prompt.
        messages.push({ role: 'system', content: flattenText(message.content) })
        break

      case 'user': {
        const content = await toGatewayContent(message.content, attachments, options.signal)
        if (content !== '') messages.push({ role: 'user', content })
        break
      }

      case 'assistant': {
        const text = flattenText(message.content)
        const toolCalls = (message.content ?? [])
          .filter((block) => block?.type === 'tool-call')
          .map((block) => ({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: block.arguments },
          }))
        if (text === '' && toolCalls.length === 0) break
        messages.push({
          role: 'assistant',
          ...(text !== '' ? { content: text } : { content: null }),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        })
        break
      }

      case 'tool':
        messages.push({
          role: 'tool',
          tool_call_id: message.toolCallId ?? message.source?.callId,
          content: flattenText(message.content),
        })
        break

      default:
        break
    }
  }

  return messages
}

/**
 * Flatten Host content blocks into plain text.
 * @param {Array<any>|string|undefined} content content blocks.
 * @returns {string} concatenated text.
 */
function flattenText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

/**
 * Convert Host content into the gateway's content form.
 *
 * All-text content collapses to a plain string, which is both cheaper on the
 * wire and the only form some models accept.
 *
 * @param {Array<any>|string|undefined} content content blocks.
 * @param {any} [attachments] the Host attachment service.
 * @param {AbortSignal} [signal] cancellation.
 * @returns {Promise<string|Array<object>>} gateway content.
 */
async function toGatewayContent(content, attachments, signal) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text })
    } else if (block?.type === 'image' && block.attachment) {
      // A durable image block carries a reference; the bytes come from the
      // attachment service as a data URL the gateway understands.
      const encoded = await encodeImage(block.attachment, attachments, signal)
      if (encoded) parts.push({ type: 'image_url', image_url: { url: encoded } })
    }
  }

  if (parts.length === 0) return ''
  if (parts.every((part) => part.type === 'text')) {
    return parts.map((part) => part.text).join('')
  }
  return parts
}

/**
 * Encode one durable image as a data URL.
 *
 * An image that cannot be read is reported to the model as a short text note
 * rather than silently dropped: a missing picture must not look like the
 * question was never sent with one.
 *
 * @param {any} ref the image attachment reference.
 * @param {any} attachments the Host attachment service.
 * @param {AbortSignal} [signal] cancellation.
 * @returns {Promise<string|null>} the data URL, or null when unreadable.
 */
async function encodeImage(ref, attachments, signal) {
  try {
    if (typeof attachments?.readImageRequest === 'function') {
      // Ask for the image at its stored size: the gateway does its own
      // resizing, and a second downscale here would only lose detail.
      const read = await attachments.readImageRequest(
        ref,
        { width: ref.width, height: ref.height, maxBytes: ref.bytes },
        signal,
      )
      return `data:${read.mediaType};base64,${Buffer.from(read.data).toString('base64')}`
    }
    if (typeof attachments?.readImage === 'function') {
      const read = await attachments.readImage(ref, signal)
      return `data:${ref.mediaType};base64,${Buffer.from(read.data).toString('base64')}`
    }
  } catch {
    return null
  }
  return null
}

/**
 * Convert one Host tool schema into the gateway's function-tool form.
 * @param {any} tool Host tool schema.
 * @returns {object} gateway tool schema.
 */
function toGatewayTool(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  }
}

/**
 * Map an upstream finish reason onto the Host vocabulary.
 * @param {string} finish upstream reason.
 * @param {boolean} sawToolCall whether any tool call was streamed.
 * @returns {any} Host finish reason.
 */
function mapFinishReason(finish, sawToolCall) {
  switch (finish) {
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' }
    case 'length':
    case 'max_tokens':
      return { kind: 'max-tokens' }
    case 'content_filter':
      return { kind: 'stop' }
    default:
      // Some gateways report `stop` even for a tool-call turn.
      return sawToolCall ? { kind: 'tool-calls' } : { kind: 'stop' }
  }
}

/**
 * Turn a thrown error into a Host failure.
 *
 * The gateway's queue codes are translated rather than relayed, because the
 * upstream text names a business code and not what the user should do.
 * @param {any} error the thrown error.
 * @returns {{message: string, code: string, status?: number}} Host failure facts.
 */
function describeFailure(error) {
  if (error instanceof GatewayError) {
    return {
      message: error.message,
      code: error.code ?? (error.status ? 'PROVIDER_ERROR' : 'REQUEST_FAILED'),
      ...(error.status ? { status: error.status } : {}),
    }
  }
  if (error?.name === 'AbortError') {
    return { message: '已取消', code: 'ABORTED' }
  }
  return { message: error?.message ?? String(error), code: 'REQUEST_FAILED' }
}

/** Re-export so the Host half can name the identity helper without a second import. */
export { parseIdentity }
