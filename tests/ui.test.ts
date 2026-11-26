/** Offline interactions for the actual client components; no browser, network, or credentials. */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
type TestNode = { type: any; props: Record<string, any> }
type PendingRequest = {
  path: string
  options: { method?: string; body?: string; signal?: AbortSignal }
  resolve(body: unknown): void
  reject(reason?: unknown): void
}
type Write = { path: string; body: any }
type Download = { name: string; blob: Blob | undefined }
function latest<T>(items: T[]): T {
  const item = items.at(-1)
  assert.ok(item, 'expected at least one recorded item')
  return item
}
const initialModels = {
  ok: true, source: 'cache', enabledIds: null, refreshedAt: 1,
  models: [
    { id: 'reasoner', name: 'Reasoner', strengths: ['high', 'max'], defaultStrength: 'max', allowOff: false, supportsImages: true, overrides: { images: true, allowOff: false, defaultStrength: 'max' }, ratio: '0.7x' },
    { id: 'coder', name: 'Coder', strengths: [], supportsImages: false, overrides: null, ratio: '1x' },
  ],
}

function harness(surface = 'settings', rootProps = {}) {
  const postResponses = new Map<string, unknown>()
  const confirmations: string[] = []
  const controls = { confirmAnswer: true, now: Date.now() }
  let active: { type: any; hooks: any[] } | undefined
  let cursor = 0
  let SettingsPage: any
  let ComposerChip: any
  const exposed: Record<string, any> = {}
  let currentTree: any
  const instances = new Map<string, { type: any; hooks: any[] }>()
  const effects: Array<() => void> = []
  const intervals: Array<() => void> = []
  const pending: PendingRequest[] = []
  const writes: Write[] = []
  const copied: string[] = []
  const downloads: Download[] = []
  const blobs = new Map<string, Blob>()
  const state = () => {
    const index = cursor++
    return [active!, index] as const
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
    Date: class extends Date { static now() { return controls.now } },
    Blob,
    URL: {
      createObjectURL: (blob) => { const url = `blob:offline-${blobs.size}`; blobs.set(url, blob); return url },
      revokeObjectURL: (url) => blobs.delete(url),
    },
    document: {
      documentElement: { lang: 'zh-CN' }, body: { appendChild() {} },
      addEventListener() {}, removeEventListener() {},
      createElement: (tag: string) => {
        assert.equal(tag, 'a')
        return {
          download: '',
          href: '',
          click() { downloads.push({ name: this.download, blob: blobs.get(this.href) }) },
          remove() {},
        }
      },
    },
    navigator: { language: 'zh-CN', clipboard: { writeText: async (text) => copied.push(text) } },
    setInterval: (fn) => { intervals.push(fn); return intervals.length }, clearInterval() {},
    fetch: async (url: string, options: { method?: string; body?: string; signal?: AbortSignal } = {}) => {
      const path = url.replace('/plugins/dsh-codearts-dock', '')
      if (options.method === 'POST') {
        const body = JSON.parse(options.body ?? '{}')
        writes.push({ path, body })
        const reply = postResponses.get(path)
        const result = await (typeof reply === 'function' ? reply(body) : reply ?? { ok: true, enabled: 1 })
        return { ok: true, text: async () => JSON.stringify(result) }
      }
      return new Promise((resolve, reject) => {
        pending.push({ path, options, resolve: (body) => resolve({ ok: true, text: async () => JSON.stringify(body) }), reject })
      })
    },
    window: { setTimeout: (fn) => fn(), confirm: (text) => { confirmations.push(text); return controls.confirmAnswer }, __ModuleLoader__: { load: (definition) => {
      const module = definition.factory(() => React)
      exposed.module = module
      module.apply({ effect() {}, slots: {
        inject: (_, fn) => fn(),
        register: (seat, component) => {
          if (seat.name === 'settings.section') SettingsPage = component
          if (seat.name === 'conversation.input.right') ComposerChip = component
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
    currentTree = resolve(React.createElement(surface === 'settings' ? SettingsPage : ComposerChip, rootProps), 'root')
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
  function one(predicate, node = currentTree) {
    const matches = findAll(predicate, node)
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
  async function fail(path) {
    const index = pending.findIndex((request) => request.path === path)
    assert.notEqual(index, -1, `Missing request ${path}`)
    pending.splice(index, 1)[0].reject(new Error('Offline refresh failure'))
    await new Promise(setImmediate)
    render()
  }
  render()
  return { render, findAll, one, text, settle, fail, pending, writes, intervals, copied, postResponses, confirmations, controls, downloads, exposed }
}

test('client components preserve settings and composer interactions', async () => {
const app = harness()
assert.deepEqual(app.pending.map((request) => request.path).sort(), ['/account', '/accounts', '/models', '/status'])
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
tab('diagnostics').props.ref({ focus: () => { focused = true } })
tab('models').props.onKeyDown({ key: 'ArrowRight', preventDefault() {} })
app.render()
assert.equal(focused, true)
assert.equal(panel('diagnostics').props.hidden, false)
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

const savePromise = button('保存模型配置').props.onClick()
await new Promise(setImmediate)
assert.equal(app.writes[0].path, '/models/select')
assert.deepEqual(app.writes[0].body.enabledIds, ['coder'])
assert.deepEqual(app.writes[0].body.overrides.reasoner, { images: true, allowOff: false, defaultStrength: 'max' })
assert.equal(app.pending.filter((entry) => entry.path === '/models').length, 1)
assert.equal(app.pending.filter((entry) => entry.path === '/account').length, 1)
await app.settle('/models', { ...initialModels, enabledIds: ['coder'] })
await savePromise
app.render()
assert.equal(button('保存模型配置').props.disabled, true)
assert.match(app.text(panel('models')), /已保存/)
console.log('✓ save preserves existing overrides and completes without waiting for account probes')

const status = { ok: true, provider: 'codearts', catalog: { source: 'cache', models: 2, error: 'SECRET_ERROR', refreshedAt: 1 }, credential: { configured: true, source: 'file', savedAk: 'SECRET_AK', savedSk: 'SECRET_SK', sourceLabel: 'SECRET_LABEL', path: '/SECRET_PATH', candidates: [{ label: 'SECRET_CANDIDATE' }] }, registration: { configSchema: true, settingsNs: 'SECRET_NAMESPACE' }, settings: { gateway: 'https://SECRET_HOST', dailyCheckinEnabled: false } }
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
assert.ok(oldRequest, 'the foreground model request remains pending')
app.intervals[0]()
await new Promise(setImmediate)
assert.equal(app.pending.filter((request) => request.path === '/models').length, 1, 'background polling does not abort a foreground refresh')
await app.settle('/models', { ...initialModels, source: 'gateway', enabledIds: ['coder'] })
await refreshPromise
assert.equal(oldRequest.options.signal?.aborted, false)
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
  '/accounts': { ok: true, memberAccountIds: ['account-1'], activeId: 'account-1', accounts: [{ id: 'account-1', label: 'Example', ak: 'TEST…MASK', isActive: true, health: { state: 'credentials', checkedAt: features.controls.now - 300000 }, error: 'RAW_GATEWAY_ERROR_FOR_DETAILS', credit: null, checkin: null }] },
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

assert.equal(features.findAll((node) => node.props.role === 'tab').length, 4)
assert.doesNotMatch(features.text(fp('account')), /余额提醒/)
assert.ok(!features.pending.some((request) => ['/usage', '/preferences'].includes(request.path)))
const dailyToggle = () => features.one((node) => node.props.role === 'switch' && node.props['aria-label'] === '每天自动签到')
assert.equal(dailyToggle().type, 'button', 'automatic check-in uses a switch button, not a checkbox')
assert.equal(dailyToggle().props['aria-checked'], false, 'automatic daily check-in is off by default')
console.log('✓ settings retain the account tools and show the opt-in daily check-in switch')
const checkTime = () => features.one((node) => node.type === 'time')
assert.equal(features.text(checkTime()), '5 分钟前')
assert.match(checkTime().props.title, /最近检查/)
assert.equal(checkTime().props.dateTime, new Date(features.controls.now - 300000).toISOString())
features.controls.now += 60000
features.intervals[1]()
features.render()
assert.equal(features.text(checkTime()), '6 分钟前')
const accountError = features.one((node) => node.type === 'details' && node.props.className === 'dca-details dca-account-error')
assert.notEqual(accountError.props.open, true)
assert.match(features.text(accountError), /RAW_GATEWAY_ERROR_FOR_DETAILS/)
console.log('✓ account check times advance without fetching; raw errors stay in collapsed details')


fb('更新凭证').props.onClick()
features.render(); features.render()
assert.match(features.text(fp('account')), /填写同一个 AK 和新的 SK/)
features.postResponses.set('/accounts/check-all', { ok: true, accounts: [{ health: { state: 'available' } }] })
await act(() => fb('检查全部账号').props.onClick())
assert.ok(features.writes.some((entry) => entry.path === '/accounts/check-all' && Object.keys(entry.body).length === 0))
assert.match(features.text(fp('account')), /检查完成：1 个账号，1 个可用，0 个异常/)
console.log('✓ account health checks run for the whole pool from the top action')
assert.ok(!features.writes.some((entry) => entry.path.startsWith('/checkin')), 'checking accounts never claims benefits')
features.postResponses.set('/preferences/save', { ok: true, preferences: { dailyCheckinEnabled: true } })
fixtures['/status'] = { ...status, settings: { ...status.settings, dailyCheckinEnabled: true } }
await act(() => dailyToggle().props.onClick())
assert.deepEqual(features.writes.at(-1), { path: '/preferences/save', body: { dailyCheckinEnabled: true } })
assert.equal(dailyToggle().props['aria-checked'], true, 'the switch reflects the saved preference')
assert.ok(!features.writes.some((entry) => entry.path.startsWith('/checkin')), 'enabling scheduling does not claim from the browser')
features.postResponses.set('/checkin/claim-all', { ok: true, summary: { claimed: 1, failures: [] } })
await act(() => fb('一键签到').props.onClick())
const manualClaims = features.writes.filter((entry) => entry.path.startsWith('/checkin'))
assert.equal(manualClaims.length, 1)
assert.deepEqual(manualClaims[0], { path: '/checkin/claim-all', body: {} })
console.log('✓ daily switch persists separately; manual welfare claims remain a separate action')


ft('models').props.onClick(); features.render()
const capability = (label, value) => { labelled(label).props.onChange({ target: { checked: value } }); features.render() }
capability('支持图片', true)
assert.equal(features.findAll((node) => node.type === 'input' && node.props['aria-label'] === 'Coder').length, 0)
assert.equal(features.findAll((node) => node.type === 'input' && node.props['aria-label'] === 'Reasoner').length, 1)
capability('支持图片', false)
capability('支持推理', true)
assert.equal(features.findAll((node) => node.type === 'input' && node.props['aria-label'] === 'Free').length, 0)
capability('支持推理', false)
assert.equal(features.findAll((node) => node.type === 'input' && node.props.maxLength === 48).length, 0)
assert.doesNotMatch(features.text(fp('models')), /模型配置预设|保存为预设|应用到草稿/)
assert.equal(features.findAll((node) => node.type === 'select' && node.props['aria-label'] === '模型配置预设').length, 0)
const writesBeforeFilters = features.writes.length
features.one((node) => node.type === 'input' && node.props['aria-label'] === 'Expensive').props.onChange({ target: { checked: false } }); features.render()
features.one((node) => node.type === 'select' && node.props['aria-label'] === '模型排序').props.onChange({ target: { value: 'ratio' } }); features.render()
assert.deepEqual(features.findAll((node) => node.type === 'input' && node.props.className === 'dca-model-check').map((node) => node.props['aria-label']), ['Free', 'Reasoner', 'Coder', 'Expensive'])
features.one((node) => node.type === 'input' && node.props.type === 'search').props.onChange({ target: { value: 'free' } }); features.render()
assert.equal(features.findAll((node) => node.type === 'input' && node.props.className === 'dca-model-check').length, 1)
assert.equal(features.one((node) => node.type === 'input' && node.props['aria-label'] === 'Free').props.checked, true)
features.one((node) => node.type === 'input' && node.props.type === 'search').props.onChange({ target: { value: '' } }); features.render()
assert.equal(features.one((node) => node.type === 'input' && node.props['aria-label'] === 'Expensive').props.checked, false)
assert.match(features.text(fp('models')), /未保存/)
assert.equal(features.writes.length, writesBeforeFilters)
console.log('✓ model filters and sorting preserve manual drafts and zero-cost models without preset controls or automatic saves')

ft('account').props.onClick(); features.render()
assert.doesNotMatch(features.text(fp('account')), /凭证管理|清除已保存的凭证|配置备份与迁移|下载备份|恢复配置/)
assert.equal(features.findAll((node) => node.type === 'input' && node.props.autoComplete === 'new-password').length, 0)
assert.equal(fb('测试连接').props.disabled, false, 'the connection test remains available')
assert.equal(fb('导出').props.disabled, false, 'account export remains available')
console.log('✓ account tools remain available without credential clearing or configuration backup controls')

// The composer is a compact account picker, not a second diagnostics page.
let openedSettings = 0
const chip = harness('composer', {
  useProjection: () => ({ next: { provider: 'codearts' } }),
  openSettings: () => { openedSettings += 1 },
})

const chipPool = { ok: true, accounts: [
  { id: 'primary', label: 'Primary', active: true, credit: { remain: 42 }, health: { state: 'available' } },
  { id: 'backup', label: 'Backup', credit: { remain: 13.25 }, health: { state: 'available' } },
  { id: 'network', label: 'Network', error: 'RAW_NETWORK_ERROR', health: { state: 'network' } },
] }
await chip.settle('/account', { ok: true, credit: { remain: 42 } })
await chip.settle('/accounts', chipPool)
chip.one((node) => node.props['aria-haspopup'] === 'dialog').props.onClick()
chip.render()
const dialog = () => chip.one((node) => node.props.role === 'dialog')
const chipRow = (name) => chip.one((node) => node.props['aria-label'] === `切换到 ${name}`)
assert.equal(chipRow('Primary').props.disabled, true)
assert.equal(chip.text(chipRow('Primary')), 'Primary当前选用')
assert.equal(chip.text(chipRow('Backup')), 'Backup')
assert.equal(chip.text(chipRow('Network')), 'Network网络异常')
assert.equal(chip.findAll((node) => node.props.title === 'RAW_NETWORK_ERROR', dialog()).length, 1)
assert.doesNotMatch(chip.text(dialog()), /RAW_NETWORK_ERROR/)
chipRow('Backup').props.onClick()
await new Promise(setImmediate)
assert.deepEqual(chip.writes.at(-1), { path: '/accounts/activate', body: { id: 'backup' } })
chip.render()
assert.match(chip.text(chipRow('Backup')), /正在切换/)
assert.doesNotMatch(chip.text(chipRow('Primary')), /正在切换/)
assert.equal(chipRow('Backup').props['aria-busy'], true)
assert.equal(chipRow('Network').props.disabled, true)
assert.equal(chip.findAll((node) => node.type === 'svg' && node.props.className?.includes('dca-pop-refresh-icon-spin')).length, 0, 'switching must not look like a refresh')
await chip.settle('/account', { ok: true, credit: { remain: 13.25 } })
await chip.settle('/accounts', { ok: true, accounts: chipPool.accounts.map((account) => ({ ...account, active: account.id === 'backup' })) })
assert.equal(chip.text(chipRow('Backup')), 'Backup当前选用')
assert.equal(chipRow('Backup').props['aria-busy'], false)
assert.match(chip.text(dialog()), /已切换到「Backup」/)
chip.postResponses.set('/accounts/activate', { ok: false, error: 'Switch refused' })
chipRow('Primary').props.onClick()
await new Promise(setImmediate); chip.render()
assert.equal(chipRow('Primary').props.disabled, false, 'failed account switches can be retried')
assert.equal(chip.text(chipRow('Backup')), 'Backup当前选用', 'failed switches keep the current account')
assert.match(chip.text(dialog()), /切换到「Primary」失败：Switch refused/)
assert.doesNotMatch(chip.text(dialog()), /已切换到「Backup」/)
chip.one((node) => node.props.className === 'dca-pop-settings').props.onClick()
chip.render()
assert.equal(openedSettings, 1)
assert.equal(chip.findAll((node) => node.props.role === 'dialog').length, 0)
const otherProvider = harness('composer', { useProjection: () => ({ next: { provider: 'another' } }) })
assert.equal(otherProvider.render(), null)
assert.equal(otherProvider.pending.length, 0)
console.log('✓ composer shows concise health states, keeps raw errors out of row text, and supports account switching')

async function flushSettings(instance, responses) {
  await new Promise(setImmediate)
  let turns = 0
  while (instance.pending.length && turns++ < 20) {
    const path = instance.pending[0].path
    assert.ok(path in responses, `Unexpected request ${path}`)
    await instance.settle(path, responses[path])
  }
  assert.equal(instance.pending.length, 0)
  instance.render()
}
// Deferred writes expose progress before acknowledgement and before the subsequent reload.
const switching = harness()
const switchResponses = { ...fixtures, '/accounts': { ok: true, accounts: [
  { id: 'personal', label: '个人', active: true, health: { state: 'available' } },
  { id: 'work', label: '工作', active: false, health: { state: 'available' } },
] } }
await flushSettings(switching, switchResponses)
const accountRow = (id) => switching.one((node) => node.type === 'div' && node.props.key === id && node.props.className?.startsWith('dca-pool-row'))
const accountSwitch = (id) => switching.one((node) => node.type === 'button' && switching.text(node) === '切换', accountRow(id))
const chooseAccount = (id) => accountSwitch(id).props.onClick()
assert.equal(accountSwitch('personal').props.disabled, true, 'the current account cannot be switched to again')
assert.equal(accountSwitch('work').props.disabled, false)
let finishSwitch
switching.postResponses.set('/accounts/activate', () => new Promise((resolve) => { finishSwitch = resolve }))
const pendingSwitch = chooseAccount('work')
switching.render()
assert.equal(accountSwitch('work').props.disabled, true)
assert.equal(accountSwitch('work').props['aria-busy'], true)
assert.equal(accountSwitch('personal').props.disabled, true)
assert.match(accountRow('personal').props.className, /dca-pool-row-current/, 'the current account stays marked while activation is pending')
assert.match(switching.text(accountRow('work')), /正在切换/)
assert.equal(switching.one((node) => node.type === 'button' && switching.text(node) === '检查全部账号').props.disabled, true)
assert.doesNotMatch(switching.text(accountRow('personal')), /正在切换/)
assert.equal(switching.findAll((node) => node.type === 'button' && switching.text(node) === '加载中…').length, 0)
assert.equal(switching.pending.length, 0, 'reload waits for activation acknowledgement')
finishSwitch({ ok: true })
await new Promise(setImmediate); switching.render()
assert.match(switching.text(accountRow('work')), /正在切换/)
switchResponses['/accounts'] = { ok: true, accounts: switchResponses['/accounts'].accounts.map((account) => ({ ...account, active: account.id === 'work' })) }
await flushSettings(switching, switchResponses)
await pendingSwitch; switching.render()
assert.match(switching.text(accountRow('work')), /已切换到「工作」/)
assert.doesNotMatch(switching.text(accountRow('personal')), /已切换到/)
assert.equal(accountRow('work').props['aria-busy'], false)
assert.equal(accountSwitch('personal').props.disabled, false)
assert.equal(accountSwitch('work').props.disabled, true, 'the successfully selected account cannot be switched to again')
switching.postResponses.set('/accounts/activate', { ok: false, error: 'Switch refused' })
await chooseAccount('personal'); switching.render()
assert.match(switching.text(accountRow('personal')), /切换到「个人」失败：Switch refused/)
assert.equal(switching.findAll((node) => node.props.role === 'alert', accountRow('personal')).length, 1)
assert.equal(accountSwitch('personal').props.disabled, false)
assert.equal(accountSwitch('work').props.disabled, true, 'the successfully selected account cannot be switched to again')
assert.match(accountRow('work').props.className, /dca-pool-row-current/)
assert.doesNotMatch(switching.text(accountRow('work')), /Switch refused|已切换到/)
switching.postResponses.set('/accounts/activate', () => { throw new Error('Offline switch') })
await chooseAccount('personal'); switching.render()
assert.match(switching.text(accountRow('personal')), /切换到「个人」失败：Offline switch/)
assert.equal(accountSwitch('personal').props.disabled, false)
assert.equal(accountSwitch('work').props.disabled, true, 'the successfully selected account cannot be switched to again')
console.log('✓ row switch buttons show progress and outcomes on the target row, preserve current state on failure, and allow retry')

// Imported names can be replaced with a short name, hiding the original.
const names = harness()
const renameResponses = {
  ...fixtures,
  '/accounts': {
    ...fixtures['/accounts'],
    accounts: [{
      ...fixtures['/accounts'].accounts[0],
      renameable: true,
      accountName: 'hw045252840967331',
      akMasked: 'TEST…MASK',
    }],
  },
}
await flushSettings(names, renameResponses)
const nameRow = () => names.one((node) => node.type === 'div' && node.props.key === 'account-1' && node.props.className?.startsWith('dca-pool-row'))
const staticName = names.one((node) => node.props.className === 'dca-pool-account-name', nameRow())
assert.equal(staticName.type, 'b')
assert.equal(names.text(staticName), 'Example', 'the existing saved account label remains visible')
assert.doesNotMatch(names.text(nameRow()), /hw045252840967331/, 'a custom name hides the original imported cloud name')
assert.equal(names.findAll((node) => node.type === 'button' && names.text(node) === '修改名称', nameRow()).length, 1)
assert.equal(names.findAll((node) => node.props.className === 'dca-account-menu' || node.props.className === 'dca-menu-actions').length, 0)
assert.equal(names.findAll((node) => node.type === 'input' && node.props['aria-label'] === '账号名称').length, 0)
assert.deepEqual(names.findAll((node) => node.type === 'button', nameRow()).map((node) => names.text(node)).slice(-2), ['切换', '移除'], 'switching sits immediately before removal')
assert.equal(names.findAll((node) => node.type === 'button' && names.text(node) === '更新凭证', nameRow()).length, 1)
names.one((node) => node.type === 'button' && names.text(node) === '修改名称', nameRow()).props.onClick()
names.render()
const nameInput = () => names.one((node) => node.type === 'input' && node.props['aria-label'] === '账号名称', nameRow())
assert.equal(nameInput().props.value, 'Example')
nameInput().props.onChange({ target: { value: '短名称' } })
names.render()
names.postResponses.set('/accounts/rename', { ok: true })
const saveName = names.one((node) => node.type === 'button' && names.text(node) === '保存', nameRow()).props.onClick()
renameResponses['/accounts'] = {
  ...renameResponses['/accounts'],
  accounts: renameResponses['/accounts'].accounts.map((account) => ({ ...account, label: '短名称' })),
}
await new Promise(setImmediate)
await flushSettings(names, renameResponses)
await saveName
names.render()
assert.deepEqual(names.writes.at(-1), { path: '/accounts/rename', body: { id: 'account-1', label: '短名称' } })
assert.match(names.text(nameRow()), /短名称/)
assert.doesNotMatch(names.text(nameRow()), /hw045252840967331/)
names.one((node) => node.type === 'button' && names.text(node) === '添加账号').props.onClick()
names.render()
assert.equal(names.findAll((node) => node.type === 'input' && node.props.id === 'dca-label').length, 0)
assert.doesNotMatch(names.text(names.one((node) => node.props.id === 'dca-add-account')), /名称（可选）|账号名称/)
names.one((node) => node.type === 'input' && node.props['aria-label'] === 'Access Key ID').props.onChange({ target: { value: 'OFFLINE_NEW_AK' } })
names.render()
names.one((node) => node.type === 'input' && node.props['aria-label'] === 'Secret Access Key').props.onChange({ target: { value: 'OFFLINE_NEW_SK' } })
names.render()
names.postResponses.set('/accounts/add', { ok: true, added: true })
names.one((node) => node.type === 'form').props.onSubmit({ preventDefault() {} })
await flushSettings(names, fixtures)
assert.deepEqual(names.writes.at(-1), { path: '/accounts/add', body: { ak: 'OFFLINE_NEW_AK', sk: 'OFFLINE_NEW_SK' } })
assert.ok(names.writes.some((entry) => entry.path === '/accounts/rename'), 'the account name save uses the rename route')
console.log('✓ account names can be edited, custom names hide imported names, and new credentials remain separate from account names')

// Account import is a read-only preview of the entire confirmed batch.
const imports = harness()
await flushSettings(imports, fixtures)
const importFile = () => imports.one((node) => node.type === 'input' && node.props.type === 'file' && node.props.accept.includes('.csv'))
const importDialog = () => imports.one((node) => node.props.role === 'dialog' && node.props.className === 'dca-transfer-dialog')
const importButton = (label) => {
  const matches = imports.findAll((node) => node.type === 'button' && imports.text(node) === label, importDialog())
  assert.equal(matches.length, 1)
  return matches[0]
}
const importText = 'OFFLINE_AK_1,OFFLINE_SK_1\nOFFLINE_AK_2,OFFLINE_SK_2'
imports.postResponses.set('/accounts/preview', { ok: true, total: 2, accounts: [
  { index: 0, label: '个人', akMasked: 'OFF…ONE' },
  { index: 1, akMasked: 'OFF…TWO' },
] })
const chooseImport = async () => {
  importFile().props.onChange({ target: { value: 'credentials.csv', files: [{ text: async () => importText }] } })
  await flushSettings(imports, fixtures)
}
await chooseImport()
assert.match(imports.text(importDialog()), /将导入以下 2 个账号/)
assert.equal(imports.findAll((node) => node.type === 'li', importDialog()).length, 2)
assert.equal(imports.findAll((node) => node.type === 'input' || node.type === 'label', importDialog()).length, 0, 'the preview must not imply per-account selection')
assert.match(imports.text(importDialog()), /个人OFF…TWO/)
assert.doesNotMatch(imports.text(importDialog()), /OFFLINE_SK|OFFLINE_AK/)
assert.ok(!imports.writes.some((write) => write.path === '/accounts/import'))
importButton('取消').props.onClick(); imports.render()
assert.equal(imports.findAll((node) => node.props.className === 'dca-transfer-dialog').length, 0)
assert.ok(!imports.writes.some((write) => write.path === '/accounts/import'), 'cancel does not write any accounts')
await chooseImport()
imports.postResponses.set('/accounts/import', { ok: true, added: 2, updated: 0, skipped: 0 })
const importing = importButton('导入 2 个').props.onClick()
await flushSettings(imports, fixtures)
await importing; imports.render()
assert.deepEqual(imports.writes.at(-1), { path: '/accounts/import', body: { text: importText } })
assert.equal(imports.findAll((node) => node.props.className === 'dca-transfer-dialog').length, 0)
console.log('✓ account import previews a plain list with the confirmed batch count and only writes after confirmation')

const balances = harness()
const checkedAt = balances.controls.now - 300000
const balanceResponses: Record<string, any> = { ...fixtures,
  '/account': { ok: true, accountId: 'primary', creditIdentity: 'primary-key', credit: { remain: 20 }, creditCheckedAt: checkedAt },
  '/accounts': { ok: true, accounts: [
    { id: 'primary', creditIdentity: 'primary-key', label: 'Primary', credit: { remain: 20 }, creditCheckedAt: checkedAt },
    { id: 'backup', creditIdentity: 'backup-key', label: 'Backup', credit: { remain: 0 }, creditCheckedAt: checkedAt },
  ] },
}
await flushSettings(balances, balanceResponses)
const balanceCell = (name) => {
  const row = balances.one((node) => node.type === 'div' && /^dca-pool-row(?: dca-pool-row-current)?$/.test(node.props.className ?? '') && balances.text(node).includes(name))
  return balances.findAll((node) => node.props.className === 'dca-pool-credits-row', row)[0]
}
balanceResponses['/accounts'] = { ok: true, accounts: balanceResponses['/accounts'].accounts.map((account) => ({ ...account, credit: null, creditCheckedAt: null, health: { state: 'network' } })) }
balances.intervals[0]()
await flushSettings(balances, balanceResponses)
assert.match(balances.text(balanceCell('Primary')), /20.*上次结果.*5 分钟前/)
assert.match(balances.text(balanceCell('Backup')), /0.*上次结果.*5 分钟前/, 'zero is a successful balance too')
balances.controls.now += 120000
balances.intervals[1]()
balances.intervals[0]()
await balances.fail('/accounts')
await flushSettings(balances, balanceResponses)
assert.match(balances.text(balanceCell('Primary')), /20.*上次结果.*7 分钟前/, 'failed reads must not move the success timestamp')
balanceResponses['/accounts'] = { ok: true, accounts: [{ id: 'primary', creditIdentity: 'primary-key', label: 'Primary', credit: { remain: 0 }, creditCheckedAt: balances.controls.now }] }
balances.intervals[0]()
await flushSettings(balances, balanceResponses)
assert.equal(balances.text(balanceCell('Primary')), '积分0')
balanceResponses['/accounts'] = { ok: true, accounts: [{ id: 'primary', creditIdentity: 'replaced-key', label: 'Primary', credit: null }] }
balances.intervals[0]()
await flushSettings(balances, balanceResponses)
assert.equal(balances.text(balanceCell('Primary')), '积分—', 'new credentials must not inherit an old credential snapshot')
console.log('✓ settings retain successful balances and timestamps on gateway and route failures, recover zero balances, and isolate credential identities')

const staleChip = harness('composer', { useProjection: () => ({ next: { provider: 'codearts' } }) })
const chipCheckedAt = staleChip.controls.now - 300000
const currentAccount = { ok: true, accountId: 'primary', creditIdentity: 'primary-key', credit: { remain: 20 }, creditCheckedAt: chipCheckedAt }
const currentPool = { ok: true, accounts: [
  { id: 'primary', creditIdentity: 'primary-key', active: true, label: 'Primary', credit: { remain: 20 }, creditCheckedAt: chipCheckedAt },
  { id: 'backup', creditIdentity: 'backup-key', active: false, label: 'Backup', credit: { remain: 0 }, creditCheckedAt: chipCheckedAt },
] }
await staleChip.settle('/account', currentAccount)
await staleChip.settle('/accounts', currentPool)
const chipTrigger = () => staleChip.one((node) => node.props['aria-haspopup'] === 'dialog')
const chipRefresh = () => staleChip.one((node) => node.props.className === 'dca-pop-refresh')
chipTrigger().props.onClick(); staleChip.render()
const failedRefresh = chipRefresh().props.onClick()
await staleChip.fail('/account')
await staleChip.fail('/accounts')
await failedRefresh; staleChip.render()
assert.equal(staleChip.text(chipTrigger()), '◈上次积分 20')
assert.match(staleChip.text(staleChip.render()), /积分刷新失败，显示上次结果/)
assert.match(staleChip.text(staleChip.render()), /5 分钟前/)
assert.equal(staleChip.text(chipRefresh()).includes('重试'), true)
const nullRefresh = chipRefresh().props.onClick()
await staleChip.settle('/account', { ...currentAccount, credit: null, creditCheckedAt: null })
await staleChip.settle('/accounts', { ok: true, accounts: currentPool.accounts.map((account) => ({ ...account, credit: null, creditCheckedAt: null })) })
await nullRefresh; staleChip.render()
assert.equal(staleChip.text(chipTrigger()), '◈上次积分 20', 'an HTTP success without credit data is still a failed credit read')
const gatewayError = chipRefresh().props.onClick()
await staleChip.settle('/account', { ok: false, stage: 'gateway', error: 'offline gateway error' })
await staleChip.settle('/accounts', { ok: false, error: 'offline gateway error' })
await gatewayError; staleChip.render()
assert.equal(staleChip.text(chipTrigger()), '◈上次积分 20', 'HTTP-200 error payloads must retain last successful values too')
const recovery = chipRefresh().props.onClick()
await staleChip.settle('/account', { ...currentAccount, credit: { remain: 7 }, creditCheckedAt: staleChip.controls.now })
await staleChip.settle('/accounts', { ok: true, accounts: currentPool.accounts.map((account) => ({ ...account, credit: { remain: account.id === 'primary' ? 7 : 0 } })) })
await recovery; staleChip.render()
assert.equal(staleChip.text(chipTrigger()), '◈积分 7')
assert.equal(staleChip.findAll((node) => node.props.className === 'dca-credit-status').length, 0)
// An older background response must not overwrite a newer manual refresh.
staleChip.intervals[0]()
const olderReads = staleChip.pending.splice(0)
const newestRefresh = chipRefresh().props.onClick()
await staleChip.settle('/account', { ...currentAccount, credit: { remain: 9 }, creditCheckedAt: staleChip.controls.now })
await staleChip.settle('/accounts', currentPool)
await newestRefresh
for (const request of olderReads) request.resolve(request.path === '/account' ? { ...currentAccount, credit: { remain: 999 } } : currentPool)
await new Promise(setImmediate); staleChip.render()
assert.equal(staleChip.text(chipTrigger()), '◈积分 9', 'late background responses cannot restore an older value')
staleChip.one((node) => node.props['aria-label'] === '切换到 Backup').props.onClick()
await new Promise(setImmediate); staleChip.render()
assert.doesNotMatch(staleChip.text(chipTrigger()), /9/, 'switching clears the previous account headline immediately')
await staleChip.settle('/account', { ok: true, accountId: 'backup', creditIdentity: 'backup-key', credit: null })
await staleChip.settle('/accounts', { ok: true, accounts: currentPool.accounts.map((account) => ({ ...account, active: account.id === 'backup' })) })
assert.doesNotMatch(staleChip.text(chipTrigger()), /9/, 'failed reads for the new account cannot reuse the previous account balance')
console.log('✓ composer retains last values on refresh failures, exposes retry and timestamps, clears stale markers on recovery, and isolates account switches')

const unreadChip = harness('composer', { useProjection: () => ({ next: { provider: 'codearts' } }) })
await unreadChip.fail('/account')
await unreadChip.fail('/accounts')
unreadChip.one((node) => node.props['aria-haspopup'] === 'dialog').props.onClick(); unreadChip.render()
assert.match(unreadChip.text(unreadChip.render()), /积分暂时无法读取，请重试/)
assert.doesNotMatch(unreadChip.text(unreadChip.render()), /上次积分|积分 0/)
console.log('✓ first-time credit failures show an actionable state without inventing a cached balance')

// Two daily campaigns run at once; the row has to show both, not one word.
const dual = harness()
const dualPool = [
  { id: 'both', label: 'Both', active: true, health: { state: 'available' }, checkin: {
    available: true, claimable: true, claimedToday: false, amount: 1100, title: '每日签到领100积分',
    campaigns: [
      { key: '34', campaignId: 34, label: '每日签到领100积分', claimable: true, claimedToday: false, amount: 100, reason: null },
      { key: '40', campaignId: 40, label: 'Skill创新赛每日签到礼', claimable: true, claimedToday: false, amount: 1000, reason: null },
    ],
    // Campaigns this account cannot claim, so the tooltip can explain them.
    unavailable: [
      { campaignId: 39, label: '2026年学生专属福利', status: null, triggerMode: 'MANUAL_CLAIM', reason: 'condition' },
      { campaignId: 4, label: '新用户注册送 4000 积分', status: 'CLAIMED', triggerMode: 'AUTO_GRANT', reason: 'auto' },
    ],
  } },
  { id: 'half', label: 'Half', active: false, health: { state: 'available' }, checkin: {
    available: true, claimable: true, claimedToday: false, amount: 1000, title: '每日签到领100积分',
    campaigns: [
      { key: 'credits', label: '每日签到领100积分', claimable: false, claimedToday: true, amount: 100, reason: null },
      { key: 'skill', label: 'Skill创新赛每日签到礼', claimable: true, claimedToday: false, amount: 1000, reason: null },
    ],
  } },
  { id: 'done', label: 'Done', active: false, health: { state: 'available' }, checkin: {
    available: true, claimable: false, claimedToday: true, amount: 0, title: '每日签到领100积分',
    campaigns: [
      { key: 'credits', label: '每日签到领100积分', claimable: false, claimedToday: true, amount: 100, reason: null },
      { key: 'skill', label: 'Skill创新赛每日签到礼', claimable: false, claimedToday: true, amount: 1000, reason: null },
    ],
  } },
]
await flushSettings(dual, { ...fixtures, '/accounts': { ok: true, activeId: 'both', accounts: dualPool } })
const dualRow = (id) => dual.one((node) => node.type === 'div' && node.props.key === id && node.props.className?.startsWith('dca-pool-row'))
const checkinBadge = (id) => dual.one((node) => node.props.className?.includes('dca-checkin-badge'), dualRow(id))
// Nothing signed yet: the count states what is left, not a bare "due".
assert.match(dual.text(dualRow('both')), /已签 0\/2/)
assert.match(checkinBadge('both').props.className, /dca-checkin-pending/)
// One of two signed: still pending, and the count reflects the progress.
assert.match(dual.text(dualRow('half')), /已签 1\/2/)
assert.match(checkinBadge('half').props.className, /dca-checkin-progress/)
// Both signed collapses back to the single word the row used before.
assert.match(dual.text(dualRow('done')), /今日已签/)
assert.match(checkinBadge('done').props.className, /dca-checkin-done/)
assert.equal(dual.text(checkinBadge('done')).startsWith('✓'), true, 'completed check-in has a visible check mark')
assert.doesNotMatch(dual.text(dualRow('done')), /2\/2/)
// The campaign names are reachable as the cell tooltip, not just a bare count.
const dualCell = dual.findAll((node) => node.props.className === 'dca-pool-probe-main')
assert.ok(dualCell.length > 0, 'the check-in cell renders')
assert.ok(
  dualCell.some((node) => typeof node.props.title === 'string' && node.props.title.includes('Skill创新赛每日签到礼')),
  'each campaign is named in the cell tooltip',
)
// Campaigns the account cannot claim are explained rather than hidden.
const explained = dual.findAll((node) => typeof node.props.title === 'string' && node.props.title.includes('2026年学生专属福利'))
assert.ok(explained.length > 0, 'an ineligible campaign is named in the tooltip')
assert.match(explained[0].props.title, /需先满足条件/)
const autoLine = dual.findAll((node) => typeof node.props.title === 'string' && node.props.title.includes('新用户注册'))
assert.ok(autoLine.length > 0, 'an auto-granted campaign is named too')
assert.match(autoLine[0].props.title, /系统自动发放/)
console.log('✓ the check-in cell reports per-campaign progress and explains ineligible ones')


// ── a claimed bonus must not leave the composer showing the old balance ─────
//
// Two separate slots: the check-in button on the settings page, the reading beside
// the composer, each with its own polling. Claiming moves the balance upstream, so
// without a notification the reading keeps the pre-claim figure until its
// five-minute poll — and the moment a user claims is exactly when they look.
//
// Asserted through the exported notification pair rather than by mounting both
// slots: this harness re-runs every effect on each render (a real host does not),
// so a subscription made by one component cannot survive another's render. That
// would test the harness. The pair is what both components actually use, so its
// semantics are the thing worth pinning down.
const notifier = harness().exposed.module.__credits

let reads = 0
const stopReading = notifier.onCreditsChanged(() => { reads += 1 })
notifier.creditsChanged()
assert.equal(reads, 1, 'a notification reaches a subscriber')
notifier.creditsChanged()
assert.equal(reads, 2, 'and every later notification reaches it too')
stopReading()
notifier.creditsChanged()
assert.equal(reads, 2, 'an unsubscribed reader is not called again')

// Slots mount in either order, so a change can land before a reader subscribes.
// Dropping it would leave the reading stale until the poll — the same bug with a
// rarer trigger, which is why the module remembers it.
notifier.creditsChanged()
let lateReads = 0
notifier.onCreditsChanged(() => { lateReads += 1 })
assert.equal(lateReads, 1, 'a late subscriber reads once for the change it missed')
notifier.creditsChanged()
assert.equal(lateReads, 2, 'then keeps receiving notifications')

// One broken reader must not stop the others, nor make the claim look failed.
let survivorReads = 0
notifier.onCreditsChanged(() => { throw new Error('subscriber exploded') })
notifier.onCreditsChanged(() => { survivorReads += 1 })
const beforeThrow = survivorReads
notifier.creditsChanged()
assert.equal(survivorReads, beforeThrow + 1, 'a throwing subscriber does not block the rest')

// A successful claim is what announces; a claim that claimed nothing is silent,
// because re-reading would flash a load on every click for a change that did not
// happen. Driven through the real settings component and its real button; POST
// routes answer from postResponses, so the reply is registered up front.
async function claimAnnounces(claimedCount) {
  const instance = harness()
  const at = instance.controls.now
  instance.postResponses.set('/checkin/claim-all', {
    ok: true, summary: { claimed: claimedCount, failures: [], today: { claimed: claimedCount, total: 1 } },
  })
  await flushSettings(instance, { ...fixtures,
    '/accounts': { ok: true, accounts: [
      { id: 'primary', creditIdentity: 'primary-key', active: true, label: 'Primary', credit: { remain: 100 }, creditCheckedAt: at, checkin: { available: true, claimable: true, claimedToday: 0, campaigns: [] } },
    ] },
  })
  const button = instance.one((node) => typeof node.props.className === 'string' && node.props.className.includes('dca-btn') && /一键签到|签到/.test(instance.text(node)) && typeof node.props.onClick === 'function')

  // Subscribe immediately before the click and do not render in between: this
  // harness re-runs every effect on each render, so a render would drop the
  // subscription before the claim gets to announce.
  let reads = 0
  instance.exposed.module.__credits.onCreditsChanged(() => { reads += 1 })
  void button.props.onClick()
  for (let i = 0; i < 6; i += 1) await new Promise(setImmediate)
  return reads
}

assert.equal(await claimAnnounces(1), 1, 'a claim that claimed something announces a credit change')
assert.equal(await claimAnnounces(0), 0, 'a claim that claimed nothing announces nothing')
console.log('✓ a claim announces a credit change, and a claim that claimed nothing stays quiet')

})

test('activity loads on demand, filters, retries without losing history, and confirms clearing', async () => {
  const app = harness()
  const tab = (id) => app.one((node) => node.props.role === 'tab' && node.props.id.endsWith(`-tab-${id}`))
  const panel = () => app.one((node) => node.props.role === 'tabpanel' && node.props.id.endsWith('-panel-activity'))
  const button = (label) => app.one((node) => node.type === 'button' && app.text(node) === label, panel())
  const filter = (label) => app.one((node) => node.type === 'select', app.one((node) => node.type === 'label' && app.text(node).startsWith(label), panel()))
  assert.ok(!app.pending.some((request) => request.path === '/activities'), 'the new tab does not slow initial settings reads')
  tab('activity').props.onClick(); app.render()
  assert.equal(app.pending.filter((request) => request.path === '/activities').length, 1)
  await app.fail('/activities')
  assert.match(app.text(panel()), /操作失败/)
  const retry = button('重试').props.onClick()
  const at = app.controls.now
  const records = [
    { id: 'first', at, action: 'account.add', category: 'account', status: 'success', details: { added: 1, text: 'PRIVATE_TEXT' } },
    { id: 'second', at: at - 60000, action: 'checkin.auto', category: 'checkin', status: 'warning', details: { claimed: 2, failed: 1, reason: 'network' } },
  ]
  await app.settle('/activities', { ok: true, records, limit: 200 }); await retry
  assert.equal(app.findAll((node) => node.type === 'li', panel()).length, 2)
  assert.match(app.text(panel()), /添加账号/)
  assert.match(app.text(panel()), /每天自动签到/)
  assert.match(app.text(panel()), /网络异常/)
  assert.doesNotMatch(app.text(panel()), /PRIVATE_TEXT/)
  assert.equal(app.one((node) => node.type === 'time' && node.props.dateTime === new Date(at).toISOString(), panel()).props.className, 'dca-activity-time')
  filter('活动类型').props.onChange({ target: { value: 'checkin' } }); app.render()
  assert.equal(app.findAll((node) => node.type === 'li', panel()).length, 1)
  filter('活动结果').props.onChange({ target: { value: 'error' } }); app.render()
  assert.match(app.text(panel()), /没有符合筛选条件/)
  filter('活动结果').props.onChange({ target: { value: 'warning' } }); app.render()
  tab('account').props.onClick(); app.render()
  tab('activity').props.onClick(); app.render()
  await app.fail('/activities')
  assert.equal(filter('活动类型').props.value, 'checkin', 'filters survive tab navigation')
  assert.equal(app.findAll((node) => node.type === 'li', panel()).length, 1, 'refresh failures retain the last history')
  app.controls.confirmAnswer = false
  await button('清空记录').props.onClick(); app.render()
  assert.equal(app.writes.length, 0, 'cancelling does not clear records')
  app.controls.confirmAnswer = true
  app.postResponses.set('/activities/clear', { ok: false })
  await button('清空记录').props.onClick(); app.render()
  assert.equal(app.findAll((node) => node.type === 'li', panel()).length, 1, 'a failed clear retains records')
  let finishClear: (value: unknown) => void = () => {}
  app.postResponses.set('/activities/clear', new Promise((resolve) => { finishClear = resolve }))
  const clearing = button('清空记录').props.onClick()
  app.render()
  tab('account').props.onClick(); app.render()
  tab('activity').props.onClick(); app.render()
  assert.ok(!app.pending.some((request) => request.path === '/activities'), 'navigation cannot start a stale read while clearing')
  finishClear({ ok: true })
  await clearing; app.render()
  assert.equal(latest(app.writes).path, '/activities/clear')
  assert.match(app.text(panel()), /活动记录已清空/)
  assert.match(app.text(panel()), /暂无活动记录/)
  assert.equal(button('清空记录').props.disabled, true)
})

const modelContextFixture = (context?: number, contextLimit = 131072) => ({
  ...initialModels,
  models: initialModels.models.map((model) => ({
    ...model,
    context: model.id === 'reasoner' ? context ?? contextLimit : contextLimit,
    maxOutput: 16384,
    defaults: { context: contextLimit, maxOutput: 16384 },
    overrides: model.id === 'reasoner' ? { ...model.overrides, ...(context === undefined ? {} : { context }) } : model.overrides,
  })),
})

async function modelContextHarness(context?: number, contextLimit = 131072) {
  const app = harness()
  await app.settle('/models', modelContextFixture(context, contextLimit))
  app.one((node) => node.props.role === 'tab' && node.props.id.endsWith('-tab-models')).props.onClick()
  app.render()
  const select = () => app.one((node) => node.type === 'select' && node.props['aria-label'] === '上下文长度 — Reasoner')
  const button = (label: string) => app.one((node) => node.type === 'button' && app.text(node) === label)
  const testButton = () => app.one((node) => node.type === 'button' && node.props['aria-label'] === '测试模型 — Reasoner')
  const change = (value: string) => {
    select().props.onChange({ target: { value } })
    app.render()
  }
  const save = async (context?: number) => {
    const saving = button('保存模型配置').props.onClick()
    await new Promise(setImmediate)
    await app.settle('/models', modelContextFixture(context, contextLimit))
    await saving
    app.render()
  }
  return { app, select, button, testButton, change, save }
}

test('model context choices preserve existing values, save selections, and restore the default', async () => {
  const { app, select, button, change, save } = await modelContextHarness(202752, 524288)
  assert.equal(Number(select().props.value), 202752, 'a saved non-preset context remains selectable')
  const choices = app.findAll((node) => node.type === 'option', select()).map((node) => String(node.props.value))
  for (const value of ['', '32768', '65536', '131072', '204800', '262144', '524288', '202752']) {
    assert.ok(choices.includes(value), `context choice ${value || 'default'} is available`)
  }
  change('32768')
  assert.equal(app.writes.length, 0, 'selecting a context only changes the local draft')
  assert.equal(button('保存模型配置').props.disabled, false)
  await save(32768)
  assert.deepEqual(latest(app.writes), {
    path: '/models/select',
    body: { enabledIds: null, overrides: {
      reasoner: { images: true, allowOff: false, defaultStrength: 'max', context: 32768 },
      coder: {},
    } },
  })
  assert.equal(button('保存模型配置').props.disabled, true, 'a successful reload clears the saved draft')
  const reloadedChoices = app.findAll((node) => node.type === 'option', select()).map((node) => String(node.props.value))
  assert.ok(reloadedChoices.includes('524288'), 'saving a lower context retains the upstream limit for subsequent choices')
  assert.ok(reloadedChoices.includes('262144'), 'the saved 32K context does not hide larger valid choices')

  change('')
  assert.equal(select().props.value, '')
  assert.equal(button('保存模型配置').props.disabled, false, 'returning to the default changes the saved override')
  await save()
  assert.equal(latest(app.writes).body.overrides.reasoner.context, null, 'the default choice explicitly clears the override')
  assert.equal(latest(app.writes).body.overrides.reasoner.images, true, 'changing context preserves capability choices')
  assert.equal(latest(app.writes).body.overrides.reasoner.defaultStrength, 'max')
  assert.equal(select().props.value, '')
  assert.equal(button('保存模型配置').props.disabled, true)
})

test('model tests use an unsaved context, expose progress and outcomes, and preserve the draft', async () => {
  const { app, select, button, testButton, change } = await modelContextHarness()
  change('65536')
  // A model may be tested before it is offered in the conversation picker.
  app.one((node) => node.type === 'input' && node.props['aria-label'] === 'Reasoner').props.onChange({ target: { checked: false } })
  app.render()
  assert.equal(testButton().props.disabled, false)
  let finishTest: (value: unknown) => void = () => {}
  app.postResponses.set('/models/test', new Promise((resolve) => { finishTest = resolve }))
  const testing = testButton().props.onClick()
  app.render()
  assert.match(app.text(testButton()), /测试中/)
  assert.equal(testButton().props.disabled, true, 'the in-flight test cannot be submitted twice')
  assert.deepEqual(latest(app.writes), {
    path: '/models/test',
    body: { modelId: 'reasoner', overrides: { images: true, allowOff: false, defaultStrength: 'max', context: 65536 } },
  })
  finishTest({ ok: true, elapsedMs: 124 })
  await testing
  app.render()
  assert.match(app.text(app.render()), /测试成功.*124.*ms/)
  assert.equal(Number(select().props.value), 65536)
  assert.equal(button('保存模型配置').props.disabled, false, 'testing leaves the local changes unsaved')
  assert.ok(!app.writes.some((entry) => entry.path === '/models/select'), 'testing never saves model settings')
  assert.ok(!app.pending.some((entry) => entry.path === '/models'), 'testing does not reload and replace the draft')

  app.postResponses.set('/models/test', { ok: false, elapsedMs: 60, error: 'MODEL_UNAVAILABLE' })
  await testButton().props.onClick()
  app.render()
  assert.match(app.text(app.render()), /测试失败.*MODEL_UNAVAILABLE/)
  assert.doesNotMatch(app.text(app.render()), /测试成功/)
  assert.equal(Number(select().props.value), 65536, 'a rejected test preserves the selected context')
  assert.equal(testButton().props.disabled, false, 'a failed test can be retried')
})

test('model context options respect each upstream limit and include its exact value', async () => {
  const app = harness()
  const limits = [202752, 524288, 1048576, 2097152]
  const expected = [
    ['', '32768', '65536', '131072', '202752'],
    ['', '32768', '65536', '131072', '204800', '262144', '524288'],
    ['', '32768', '65536', '131072', '204800', '262144', '524288', '1048576'],
    ['', '32768', '65536', '131072', '204800', '262144', '524288', '1048576', '2097152'],
  ]
  await app.settle('/models', { ...initialModels, models: limits.map((limit) => ({
    id: `limit-${limit}`, name: `Limit ${limit}`, strengths: [], supportsImages: false,
    context: limit, maxOutput: 16384, defaults: { context: limit, maxOutput: 16384 }, overrides: null,
  })) })
  app.one((node) => node.props.role === 'tab' && node.props.id.endsWith('-tab-models')).props.onClick()
  app.render()
  limits.forEach((limit, index) => {
    const select = app.one((node) => node.type === 'select' && node.props['aria-label'] === `上下文长度 — Limit ${limit}`)
    const choices = app.findAll((node) => node.type === 'option', select).map((node) => String(node.props.value))
    assert.deepEqual(choices, expected[index], `only supported choices are offered for the ${limit}-token model`)
  })
})

test('outdated context overrides above the upstream limit render as default and are cleared in requests', async () => {
  const { app, select, button, testButton, save } = await modelContextHarness(2097152, 131072)
  assert.equal(select().props.value, '', 'an old 2M override is unavailable for a 128K model')
  const choices = app.findAll((node) => node.type === 'option', select()).map((node) => String(node.props.value))
  assert.ok(!choices.includes('2097152'), 'an unsupported saved value cannot be reselected')
  app.postResponses.set('/models/test', { ok: true, elapsedMs: 10 })
  await testButton().props.onClick()
  app.render()
  assert.equal(latest(app.writes).body.overrides.context, null, 'testing clears the stale override instead of forwarding it')
  app.one((node) => node.type === 'input' && node.props['aria-label'] === 'Coder').props.onChange({ target: { checked: false } })
  app.render()
  assert.equal(button('保存模型配置').props.disabled, false)
  await save()
  assert.equal(latest(app.writes).path, '/models/select')
  assert.equal(latest(app.writes).body.overrides.reasoner.context, null, 'saving any model changes also clears the stale override')
  assert.equal(select().props.value, '')
})

test('row buttons switch accounts manually and automatic check-in saves after acknowledgement', async () => {
  const app = harness()
  const responses = {
    '/status': { ok: true, settings: { dailyCheckinEnabled: false } },
    '/models': initialModels,
    '/account': { ok: true, credit: { remain: 10 } },
    '/accounts': { ok: true, memberAccountIds: ['primary'], activeId: 'primary', accounts: [
      { id: 'primary', label: '主账号', active: true },
      { id: 'backup', label: '备用账号', active: false },
    ] },
  }
  const drain = async () => {
    await new Promise(setImmediate)
    for (let turns = 0; app.pending.length && turns < 20; turns += 1) {
      const path = app.pending[0].path
      assert.ok(path in responses, `Unexpected account-pool request ${path}`)
      await app.settle(path, responses[path])
    }
    assert.equal(app.pending.length, 0)
    app.render()
  }
  const row = (id: string) => app.one((node) => node.props.key === id && node.props.className?.startsWith('dca-pool-row'))
  const activate = (id: string) => app.one((node) => node.type === 'button' && app.text(node) === '切换', row(id))
  const panel = () => app.one((node) => node.props.role === 'tabpanel' && node.props.id.endsWith('-panel-account'))
  await drain()
  assert.equal(app.findAll((node) => node.props.role === 'switch' && node.props['aria-label'] === '启用账号池').length, 0)
  assert.equal(app.findAll((node) => node.type === 'select', panel()).length, 0, 'the account dropdown is removed')
  assert.equal(activate('primary').props.disabled, true)
  assert.equal(activate('backup').props.disabled, false)
  for (const id of ['primary', 'backup']) {
    assert.deepEqual(app.findAll((node) => node.type === 'button', row(id)).map((node) => app.text(node)), ['修改名称', '切换', '移除'])
  }
  const pool = app.one((node) => node.props.className === 'dca-pool')
  assert.deepEqual(pool.props.children.filter(Boolean).map((node) => node.props.className), [
    'dca-pool-head', 'dca-pool-modebar', 'dca-pool-toolbar', 'dca-pool-table',
  ], 'account title, check-in settings, batch actions and rows follow the reference module order')
  const header = app.one((node) => node.props.className === 'dca-pool-head')
  assert.equal(app.findAll((node) => node.type === 'button' || node.type === 'p', header).length, 0, 'the title row contains only the title')
  const modebar = app.one((node) => node.props.className === 'dca-pool-modebar')
  assert.deepEqual(app.findAll((node) => node.props.role === 'switch', modebar).map((node) => node.props['aria-label']), ['每天自动签到'])
  const batch = app.one((node) => node.props.className === 'dca-pool-toolbar')
  assert.deepEqual(app.findAll((node) => node.type === 'button', batch).map((node) => app.text(node)), ['检查全部账号', '一键签到', '测试连接'])
  const primaryRow = app.one((node) => node.props.key === 'primary' && node.props.className?.startsWith('dca-pool-row'))
  assert.deepEqual(primaryRow.props.children.filter(Boolean).map((node) => node.props.className), [
    'dca-pool-col-account', 'dca-pool-probe', 'dca-pool-credits-row', 'dca-pool-probe-cell', 'dca-pool-col-actions',
  ], 'health is its own grid cell beside check-in and actions')
  assert.equal(app.findAll((node) => node.props.className === 'dca-pool-col-account' && app.text(node).includes('最近检查')).length, 0)
  assert.match(app.text(primaryRow), /积分—未读取/)
  assert.match(app.one((node) => node.props.className?.includes('dca-checkin-badge'), primaryRow).props.className, /dca-checkin-unknown/)
  const tools = app.one((node) => node.props.className === 'dca-account-tools-bar')
  assert.deepEqual(app.findAll((node) => node.type === 'button', tools).map((node) => app.text(node)), ['添加账号', '导入', '导出'])
  const addForm = () => app.one((node) => node.props.id === 'dca-add-account')
  assert.equal(addForm().props.open, false)
  const file = app.one((node) => node.type === 'input' && node.props.type === 'file')
  let pickerOpened = 0
  file.props.ref.current = { click: () => { pickerOpened += 1 } }
  app.one((node) => node.type === 'button' && app.text(node) === '导入', tools).props.onClick()
  assert.equal(pickerOpened, 1, 'file import is available while manual credentials stay collapsed')
  assert.equal(addForm().props.open, false)
  app.one((node) => node.type === 'button' && app.text(node) === '添加账号', tools).props.onClick()
  app.render()
  assert.equal(addForm().props.open, true, 'the bottom add action controls the existing credential form')

  let acknowledge: (body: unknown) => void = () => {}
  app.postResponses.set('/accounts/activate', { ok: false, error: '切换被拒绝' })
  activate('backup').props.onClick()
  await drain()
  assert.deepEqual(app.writes.at(-1), { path: '/accounts/activate', body: { id: 'backup' } })
  assert.match(row('primary').props.className, /dca-pool-row-current/, 'failed activation preserves the current account')
  assert.equal(activate('backup').props.disabled, false)
  assert.match(app.text(panel()), /切换到「备用账号」失败：切换被拒绝/)

  app.postResponses.set('/accounts/activate', { ok: true })
  responses['/accounts'] = { ...responses['/accounts'], activeId: 'backup', accounts: responses['/accounts'].accounts.map((account) => ({ ...account, active: account.id === 'backup' })) }
  activate('backup').props.onClick()
  app.render()
  assert.equal(activate('backup').props.disabled, true)
  assert.equal(activate('backup').props['aria-busy'], true)
  assert.match(app.text(row('backup')), /正在切换/)
  await drain()
  assert.match(row('backup').props.className, /dca-pool-row-current/)
  assert.equal(activate('backup').props.disabled, true)
  assert.equal(activate('primary').props.disabled, false)
  assert.match(app.text(panel()), /已切换到「备用账号」/)

  const daily = () => app.one((node) => node.props.role === 'switch' && node.props['aria-label'] === '每天自动签到')
  const previousWrites = app.writes.length
  app.postResponses.set('/preferences/save', () => new Promise((resolve) => { acknowledge = resolve }))
  const scheduling = daily().props.onClick()
  app.render()
  assert.equal(daily().props['aria-checked'], false, 'daily scheduling also waits for saved acknowledgement')
  assert.equal(daily().props['aria-busy'], true)
  assert.equal(daily().props.disabled, true)
  assert.equal(activate('primary').props.disabled, true, 'manual account switches cannot race a preference save')
  await daily().props.onClick()
  assert.equal(app.writes.length, previousWrites + 1)
  assert.deepEqual(app.writes.at(-1), { path: '/preferences/save', body: { dailyCheckinEnabled: true } })
  responses['/status'] = { ok: true, settings: { dailyCheckinEnabled: true } }
  acknowledge({ ok: true, preferences: { dailyCheckinEnabled: true } })
  await drain()
  await scheduling
  app.render()
  assert.equal(daily().props['aria-checked'], true)
  app.postResponses.set('/preferences/save', { ok: false, error: '签到设置保存被拒绝' })
  await daily().props.onClick()
  app.render()
  assert.equal(daily().props['aria-checked'], true, 'a failed daily-check-in preference keeps the saved schedule')
  assert.match(app.text(panel()), /保存自动签到设置失败：签到设置保存被拒绝/)
})

test('batch account actions include every account without membership controls', async () => {
  const app = harness()
  const responses: Record<string, any> = {
    '/status': { ok: true, settings: { accountPoolEnabled: true, accountPoolMemberIds: [], dailyCheckinEnabled: false } },
    '/models': initialModels,
    '/account': { ok: true, credit: { remain: 10 } },
    '/accounts': { ok: true, activeId: 'primary', memberAccountIds: [], accounts: [
      { id: 'primary', label: '主账号', active: true, checkin: { claimable: false } },
      { id: 'backup', label: '备用账号', active: false, checkin: { claimable: true } },
      { id: 'third', label: '第三账号', active: false, checkin: { claimable: true } },
    ] },
  }
  const drain = async () => {
    await new Promise(setImmediate)
    for (let turns = 0; app.pending.length && turns < 30; turns += 1) {
      const path = app.pending[0].path
      assert.ok(path in responses, `Unexpected batch-account request ${path}`)
      await app.settle(path, responses[path])
    }
    assert.equal(app.pending.length, 0)
    app.render()
  }
  const panel = () => app.one((node) => node.props.role === 'tabpanel' && node.props.id.endsWith('-panel-account'))
  const button = (name: string) => app.one((node) => node.type === 'button' && app.text(node) === name, panel())
  const currentRow = () => app.one((node) => node.props.key === 'primary' && node.props.className?.startsWith('dca-pool-row'))
  const save = async (operation: () => unknown) => {
    const result = operation()
    await drain()
    await result
    app.render()
  }
  await drain()
  assert.equal(app.findAll((node) => node.type === 'input' && node.props.type === 'checkbox', panel()).length, 0)
  assert.doesNotMatch(app.text(panel()), /本池包含的账号|全选|全不选|勾选加入账号池/)
  assert.equal(button('检查全部账号').props.disabled, false)
  assert.equal(button('一键签到').props.disabled, false, 'any eligible account enables claims, regardless of retired membership settings')
  assert.equal(button('测试连接').props.disabled, false)
  assert.equal(app.writes.length, 0, 'opening the page never writes membership settings')
  assert.equal(app.findAll((node) => node.type === 'button' && app.text(node) === '切换', panel()).length, 3, 'retired automatic-selection settings do not hide manual switch buttons')

  app.postResponses.set('/accounts/check-all', { ok: true, accounts: responses['/accounts'].accounts.map((account) => ({ ...account, health: { state: 'available' } })) })
  await save(() => button('检查全部账号').props.onClick())
  assert.deepEqual(app.writes.at(-1), { path: '/accounts/check-all', body: {} })
  assert.match(app.text(panel()), /检查完成：3 个账号，3 个可用/)
  app.postResponses.set('/checkin/claim-all', { ok: true, summary: { claimed: 2, failures: [] } })
  await save(() => button('一键签到').props.onClick())
  assert.deepEqual(app.writes.at(-1), { path: '/checkin/claim-all', body: {} })
  assert.match(currentRow().props.className, /dca-pool-row-current/, 'batch check-in preserves the manual account choice')

  responses['/accounts'].accounts = responses['/accounts'].accounts.map((account) => ({ ...account, checkin: { claimable: false } }))
  app.intervals[0]()
  await drain()
  assert.equal(button('一键签到').props.disabled, true)
  responses['/accounts'].accounts.push({ id: 'imported', label: '新导入账号', active: false, checkin: { claimable: true } })
  app.intervals[0]()
  await drain()
  assert.equal(button('一键签到').props.disabled, false, 'new accounts take part in batch actions immediately')
  assert.equal(app.findAll((node) => node.type === 'button' && app.text(node) === '切换', panel()).length, 4, 'new accounts get their own manual switch button')
})
