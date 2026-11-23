/**
 * Exchange a permanent Huawei Cloud AK/SK pair for temporary STS credentials.
 *
 * Endpoint: POST /v3.0/OS-CREDENTIAL/securitytokens
 *
 * Two facts about this exchange are counter-intuitive and both cost real
 * debugging time:
 *
 *   1. The SIGNED canonical URI carries a trailing slash; the request itself
 *      does not. A mismatch answers `401 verify ak sk signature failed`.
 *   2. The body must declare `methods: ["token"]`. `["hw_ak_sk"]` is
 *      rejected with `Unsupported method`. The AK/SK prove themselves in the
 *      signature, not in the body.
 */

import { signHuawei } from './protocol/sign.js'
import { errorMessage } from './errors.js'

const IAM_HOST = 'iam.cn-north-4.myhuaweicloud.com'
const IAM_REQUEST_PATH = '/v3.0/OS-CREDENTIAL/securitytokens'
/** The signed form: the request path plus a trailing slash. */
const IAM_SIGN_PATH = `${IAM_REQUEST_PATH}/`

/**
 * @typedef {object} TemporaryCredential
 * @property {string} ak temporary access key id.
 * @property {string} sk temporary secret access key.
 * @property {string} securityToken the STS token, sent as `X-Security-Token`.
 * @property {string} expiresAt ISO-8601 expiry.
 */

/** A failure from the IAM exchange, with the upstream text preserved. */
export class StsError extends Error {
  constructor(message) {
    super(message)
    this.name = 'StsError'
  }
}

/**
 * Exchange permanent credentials for STS credentials.
 * @param {string} ak permanent access key id.
 * @param {string} sk permanent secret access key.
 * @param {number} [durationSeconds] requested lifetime; 3600 default, 86400 max.
 * @param {typeof fetch} [fetchImpl] fetch implementation, for tests.
 * @returns {Promise<TemporaryCredential>} the temporary triple.
 */
export async function getSts(ak, sk, durationSeconds = 3600, fetchImpl = globalThis.fetch) {
  const body = JSON.stringify({
    auth: {
      identity: {
        methods: ['token'],
        token: { duration_seconds: durationSeconds },
      },
    },
  })

  const headers = signHuawei({
    method: 'POST',
    host: IAM_HOST,
    path: IAM_SIGN_PATH,
    contentType: 'application/json;charset=utf8',
    body,
    ak,
    sk,
  })

  let response
  try {
    response = await fetchImpl(`https://${IAM_HOST}${IAM_REQUEST_PATH}`, {
      method: 'POST',
      headers,
      body,
    })
  } catch (error) {
    throw new StsError(`无法连接华为云 IAM（${IAM_HOST}）：${errorMessage(error)}`)
  }

  const text = await response.text()
  if (!response.ok) {
    throw new StsError(describeIamFailure(response.status, text))
  }

  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new StsError(`IAM 返回非 JSON：${text.slice(0, 300)}`)
  }

  const credential = payload?.credential
  if (!credential?.access || !credential?.secret || !credential?.securitytoken) {
    throw new StsError(`IAM 响应缺少 credential 字段：${text.slice(0, 500)}`)
  }

  return {
    ak: credential.access,
    sk: credential.secret,
    securityToken: credential.securitytoken,
    expiresAt: credential.expires_at ?? '',
  }
}

/** Explain the common IAM rejections instead of relaying a raw status. */
function describeIamFailure(status, text) {
  const raw = text.slice(0, 500)
  if (status === 403 || /forbidden/i.test(text)) {
    return (
      `IAM 拒绝了这次换 STS 请求（HTTP ${status}）。常见原因：\n` +
      '  · AK/SK 不正确或已被停用 —— 到「我的凭证 → 访问密钥」核对\n' +
      '  · 短时间内换得太频繁，触发了频率限制 —— 等约 1 分钟再试\n' +
      `上游原文：${raw}`
    )
  }
  if (status === 401) {
    return `IAM 签名校验失败（HTTP 401）。AK/SK 可能抄错，或不是同一对。上游原文：${raw}`
  }
  return `IAM 换 STS 失败（HTTP ${status}）。上游原文：${raw}`
}
