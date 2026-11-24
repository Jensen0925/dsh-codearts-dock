/**
 * Live end-to-end probe against the real 码道 gateway.
 *
 * Not part of `npm test`: it spends real credit and needs working credentials.
 * Run it after a protocol change to confirm the whole chain still holds:
 *
 *   CODEARTS_AK=... CODEARTS_SK=... node --import tsx/esm test/live-probe.ts
 */

import { getSts } from '../src/sts.ts'
import { MadaoClient } from '../src/gateway.ts'

const ak = process.env.CODEARTS_AK
const sk = process.env.CODEARTS_SK
if (!ak || !sk) {
  console.error('设置 CODEARTS_AK / CODEARTS_SK 后再跑这个探针。')
  process.exit(2)
}

const started = Date.now()
const sts = await getSts(ak, sk)
console.log(`✓ STS（${Date.now() - started}ms）`)

const client = new MadaoClient({
  credentials: { ak: sts.ak, sk: sts.sk, securityToken: sts.securityToken },
})

const key = await client.ensureSessionKey()
console.log(`✓ 会话密钥 keyId=${key.keyId}`)

const models = await client.getJson('/v1/model/builtin')
console.log(`✓ 模型清单 ${models?.builtinModels?.length} 个`)

let text = ''
let reasoning = ''
let usage = null
let finish = null
const chatStarted = Date.now()
for await (const event of client.streamChat({
  model: 'glm-5.3-flash',
  messages: [{ role: 'user', content: '用一句话介绍你自己。' }],
  maxTokens: 2000,
})) {
  if (event.text) text += event.text
  if (event.reasoning) reasoning += event.reasoning
  if (event.usage) usage = event.usage
  if (event.finish) finish = event.finish
  if (event.done) break
}
console.log(`✓ 对话流式返回（${Date.now() - chatStarted}ms）finish=${finish}`)
console.log(`  usage=${JSON.stringify(usage)}`)
console.log(`  reasoning ${reasoning.length} 字符`)
console.log(`  text=${JSON.stringify(text.slice(0, 160))}`)

await client.heartbeat('idle')
