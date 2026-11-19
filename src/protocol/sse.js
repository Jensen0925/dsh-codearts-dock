/**
 * Server-sent-event parsing for the 码道 chat stream.
 *
 * The gateway streams OpenAI-shaped chunks (`data: {...}`), so the parser
 * reads that shape first and keeps a tolerant fallback for an ai-sdk-shaped
 * event, which the same endpoint has been observed to emit. An unrecognised
 * event yields nothing rather than throwing: a single unknown frame must not
 * abort an otherwise healthy response.
 */

/**
 * @typedef {object} ParsedEvent
 * @property {string} [text] visible text delta.
 * @property {string} [reasoning] reasoning delta.
 * @property {Array<object>} [toolCalls] tool-call deltas, passed through verbatim.
 * @property {string} [finish] finish reason.
 * @property {{inputTokens: number, outputTokens: number, totalTokens: number}} [usage] usage.
 * @property {string} [error] upstream error text.
 * @property {boolean} [done] the `[DONE]` sentinel was seen.
 */

/**
 * Split a stream buffer into complete blocks, returning the remainder.
 *
 * A block is whatever sits between two blank lines. It is NOT required to
 * carry a `data:` prefix: a sealed 码道 frame is an `iv:tag:ciphertext`
 * triple, and only the plaintext behind it is SSE-shaped. Filtering here by
 * prefix would silently discard every sealed frame.
 *
 * @param {string} buffer accumulated stream text.
 * @returns {{blocks: string[], rest: string}} complete blocks and the trailing partial.
 */
export function splitSseEvents(buffer) {
  const blocks = []
  let rest = buffer
  for (;;) {
    const match = /\r?\n\r?\n/.exec(rest)
    if (!match) break
    const raw = rest.slice(0, match.index)
    rest = rest.slice(match.index + match[0].length)
    if (raw.trim() !== '') blocks.push(raw.trim())
  }
  return { blocks, rest }
}

/**
 * Parse one SSE payload.
 * @param {string} data the text after `data:`, already joined.
 * @returns {ParsedEvent} whatever the frame carries; empty when unrecognised.
 */
export function parseStreamEvent(data) {
  const trimmed = data.trim()
  if (trimmed === '') return {}
  if (trimmed === '[DONE]') return { done: true }

  let obj
  try {
    obj = JSON.parse(trimmed)
  } catch {
    return {}
  }
  if (obj === null || typeof obj !== 'object') return {}

  /** @type {ParsedEvent} */
  const out = {}

  // An upstream failure can arrive as a normal-looking frame.
  if (obj.error) {
    const error = obj.error
    out.error = typeof error === 'string' ? error : (error.message ?? JSON.stringify(error))
    return out
  }

  // ── OpenAI chat-completions chunk ────────────────────────────────────────
  if (Array.isArray(obj.choices)) {
    // Usage arrives on its own frame with an empty `choices` array.
    if (obj.usage) out.usage = readUsage(obj.usage)

    const choice = obj.choices[0]
    if (!choice) return out

    const delta = choice.delta ?? choice.message ?? {}
    if (typeof delta.content === 'string' && delta.content !== '') out.text = delta.content
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
      out.reasoning = delta.reasoning_content
    }
    if (typeof delta.reasoning === 'string' && delta.reasoning !== '') out.reasoning = delta.reasoning
    // Tool calls must pass through untouched: dropping them loses every
    // action the model asked for and surfaces as `finish_reason: tool_calls`
    // with empty content, which the host reports as a broken response.
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      out.toolCalls = delta.tool_calls
    }
    if (choice.finish_reason) out.finish = String(choice.finish_reason)
    return out
  }

  // ── ai-sdk event shapes ──────────────────────────────────────────────────
  const type = typeof obj.type === 'string' ? obj.type : ''
  if (type === 'text-delta' || type === 'text_delta') {
    out.text = obj.delta ?? obj.textDelta ?? obj.text ?? ''
    return out
  }
  if (type === 'reasoning' || type === 'reasoning-delta') {
    out.reasoning = obj.delta ?? obj.textDelta ?? obj.text ?? ''
    return out
  }
  if (type === 'finish' || type === 'finish-step') {
    out.finish = obj.finishReason ?? obj.finish_reason ?? 'stop'
    if (obj.usage) out.usage = readUsage(obj.usage)
    return out
  }
  if (type === 'error') {
    out.error = obj.error ?? obj.message ?? 'upstream stream error'
    return out
  }
  if (type === 'message.part.updated') {
    const part = obj.part ?? obj.properties?.part ?? {}
    if (part.type === 'text' && typeof part.text === 'string') out.text = part.text
    if (part.type === 'reasoning' && typeof part.text === 'string') out.reasoning = part.text
    return out
  }

  return out
}

/** Normalise a usage object, accepting both snake_case and camelCase. */
function readUsage(usage) {
  return {
    inputTokens: usage.prompt_tokens ?? usage.promptTokens ?? usage.inputTokens ?? 0,
    outputTokens: usage.completion_tokens ?? usage.completionTokens ?? usage.outputTokens ?? 0,
    totalTokens: usage.total_tokens ?? usage.totalTokens ?? 0,
  }
}
