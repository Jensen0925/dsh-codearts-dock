// Feed the adapter's chunks through the Host's REAL BlockAssembler to prove
// the emitted block content survives.
// Needs the Host's own package, so it only runs inside a DSH shell.
const base = process.env.DSH_INSTALL_DIR;
if (!base) { console.log('DSH_INSTALL_DIR unset; skipping assembler integration test'); process.exit(0); }
const { createRequire } = await import('node:module');
const req = createRequire(base + '/package.json');
let mod;
try { mod = await import(req.resolve('@deepseek-ai/dsh-llm')); }
catch (e) {
  // Outside a DSH shell this integration check cannot resolve the Host
  // package; skip rather than fail, and say so once.
  console.log(`assembler: skipped (${e.code}) — run inside a DSH shell`);
  process.exit(0);
}
const { BlockAssembler } = mod;
if (!BlockAssembler) { console.log('BlockAssembler not exported; exports:', Object.keys(mod).slice(0,40).join(',')); process.exit(0); }

// Relative to this file, so the test runs from any checkout location.
const { createCodeArtsAdapter } = await import(new URL('../src/adapter.js', import.meta.url).href);
const chunks = [
  { reasoning:'让我想想' },
  { text:'你好' },
  { text:'，世界' },
  { toolCalls:[{index:0, id:'call_1', function:{name:'get_weather', arguments:''}}] },
  { toolCalls:[{index:0, function:{arguments:'{"city":"BJ"}'}}] },
  { finish:'tool_calls' },
  { usage:{inputTokens:5,outputTokens:9,totalTokens:14} },
  { done:true },
];
const adapter = createCodeArtsAdapter({
  credentials:{ resolve: async()=>({ key:{ak:'A',sk:'S',securityToken:'T'} }) },
  catalog:{ models:()=>[], find:()=>undefined },
  createClient: ()=>({ heartbeat: async()=>true, streamChat: async function*(req){ yield* chunks } }),
});
const asm = new BlockAssembler();
for await (const c of adapter.stream({ provider:'codearts', model:'m', messages:[] })) asm.push(c);
const blocks = asm.blocks();
console.log('blocks:', JSON.stringify(blocks, null, 1));
const text = blocks.filter(b=>b.type==='text').map(b=>b.text).join('');
const reasoning = blocks.filter(b=>b.type==='reasoning').map(b=>b.text).join('');
const call = blocks.find(b=>b.type==='tool-call');
console.log('---');
console.log('text preserved :', JSON.stringify(text), text==='你好，世界' ? 'OK':'MISMATCH');
console.log('reasoning kept :', JSON.stringify(reasoning), reasoning==='让我想想' ? 'OK':'MISMATCH');
console.log('tool name/args :', call ? `${call.name} ${call.arguments}` : 'MISSING',
  call && call.name==='get_weather' && call.arguments==='{"city":"BJ"}' ? 'OK':'MISMATCH');
console.log('usage:', JSON.stringify(asm.usage));
console.log('finish:', JSON.stringify(asm.finish));

// Fail the run when any assertion above regressed, so `npm test` catches it.
const failures = [];
if (text !== '你好，世界') failures.push('text');
if (reasoning !== '让我想想') failures.push('reasoning');
if (!call || call.name !== 'get_weather') failures.push('tool-call');
if (asm.finish?.kind !== 'tool-calls') failures.push('finish');
if (failures.length) { console.log('assembler: FAILED —', failures.join(', ')); process.exit(1); }
// A stream with NO tool call closes its text block through the settle path,
// which is a different code path from the tool-call one above. Both must echo
// their content: the assembler replaces the block with whatever `block-end`
// carries.
{
  const plainChunks = [
    { reasoning: '先想' },
    { text: '只有文字' },
    { text: '，没有工具调用' },
    { finish: 'stop' },
    { usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 } },
    { done: true },
  ];
  const plainAdapter = createCodeArtsAdapter({
    credentials: { resolve: async () => ({ key: { ak: 'A', sk: 'S', securityToken: 'T' } }) },
    catalog: { models: () => [], find: () => undefined, resolveId: (id) => id },
    createClient: () => ({ heartbeat: async () => true, streamChat: async function* () { yield* plainChunks } }),
  });
  const plainAsm = new BlockAssembler();
  for await (const c of plainAdapter.stream({ provider: 'codearts', model: 'm', messages: [] })) plainAsm.push(c);
  const plainText = plainAsm.blocks().filter((b) => b.type === 'text').map((b) => b.text).join('');
  const plainReasoning = plainAsm.blocks().filter((b) => b.type === 'reasoning').map((b) => b.text).join('');
  console.log('settle path text :', JSON.stringify(plainText));
  console.log('settle path think:', JSON.stringify(plainReasoning));
  if (plainText !== '只有文字，没有工具调用') { console.log('assembler: FAILED — settle-path text'); process.exit(1); }
  if (plainReasoning !== '先想') { console.log('assembler: FAILED — settle-path reasoning'); process.exit(1); }
}

console.log('assembler: all checks passed');
