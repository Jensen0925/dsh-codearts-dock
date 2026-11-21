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

function harness(surface = 'settings', rootProps = {}) {
  const postResponses = new Map()
  const confirmations = []
  const controls = { confirmAnswer: true, now: Date.now() }
  let active
  let cursor = 0
  let SettingsPage
  let ComposerChip
  let currentTree
  const instances = new Map()
  const effects = []
  const intervals = []
  const pending = []
  const writes = []
  const copied = []
  const downloads = []
  const blobs = new Map()
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
    Date: class extends Date { static now() { return controls.now } },
    Blob,
    URL: {
      createObjectURL: (blob) => { const url = `blob:offline-${blobs.size}`; blobs.set(url, blob); return url },
      revokeObjectURL: (url) => blobs.delete(url),
    },
    document: {
      documentElement: { lang: 'zh-CN' }, body: { appendChild() {} },
      addEventListener() {}, removeEventListener() {},
      createElement: (tag) => {
        assert.equal(tag, 'a')
        return { click() { downloads.push({ name: this.download, blob: blobs.get(this.href) }) }, remove() {} }
      },
    },
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
    window: { setTimeout: (fn) => fn(), confirm: (text) => { confirmations.push(text); return controls.confirmAnswer }, __ModuleLoader__: { load: (definition) => {
      const module = definition.factory(() => React)
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
  return { render, findAll, one, text, settle, pending, writes, intervals, copied, postResponses, confirmations, controls, downloads }
}

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
assert.equal(features.writes.at(-1).path, '/presets')
assert.equal(features.writes.at(-1).body.modelOverrides.reasoner.allowOff, false)
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
const exportedEnvelope = { format: 'dsh-connect-codearts-encrypted', version: 1, data: 'fake-test-ciphertext' }
features.postResponses.set('/backup/export', { ok: true, backup: exportedEnvelope })
await act(() => backupForm().props.onSubmit({ preventDefault() {} }))
assert.equal(features.writes.at(-1).body.includeCredentials, true)
assert.equal(features.writes.at(-1).body.password, 'password-123')
assert.equal(features.downloads.length, 1)
assert.match(features.downloads[0].name, /^codearts-backup-\d{4}-\d{2}-\d{2}\.json$/)
assert.deepEqual(JSON.parse(await features.downloads[0].blob.text()), exportedEnvelope)
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
assert.equal(features.writes.at(-1).path, '/backup/preview')
assert.ok(!features.writes.some((entry) => entry.path === '/backup/restore'))
labelled('解密密码').props.onChange({ target: { value: 'new-password' } }); features.render()
assert.equal(features.findAll((node) => node.type === 'button' && features.text(node) === '确认恢复').length, 0)
await act(() => fb('读取并预览').props.onClick())
features.postResponses.set('/backup/restore', { ok: true, added: 1, updated: 0 })
await act(() => fb('确认恢复').props.onClick())
assert.equal(features.writes.at(-1).path, '/backup/restore')
assert.equal(features.writes.at(-1).body.text, backupText)
assert.equal(features.writes.at(-1).body.password, 'new-password')
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
const plainBackup = '{"format":"dsh-connect-codearts-backup","version":1,"preferences":{}}'
labelled('备份内容（也可粘贴 JSON）', 'textarea').props.onChange({ target: { value: plainBackup } }); features.render()
assert.equal(features.findAll((node) => node.type === 'input' && node.props.autoComplete === 'off' && node.props.type === 'password', backupRoot()).length, 0)
features.postResponses.set('/backup/preview', { ok: true, changes: [], preferences: {}, accounts: { added: 0, updated: 0 } })
await act(() => fb('读取并预览').props.onClick())
assert.equal(features.writes.at(-1).body.password, '')
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
await chip.settle('/account', { ok: true, credit: { remain: 13.25 } })
await chip.settle('/accounts', { ok: true, accounts: chipPool.accounts.map((account) => ({ ...account, active: account.id === 'backup' })) })
assert.equal(chip.text(chipRow('Backup')), 'Backup当前选用')
chip.one((node) => node.props.className === 'dca-pop-settings').props.onClick()
chip.render()
assert.equal(openedSettings, 1)
assert.equal(chip.findAll((node) => node.props.role === 'dialog').length, 0)
const otherProvider = harness('composer', { useProjection: () => ({ next: { provider: 'another' } }) })
assert.equal(otherProvider.render(), null)
assert.equal(otherProvider.pending.length, 0)
console.log('✓ composer shows concise health states, keeps raw errors out of row text, and supports account switching')

console.log('\nui: all checks passed')
