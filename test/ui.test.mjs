/** Offline interactions for the actual client components; no browser, network, or credentials. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const initialModels = {
  ok: true, source: 'cache', enabledIds: null, refreshedAt: 1,
  models: [
    { id: 'reasoner', name: 'Reasoner', strengths: ['high', 'max'], defaultStrength: 'max', allowOff: false, supportsImages: true, overrides: { images: true, allowOff: false, defaultStrength: 'max' }, ratio: '0.7x' },
    { id: 'coder', name: 'Coder', strengths: [], supportsImages: false, overrides: null, ratio: '1x' },
  ],
}

function harness() {
  const postResponses = new Map()
  const confirmations = []
  const controls = { confirmAnswer: true }
  let active
  let cursor = 0
  let SettingsPage
  let currentTree
  const instances = new Map()
  const effects = []
  const intervals = []
  const pending = []
  const writes = []
  const copied = []
  const state = () => {
    const index = cursor++
    return [active, index]
  }
  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
    useState: (initial) => {
      const [instance, index] = state()
      if (!(index in instance.hooks)) instance.hooks[index] = typeof initial === 'function' ? initial() : initial
      return [instance.hooks[index], (value) => { instance.hooks[index] = typeof value === 'function' ? value(instance.hooks[index]) : value }]
    },
    useRef: (initial) => {
      const [instance, index] = state()
      return instance.hooks[index] ??= { current: initial }
    },
    useCallback: (fn, deps) => {
      const [instance, index] = state()
      const previous = instance.hooks[index]
      if (!previous || deps.some((dep, i) => dep !== previous.deps[i])) {
        instance.hooks[index] = { value: fn, deps }
      }
      return instance.hooks[index].value
    },
    useId: () => {
      const [instance, index] = state()
      return instance.hooks[index] ??= `test-${instances.size}-${index}`
    },
    useEffect: (fn, deps) => {
      const [instance, index] = state()
      const previous = instance.hooks[index]
      if (!previous || !deps || deps.some((dep, i) => dep !== previous.deps[i])) {
        instance.hooks[index] = { deps, cleanup: previous?.cleanup }
        effects.push(() => {
          previous?.cleanup?.()
          instance.hooks[index].cleanup = fn()
        })
      }
    },
  }
  const context = vm.createContext({
    console, AbortController,
    document: { documentElement: { lang: 'zh-CN' } },
    navigator: { language: 'zh-CN', clipboard: { writeText: async (text) => copied.push(text) } },
    setInterval: (fn) => { intervals.push(fn); return intervals.length }, clearInterval() {},
    fetch: async (url, options = {}) => {
      const path = url.replace('/plugins/dsh-connect-codearts', '')
      if (options.method === 'POST') {
        const body = JSON.parse(options.body)
        writes.push({ path, body })
        const reply = postResponses.get(path)
        const result = typeof reply === 'function' ? reply(body) : reply ?? { ok: true, enabled: 1 }
        return { ok: true, text: async () => JSON.stringify(result) }
      }
      return new Promise((resolve, reject) => {
        pending.push({ path, options, resolve: (body) => resolve({ ok: true, text: async () => JSON.stringify(body) }), reject })
      })
    },
    window: { confirm: (text) => { confirmations.push(text); return controls.confirmAnswer }, __ModuleLoader__: { load: (definition) => {
      const module = definition.factory(() => React)
      module.apply({ effect() {}, slots: {
        inject: (_, fn) => fn(),
        register: (seat, component) => {
          if (seat.name === 'settings.section') SettingsPage = component
          return () => {}
        },
      } })
    } } },
  })
  vm.runInContext(source, context)

  function render() {
    const live = new Set()
    function resolve(element, path) {
      if (element === undefined || element === null || typeof element === 'boolean') return null
      if (typeof element !== 'object') return element
      if (typeof element.type === 'function') {
        live.add(path)
        let instance = instances.get(path)
        if (!instance || instance.type !== element.type) {
          instance = { type: element.type, hooks: [] }
          instances.set(path, instance)
        }
        active = instance
        cursor = 0
        return resolve(element.type(element.props), `${path}/output`)
      }
      const result = { ...element, props: { ...element.props, children: element.props.children.map((child, i) => resolve(child, `${path}/${child?.props?.key ?? i}`)) } }
      return result
    }
    currentTree = resolve(React.createElement(SettingsPage), 'root')
    for (const [key, instance] of instances) {
      if (!live.has(key)) {
        instance.hooks.forEach((hook) => hook?.cleanup?.())
        instances.delete(key)
      }
    }
    effects.splice(0).forEach((run) => run())
    return currentTree
  }
  function findAll(predicate, node = currentTree) {
    if (!node || typeof node !== 'object') return []
    return [...(predicate(node) ? [node] : []), ...node.props.children.flatMap((child) => findAll(predicate, child))]
  }
  function one(predicate) {
    const matches = findAll(predicate)
    assert.equal(matches.length, 1, `Expected one node, got ${matches.length}`)
    return matches[0]
  }
  const text = (node) => typeof node === 'object' && node ? node.props.children.map(text).join('') : node ?? ''
  async function settle(path, body) {
    const index = pending.findIndex((request) => request.path === path)
    assert.notEqual(index, -1, `Missing request ${path}`)
    pending.splice(index, 1)[0].resolve(body)
    await new Promise(setImmediate)
    render()
  }
  render()
  return { render, findAll, one, text, settle, pending, writes, intervals, copied, postResponses, confirmations, controls }
}

const app = harness()
const tab = (id) => app.one((node) => node.props.role === 'tab' && node.props.id.endsWith(`-tab-${id}`))
const panel = (id) => app.one((node) => node.props.role === 'tabpanel' && node.props.id.endsWith(`-panel-${id}`))
const button = (label) => app.one((node) => node.type === 'button' && app.text(node) === label)

await app.settle('/models', initialModels)
assert.match(app.text(panel('account')), /加载中/)
assert.doesNotMatch(app.text(panel('account')), /还没有账号/)
tab('models').props.onClick()
app.render()
assert.equal(panel('models').props.hidden, false)
assert.match(app.text(panel('models')), /本地缓存/)
let focused = false
tab('usage').props.ref({ focus: () => { focused = true } })
tab('models').props.onKeyDown({ key: 'ArrowRight', preventDefault() {} })
app.render()
assert.equal(focused, true)
assert.equal(panel('usage').props.hidden, false)
assert.match(app.text(panel('diagnostics')), /加载中/)
console.log('✓ fast model reads render before account probes; tab arrows move focus')

const reasoner = () => app.one((node) => node.type === 'input' && node.props['aria-label'] === 'Reasoner')
reasoner().props.onChange({ target: { checked: false } })
app.render()
tab('account').props.onClick()
app.render()
tab('models').props.onClick()
app.render()
assert.equal(reasoner().props.checked, false)
assert.match(app.text(panel('models')), /未保存/)
console.log('✓ switching panels preserves the model draft')

const savePromise = button('保存').props.onClick()
await new Promise(setImmediate)
assert.equal(app.writes[0].path, '/models/select')
assert.deepEqual(app.writes[0].body.enabledIds, ['coder'])
assert.deepEqual(app.writes[0].body.overrides.reasoner, { images: true, allowOff: false, defaultStrength: 'max' })
assert.equal(app.pending.filter((entry) => entry.path === '/models').length, 1)
assert.equal(app.pending.filter((entry) => entry.path === '/account').length, 1)
await app.settle('/models', { ...initialModels, enabledIds: ['coder'] })
await savePromise
app.render()
assert.equal(button('保存').props.disabled, true)
assert.match(app.text(panel('models')), /已保存/)
console.log('✓ save preserves existing overrides and completes without waiting for account probes')

const status = { ok: true, provider: 'codearts', catalog: { source: 'cache', models: 2, error: 'SECRET_ERROR', refreshedAt: 1 }, credential: { configured: true, source: 'file', savedAk: 'SECRET_AK', savedSk: 'SECRET_SK', sourceLabel: 'SECRET_LABEL', path: '/SECRET_PATH', candidates: [{ label: 'SECRET_CANDIDATE' }] }, registration: { configSchema: true, settingsNs: 'SECRET_NAMESPACE' }, settings: { gateway: 'https://SECRET_HOST' } }
await app.settle('/status', status)
await app.settle('/account', { ok: true, account: 'SECRET_ACCOUNT', userId: 'SECRET_USER', roles: ['SECRET_ROLE'], credit: { total: 1000, remain: 99 } })
await button('复制脱敏诊断信息').props.onClick()
const report = JSON.parse(app.copied[0])
assert.equal(report.catalog.hasError, true)
assert.equal(report.credential.savedAkSet, true)
assert.equal(report.credential.savedSkSet, true)
assert.ok(!app.copied[0].includes('SECRET'))
assert.equal(report.catalog.source, 'cache')
console.log('✓ copied diagnostics omit account identities, paths, gateway, credentials, and error text')

// Background polling must not interrupt a foreground model refresh.
const refreshButton = button('重读模型目录')
const refreshPromise = refreshButton.props.onClick()
await new Promise(setImmediate)
// The refresh route is deliberately a normal pending read in this harness.
await app.settle('/refresh', { ok: true })
const oldRequest = app.pending.find((request) => request.path === '/models')
app.intervals[0]()
await new Promise(setImmediate)
assert.equal(app.pending.filter((request) => request.path === '/models').length, 1, 'background polling does not abort a foreground refresh')
await app.settle('/models', { ...initialModels, source: 'gateway', enabledIds: ['coder'] })
await refreshPromise
assert.equal(oldRequest.options.signal.aborted, false)
console.log('✓ background polling leaves a foreground model refresh in progress')



// Exercise the new forms through SettingsPage with controlled HTTP responses.
const features = harness()
const fixtures = {
  '/models': { ...initialModels, models: [
    ...initialModels.models,
    { id: 'expensive', name: 'Expensive', ratio: '9x', strengths: [], supportsImages: false },
    { id: 'free', name: 'Free', ratio: '0x', strengths: [], supportsImages: false },
  ] },
  '/status': status,
  '/account': { ok: true, credit: { total: 1000, remain: 99 } },
  '/accounts': { ok: true, activeId: 'account-1', accounts: [{ id: 'account-1', label: 'Example', ak: 'TEST…MASK', isActive: true, health: { state: 'credentials', checkedAt: 1 }, credit: null, checkin: null }] },
  '/preferences': { ok: true, preferences: { lowBalanceEnabled: true, lowBalanceThreshold: 500, usageEnabled: true } },
  '/usage': { ok: true, enabled: true, records: [
    { id: 'one', at: Date.now(), model: 'reasoner', durationMs: 1000, inputTokens: 8, outputTokens: 2, status: 'success' },
    { id: 'two', at: Date.now(), model: 'coder', durationMs: 20, inputTokens: null, outputTokens: null, status: 'error' },
    { id: 'three', at: Date.now(), model: 'reasoner', durationMs: 20, status: 'aborted' },
  ] },
}
const ft = (id) => features.one((node) => node.props.role === 'tab' && node.props.id.endsWith(`-tab-${id}`))
const fp = (id) => features.one((node) => node.props.role === 'tabpanel' && node.props.id.endsWith(`-panel-${id}`))
const fb = (label) => features.one((node) => node.type === 'button' && features.text(node) === label)
const labelled = (label, type = 'input') => {
  const wrapper = features.one((node) => node.type === 'label' && features.text(node).startsWith(label))
  const matches = features.findAll((node) => node.type === type, wrapper)
  assert.equal(matches.length, 1)
  return matches[0]
}
async function drain() {
  await new Promise(setImmediate)
  let turns = 0
  while (features.pending.length && turns++ < 30) {
    const path = features.pending[0].path
    assert.ok(path in fixtures, `Unexpected offline request ${path}`)
    await features.settle(path, fixtures[path])
  }
  assert.equal(features.pending.length, 0)
  features.render()
}
async function act(fn) {
  const promise = fn()
  await drain()
  await promise
  features.render()
}
await drain()

// Balance form validates locally and posts only the two alert preferences.
labelled('提醒阈值（积分）').props.onChange({ target: { value: '-1' } })
features.render()
const reminderForm = () => features.one((node) => node.type === 'form' && features.findAll((child) => child.type === 'input' && child.props.type === 'number', node).length === 1)
assert.equal(features.findAll((node) => node.type === 'button', reminderForm())[0].props.disabled, true)
labelled('提醒阈值（积分）').props.onChange({ target: { value: '250' } })
features.render()
features.postResponses.set('/preferences/save', (body) => {
  Object.assign(fixtures['/preferences'].preferences, body)
  if ('usageEnabled' in body) fixtures['/usage'].enabled = body.usageEnabled
  return { ok: true }
})
await act(() => reminderForm().props.onSubmit({ preventDefault() {} }))
assert.deepEqual(features.writes.at(-1), { path: '/preferences/save', body: { lowBalanceEnabled: true, lowBalanceThreshold: 250 } })
assert.equal(labelled('提醒阈值（积分）').props.value, '250')
console.log('✓ balance alerts reject invalid thresholds and persist the edited preferences')

fb('更新凭证').props.onClick()
features.render(); features.render()
assert.match(features.text(fp('account')), /填写同一个 AK 和新的 SK/)
features.postResponses.set('/accounts/check', { ok: true, account: { label: 'Example', health: { state: 'available' } } })
await act(() => fb('重新检查').props.onClick())
assert.ok(features.writes.some((entry) => entry.path === '/accounts/check' && entry.body.id === 'account-1'))
console.log('✓ unhealthy accounts expose credential repair and account-specific rechecks')

ft('models').props.onClick(); features.render()
const capability = (label, value) => { labelled(label).props.onChange({ target: { checked: value } }); features.render() }
capability('支持图片', true)
assert.equal(features.findAll((node) => node.type === 'input' && node.props['aria-label'] === 'Coder').length, 0)
assert.equal(features.findAll((node) => node.type === 'input' && node.props['aria-label'] === 'Reasoner').length, 1)
capability('支持图片', false)
capability('支持推理', true)
assert.equal(features.findAll((node) => node.type === 'input' && node.props['aria-label'] === 'Free').length, 0)
capability('支持推理', false)
const presetSelect = () => features.one((node) => node.type === 'select' && node.props['aria-label'] === '模型配置预设')
presetSelect().props.onChange({ target: { value: 'builtin:daily' } }); features.render()
const writesBeforePreview = features.writes.length
fb('预览配置').props.onClick(); features.render()
const previewList = features.one((node) => node.type === 'ul' && node.props.className === 'dca-preset-preview')
assert.match(features.text(previewList), /Free/)
assert.doesNotMatch(features.text(previewList), /Expensive/)
assert.equal(features.writes.length, writesBeforePreview)
fb('应用到草稿').props.onClick(); features.render()
assert.equal(features.writes.length, writesBeforePreview)
assert.equal(features.one((node) => node.type === 'input' && node.props['aria-label'] === 'Expensive').props.checked, false)
assert.match(features.text(fp('models')), /未保存/)
const presetName = features.one((node) => node.type === 'input' && node.props.maxLength === 48)
presetName.props.onChange({ target: { value: 'My draft' } }); features.render()
features.postResponses.set('/presets', (body) => ({ ok: true, presets: [{ ...body, id: 'custom-1' }] }))
await act(() => fb('保存当前草稿为预设').props.onClick())
assert.equal(features.writes.at(-1).path, '/presets')
assert.equal(features.writes.at(-1).body.modelOverrides.reasoner.allowOff, false)
assert.ok(!features.writes.slice(writesBeforePreview).some((entry) => entry.path === '/models/select'))
console.log('✓ capability filters and presets preserve drafts, include zero-cost models, and never auto-save the live selection')

ft('usage').props.onClick(); features.render()
const usageRows = () => features.findAll((node) => node.type === 'tbody', fp('usage'))[0].props.children.filter(Boolean)
assert.equal(usageRows().length, 3)
features.one((node) => node.type === 'input' && node.props['aria-label'] === '按模型搜索记录').props.onChange({ target: { value: 'reasoner' } }); features.render()
assert.equal(usageRows().length, 2)
features.one((node) => node.type === 'select' && node.props['aria-label'] === '结果').props.onChange({ target: { value: 'success' } }); features.render()
assert.equal(usageRows().length, 1)
await act(() => labelled('记录最近 200 次请求').props.onChange())
assert.equal(labelled('记录最近 200 次请求').props.checked, false)
features.controls.confirmAnswer = false
const beforeCancel = features.writes.length
await act(() => fb('清空记录').props.onClick())
assert.equal(features.writes.length, beforeCancel)
features.controls.confirmAnswer = true
features.postResponses.set('/usage/clear', () => { fixtures['/usage'].records = []; return { ok: true } })
await act(() => fb('清空记录').props.onClick())
assert.equal(usageRows().length, 0)
assert.match(features.text(fp('usage')), /暂无符合条件的记录/)
console.log('✓ usage filters, opt-out, clear confirmation, and empty states behave correctly')

ft('account').props.onClick(); features.render()
labelled('包含账号凭证（AK/SK）').props.onChange({ target: { checked: true } }); features.render()
assert.equal(fb('下载备份').props.disabled, true)
labelled('加密密码（不含凭证时可留空）').props.onChange({ target: { value: 'password-123' } })
labelled('确认加密密码').props.onChange({ target: { value: 'different' } }); features.render()
assert.equal(fb('下载备份').props.disabled, true)
labelled('确认加密密码').props.onChange({ target: { value: 'password-123' } }); features.render()
assert.equal(fb('下载备份').props.disabled, false)
const backupText = '{"format":"test-backup"}'
labelled('备份内容（也可粘贴 JSON）', 'textarea').props.onChange({ target: { value: backupText } }); features.render()
features.postResponses.set('/backup/preview', { ok: true, changes: ['usageEnabled'], preferences: { usageEnabled: true }, accounts: { added: 1, updated: 0 } })
await act(() => fb('读取并预览').props.onClick())
assert.equal(features.writes.at(-1).path, '/backup/preview')
assert.ok(!features.writes.some((entry) => entry.path === '/backup/restore'))
labelled('解密密码（未加密文件可留空）').props.onChange({ target: { value: 'new-password' } }); features.render()
assert.equal(features.findAll((node) => node.type === 'button' && features.text(node) === '确认恢复').length, 0)
await act(() => fb('读取并预览').props.onClick())
features.postResponses.set('/backup/restore', { ok: true, added: 1, updated: 0 })
await act(() => fb('确认恢复').props.onClick())
assert.equal(features.writes.at(-1).path, '/backup/restore')
assert.equal(features.writes.at(-1).body.text, backupText)
assert.equal(labelled('备份内容（也可粘贴 JSON）', 'textarea').props.value, '')
assert.equal(labelled('解密密码（未加密文件可留空）').props.value, '')
console.log('✓ credential backups require matching passwords; restore needs a current preview and clears sensitive inputs')
console.log('\nui: all checks passed')
