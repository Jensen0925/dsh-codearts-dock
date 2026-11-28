// Adapter-level checks against a fake gateway client: no network involved.
import assert from 'node:assert/strict'
import { test } from 'vitest';
import { createCodeArtsAdapter, PROVIDER_ID } from '../src/adapter.ts';
import { Catalog } from '../src/catalog.ts';

type CatalogModel = {
  id: string;
  name: string;
  context: number;
  maxOutput: number;
  ratio: string;
  supportsImages: boolean;
  strengths: string[];
  defaultStrength?: string;
  busyLevel?: 'idle' | 'normal' | 'busy' | 'congested' | 'unavailable' | 'unknown';
  limitedTimeHalfPrice?: boolean;
};

type GatewayEvent = {
  done?: boolean;
  text?: string;
  reasoning?: string;
  finish?: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  toolCalls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
};

type GatewayMessage = {
  role: string;
  content?: string;
  tool_calls?: Array<{ id: string }>;
  tool_call_id?: string;
};

type StreamChunk =
  | { type: 'block-start'; blockType: string }
  | { type: 'block-end'; index: number }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call-delta'; id: string; name: string; argumentsDelta: string }
  | { type: 'usage'; usage: { inputTokens: number; outputTokens: number; totalTokens: number } }
  | { type: 'finish'; reason: { kind: string; failure?: { message: string } } };

function fakeCatalog(models: CatalogModel[]) {
  const c = new Catalog();
  c.current = models; c.source = 'gateway';
  return c;
}

const models: CatalogModel[] = [
  { id:'m1', name:'Model One', context:100000, maxOutput:8192, ratio:'0.1x', supportsImages:true, strengths:[] },
  { id:'m2', name:'Model Two', context:200000, maxOutput:8192, ratio:'0.2x', supportsImages:false, strengths:['high','max'], defaultStrength:'high' },
];

// Build an adapter whose gateway client is a stub, so no request leaves the
// process while the real stream() logic runs.
function adapterWith(chunks: GatewayEvent[], credential = { key:{ ak:'AK', sk:'SK', securityToken:'TOKEN' } }) {
  const sent: unknown[] = [];
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
async function collect(adapter: ReturnType<typeof createCodeArtsAdapter>, options: Record<string, unknown>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of adapter.stream(options)) out.push(chunk as StreamChunk);
  return out;
}

function last<T>(items: readonly T[]): T {
  const item = items.at(-1);
  assert.ok(item, 'expected at least one item');
  return item;
}

function textDeltas(items: readonly StreamChunk[]): Extract<StreamChunk, { type: 'text-delta' }>[] {
  return items.filter((chunk): chunk is Extract<StreamChunk, { type: 'text-delta' }> => chunk.type === 'text-delta');
}

function finishChunk(items: readonly StreamChunk[]): Extract<StreamChunk, { type: 'finish' }> {
  const finish = items.find((chunk): chunk is Extract<StreamChunk, { type: 'finish' }> => chunk.type === 'finish');
  assert.ok(finish, 'expected a finish chunk');
  return finish;
}

function messagesFrom(request: unknown): GatewayMessage[] {
  assert.ok(request && typeof request === 'object' && 'messages' in request);
  const messages = request.messages;
  assert.ok(Array.isArray(messages));
  return messages as GatewayMessage[];
}

const check = (name: string, fn: () => void | Promise<void>) => test(name, fn);

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

await check('listModels places the upstream busy icon immediately after a promotion badge', async () => {
  const catalog = fakeCatalog([
    { ...models[0], limitedTimeHalfPrice: true, busyLevel: 'congested' },
    { ...models[1], busyLevel: 'idle' },
  ]);
  const adapter = createCodeArtsAdapter({
    credentials: { resolve: async () => ({ key: { ak: 'TEST_AK', sk: 'TEST_SK', securityToken: 'TEST_TOKEN' } }) },
    catalog,
  });
  const list = await adapter.listModels(PROVIDER_ID);
  assert.equal(list[0].badge.text.zh, '限时半价 🧍🧍🧍 · 极度拥堵');
  assert.equal(list[1].badge.text.zh, '🚀 空闲');
});

await check('resolveModel declares context, output cap, and reasoning', async () => {
  const { adapter } = adapterWith([]);
  const model = await adapter.resolveModel(PROVIDER_ID, 'm2');
  assert.ok('context' in model, 'known models include context metadata');
  assert.ok(model.context, 'known models expose their context window');
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
  assert.equal('reasoning' in model, false);
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
  const text = textDeltas(out).map((chunk) => chunk.text).join('');
  assert.equal(text, 'Hello world');
  const finish = finishChunk(out);
  assert.equal(finish.reason.kind, 'stop');
});

await check('tool-call deltas accumulate into one block and finish as tool-calls', async () => {
  const { adapter } = adapterWith([
    { toolCalls:[{ index:0, id:'call_1', function:{ name:'get_weather', arguments:'' } }] },
    { toolCalls:[{ index:0, function:{ arguments:'{"city":"BJ"}' } }] },
    { finish:'tool_calls' },
  ]);
  const out = await collect(adapter, { provider: PROVIDER_ID, model:'m1', messages:[{role:'user',content:[{type:'text',text:'weather'}]}] });
  const starts = out.filter((c): c is Extract<StreamChunk, { type: 'block-start' }> => c.type === 'block-start');
  assert.equal(starts.length, 1);
  assert.equal(last(starts).blockType, 'tool-call');
  const deltas = out.filter((c): c is Extract<StreamChunk, { type: 'tool-call-delta' }> => c.type === 'tool-call-delta');
  assert.equal(deltas.length, 2);
  assert.equal(deltas[0]?.id, 'call_1');
  assert.equal(deltas[0]?.name, 'get_weather');
  assert.equal(deltas[1]?.argumentsDelta, '{"city":"BJ"}');
  assert.equal(finishChunk(out).reason.kind, 'tool-calls');
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
  const msgs = messagesFrom(sent[0]);
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[0].content, 'be brief');
  assert.equal(msgs[1].role, 'user');
  assert.equal(msgs[2].role, 'assistant');
  assert.ok(msgs[2].tool_calls, 'assistant message includes tool calls');
  assert.equal(msgs[2].tool_calls[0]?.id, 'c1');
  assert.equal(msgs[3].role, 'tool');
  assert.equal(msgs[3].tool_call_id, 'c1');
  assert.equal(msgs[3].content, 'result');
});

await check('system prompt is sent as the leading system message', async () => {
  const { adapter, sent } = adapterWith([{ finish:'stop' }]);
  await collect(adapter, { provider: PROVIDER_ID, model:'m1', system:'SYS', messages:[] });
  const messages = messagesFrom(sent[0]);
  assert.equal(messages[0]?.role, 'system');
  assert.equal(messages[0]?.content, 'SYS');
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
  const finish = finishChunk(out);
  assert.equal(finish.reason.kind, 'error');
  assert.ok(finish.reason.failure, 'error finish includes the upstream failure');
  assert.match(finish.reason.failure.message, /exploded/);
});

await check('request failures notify once and preserve error chunks, open-block closure and heartbeat release', async () => {
  const failure = Object.assign(new Error('upstream failed'), { status: 429 });
  const reported: unknown[] = [];
  const heartbeats: string[] = [];
  let requests = 0;
  const adapter = createCodeArtsAdapter({
    credentials: {
      resolve: async () => ({ key: { ak: 'TEST_AK', sk: 'TEST_SK', securityToken: 'TEST_TOKEN' } }),
    },
    catalog: fakeCatalog(models),
    onError: (error) => { reported.push(error); },
    createClient: () => ({
      heartbeat: async (state) => { heartbeats.push(state); },
      streamChat: async function* () { requests++; yield { text: 'partial' }; throw failure; },
    }),
  });
  const out = await collect(adapter, { provider: PROVIDER_ID, model: 'm1', messages: [] });
  assert.deepEqual(reported, [failure]);
  assert.equal(requests, 1, 'failure reporting never replays a partially emitted stream');
  assert.deepEqual(heartbeats, ['busy', 'idle']);
  assert.equal(out.at(-2)?.type, 'block-end');
  assert.equal(finishChunk(out).reason.kind, 'error');
});

await check('concurrent streams keep the client resolved for each request and notify their own failure', async () => {
  const reported: unknown[] = [];
  const failures = { first: new Error('first account failed'), second: new Error('second account failed') };
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  let notifyStarted!: () => void;
  const bothStarted = new Promise<void>((resolve) => { notifyStarted = resolve; });
  let started = 0;
  let resolved = 0;
  const credentials = {
    accountId: '',
    resolve: async () => {
      const id = resolved++ === 0 ? 'first' : 'second';
      credentials.accountId = id;
      return { key: { ak: id, sk: 'TEST_SK', securityToken: id }, accountId: id };
    },
  };
  const adapter = createCodeArtsAdapter({
    credentials, catalog: fakeCatalog(models), onError: (error) => { reported.push(error); },
    createClient: (key) => ({
      heartbeat: async () => true,
      streamChat: async function* () {
        if (++started === 2) notifyStarted();
        await (key.ak === 'first' ? firstGate : secondGate);
        throw failures[key.ak as keyof typeof failures];
      },
    }),
  });
  const options = { provider: PROVIDER_ID, model: 'm1', messages: [] };
  const first = collect(adapter, options);
  const second = collect(adapter, options);
  await bothStarted;
  assert.equal(credentials.accountId, 'second', 'another resolution changed the provider current account');
  releaseFirst();
  assert.equal(finishChunk(await first).reason.failure?.message, failures.first.message);
  releaseSecond();
  assert.equal(finishChunk(await second).reason.failure?.message, failures.second.message);
  assert.deepEqual(reported, [failures.first, failures.second]);
});

await check('credential failures notify once and retain the original rejected stream', async () => {
  const failure = Object.assign(new Error('offline test credentials unavailable'), { name: 'CredentialError' });
  const reported: unknown[] = [];
  let created = false;
  const adapter = createCodeArtsAdapter({
    credentials: { resolve: async () => { throw failure; } },
    catalog: fakeCatalog(models),
    onError: (error) => { reported.push(error); },
    createClient: () => { created = true; },
  });
  await assert.rejects(collect(adapter, { provider: PROVIDER_ID, model: 'm1', messages: [] }), (error) => error === failure);
  assert.deepEqual(reported, [failure]);
  assert.equal(created, false, 'no heartbeat or stream client exists when credentials fail');
});

await check('throwing and rejecting failure callbacks cannot replace the model failure', async () => {
  for (const onError of [() => { throw new Error('test history unavailable'); }, async () => { throw new Error('test history write rejected'); }]) {
    const failure = new Error('original upstream test failure');
    const adapter = createCodeArtsAdapter({
      credentials: { resolve: async () => ({ key: { ak: 'TEST_AK', sk: 'TEST_SK', securityToken: 'TEST_TOKEN' } }) },
      catalog: fakeCatalog(models), onError,
      createClient: () => ({ heartbeat: async () => true, streamChat: async function* () { throw failure; } }),
    });
    const out = await collect(adapter, { provider: PROVIDER_ID, model: 'm1', messages: [] });
    assert.equal(finishChunk(out).reason.kind, 'error');
    assert.equal(finishChunk(out).reason.failure?.message, failure.message);
    const noCredential = createCodeArtsAdapter({ credentials: { resolve: async () => { throw failure; } }, catalog: fakeCatalog(models), onError });
    await assert.rejects(collect(noCredential, { provider: PROVIDER_ID, model: 'm1', messages: [] }), (error) => error === failure);
    await new Promise(setImmediate);
  }
});

await check('successful streams and user cancellations never notify request failure history', async () => {
  const reported: unknown[] = [];
  for (const mode of ['success', 'abort-error', 'aborted-signal', 'aborted-signal-failure']) {
    const controller = new AbortController();
    const heartbeats: string[] = [];
    const adapter = createCodeArtsAdapter({
      credentials: {
        resolve: async () => ({ key: { ak: 'TEST_AK', sk: 'TEST_SK', securityToken: 'TEST_TOKEN' } }),
      },
      catalog: fakeCatalog(models),
      onError: (error) => { reported.push(error); },
      createClient: () => ({
        heartbeat: async (state) => { heartbeats.push(state); },
        streamChat: async function* () {
          if (mode === 'abort-error') throw Object.assign(new Error('test cancelled'), { name: 'AbortError' });
          if (mode.startsWith('aborted-signal')) controller.abort();
          if (mode === 'aborted-signal-failure') throw new Error('test transport ended after cancellation');
          yield { text: 'test response' };
          yield { finish: 'stop' };
        },
      }),
    });
    const out = await collect(adapter, { provider: PROVIDER_ID, model: 'm1', messages: [], signal: controller.signal });
    assert.equal(finishChunk(out).reason.kind, mode === 'success' ? 'stop' : mode === 'aborted-signal-failure' ? 'error' : 'aborted');
    assert.deepEqual(heartbeats, ['busy', 'idle']);
  }
  const cancelledCredential = createCodeArtsAdapter({
    credentials: { resolve: async () => { throw Object.assign(new Error('test cancelled'), { name: 'AbortError' }); } },
    catalog: fakeCatalog(models), onError: (error) => { reported.push(error); },
  });
  await assert.rejects(collect(cancelledCredential, { provider: PROVIDER_ID, model: 'm1', messages: [] }), { name: 'AbortError' });
  assert.deepEqual(reported, []);
});

await check('a slow busy heartbeat cannot block starting the model stream', async () => {
  let requested = false;
  const adapter = createCodeArtsAdapter({
    credentials: { resolve: async () => ({ key: { ak: 'TEST_AK', sk: 'TEST_SK', securityToken: 'TEST_TOKEN' } }) },
    catalog: fakeCatalog(models),
    createClient: () => ({
      heartbeat: async (state) => state === 'busy' ? new Promise(() => {}) : true,
      streamChat: async function* () { requested = true; yield { finish: 'stop' }; },
    }),
  });
  const outcome = await Promise.race([
    collect(adapter, { provider: PROVIDER_ID, model: 'm1', messages: [] }).then(() => 'settled'),
    new Promise<string>((resolve) => setTimeout(() => resolve('blocked'), 100)),
  ]);
  assert.equal(outcome, 'settled');
  assert.equal(requested, true);
});

await check('max-tokens maps through', async () => {
  const { adapter } = adapterWith([{ finish:'length' }]);
  const out = await collect(adapter, { provider: PROVIDER_ID, model:'m1', messages:[] });
  assert.equal(finishChunk(out).reason.kind, 'max-tokens');
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
  const usage = out.find((c): c is Extract<StreamChunk, { type: 'usage' }> => c.type === 'usage');
  assert.ok(usage, 'usage must be emitted');
  assert.equal(usage.usage.inputTokens, 17);
  assert.equal(usage.usage.outputTokens, 600);
  assert.equal(finishChunk(out).reason.kind, 'max-tokens');
});

await check('exactly one finish chunk is emitted', async () => {
  const { adapter } = adapterWith([{ text:'x' }, { finish:'stop' }, { done:true }]);
  const out = await collect(adapter, { provider: PROVIDER_ID, model:'m1', messages:[] });
  assert.equal(out.filter(c=>c.type==='finish').length, 1);
});

await check('a done frame without a finish reason still settles as stop', async () => {
  const { adapter } = adapterWith([{ text:'x' }, { done:true }]);
  const out = await collect(adapter, { provider: PROVIDER_ID, model:'m1', messages:[] });
  assert.equal(last(out).type, 'finish');
  assert.equal(finishChunk(out).reason.kind, 'stop');
});

await check('a display name is resolved to the gateway model id', async () => {
  // The gateway answers `GLM-5.2 · 0.7x` with HTTP 200 and an empty body, so a
  // display string must never reach the wire.
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
  const text = textDeltas(out).map((chunk) => chunk.text).join('');
  assert.ok(text.length > 0, 'a note must be emitted');
  assert.match(text, /max_tokens/);
  assert.equal(finishChunk(out).reason.kind, 'stop');
});

await check('a normal reply is left alone by the reasoning-only guard', async () => {
  const { adapter } = adapterWith([{ text: '正常回复' }, { finish: 'stop' }, { done: true }]);
  const out = await collect(adapter, { provider: PROVIDER_ID, model: 'm1', messages: [] });
  const text = textDeltas(out).map((chunk) => chunk.text).join('');
  assert.equal(text, '正常回复');
});
