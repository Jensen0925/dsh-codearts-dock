// Feed adapter chunks through the Host's real BlockAssembler when a DSH shell
// installation is available. Vitest reports the check as skipped otherwise.
import { test } from 'vitest'

const base = process.env.DSH_INSTALL_DIR
let BlockAssembler
let skipReason

if (!base) {
  skipReason = 'DSH_INSTALL_DIR unavailable'
} else {
  try {
    const { createRequire } = await import('node:module')
    const req = createRequire(base + '/package.json')
    const host = await import(req.resolve('@deepseek-ai/dsh-llm'))
    BlockAssembler = host.BlockAssembler
    if (!BlockAssembler) skipReason = 'BlockAssembler is not exported by the installed host'
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    skipReason = `host package unavailable (${detail})`
  }
}

if (skipReason) {
  test.skip(`BlockAssembler integration: ${skipReason}`, () => {})
} else {
  test('adapter chunks survive the Host BlockAssembler', async () => {
    const { createCodeArtsAdapter } = await import(new URL('../src/adapter.ts', import.meta.url).href)
    const chunks = [
      { reasoning: '让我想想' },
      { text: '你好' },
      { text: '，世界' },
      { toolCalls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '' } }] },
      { toolCalls: [{ index: 0, function: { arguments: '{"city":"BJ"}' } }] },
      { finish: 'tool_calls' },
      { usage: { inputTokens: 5, outputTokens: 9, totalTokens: 14 } },
      { done: true },
    ]
    const adapter = createCodeArtsAdapter({
      credentials: { resolve: async () => ({ key: { ak: 'A', sk: 'S', securityToken: 'T' } }) },
      catalog: { models: () => [], find: () => undefined },
      createClient: () => ({ heartbeat: async () => true, streamChat: async function* () { yield* chunks } }),
    })
    const asm = new BlockAssembler()
    for await (const chunk of adapter.stream({ provider: 'codearts', model: 'm', messages: [] })) asm.push(chunk)
    const blocks = asm.blocks()
    const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('')
    const reasoning = blocks.filter((block) => block.type === 'reasoning').map((block) => block.text).join('')
    const call = blocks.find((block) => block.type === 'tool-call')
    if (text !== '你好，世界') throw new Error(`text mismatch: ${text}`)
    if (reasoning !== '让我想想') throw new Error(`reasoning mismatch: ${reasoning}`)
    if (!call || call.name !== 'get_weather' || call.arguments !== '{"city":"BJ"}') throw new Error('tool-call mismatch')
    if (asm.finish?.kind !== 'tool-calls') throw new Error('finish mismatch')

    const plainChunks = [
      { reasoning: '先想' },
      { text: '只有文字' },
      { text: '，没有工具调用' },
      { finish: 'stop' },
      { usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 } },
      { done: true },
    ]
    const plainAdapter = createCodeArtsAdapter({
      credentials: { resolve: async () => ({ key: { ak: 'A', sk: 'S', securityToken: 'T' } }) },
      catalog: { models: () => [], find: () => undefined, resolveId: (id) => id },
      createClient: () => ({ heartbeat: async () => true, streamChat: async function* () { yield* plainChunks } }),
    })
    const plainAsm = new BlockAssembler()
    for await (const chunk of plainAdapter.stream({ provider: 'codearts', model: 'm', messages: [] })) plainAsm.push(chunk)
    const plainText = plainAsm.blocks().filter((block) => block.type === 'text').map((block) => block.text).join('')
    const plainReasoning = plainAsm.blocks().filter((block) => block.type === 'reasoning').map((block) => block.text).join('')
    if (plainText !== '只有文字，没有工具调用') throw new Error(`settle text mismatch: ${plainText}`)
    if (plainReasoning !== '先想') throw new Error(`settle reasoning mismatch: ${plainReasoning}`)
  })
}
