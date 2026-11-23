// @ts-nocheck
/**
 * The 码道 (CodeArts Agent) gateway client.
 *
 * One chat request draws on all three layers:
 *
 *   1. `SDK-HMAC-SHA256` signing over the AK/SK/STS triple
 *   2. a P-256 agreement that yields the SM4 session key
 *   3. an SM4-GCM sealed request body with a per-chunk decrypted SSE stream
 *
 * The wire format is not a JSON envelope. The ciphertext travels in the raw
 * body as Base64 TEXT, and IV, tag, key id, and timestamp travel in
 * `X-Encrypt-*` headers:
 *
 *   Content-Type:      application/octet-stream
 *   X-Encrypt-Algo:    sm4-gcm
 *   X-Encrypt-Key-Id:  <keyId>
 *   X-Encrypt-Iv:      <base64>
 *   X-Encrypt-Tag:     <base64>
 *   X-Encrypt-Ts:      <epoch ms, also part of the request AAD>
 *   body:              <base64 ciphertext>
 *
 * The reply is an SSE stream whose frames are `iv:tag:ciphertext` triples,
 * each decrypted with AAD `${keyId}|${chunkIndex}`. The gateway signals that
 * by answering `x-encrypt-algo: sm4-gcm`; without that header the stream is
 * already plaintext.
 *
 * Base: https://snap-access.cn-north-4.myhuaweicloud.com
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { signRequest } from './protocol/sign.js'
import { completeKeyExchange, createEcdhPair, deriveRequestEnvelope, openChunk } from './protocol/crypto.js'
import { parseStreamEvent, splitSseEvents } from './protocol/sse.js'

/** The gateway root used when configuration names none. */
export const DEFAULT_GATEWAY = 'https://snap-access.cn-north-4.myhuaweicloud.com'

/** Chat completions (sealed body, streamed and sealed response). */
export const CHAT_PATH = '/api/v2/chat/completions'
/** Session-key agreement. */
export const KEY_EXCHANGE_PATH = '/api/v1/security/key-exchange'
/** Plain (unsealed) JSON reads. */
export const MODELS_PATH = '/v1/model/builtin'
export const THINKING_VARIANTS_PATH = '/v1/model/thinking-variants'
/** Current model congestion levels, returned independently from the roster. */
export const MODEL_BUSY_PATH = '/v2/chat/busy'
export const CREDIT_STATISTICS_PATH = '/snap-manager/v1/statistics/plugin'
export const ROLES_PATH = '/snap-manager/v1/member/roles'
export const BENEFITS_PATH = '/v1/ops/delivery?channel=IDE'
export const BENEFIT_CLAIM_PATH = '/v1/ops/claim'
export const HEARTBEAT_PATH = '/snap-manager/v1/chat-session/heartbeat'

/** Renew the session key this long before it expires. */
const REFRESH_MARGIN_MS = 300_000

/**
 * Headers every request to this gateway must carry. Each one is required:
 * omitting `Agent-Type` or `x-language` answers HTTP 400 with no explanation.
 */
const BUSINESS_HEADERS = {
  'Agent-Type': 'PromptCenter',
}

/**
 * The client identity asserted to the gateway. These mirror the official
 * CodeArts Agent extension — product names and version numbers, not secrets.
 */
const DEFAULT_IDENTITY = {
  pluginName: 'codemate_vscode',
  pluginVersion: '26.11.100',
  ideName: 'VSCode',
  ideVersion: '26.11.100',
  userAgent: 'ai-sdk/provider-utils/4.0.21 runtime/bun/1.3.14',
}

/** An upstream failure carrying the HTTP status and the gateway's own text. */
export class GatewayError extends Error {
  /**
   * @param {string} message human-readable failure.
   * @param {object} [details] failure facts.
   * @param {number} [details.status] HTTP status.
   * @param {string} [details.code] gateway business code.
   * @param {boolean} [details.retryable] whether a retry could succeed.
   */
  constructor(message, { status, code, retryable = false } = {}) {
    super(message)
    this.name = 'GatewayError'
    this.status = status
    this.code = code
    this.retryable = retryable
  }
}

export class MadaoClient {
  /**
   * @param {object} options client options.
   * @param {{ak: string, sk: string, securityToken: string}} options.credentials the signed triple.
   * @param {string} [options.gateway] gateway root override.
   * @param {typeof fetch} [options.fetch] fetch implementation, for tests.
   * @param {object} [options.identity] client identity overrides.
   * @param {string} [options.language] language header value.
   * @param {string} [options.sessionId] fixed `user-session-id`.
   */
  constructor(options) {
    this.gateway = (options.gateway ?? DEFAULT_GATEWAY).replace(/\/+$/, '')
    this.credentials = options.credentials
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.identity = { ...DEFAULT_IDENTITY, ...options.identity }
    this.language = options.language ?? 'zh-cn'
    this.sessionKey = null
    this.negotiating = null
    this.sessionId = options.sessionId ?? null

    // The gateway counts concurrent sessions per `user-session-id` with a
    // small ceiling (three). Without the header every request opens a new
    // session, and a handful of requests exhausts the quota permanently.
    // One stable value per credential keeps the plugin inside one session.
    this.defaultSessionId =
      this.sessionId ??
      `codearts-${createHash('sha256')
        .update(options.credentials.ak ?? 'default')
        .digest('hex')
        .slice(0, 16)}`
  }

  /** The identity headers the gateway requires on every call. */
  #identityHeaders() {
    return {
      ...BUSINESS_HEADERS,
      'x-language': this.language,
      'plugin-name': this.identity.pluginName,
      'plugin-version': this.identity.pluginVersion,
      'ide-name': this.identity.ideName,
      'ide-version': this.identity.ideVersion,
    }
  }

  // ── key agreement ────────────────────────────────────────────────────────

  /**
   * Return a usable session key, negotiating one when the cached key is
   * near expiry. Concurrent callers share a single negotiation.
   * @returns {Promise<{keyId: string, key: Buffer, expiresAt: number}>} the key.
   */
  async ensureSessionKey() {
    if (this.sessionKey && Date.now() < this.sessionKey.expiresAt - REFRESH_MARGIN_MS) {
      return this.sessionKey
    }
    if (this.negotiating) return this.negotiating
    this.negotiating = this.negotiate().finally(() => {
      this.negotiating = null
    })
    return this.negotiating
  }

  /** Run one P-256 agreement and cache its result. */
  async negotiate() {
    const pathname = KEY_EXCHANGE_PATH
    const url = new URL(this.gateway + pathname)
    const pair = createEcdhPair()
    const body = JSON.stringify({
      clientPublicKey: pair.publicKeyB64,
      sessionId: randomBytes(16).toString('hex'),
      timestamp: Date.now(),
    })

    const headers = signRequest({
      method: 'POST',
      url,
      contentType: 'application/json',
      body,
      credentials: this.credentials,
    })

    const response = await this.fetch(url, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'User-Agent': this.identity.userAgent,
        ...this.#identityHeaders(),
      },
      body,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new GatewayError(summariseFailure(response.status, text), {
        status: response.status,
        code: extractBusinessCode(text),
        retryable: response.status >= 500,
      })
    }

    const payload = await response.json()
    const serverKey = payload?.serverPublicKey ?? payload?.data?.serverPublicKey
    const keyId = payload?.keyId ?? payload?.data?.keyId
    const expiresInSec = payload?.expiresIn ?? payload?.data?.expiresIn ?? 7200

    if (!serverKey || !keyId) {
      throw new GatewayError(
        `key-exchange response missing fields: ${JSON.stringify(payload).slice(0, 300)}`,
      )
    }

    const sharedSecret = pair.ecdh.computeSecret(Buffer.from(serverKey, 'base64'))
    this.sessionKey = {
      keyId: String(keyId),
      key: completeKeyExchange(sharedSecret),
      expiresAt: Date.now() + Number(expiresInSec) * 1000,
    }
    return this.sessionKey
  }

  // ── plain JSON reads ─────────────────────────────────────────────────────

  /**
   * GET a plain (unsealed) JSON endpoint.
   * @param {string} pathname request path, including any query string.
   * @returns {Promise<any>} the parsed body.
   */
  async getJson(pathname) {
    return this.#requestJson('GET', pathname)
  }

  /**
   * POST a plain (unsealed) JSON body and read the JSON reply.
   * @param {string} pathname request path.
   * @param {unknown} body JSON-serialisable request body.
   * @returns {Promise<any>} the parsed body.
   */
  async postJson(pathname, body, options = {}) {
    return this.#requestJson('POST', pathname, body, options)
  }

  /** Shared implementation for the unsealed JSON endpoints. */
  async #requestJson(method, pathname, body, { signal } = {}) {
    // Sign the path and carry the query separately: the signature covers the
    // canonical path only.
    const [pathOnly, query] = pathname.split('?')
    const url = new URL(this.gateway + pathOnly)
    if (query) url.search = query

    const text = body === undefined ? '' : JSON.stringify(body)
    const headers = signRequest({
      method,
      url,
      contentType: body === undefined ? null : 'application/json',
      body: text,
      credentials: this.credentials,
    })

    const response = await this.fetch(url, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        'User-Agent': this.identity.userAgent,
        ...this.#identityHeaders(),
      },
      ...(body === undefined ? {} : { body: text }),
      ...(signal ? { signal } : {}),
    })

    const replyText = await response.text()
    if (!response.ok) {
      throw new GatewayError(summariseFailure(response.status, replyText), {
        status: response.status,
        code: extractBusinessCode(replyText),
        retryable: response.status === 429 || response.status >= 500,
      })
    }
    try {
      return JSON.parse(replyText)
    } catch {
      throw new GatewayError(`non-JSON reply from ${pathOnly}: ${replyText.slice(0, 200)}`)
    }
  }

  /**
   * PUT the session heartbeat, marking this session busy or idle.
   *
   * The gateway counts concurrent sessions per `user-session-id`; declaring
   * idle releases the slot immediately instead of leaving it held for the
   * full timeout. Failure is ignored — this only optimises quota, and must
   * never break a conversation.
   *
   * @param {'busy'|'idle'} status current session state.
   * @returns {Promise<boolean>} whether the gateway accepted it.
   */
  async heartbeat(status) {
    try {
      const path = `${HEARTBEAT_PATH}?status=${status}`
      const url = new URL(this.gateway + HEARTBEAT_PATH)
      url.search = `?status=${status}`
      const headers = signRequest({
        method: 'PUT',
        url,
        contentType: null,
        body: '',
        credentials: this.credentials,
      })
      const response = await this.fetch(url, {
        method: 'PUT',
        headers: {
          ...headers,
          'User-Agent': this.identity.userAgent,
          ...this.#identityHeaders(),
          'user-session-id': this.defaultSessionId,
        },
      })
      return response.ok
    } catch {
      return false
    }
  }

  // ── chat ─────────────────────────────────────────────────────────────────

  /**
   * Stream one chat completion.
   *
   * The reply is normally an encrypted SSE stream; this yields
   * already-decrypted parsed events and stops after the terminal frame.
   *
   * @param {object} request chat request.
   * @param {string} request.model model id.
   * @param {Array<object>} request.messages OpenAI-shaped messages.
   * @param {number} [request.maxTokens] output cap.
   * @param {number} [request.temperature] sampling temperature.
   * @param {string} [request.reasoningEffort] thinking level.
   * @param {Array<object>} [request.tools] tool schemas.
   * @param {string|string[]} [request.stop] stop sequences.
   * @param {AbortSignal} [request.signal] cancellation.
   * @returns {AsyncGenerator<import('./protocol/sse.js').ParsedEvent>} parsed events.
   */
  async *streamChat(request) {
    const session = await this.ensureSessionKey()
    const pathname = CHAT_PATH
    const url = new URL(this.gateway + pathname)
    const timestamp = Date.now()

    const body = {
      model: request.model,
      messages: request.messages,
      max_tokens: request.maxTokens ?? 65536,
      stream: true,
      ...(typeof request.temperature === 'number' ? { temperature: request.temperature } : {}),
      ...(request.stop ? { stop: request.stop } : {}),
      ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
      // The gateway reads `reasoning_effort`; it silently ignores `strength`,
      // which is why an earlier build appeared to change nothing.
      ...(request.reasoningEffort
        ? { reasoning_effort: request.reasoningEffort === 'off' ? 'none' : request.reasoningEffort }
        : {}),
    }

    const envelope = deriveRequestEnvelope({
      key: session.key,
      keyId: session.keyId,
      method: 'POST',
      pathname,
      timestamp,
      plaintext: JSON.stringify(body),
    })

    // The signature must cover the bytes actually sent — the Base64
    // ciphertext text, not the JSON request body.
    const signed = signRequest({
      method: 'POST',
      url,
      contentType: envelope.headers['Content-Type'],
      body: envelope.body,
      credentials: this.credentials,
    })

    let response
    try {
      response = await this.fetch(url, {
        method: 'POST',
        headers: {
          ...signed,
          ...envelope.headers,
          Accept: 'text/event-stream',
          'X-Encrypt-Capable': 'sm4-gcm',
          'User-Agent': this.identity.userAgent,
          ...this.#identityHeaders(),
          'user-session-id': this.defaultSessionId,
          'user-msg-id': randomUUID(),
        },
        body: envelope.body,
        signal: request.signal,
      })
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      throw new GatewayError(`无法连接码道网关：${error?.message ?? error}`, { retryable: true })
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      // A 4xx body is also sealed, so it is unreadable until decrypted;
      // trying is what turns "HTTP 400" into something actionable.
      const detail = openSealedBody(errorText, session.key, session.keyId)
      throw new GatewayError(summariseFailure(response.status, detail, true), {
        status: response.status,
        code: extractBusinessCode(detail),
        retryable: response.status === 429 || response.status >= 500,
      })
    }

    const sealed = response.headers.get('x-encrypt-algo') === 'sm4-gcm'
    if (!response.body) throw new GatewayError('chat response carried no body')

    const decoder = new TextDecoder()
    let buffer = ''
    let index = 0

    for await (const bytes of response.body) {
      buffer += decoder.decode(bytes, { stream: true })
      const { blocks, rest } = splitSseEvents(buffer)
      buffer = rest

      for (const block of blocks) {
        // Decrypt first, then parse: a sealed block carries no `data:` prefix
        // until it is opened.
        const plaintext = sealed ? openChunk(block, session.key, session.keyId, index) : block
        index += 1
        if (plaintext === null) continue
        for (const event of parseFrames(plaintext)) {
          if (event.error) {
            throw new GatewayError(`码道上游返回错误：${event.error}`, {
              code: event.error,
              retryable: false,
            })
          }
          yield event
          if (event.done) return
        }
      }
    }

    // A stream that ends without `[DONE]` still has to settle.
    if (buffer.trim() !== '') {
      const plaintext = sealed ? openChunk(buffer.trim(), session.key, session.keyId, index) : buffer.trim()
      if (plaintext) {
        for (const event of parseFrames(plaintext)) {
          if (event.error) {
            throw new GatewayError(`码道上游返回错误：${event.error}`, { code: event.error })
          }
          yield event
          if (event.done) return
        }
      }
    }
  }
}

/**
 * Split one decrypted block into SSE payloads.
 *
 * A decrypted block is `data:{...}` with no trailing newline, so it may hold
 * one payload and may also be a multi-line body. Every `data:` line is
 * treated as its own payload.
 */
function parseFrames(plaintext) {
  const trimmed = plaintext.trim()
  if (trimmed === '') return []
  const lines = trimmed.split(/\r?\n/).filter((line) => line.startsWith('data:'))
  if (lines.length === 0) {
    // Not SSE-framed: a bare JSON object or the [DONE] sentinel.
    const event = parseStreamEvent(trimmed)
    return Object.keys(event).length > 0 ? [event] : []
  }
  return lines.map((line) => parseStreamEvent(line.slice(5).replace(/^ /, '')))
}

/**
 * Try to open a sealed error body, falling back to the raw text.
 * @returns {string} readable failure text.
 */
function openSealedBody(text, key, keyId) {
  const trimmed = (text ?? '').trim()
  if (trimmed === '') return '(空响应体)'
  try {
    return openChunk(trimmed, key, keyId, 0) ?? trimmed.slice(0, 300)
  } catch {
    return trimmed.slice(0, 300)
  }
}

/** Turn one gateway failure body into a readable sentence. */
function summariseFailure(status, text, alreadyReadable = false) {
  const code = alreadyReadable ? extractBusinessCode(text) : extractBusinessCode(text)
  let detail = ''
  try {
    const parsed = JSON.parse(text)
    // The gateway's own failures use `error_code` / `error_msg`; a proxy in
    // front of it may use `msg` / `message`. Accept both, or the message is
    // an empty shell with only the status.
    detail =
      parsed?.error_msg ??
      parsed?.msg ??
      parsed?.message ??
      parsed?.error?.message ??
      ''
    if (detail === '' && typeof parsed?.error === 'string') detail = parsed.error
  } catch {
    detail = text.slice(0, 300)
  }
  const suffix = code ? ` (code ${code})` : ''
  return `码道网关返回 HTTP ${status}${suffix}${detail ? `：${detail}` : ''}`
}

/** Pull a gateway business code out of a failure body. */
function extractBusinessCode(text) {
  try {
    const parsed = JSON.parse(text)
    const code =
      parsed?.error_code ?? parsed?.code ?? parsed?.error?.code ?? parsed?.error?.type
    return code === undefined || code === null ? undefined : String(code)
  } catch {
    return undefined
  }
}
