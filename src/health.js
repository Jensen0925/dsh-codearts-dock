/** Fixed, actionable health categories; never persist error text or credentials. */
export function accountHealth({ error, credit, checkedAt = Date.now() } = {}) {
  let state = 'unknown'
  if (error) {
    const code = String(error.code ?? '')
    const text = String(error.message ?? '').toLowerCase()
    const status = Number(error.status ?? error.statusCode ?? text.match(/http\s*(\d{3})/)?.[1])
    if (status === 429 || /rate.?limit|throttl|限流/.test(text)) state = 'rate_limited'
    else if (/insufficient|quota.*exceed|余额不足|积分不足|额度不足/.test(text) || status === 402) state = 'insufficient'
    else if (status === 401 || status === 403 || error.name === 'CredentialError' || (error.name === 'StsError' && !/无法连接|network|timeout|fetch failed/.test(text)) || /expired.*token|invalid.*(credential|access.?key)|凭证.*(失效|过期)/.test(text)) state = 'credentials'
    else if (['ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code) || error.name === 'AbortError' || error.name === 'TimeoutError' || /fetch failed|network|timeout|timed out|无法连接|网络|超时/.test(text)) state = 'network'
    else state = 'gateway'
  } else if (Number.isFinite(credit?.remain)) state = credit.remain <= 0 ? 'insufficient' : 'available'
  return { state, checkedAt, action: state === 'credentials' ? 'credentials' : state === 'insufficient' ? 'switch' : 'recheck' }
}
export function isLowBalance(credit, settings) {
  return settings.lowBalanceEnabled !== false && Number.isFinite(credit?.remain) && credit.remain < settings.lowBalanceThreshold
}
