/**
 * Huawei Cloud APIG request signing (`SDK-HMAC-SHA256`).
 *
 * Used for both the 码道 gateway and the IAM STS exchange. The canonical
 * request is:
 *
 *   CanonicalRequest =
 *     METHOD \n
 *     CanonicalURI \n            <- path WITH a trailing slash (the request itself sends none)
 *     CanonicalQueryString \n
 *     CanonicalHeaders \n        <- "lowercase-name:value\n", sorted, only headers actually sent
 *     SignedHeaders \n
 *     HexEncode(SHA256(body))    <- the REAL body hash, not UNSIGNED-PAYLOAD
 *
 *   StringToSign =
 *     "SDK-HMAC-SHA256" \n
 *     X-Sdk-Date \n
 *     HexEncode(SHA256(CanonicalRequest))
 *
 *   Signature = HexEncode(HMAC-SHA256(SK, StringToSign))
 *
 * The four rules below cost real debugging time; each one is a 401 when
 * violated, and the response body never says which:
 *
 *   1. SIGN the path with a trailing slash; SEND it without one.
 *   2. Hash the real body — never the `UNSIGNED-PAYLOAD` literal.
 *   3. SignedHeaders must match the headers actually sent, exactly.
 *   4. Never sign `x-sdk-content-sha256`; an extra signed name is a 401.
 */

import { createHash, createHmac } from 'node:crypto'

/** The signing algorithm identifier sent on the wire. */
export const SIGN_ALGORITHM = 'SDK-HMAC-SHA256'

/**
 * Format the `X-Sdk-Date` header value (`YYYYMMDDTHHMMSSZ`, UTC).
 * @param {Date} [date] instant to format; defaults to now.
 * @returns {string} the header value.
 */
export function formatSdkDate(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}T` +
    `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`
  )
}

/**
 * Build the canonical URI: percent-encode each segment and add a trailing slash.
 * @param {string} pathname request path without a query.
 * @returns {string} the canonical form.
 */
export function canonicalUri(pathname) {
  const encoded = pathname.split('/').map((segment) => encodeURIComponent(segment)).join('/')
  return encoded.endsWith('/') ? encoded : `${encoded}/`
}

/** Sort and join the headers into the canonical block plus the signed-name list. */
function canonicalHeaders(headers) {
  const lower = new Map()
  for (const [name, value] of Object.entries(headers)) lower.set(name.toLowerCase(), String(value))

  const names = [...lower.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const block = names.map((name) => `${name}:${(lower.get(name) ?? '').replace(/[\r\n]/g, ' ').trim()}\n`).join('')
  return { block, signed: names.join(';') }
}

/** The `Host` header value: include the port only when it is not the protocol default. */
function hostHeader(url) {
  const defaultPort = url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : ''
  return url.port && url.port !== defaultPort ? `${url.hostname}:${url.port}` : url.hostname
}

/**
 * Produce the signed headers. Send exactly these on the request: adding or
 * dropping any of them invalidates the signature.
 *
 * @param {object} input signature input.
 * @param {string} input.method HTTP method.
 * @param {URL} input.url request URL.
 * @param {string|null} input.contentType `Content-Type` to sign, or `null` when the request sends none.
 * @param {string} [input.body] request body text; ignored when `bodyBytes` is given.
 * @param {Uint8Array} [input.bodyBytes] binary body (already-encrypted payloads); takes precedence over `body`.
 * @param {{ak: string, sk: string, securityToken: string}} input.credentials temporary or permanent key triple.
 * @param {string} [input.sdkDate] fixed timestamp, for tests.
 * @returns {Record<string, string>} headers to send verbatim.
 */
export function signRequest(input) {
  const { method, url, contentType, credentials } = input
  const sdkDate = input.sdkDate ?? formatSdkDate()
  const payloadHash = input.bodyBytes
    ? createHash('sha256').update(input.bodyBytes).digest('hex')
    : createHash('sha256').update(input.body ?? '').digest('hex')

  const headersToSign = {
    Host: hostHeader(url),
    'X-Sdk-Date': sdkDate,
    'X-Security-Token': credentials.securityToken,
  }
  if (contentType) headersToSign['Content-Type'] = contentType

  const { block, signed } = canonicalHeaders(headersToSign)
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(url.pathname),
    url.search ? url.search.slice(1) : '',
    block,
    signed,
    payloadHash,
  ].join('\n')

  const stringToSign = [
    SIGN_ALGORITHM,
    sdkDate,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n')

  const signature = createHmac('sha256', credentials.sk).update(stringToSign).digest('hex')

  return {
    ...headersToSign,
    Authorization: `${SIGN_ALGORITHM} Access=${credentials.ak}, SignedHeaders=${signed}, Signature=${signature}`,
  }
}

/**
 * Sign a request for Huawei Cloud IAM (the STS exchange).
 *
 * Same algorithm, different header set: IAM takes no `X-Security-Token`
 * because the caller is proving ownership of a permanent AK/SK pair.
 *
 * @param {object} input signature input.
 * @param {string} input.method HTTP method.
 * @param {string} input.host request host.
 * @param {string} input.path canonical (trailing-slash) path.
 * @param {string} input.contentType request content type.
 * @param {string} input.body request body text.
 * @param {string} input.ak permanent access key id.
 * @param {string} input.sk permanent secret access key.
 * @param {string} [input.sdkDate] fixed timestamp, for tests.
 * @returns {Record<string, string>} headers to send verbatim.
 */
export function signHuawei(input) {
  const sdkDate = input.sdkDate ?? formatSdkDate()
  const payloadHash = createHash('sha256').update(input.body).digest('hex')

  const headersToSign = {
    Host: input.host,
    'X-Sdk-Date': sdkDate,
    'Content-Type': input.contentType,
  }

  const { block, signed } = canonicalHeaders(headersToSign)
  const canonicalRequest = [
    input.method.toUpperCase(),
    input.path,
    '',
    block,
    signed,
    payloadHash,
  ].join('\n')

  const stringToSign = [
    SIGN_ALGORITHM,
    sdkDate,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n')

  const signature = createHmac('sha256', input.sk).update(stringToSign).digest('hex')

  return {
    ...headersToSign,
    Authorization: `${SIGN_ALGORITHM} Access=${input.ak}, SignedHeaders=${signed}, Signature=${signature}`,
  }
}
