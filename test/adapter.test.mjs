// Adapter-level checks against a fake gateway client: no network involved.
import assert from 'node:assert/strict'
import { test } from 'vitest';
import { createCodeArtsAdapter, PROVIDER_ID } from '../src/adapter.ts';
import { Catalog } from '../src/catalog.ts';

function fakeCatalog(models) {
  const c = new Catalog();
  c.current = models; c.source = 'gateway';
  return c;
}

const models = [
  { id:'m1', name:'Model One', context:100000, maxOutput:8192, ratio:'0.1x', supportsImages:true, strengths:[] },
  { id:'m2', name:'Model Two', context:200000, maxOutput:8192, ratio:'0.2x', supportsImages:false, strengths:['high','max'], defaultStrength:'high' },
];

// Build an adapter whose gateway client is a stub, so no request leaves the
// process while the real stream() logic runs.
function adapterWith(chunks, credential = { key:{ ak:'AK', sk:'SK', securityToken:'TOKEN' } }) {
  const sent = [];
  const adapter = createCodeArtsAdapter({
    credentials: { resolve: async () => credential },
    catalog: fakeCatalog(models),
    createClient: () => ({
      heartbeat: async () => true,
      streamChat: async function* (req) { sent.push(req); yield* chunks; },
    }),
  });
  return { adapter, sent };
}

// The adapter caches clients behind #client; drive stream with a stubbed one.
async function collect(adapter, options) {
  const out = [];
  for await (const chunk of adapter.stream(options)) out.push(chunk);
  return out;
}

const check = (name, fn) => test(name, fn);

await check('providerInfo names the route', async () => {
  const { adapter } = adapterWith([]);
  const info = adapter.providerInfo(PROVIDER_ID);
  assert.equal(info.id, PROVIDER_ID);
  assert.ok(info.name.length > 0);
});

await check('listModels renders the credit ratio into the name', async () => {
  const { adapter } = adapterWith([]);
  const list = await adapter.listModels(PROVIDER_ID);
  assert.equal(list.length, 2);
  assert.equal(list[0].name, 'Model One · 0.1x');
  assert.deepEqual(list[0].inputModalities, ['text','image']);
  assert.deepEqual(list[1].inputModalities, ['text']);
});

await check('resolveModel declares context, output cap, and reasoning', async () => {
  const { adapter } = adapterWith([]);
  const model = await adapter.resolveModel(PROVIDER_ID, 'm2');
  assert.equal(model.context.contextWindow, 200000);
  assert.equal(model.defaultMaxTokens, 8192);
  assert.ok(model.reasoning, 'm2 declares thinking levels');
  assert.equal(model.reasoning.defaultEffort, 'high');
  const ids = model.reasoning.efforts.map(e => e.id);
  assert.deepEqual(ids, ['off','high','max']);
});

await check('a model with no levels declares no reasoning', async () => {
  const { adapter } = adapterWith([]);
  const model = await adapter.resolveModel(PROVIDER_ID, 'm1');
  assert.equal(model.reasoning, undefined);
});

await check('text and reasoning deltas emit block lifecycle and a stop finish', async () => {
  const { adapter } = adapterWith([
    { reasoning:'think' },
    { text:'Hello' },
    { text:' world' },
    { usage:{ inputTokens:10, outputTokens:2, totalTokens:12 } },
    { finish:'stop' },
  ]);
  const out = await collect(adapter, { provider: PROVIDER_ID, model:'m1', messages:[{role:'user',content:[{type:'text',text:'hi'}]}] });
  const kinds = out.filter(c => c.type!=='block-end').map(c => c.type);
  assert.deepEqual(kinds, ['block-start','reasoning-delta','block-start','text-delta','text-delta','usage','finish']);
  const text = out.filter(c=>c.type==='text-delta').map(c=>c.text).join('');
  assert.equal(text, 'Hello world');
  const finish = out.at(-1);
  assert.equal(finish.reason.kind, 'stop');
});

await check('tool-call deltas accumulate into one block and finish as tool-calls', async () => {
  const { adapter } = adapterWith([
    { toolCalls:[{ index:0, id:'call_1', function:{ name:'get_weather', arguments:'' } }] },
    { toolCalls:[{ index:0, function:{ arguments:'{"city":"BJ"}' } }] },
    { finish:'tool_calls' },
  ]);
  const out = await collect(adapter, { provider: PROVIDER_ID, model:'m1', messages:[{role:'user',content:[{type:'text',text:'weather'}]}] });
  const starts = out.filter(c=>c.type==='block-start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].blockType, 'tool-call');
  const deltas = out.filter(c=>c.type==='tool-call-delta');
  assert.equal(deltas.length, 2);
  assert.equal(deltas[0].id, 'call_1');
  assert.equal(deltas[0].name, 'get_weather');
  assert.equal(deltas[1].argumentsDelta, '{"city":"BJ"}');
  assert.equal(out.at(-1).reason.kind, 'tool-calls');
});

await check('developer messages become system, and tool results become tool messages', async () => {
  const { adapter, sent } = adapterWith([{ text:'ok' }, { finish:'stop' }]);
  await collect(adapter, {
    provider: PROVIDER_ID, model:'m1',
    messages: [
      { role:'developer', content:[{type:'text',text:'be brief'}] },
      { role:'user', content:[{type:'text',text:'hi'}] },
      { role:'assistant', content:[
          {type:'text',text:'calling'},
          {type:'tool-call', id:'c1', name:'f', arguments:'{}'} ] },
      { role:'tool', toolCallId:'c1', content:[{type:'text',text:'result'}] },
    ],
  });
  const msgs = sent[0].messages;
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[0].content, 'be brief');
  assert.equal(msgs[1].role, 'user');
  assert.equal(msgs[2].role, 'assistant');
  assert.equal(msgs[2].tool_calls[0].id, 'c1');
  assert.equal(msgs[3].role, 'tool');
  assert.equal(msgs[3].tool_call_id, 'c1');
  assert.equal(msgs[3].content, 'result');
});

await check('system prompt is sent as the leading system message', async () => {
  const { adapter, sent } = adapterWith([{ finish:'stop' }]);
  await collect(adapter, { provider: PROVIDER_ID, model:'m1', system:'SYS', messages:[] });
  assert.equal(sent[0].messages[0].role, 'system');
  assert.equal(sent[0].messages[0].content, 'SYS');
});

await check('a gateway failure becomes an error finish, not a throw', async () => {
  const a = createCodeArtsAdapter({
    credentials: { resolve: async () => ({ key:{ ak:'A', sk:'S', securityToken:'T' } }) },
    catalog: fakeCatalog(models),
    createClient: () => ({
      heartbeat: async () => true,
      streamChat: async function* () { throw new Error('upstream exploded'); },
    }),
  });
  const out = await collect(a, { provider: PROVIDER_ID, model:'m1', messages:[] });
  const finish = out.at(-1);
  assert.equal(finish.reason.kind, 'error');
  assert.match(finish.reason.failure.message, /exploded/);
});

await check('max-tokens maps through', async () => {
  const { adapter } = adapterWith([{ finish:'length' }]);
  const out = await collect(adapter, { provider: PROVIDER_ID, model:'m1', messages:[] });
  assert.equal(out.at(-1).reason.kind, 'max-tokens');
});

await check('usage arriving after finish is still reported, in stream order', async () => {
  // The gateway sends finish BEFORE usage and then [DONE]. Returning on
  // finish would silently drop the token counts.
  const { adapter } = adapterWith([
    { text:'hi' },
    { finish:'length' },
    { usage:{ inputTokens:17, outputTokens:600, totalTokens:617 } },
    { done:true },
  ]);
  const out = await collect(adapter, { provider: PROVIDER_ID, model:'m1', messages:[] });
  const types = out.map(c=>c.type);
  assert.ok(types.indexOf('usage') >= 0, 'usage must be emitted');
  assert.equal(types.at(-1), 'finish', 'finish is last');
  const usage = out.find(c=>c.type==='usage');
  assert.equal(usage.usage.inputTokens, 17);
  assert.equal(usage.usage.outputTokens, 600);
  assert.equal(out.at(-1).reason.kind, 'max-tokens');
});

await check('exactly one finish chunk is emitted', async () => {
  const { adapter } = adapterWith([{ text:'x' }, { finish:'stop' }, { done:true }]);
  const out = await collect(adapter, { provider: PROVIDER_ID, model:'m1', messages:[] });
  assert.equal(out.filter(c=>c.type==='finish').length, 1);
});

await check('a done frame without a finish reason still settles as stop', async () => {
  const { adapter } = adapterWith([{ text:'x' }, { done:true }]);
  const out = await collect(adapter, { provider: PROVIDER_ID, model:'m1', messages:[] });
  assert.equal(out.at(-1).type, 'finish');
  assert.equal(out.at(-1).reason.kind, 'stop');
});

await check('a display name is resolved to the gateway model id', async () => {
  // The gateway answers `GLM-5.2 · 0.7x` with HTTP 200 and an empty body, so a
  // display string must never reach the wire.
  const { catalogModels } = globalThis.__dcaTest ?? {};
  const cat = new Catalog();
  cat.current = [{ id:'GLM-5.2', name:'GLM-5.2', context:1, maxOutput:1, ratio:'0.7x', supportsImages:false, strengths:[] }];
  cat.source = 'gateway';
  assert.equal(cat.resolveId('GLM-5.2'), 'GLM-5.2');
  assert.equal(cat.resolveId('GLM-5.2 · 0.7x'), 'GLM-5.2');
  assert.equal(cat.resolveId('glm-5.2'), 'GLM-5.2');
  assert.equal(cat.resolveId('  GLM-5.2  '), 'GLM-5.2');
  // An unknown value passes through unchanged rather than vanishing.
  assert.equal(cat.resolveId('not-a-model'), 'not-a-model');
});

await check('a reasoning-only reply explains itself instead of coming back empty', async () => {
  const { adapter } = adapterWith([
    { reasoning: '想了很久但没有正文' },
    { finish: 'stop' },
    { done: true },
  ]);
  const out = await collect(adapter, { provider: PROVIDER_ID, model: 'm1', messages: [], maxTokens: 60 });
  const text = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  assert.ok(text.length > 0, 'a note must be emitted');
  assert.match(text, /max_tokens/);
  assert.equal(out.at(-1).reason.kind, 'stop');
});

await check('a normal reply is left alone by the reasoning-only guard', async () => {
  const { adapter } = adapterWith([{ text: '正常回复' }, { finish: 'stop' }, { done: true }]);
  const out = await collect(adapter, { provider: PROVIDER_ID, model: 'm1', messages: [] });
  const text = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  assert.equal(text, '正常回复');
});
