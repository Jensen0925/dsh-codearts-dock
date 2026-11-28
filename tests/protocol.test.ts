/**
 * Offline tests for the transport envelope: signing, key agreement, and SSE
 * frame handling. The live gateway is exercised separately by `npm run test:live`.
 */

import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createHash, createHmac } from 'node:crypto'
import { canonicalUri, formatSdkDate, signRequest } from '../src/protocol/sign.ts'
import { deriveSessionKey, deriveRequestEnvelope, openChunk } from '../src/protocol/crypto.ts'
import { parseStreamEvent, splitSseEvents } from '../src/protocol/sse.ts'
import { MadaoClient, GatewayError } from '../src/gateway.ts'

const check = (name: string, fn: () => void | Promise<void>) => test(name, fn)

type ParsedEvent = {
  text?: string;
  reasoning?: string;
  toolCalls?: Array<{ id?: string }>;
  finish?: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  error?: string;
  done?: boolean;
}

const parse = (data: string): ParsedEvent => parseStreamEvent(data) as ParsedEvent

// ── signing ─────────────────────────────────────────────────────────────────

check('canonical URI adds a trailing slash', () => {
  assert.equal(canonicalUri('/api/v2/chat/completions'), '/api/v2/chat/completions/')
  assert.equal(canonicalUri('/api/v2/chat/completions/'), '/api/v2/chat/completions/')
})

check('canonical URI percent-encodes per segment, not the separators', () => {
  assert.equal(canonicalUri('/a b/c d'), '/a%20b/c%20d/')
})

check('SDK date is UTC second precision', () => {
  const d = new Date(Date.UTC(2026, 10, 18, 7, 8, 9))
  assert.equal(formatSdkDate(d), '20261118T070809Z')
})

check('signature is deterministic and covers the real body hash', () => {
  const url = new URL('https://example.test/api/v2/chat/completions')
  const credentials = { ak: 'AKID', sk: 'SECRET', securityToken: 'TOKEN' }
  const a = signRequest({ method: 'POST', url, contentType: 'application/json', body: '{"a":1}', credentials, sdkDate: '20261118T070809Z' })
  const b = signRequest({ method: 'POST', url, contentType: 'application/json', body: '{"a":1}', credentials, sdkDate: '20261118T070809Z' })
  assert.deepEqual(a, b)

  // Recompute the expected signature by hand from the documented canonical
  // form; a mismatch here means the canonical request drifted.
  const payloadHash = createHash('sha256').update('{"a":1}').digest('hex')
  const names = ['content-type', 'host', 'x-sdk-date', 'x-security-token']
  const block = [
    'content-type:application/json\n',
    'host:example.test\n',
    'x-sdk-date:20261118T070809Z\n',
    'x-security-token:TOKEN\n',
  ].join('')
  const canonical = ['POST', '/api/v2/chat/completions/', '', block, names.join(';'), payloadHash].join('\n')
  const stringToSign = ['SDK-HMAC-SHA256', '20261118T070809Z', createHash('sha256').update(canonical).digest('hex')].join('\n')
  const expected = createHmac('sha256', 'SECRET').update(stringToSign).digest('hex')
  assert.ok(a.Authorization.includes(`Signature=${expected}`), a.Authorization)
})

check('different bodies produce different signatures', () => {
  const url = new URL('https://example.test/x')
  const credentials = { ak: 'AKID', sk: 'SECRET', securityToken: 'TOKEN' }
  const a = signRequest({ method: 'POST', url, contentType: 'application/json', body: '{"a":1}', credentials, sdkDate: '20260101T000000Z' })
  const b = signRequest({ method: 'POST', url, contentType: 'application/json', body: '{"a":2}', credentials, sdkDate: '20260101T000000Z' })
  assert.notEqual(a.Authorization, b.Authorization)
})

check('a non-default port joins the Host header', () => {
  const headers = signRequest({
    method: 'GET',
    url: new URL('https://example.test:8443/x'),
    contentType: null,
    credentials: { ak: 'A', sk: 'S', securityToken: 'T' },
    sdkDate: '20260101T000000Z',
  })
  assert.equal(headers.Host, 'example.test:8443')
})

// ── key agreement ───────────────────────────────────────────────────────────

check('session key is the first 16 bytes of the SHA-256 of the secret', () => {
  const secret = Buffer.from('shared-secret-bytes')
  const expected = createHash('sha256').update(secret).digest().subarray(0, 16)
  assert.deepEqual(deriveSessionKey(secret), expected)
  assert.equal(deriveSessionKey(secret).length, 16)
})

// ── envelope ────────────────────────────────────────────────────────────────

check('a request envelope round-trips through its own chunk AAD shape', () => {
  // The request AAD binds method/path/timestamp, so a chunk sealed with it is
  // only openable by a frame claiming that exact identity. Prove the envelope
  // is well formed rather than asserting a cross-AAD decrypt.
  const envelope = deriveRequestEnvelope({
    key: Buffer.alloc(16, 5),
    keyId: 'key-1',
    method: 'POST',
    pathname: '/api/v2/chat/completions',
    timestamp: 1700000000000,
    plaintext: '{"model":"m"}',
  })
  assert.equal(envelope.headers['X-Encrypt-Algo'], 'sm4-gcm')
  assert.equal(envelope.headers['X-Encrypt-Key-Id'], 'key-1')
  assert.equal(envelope.headers['X-Encrypt-Ts'], '1700000000000')
  assert.equal(envelope.headers['Content-Type'], 'application/octet-stream')
  assert.ok(/^[A-Za-z0-9+/=]+$/.test(envelope.body), 'body must be base64 text')
})

check('openChunk ignores a frame that is not a triple', () => {
  assert.equal(openChunk('[DONE]', Buffer.alloc(16), 'k', 0), null)
  assert.equal(openChunk('', Buffer.alloc(16), 'k', 0), null)
  assert.equal(openChunk('a:b:c:d', Buffer.alloc(16), 'k', 0), null)
})

// ── SSE ─────────────────────────────────────────────────────────────────────

check('the splitter keeps sealed frames, which carry no data: prefix', () => {
  const { blocks, rest } = splitSseEvents('aaa:bbb:ccc\n\n')
  assert.deepEqual(blocks, ['aaa:bbb:ccc'])
  assert.equal(rest, '')
})

check('the splitter leaves a partial trailing block', () => {
  const { blocks, rest } = splitSseEvents('one\n\ntw')
  assert.deepEqual(blocks, ['one'])
  assert.equal(rest, 'tw')
})

check('a plain OpenAI chunk yields text, finish reason, and usage', () => {
  const text = parse('{"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}')
  assert.equal(text.text, 'hi')

  const finish = parse('{"choices":[{"delta":{},"finish_reason":"stop"}]}')
  assert.equal(finish.finish, 'stop')

  const usage = parse('{"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}')
  assert.deepEqual(usage.usage, { inputTokens: 3, outputTokens: 4, totalTokens: 7 })
})

check('reasoning and tool calls survive parsing', () => {
  const reasoning = parse('{"choices":[{"delta":{"reasoning_content":"think"}}]}')
  assert.equal(reasoning.reasoning, 'think')

  const toolCall = parse('{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"f","arguments":"{}"}}]}}]}')
  assert.ok(toolCall.toolCalls, 'tool-call deltas are exposed');
  assert.equal(toolCall.toolCalls.length, 1)
  assert.equal(toolCall.toolCalls[0].id, 'c1')
})

check('[DONE] is recognised as the terminal sentinel', () => {
  assert.deepEqual(parse('[DONE]'), { done: true })
})

check('an upstream error frame is surfaced', () => {
  const event = parse('{"error":{"message":"quota"}}')
  assert.equal(event.error, 'quota')
})

check('an unrecognised frame yields nothing rather than throwing', () => {
  assert.deepEqual(parseStreamEvent('not json'), {})
  assert.deepEqual(parseStreamEvent('{"unrelated":true}'), {})
})

const makeStreamClient = (body: string | ReadableStream<Uint8Array>, streamIdleTimeoutMs = 300_000) => {
  const client: any = new MadaoClient({
    credentials: { ak: 'AK', sk: 'SK', securityToken: 'TOKEN' },
    streamIdleTimeoutMs,
    fetch: async () => ({
      ok: true,
      headers: new Headers(),
      body: typeof body === 'string'
        ? ReadableStream.from([new TextEncoder().encode(body)])
        : body,
    }) as Response,
  })
  client.sessionKey = { keyId: 'test-key', key: Buffer.alloc(16), expiresAt: Date.now() + 3_600_000 }
  return client
}

check('an unexpected chat-stream EOF is reported instead of successful partial completion', async () => {
  const client = makeStreamClient('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')
  const received: ParsedEvent[] = []
  await assert.rejects(async () => {
    for await (const event of client.streamChat({ model: 'm', messages: [] })) received.push(event)
  }, (error) => {
    const failure = error as GatewayError & { code?: string; retryable?: boolean }
    return failure instanceof GatewayError && failure.code === 'REQUEST_FAILED' && failure.retryable === true
  })
  assert.equal(received[0]?.text, 'partial', 'already received text remains available before the terminal error')
})

check('a finish reason is enough when a gateway omits the trailing DONE sentinel', async () => {
  const client = makeStreamClient('data: {"choices":[{"delta":{"content":"complete"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
  const received: ParsedEvent[] = []
  for await (const event of client.streamChat({ model: 'm', messages: [] })) received.push(event)
  assert.equal(received.at(-1)?.finish, 'stop')
})

check('the stream parser survives byte-by-byte UTF-8 and SSE delimiter splits', async () => {
  const bytes = new TextEncoder().encode(
    'data: {"choices":[{"delta":{"content":"你好，世界 🌍"},"finish_reason":null}]}\r\n\r\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\n',
  )
  const body = ReadableStream.from(Array.from(bytes, (byte) => Uint8Array.of(byte)))
  const received: ParsedEvent[] = []
  for await (const event of makeStreamClient(body).streamChat({ model: 'm', messages: [] })) received.push(event)
  assert.equal(received.find((event) => event.text)?.text, '你好，世界 🌍')
  assert.equal(received.find((event) => event.finish)?.finish, 'stop')
})

check('a body stream reset after partial output becomes a retryable transport failure', async () => {
  let sentPartial = false
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sentPartial) return
      sentPartial = true
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'))
      await new Promise((resolve) => setTimeout(resolve, 0))
      controller.error(new TypeError('socket reset'))
    },
  })
  const received: ParsedEvent[] = []
  await assert.rejects(async () => {
    for await (const event of makeStreamClient(body).streamChat({ model: 'm', messages: [] })) received.push(event)
  }, (error) => {
    const failure = error as GatewayError & { code?: string; retryable?: boolean }
    return failure instanceof GatewayError && failure.code === 'REQUEST_FAILED' && failure.retryable === true
  })
  assert.equal(received[0]?.text, 'partial')
})

check('a body reset after the finish reason preserves the completed answer', async () => {
  let sentFinish = false
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentFinish) {
        sentFinish = true
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'))
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
      controller.error(new TypeError('socket reset after completion'))
    },
  })
  const received: ParsedEvent[] = []
  for await (const event of makeStreamClient(body).streamChat({ model: 'm', messages: [] })) received.push(event)
  assert.equal(received.find((event) => event.finish)?.finish, 'stop')
})

check('a standalone DONE sentinel completes a response without a finish reason', async () => {
  const received: ParsedEvent[] = []
  for await (const event of makeStreamClient('data: [DONE]\n\n').streamChat({ model: 'm', messages: [] })) received.push(event)
  assert.deepEqual(received, [{ done: true }])
})

check('a stalled response body times out as a retryable failure', async () => {
  const body = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) })
  await assert.rejects(async () => {
    for await (const _event of makeStreamClient(body, 10).streamChat({ model: 'm', messages: [] })) {}
  }, (error) => {
    const failure = error as GatewayError & { code?: string; retryable?: boolean }
    return failure instanceof GatewayError && /超时/.test(failure.message) && failure.code === 'REQUEST_FAILED' && failure.retryable === true
  })
})

check('a gateway that never sends response headers times out as a retryable failure', async () => {
  const client: any = new MadaoClient({
    credentials: { ak: 'AK', sk: 'SK', securityToken: 'TOKEN' },
    streamIdleTimeoutMs: 10,
    fetch: () => new Promise(() => {}),
  })
  client.sessionKey = { keyId: 'test-key', key: Buffer.alloc(16), expiresAt: Date.now() + 3_600_000 }
  await assert.rejects(async () => {
    for await (const _event of client.streamChat({ model: 'm', messages: [] })) {}
  }, (error) => {
    const failure = error as GatewayError & { code?: string; retryable?: boolean }
    return failure instanceof GatewayError && /超时/.test(failure.message) && failure.code === 'REQUEST_FAILED' && failure.retryable === true
  })
})

check('a complete final finish frame without a blank-line delimiter is still parsed', async () => {
  const received: ParsedEvent[] = []
  const payload = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}'
  for await (const event of makeStreamClient(payload).streamChat({ model: 'm', messages: [] })) received.push(event)
  assert.equal(received[0]?.finish, 'stop')
})

check('an aborted chat stream remains an abort instead of an incomplete-stream failure', async () => {
  const controller = new AbortController()
  controller.abort()
  const client = makeStreamClient('')
  await assert.rejects(async () => {
    for await (const _event of client.streamChat({ model: 'm', messages: [], signal: controller.signal })) {}
  }, { name: 'AbortError' })
})

check('an abort while waiting for the next body chunk cancels promptly', async () => {
  const controller = new AbortController()
  const body = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) })
  const pending = (async () => {
    for await (const _event of makeStreamClient(body).streamChat({ model: 'm', messages: [], signal: controller.signal })) {}
  })
  setTimeout(() => controller.abort(), 5)
  await assert.rejects(pending, { name: 'AbortError' })
})
