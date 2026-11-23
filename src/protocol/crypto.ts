/**
 * The 码道 transport envelope: P-256 key agreement plus SM4-GCM payloads.
 *
 * Every parameter here was established by observing the real gateway, and
 * three of them contradict what the public SDK shape suggests:
 *
 *   curve:      prime256v1 (P-256) — NOT X25519
 *   KDF:        sessionKey = SHA256(sharedSecret)[0:16] — a bare truncation,
 *               NOT HKDF
 *   AAD (req):  `${METHOD}|${pathname}|${timestamp}`
 *   AAD (resp): `${keyId}|${chunkIndex}` — independent of the request's
 *               method/path/timestamp, which is what makes streaming work
 *
 * The request body is sent as Base64 TEXT, not raw bytes.
 */

import { createECDH, createHash, randomBytes, randomUUID } from 'node:crypto'
import { sm4GcmDecrypt, sm4GcmEncrypt } from './sm4.js'

/** The agreed curve. */
export const CURVE = 'prime256v1'
/** Session key length in bytes (SM4-128). */
export const KEY_BYTES = 16
/** GCM IV length in bytes. */
export const IV_BYTES = 12
/** GCM tag length in bytes. */
export const TAG_BYTES = 16

/**
 * @typedef {object} SessionKey
 * @property {string} keyId gateway-issued key identifier, echoed in AAD.
 * @property {Buffer} key the 16-byte SM4 key.
 * @property {number} expiresAt epoch ms when the gateway's key expires.
 */

/** A fresh 12-byte GCM IV. */
export function randomIv() {
  return randomBytes(IV_BYTES)
}

/**
 * Derive the SM4 session key from the ECDH shared secret.
 *
 * The gateway uses a bare SHA-256 truncated to 16 bytes. Using HKDF here
 * produces a key that decrypts to garbage, which surfaces as an
 * authentication failure on the first response chunk.
 *
 * @param {Buffer} sharedSecret the ECDH secret.
 * @returns {Buffer} the 16-byte key.
 */
export function deriveSessionKey(sharedSecret) {
  return createHash('sha256').update(sharedSecret).digest().subarray(0, KEY_BYTES)
}

/**
 * Generate the client half of the key agreement.
 * @returns {{ecdh: import('node:crypto').ECDH, publicKeyB64: string}} pair.
 */
export function createEcdhPair() {
  const ecdh = createECDH(CURVE)
  const publicKey = ecdh.generateKeys()
  return { ecdh, publicKeyB64: publicKey.toString('base64') }
}

/**
 * Complete the agreement against the gateway's public key.
 * @param {Buffer} sharedSecret result of `ecdh.computeSecret()`.
 * @returns {Buffer} the SM4 key.
 */
export function completeKeyExchange(sharedSecret) {
  return deriveSessionKey(sharedSecret)
}

/** The request AAD: method, path, and timestamp joined by `|`. */
export function requestAad(method, pathname, timestamp) {
  return Buffer.from(`${method.toUpperCase()}|${pathname}|${timestamp}`, 'utf8')
}

/** The response AAD for one stream chunk: key id and chunk index joined by `|`. */
export function chunkAad(keyId, index) {
  return Buffer.from(`${keyId}|${index}`, 'utf8')
}

/**
 * @typedef {object} RequestEnvelope
 * @property {string} body Base64 ciphertext — the raw request body.
 * @property {Record<string, string>} headers the `X-Encrypt-*` header set.
 */

/**
 * Seal a chat request body into its wire envelope.
 *
 * The ciphertext travels as Base64 TEXT in the body; the IV, tag, key id, and
 * timestamp travel in headers. Every one of those headers must be sent —
 * the gateway rejects a request that carries an unlabelled body.
 *
 * @param {object} options seal options.
 * @param {Buffer} options.key 16-byte session key.
 * @param {string} options.keyId key identifier for the header.
 * @param {string} options.method HTTP method (part of the AAD).
 * @param {string} options.pathname request path (part of the AAD).
 * @param {string|number} options.timestamp request timestamp (part of the AAD).
 * @param {string} options.plaintext the JSON body.
 * @returns {RequestEnvelope} the body and headers to send.
 */
export function deriveRequestEnvelope({ key, keyId, method, pathname, timestamp, plaintext }) {
  const iv = randomIv()
  const aad = requestAad(method, pathname, timestamp)
  const { ciphertext, tag } = sm4GcmEncrypt(key, iv, Buffer.from(plaintext, 'utf8'), aad)
  return {
    body: Buffer.from(ciphertext).toString('base64'),
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Encrypt-Algo': 'sm4-gcm',
      'X-Encrypt-Key-Id': keyId,
      'X-Encrypt-Iv': iv.toString('base64'),
      'X-Encrypt-Tag': Buffer.from(tag).toString('base64'),
      'X-Encrypt-Ts': String(timestamp),
    },
  }
}

/**
 * Open one response stream chunk.
 *
 * A sealed frame is an `iv:tag:ciphertext` triple of Base64 fields. The AAD
 * for every chunk is `${keyId}|${chunkIndex}` — independent of the request's
 * method, path, and timestamp, which is what makes chunk-wise decryption
 * possible.
 *
 * @param {string} block the raw frame text.
 * @param {Buffer} key the session key.
 * @param {string} keyId key identifier (part of the AAD).
 * @param {number} index chunk index (part of the AAD).
 * @returns {string|null} the decrypted text, or null for a frame that is not sealed.
 * @throws when the frame claims to be sealed and its tag does not verify.
 */
export function openChunk(block, key, keyId, index) {
  const trimmed = (block ?? '').trim()
  if (trimmed === '') return null
  const parts = trimmed.split(':')
  if (parts.length !== 3) return null
  const [ivPart, tagPart, ciphertextPart] = parts
  const plaintext = sm4GcmDecrypt(
    key,
    Buffer.from(ivPart, 'base64'),
    Buffer.from(ciphertextPart, 'base64'),
    Buffer.from(tagPart, 'base64'),
    chunkAad(keyId, index),
  )
  return Buffer.from(plaintext).toString('utf8')
}

/**
 * A UUID stamped on each request as its message identity.
 * @returns {string} a v4 UUID.
 */
export function newRequestId() {
  return randomUUID()
}
