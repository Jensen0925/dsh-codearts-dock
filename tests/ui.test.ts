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
  '/accounts': { ok: true, activeId: 'account-1', accounts: [{ id: 'account-1', label: 'Example', ak: 'TEST…MASK', isActive: true, health: { state: 'credentials', checkedAt: features.controls.now - 300000 }, error: 'RAW_GATEWAY_ERROR_FOR_DETAILS', credit: null, checkin: null }] },
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

assert.equal(features.findAll((node) => node.props.role === 'tab').length, 3)
assert.doesNotMatch(features.text(fp('account')), /余额提醒|自动签到/)
assert.ok(!features.pending.some((request) => ['/usage', '/preferences'].includes(request.path)))
console.log('✓ settings retain three tabs and never request retired alert or history data')
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
features.postResponses.set('/accounts/check', { ok: true, account: { label: 'Example', health: { state: 'available' } } })
await act(() => fb('重新检查').props.onClick())
assert.ok(features.writes.some((entry) => entry.path === '/accounts/check' && entry.body.id === 'account-1'))
console.log('✓ unhealthy accounts expose credential repair and account-specific rechecks')
assert.ok(!features.writes.some((entry) => entry.path.startsWith('/checkin')), 'loading and rechecking accounts never claims benefits')
features.postResponses.set('/checkin/claim-all', { ok: true, summary: { claimed: 1, failures: [] } })
await act(() => fb('一键签到').props.onClick())
const manualClaims = features.writes.filter((entry) => entry.path.startsWith('/checkin'))
assert.equal(manualClaims.length, 1)
assert.deepEqual(manualClaims[0], { path: '/checkin/claim-all', body: {} })
console.log('✓ check-in only runs on an explicit click and never sends automation preferences')


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
const presetSelect = () => features.one((node) => node.type === 'select' && node.props['aria-label'] === '模型配置预设')
presetSelect().props.onChange({ target: { value: 'builtin:daily' } }); features.render()
const writesBeforePreview = features.writes.length
const previewList = features.one((node) => node.type === 'ul' && node.props.className === 'dca-preset-preview')
assert.match(features.text(previewList), /Free/)
assert.doesNotMatch(features.text(previewList), /Expensive/)
assert.equal(features.writes.length, writesBeforePreview)
fb('应用到草稿').props.onClick(); features.render()
assert.equal(features.writes.length, writesBeforePreview)
assert.equal(features.one((node) => node.type === 'input' && node.props['aria-label'] === 'Expensive').props.checked, false)
assert.match(features.text(fp('models')), /未保存/)
fb('保存为预设').props.onClick(); features.render()
const presetName = features.one((node) => node.type === 'input' && node.props.maxLength === 48)
presetName.props.onChange({ target: { value: 'My draft' } }); features.render()
features.postResponses.set('/presets', (body) => ({ ok: true, presets: [{ ...body, id: 'custom-1' }] }))
await act(() => features.one((node) => node.type === 'form' && features.findAll((child) => child.type === 'input' && child.props.maxLength === 48, node).length === 1).props.onSubmit({ preventDefault() {} }))
assert.equal(latest(features.writes).path, '/presets')
assert.equal(latest(features.writes).body.modelOverrides.reasoner.allowOff, false)
assert.ok(!features.writes.slice(writesBeforePreview).some((entry) => entry.path === '/models/select'))
console.log('✓ capability filters and presets preserve drafts, include zero-cost models, and never auto-save the live selection')

ft('account').props.onClick(); features.render()
const backupRoot = () => features.one((node) => node.type === 'details' && node.props.className === 'dca-card dca-details' && features.findAll((child) => child.type === 'summary' && features.text(child) === '配置备份与迁移', node).length === 1)
assert.equal(features.findAll((node) => node.type === 'input' && node.props.type === 'password' && node.props.autoComplete === 'new-password').length, 0)
assert.equal(features.findAll((node) => node.type === 'textarea' && node.props.rows === 4).length, 0, 'restore controls are absent in export mode')
assert.equal(fb('下载备份').props.disabled, false, 'config-only export needs no password by default')
labelled('加密备份').props.onChange({ target: { checked: true } }); features.render()
assert.equal(fb('下载备份').props.disabled, true)
labelled('加密密码').props.onChange({ target: { value: 'password-123' } })
labelled('确认加密密码').props.onChange({ target: { value: 'different' } }); features.render()
assert.equal(fb('下载备份').props.disabled, true)
labelled('确认加密密码').props.onChange({ target: { value: 'password-123' } }); features.render()
labelled('加密备份').props.onChange({ target: { checked: false } }); features.render()
assert.equal(features.findAll((node) => node.type === 'input' && node.props.autoComplete === 'new-password').length, 0)
labelled('包含账号凭证（AK/SK）').props.onChange({ target: { checked: true } }); features.render()
assert.equal(fb('下载备份').props.disabled, true)
assert.equal(labelled('加密密码').props.value, '', 'turning off encryption clears its password')
labelled('加密密码').props.onChange({ target: { value: 'password-123' } })
labelled('确认加密密码').props.onChange({ target: { value: 'password-123' } }); features.render()
assert.equal(fb('下载备份').props.disabled, false)
const backupForm = () => features.one((node) => node.type === 'form' && features.findAll((child) => child.type === 'button' && features.text(child) === '下载备份', node).length === 1)
const exportedEnvelope = { format: 'dsh-codearts-dock-encrypted', version: 1, data: 'fake-test-ciphertext' }
features.postResponses.set('/backup/export', { ok: true, backup: exportedEnvelope })
await act(() => backupForm().props.onSubmit({ preventDefault() {} }))
assert.equal(latest(features.writes).body.includeCredentials, true)
assert.equal(latest(features.writes).body.password, 'password-123')
assert.equal(features.downloads.length, 1)
const download = latest(features.downloads)
assert.match(download.name, /^codearts-backup-\d{4}-\d{2}-\d{2}\.json$/)
assert.ok(download.blob, 'the download references the generated backup')
assert.deepEqual(JSON.parse(await download.blob.text()), exportedEnvelope)
assert.equal(labelled('加密密码').props.value, '')
assert.equal(labelled('确认加密密码').props.value, '')
fb('恢复配置').props.onClick(); features.render()
assert.equal(features.findAll((node) => node.type === 'button' && features.text(node) === '下载备份').length, 0)
assert.equal(features.findAll((node) => node.type === 'input' && node.props.autoComplete === 'off' && node.props.type === 'password', backupRoot()).length, 0)
const advancedPaste = features.one((node) => node.type === 'details' && features.findAll((child) => child.type === 'summary' && features.text(child) === '粘贴 JSON（高级）', node).length === 1 && features.findAll((child) => child.type === 'textarea', node).length === 1 && node.props.className === 'dca-details')
assert.notEqual(advancedPaste.props.open, true)
const backupText = JSON.stringify(exportedEnvelope)
const inputFile = () => features.one((node) => node.type === 'input' && node.props.type === 'file' && node.props.accept === '.json,application/json')
await act(() => inputFile().props.onChange({ target: { value: 'file.json', files: [{ name: 'my-backup.json', size: backupText.length, text: async () => backupText }] } }))
assert.match(features.text(fp('account')), /已选择：my-backup.json/)
assert.equal(fb('读取并预览').props.disabled, true, 'encrypted files require a password')
labelled('解密密码').props.onChange({ target: { value: 'password-123' } }); features.render()
features.postResponses.set('/backup/preview', { ok: true, changes: ['composerChip'], preferences: { composerChip: false }, accounts: { added: 1, updated: 0 } })
await act(() => fb('读取并预览').props.onClick())
assert.equal(latest(features.writes).path, '/backup/preview')
assert.ok(!features.writes.some((entry) => entry.path === '/backup/restore'))
labelled('解密密码').props.onChange({ target: { value: 'new-password' } }); features.render()
assert.equal(features.findAll((node) => node.type === 'button' && features.text(node) === '确认恢复').length, 0)
await act(() => fb('读取并预览').props.onClick())
features.postResponses.set('/backup/restore', { ok: true, added: 1, updated: 0 })
await act(() => fb('确认恢复').props.onClick())
assert.equal(latest(features.writes).path, '/backup/restore')
assert.equal(latest(features.writes).body.text, backupText)
assert.equal(latest(features.writes).body.password, 'new-password')
assert.equal(labelled('备份内容（也可粘贴 JSON）', 'textarea').props.value, '')
assert.equal(features.findAll((node) => node.type === 'input' && node.props.autoComplete === 'off' && node.props.type === 'password', backupRoot()).length, 0)
console.log('✓ backup modes reveal only relevant forms; encryption, file selection, restore preview and input clearing work')

// Failed reads preserve input; selecting an invalid replacement never leaves a stale backup ready to restore.
labelled('备份内容（也可粘贴 JSON）', 'textarea').props.onChange({ target: { value: backupText } }); features.render()
labelled('解密密码').props.onChange({ target: { value: 'wrong-password' } }); features.render()
features.postResponses.set('/backup/preview', { ok: false, error: '密码错误，或备份文件已损坏' })
const restoreCount = features.writes.filter((entry) => entry.path === '/backup/restore').length
await act(() => fb('读取并预览').props.onClick())
assert.match(features.text(fp('account')), /密码错误/)
assert.equal(labelled('备份内容（也可粘贴 JSON）', 'textarea').props.value, backupText)
assert.equal(labelled('解密密码').props.value, 'wrong-password')
assert.equal(features.findAll((node) => node.type === 'button' && features.text(node) === '确认恢复').length, 0)
assert.equal(features.writes.filter((entry) => entry.path === '/backup/restore').length, restoreCount)
await act(() => inputFile().props.onChange({ target: { value: 'too-big.json', files: [{ name: 'too-big.json', size: 800000 }] } }))
assert.match(features.text(fp('account')), /备份文件过大/)
assert.equal(labelled('备份内容（也可粘贴 JSON）', 'textarea').props.value, '')
assert.equal(fb('读取并预览').props.disabled, true)
const plainBackup = '{"format":"dsh-codearts-dock-backup","version":1,"preferences":{}}'
labelled('备份内容（也可粘贴 JSON）', 'textarea').props.onChange({ target: { value: plainBackup } }); features.render()
assert.equal(features.findAll((node) => node.type === 'input' && node.props.autoComplete === 'off' && node.props.type === 'password', backupRoot()).length, 0)
features.postResponses.set('/backup/preview', { ok: true, changes: [], preferences: {}, accounts: { added: 0, updated: 0 } })
await act(() => fb('读取并预览').props.onClick())
assert.equal(latest(features.writes).body.password, '')
fb('导出配置').props.onClick(); features.render()
fb('恢复配置').props.onClick(); features.render()
assert.equal(features.findAll((node) => node.type === 'button' && features.text(node) === '确认恢复').length, 0, 'changing modes invalidates the preview')
console.log('✓ malformed replacements cannot restore stale contents; plain backups skip password inputs; mode changes invalidate previews')

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
const accountButton = (id, label) => {
  const matches = switching.findAll((node) => node.type === 'button' && switching.text(node) === label, accountRow(id))
  assert.equal(matches.length, 1)
  return matches[0]
}
let finishSwitch
switching.postResponses.set('/accounts/activate', () => new Promise((resolve) => { finishSwitch = resolve }))
const pendingSwitch = accountButton('work', '切换').props.onClick()
switching.render()
assert.equal(accountButton('work', '正在切换…').props.disabled, true)
assert.equal(accountButton('work', '正在切换…').props['aria-busy'], true)
assert.equal(accountButton('work', '重新检查').props.disabled, true)
assert.equal(accountButton('personal', '重新检查').props.disabled, true)
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
assert.equal(accountButton('personal', '切换').props.disabled, false)
switching.postResponses.set('/accounts/activate', { ok: false, error: 'Switch refused' })
await accountButton('personal', '切换').props.onClick(); switching.render()
assert.match(switching.text(accountRow('personal')), /切换到「个人」失败：Switch refused/)
assert.equal(switching.findAll((node) => node.props.role === 'alert', accountRow('personal')).length, 1)
assert.equal(accountButton('personal', '切换').props.disabled, false)
assert.match(accountRow('work').props.className, /dca-pool-row-current/)
assert.doesNotMatch(switching.text(accountRow('work')), /Switch refused|已切换到/)
switching.postResponses.set('/accounts/activate', () => { throw new Error('Offline switch') })
await accountButton('personal', '切换').props.onClick(); switching.render()
assert.match(switching.text(accountRow('personal')), /切换到「个人」失败：Offline switch/)
assert.equal(accountButton('personal', '切换').props.disabled, false)
console.log('✓ account switches show progress and outcomes on the target row, preserve current state on failure, and allow retry')

// Rename is available from the row menu on touch surfaces. Enter saves once;
// Escape discards, including the blur that follows either key press.
const renames = harness()
await flushSettings(renames, fixtures)
renames.one((node) => node.props.role === 'tab' && node.props.id.endsWith('-tab-account')).props.onClick()
renames.render()
const renameRow = () => renames.one((node) => node.type === 'div' && node.props.key === 'account-1' && node.props.className?.startsWith('dca-pool-row'))
const renameMenuButton = () => renames.one((node) => node.type === 'button' && renames.text(node) === '账号备注', renameRow())
const renameEvent = (details) => ({ currentTarget: { closest: () => details } })
const renameMenu = { open: true }
renameMenuButton().props.onClick(renameEvent(renameMenu)); renames.render()
let renameInput = renames.one((node) => node.type === 'input' && node.props['aria-label'] === '账号备注', renameRow())
renameInput.props.onChange({ target: { value: '工作账号' } }); renames.render()
renameInput = renames.one((node) => node.type === 'input' && node.props['aria-label'] === '账号备注', renameRow())
let preventedEnter = false
renameInput.props.onKeyDown({ key: 'Enter', preventDefault: () => { preventedEnter = true } })
renameInput.props.onBlur()
assert.equal(preventedEnter, true)
assert.equal(renames.writes.filter((entry) => entry.path === '/accounts/rename').length, 1, 'Enter plus blur submits once')
const renameMenu2 = { open: true }
renameMenuButton().props.onClick(renameEvent(renameMenu2)); renames.render()
renameInput = renames.one((node) => node.type === 'input' && node.props['aria-label'] === '账号备注', renameRow())
renameInput.props.onChange({ target: { value: '误输入的名称' } }); renames.render()
renameInput = renames.one((node) => node.type === 'input' && node.props['aria-label'] === '账号备注', renameRow())
renameInput.props.onKeyDown({ key: 'Escape' })
renameInput.props.onBlur()
renames.render()
assert.equal(renames.writes.filter((entry) => entry.path === '/accounts/rename').length, 1, 'Escape plus blur discards without writing')
assert.equal(renames.one((node) => node.type === 'button' && renames.text(node).includes('Example'), renameRow()).type, 'button')
console.log('✓ account rename is discoverable and Enter/Escape are safe across the follow-up blur')

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
assert.equal(balances.text(balanceCell('Primary')), '0')
balanceResponses['/accounts'] = { ok: true, accounts: [{ id: 'primary', creditIdentity: 'replaced-key', label: 'Primary', credit: null }] }
balances.intervals[0]()
await flushSettings(balances, balanceResponses)
assert.equal(balances.text(balanceCell('Primary')), '—', 'new credentials must not inherit an old credential snapshot')
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
// Nothing signed yet: the count states what is left, not a bare "due".
assert.match(dual.text(dualRow('both')), /已签 0\/2/)
// One of two signed: still pending, and the count reflects the progress.
assert.match(dual.text(dualRow('half')), /已签 1\/2/)
// Both signed collapses back to the single word the row used before.
assert.match(dual.text(dualRow('done')), /今日已签/)
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
