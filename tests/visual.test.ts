/**
 * Visual-contract checks against the reference connector card.
 *
 * The two plugins are both connector cards in the same settings panel, so a
 * user sees them side by side and expects the same visual language. This test
 * pins the VALUES, not just the class names: an earlier audit passed because it
 * matched `.dca-btn` existing while the rule underneath had drifted back to the
 * old padding. Every assertion here is a number or a token taken from the
 * reference's stylesheet.
 *
 * It reads the shipped browser half as text, so it runs without a DOM.
 */

import assert from 'node:assert/strict'
import { test } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'

const check = (name: string, fn: () => void | Promise<void>) => test(name, fn)

const readSource = (rel) => {
  const ts = rel.replace(/\.js$/, '.ts')
  const url = existsSync(new URL(ts, import.meta.url))
    ? new URL(ts, import.meta.url)
    : new URL(rel, import.meta.url)
  return readFileSync(url, 'utf8')
}

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** Assert one exact declaration substring appears in the stylesheet. */
const has = (needle, why) => {
  assert.ok(source.includes(needle), `${why}\n    missing: ${needle}`)
}

check('buttons use the reference geometry and its inverted primary', () => {
  has('padding:5px 14px;border-radius:8px;min-height:32px', 'button box')
  has('background:var(--dsw-alias-label-primary,#e6e6e6)', 'primary is an inverted surface, not a brand fill')
  // Inline row actions are one step smaller, not a different shape.
  has('font-size:12px;line-height:20px;font-weight:500;\n  padding:3px 10px', 'small button')
})

check('inputs are monospace 12/20 on bg-l1', () => {
  has('padding:4px 8px;border-radius:6px', 'input box')
  has('font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace', 'input is monospace')
  has('background:var(--dsw-alias-bg-l1,transparent)', 'input rests on bg-l1')
})

check('cards sit on bg-layer-3 with a border-l2 frame at radius 12', () => {
  has('border-radius:12px;background:var(--dsw-alias-bg-layer-3', 'card surface')
  assert.ok(!source.includes('.dca-card:hover'), 'passive cards do not imply a click action')
})

check('the section switcher is a sticky underlined tab strip, not cards', () => {
  has('padding:7px 11px;margin-bottom:-1px', 'tab geometry')
  has('border-bottom:2px solid transparent', 'tab underline is the state carrier')
  assert.ok(source.includes('position:sticky'), 'the strip must pin above scrolling content')
  assert.ok(
    !source.includes('dca-tab-cell'),
    'card-shaped tab cells are not the reference shape and must not come back',
  )
})

check('account rows match the reference two-line layout without a column header', () => {
  has('grid-template-columns:minmax(0,1fr) minmax(0,auto) 160px;', 'three reference tracks')
  has('"account account credits"\n    "probe   checkin actions"', 'identity and credits precede health, check-in and actions')
  assert.ok(!source.includes('dca-pool-row-head'), 'self-describing values replace the column header')
  has('.dca-pool-credit-label{font-size:12px', 'credits carry a readable label')
  has('padding:10px 14px', 'row rhythm')
})

check('one bulk claim button serves the account pool', () => {
  assert.ok(source.includes("'pool.checkinAll': ['一键签到'"), 'the bulk button exists')
  // The guard's intent is "no per-row CLAIM BUTTON". A read-only check-in
  // column is fine; only a button that claims for one row would break it.
  // It used to match the class name `dca-pool-col-checkin`, which the status
  // column legitimately introduced — assert on the control, not the column.
  assert.ok(
    !/dca-pool-col-checkin[\s\S]{0,200}checkinClaim/.test(source),
    'never a per-row claim control',
  )
  // Disabled when there is nothing to claim, so a press that cannot act never
  // looks like a broken button.
  assert.ok(source.includes('disabled: anyBusy || busyId !== null || !anyClaimable'), 'disabled with nothing to claim')
  assert.ok(source.includes("allSigned ? t('pool.allSigned')"), 'explains when the whole pool is already done')
})

check('import lives inside the add-account card, revealed on demand', () => {
  assert.ok(source.includes("className: 'dca-card dca-details dca-add-tools'"), 'the add form is a disclosure when accounts already exist')
  // One card component owns both, so the user never picks a method up front.
  const tools = source.slice(source.indexOf('function AccountTools('))
  const body = tools.slice(0, tools.indexOf('\n    /**', 10))
  assert.ok(body.includes("postRoute('/accounts/add'"), 'the pair form')
  assert.ok(body.includes("postRoute('/accounts/import'"), 'the bulk form, same component')
})

check('models render as cards on bg-layer-2, not nowrap table columns', () => {
  has('padding:10px 12px;background:var(--dsw-alias-bg-layer-2', 'model row surface')
  assert.ok(source.includes('.dca-model-off{background:'), 'disabled models keep readable text rather than fading the whole row')
  assert.ok(!source.includes('.dca-model-off{opacity:'), 'the whole model row is not dimmed')
  has('.dca-model-meta{', 'facts collapse onto one meta line')
  assert.ok(!source.includes('dca-table'), 'the six-column table is gone')
})

check('hints and row metadata use the reference type scale', () => {
  has('color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px', 'hint line')
  has('font-size:11px;line-height:16px', 'row metadata line')
})

check('daily automatic check-in has an accessible switch and keeps the manual action', () => {
  assert.ok(source.includes("postRoute('/checkin/claim-all', {})"), 'manual claim uses a dedicated route')
  assert.ok(source.includes("role: 'switch'"), 'the automatic check-in control exposes switch semantics')
  assert.match(source, /type: 'button',\s+className: `dca-switch/, 'the switch is a button control, not a checkbox')
  assert.ok(source.includes("'aria-checked': dailyCheckinEnabled === true"), 'the button reports its state accessibly')
  assert.ok(source.includes('.dca-switch::after{'), 'the switch button draws a movable thumb')
  assert.ok(source.includes('dailyCheckinEnabled'), 'the switch reads and saves the persisted preference')
  assert.ok(source.includes("postRoute('/preferences/save'"), 'the switch saves through the preferences route')
  assert.ok(!source.includes('/checkin/auto'), 'automatic check-in is scheduled by the host, not a browser timer route')
})

check('every class the markup uses has a rule in the stylesheet', () => {
  // THE BUG THIS CATCHES: after a component rebuild the markup kept its class
  // names while the rules for them were gone. `node --check` passes, the client
  // loads, and the page renders unstyled — three separate audits missed it
  // because they asked whether a class was *named*, never whether it was
  // *styled*.
  const css = source.slice(source.indexOf('const CSS = `'), source.indexOf('`\n\n    /**'))
  const used = new Set<string>()
  for (const m of source.matchAll(/className: '([^']+)'/g)) {
    for (const cls of m[1].split(/\s+/)) if (cls) used.add(cls)
  }
  const defined = new Set([...css.matchAll(/\.(dca-[a-z0-9-]+)/g)].map((m) => m[1]))
  const unstyled = [...used].filter((cls) => cls.startsWith('dca-') && !defined.has(cls))
  assert.deepEqual(unstyled, [], `classes used but never styled: ${unstyled.join(', ')}`)
})

check('the account row is two lines: identity, then a probe line', () => {
  has('.dca-pool-account-row{', 'identity line')
  has('.dca-pool-probe{', 'probe line')
  has('justify-self:end;text-align:right;font-variant-numeric:tabular-nums', 'credits hug the right')
})

check('account actions and check-in status stay clear on narrow and touch layouts', () => {
  assert.ok(!source.includes('dca-pool-checkin-label'), 'the redundant check-in label is removed')
  has('.dca-checkin-badge{display:inline-flex;align-items:center', 'check-in results use compact status badges')
  has('.dca-checkin-done{color:var(--dsw-alias-state-success-primary,#3fb950)', 'completed check-ins read as success')
  has('.dca-checkin-pending,.dca-checkin-progress{color:var(--dsw-alias-state-warn-primary,#e8b34b)', 'pending check-ins stay noticeable')
  has('.dca-checkin-error{color:var(--dsw-alias-state-error-primary,#e5534b)', 'failed reads stand apart from completed states')
  assert.ok(!source.includes('dca-account-menu'), 'account rows do not have an edit menu')
  assert.ok(source.includes("'pool.checkAll': ['检查全部账号'"), 'all accounts can be checked from the pool toolbar')
  assert.ok(source.includes("}, t('pool.remove'))"), 'remove is directly available on the row')
  assert.ok(!source.includes("t('health.recheck'))"), 'single-account recheck is absent from the row menu')
})

check('narrow settings layouts follow panel width, not viewport width', () => {
  has('.dca-settings{container:dca-settings / inline-size;', 'the settings root defines the query container')
  has('@container dca-settings (max-width:420px)', 'the narrow rules query the panel')
  assert.ok(!/@media\s*\(\s*max-width/.test(source), 'settings must also adapt inside a wide window')
})

check('selection controls retain native checkbox styling', () => {
  has('.dca-model-controls input[type="checkbox"]', 'a real model checkbox input')
  has('accent-color:var(--dsw-alias-brand-primary,#5686fe)', 'sized and drawn by the engine')
})

check('model rows indent their second line to the name', () => {
  has('padding-inline-start:22px', '22px = the checkbox box plus its gap')
})

check('model tab keeps the busy icon after the promotion badge', () => {
  const promo = source.indexOf("className: `dca-model-promo")
  const busy = source.indexOf("className: 'dca-model-busy'")
  assert.ok(promo >= 0 && busy > promo, 'busy icon is rendered after the promotion badge')
})

check('import opens the system picker, and export downloads a file', () => {
  // The reference opens the OS picker straight from the button: a ceremony
  // dialog in front of a dialog the OS is about to show is one click of
  // nothing. Export writes a file rather than a clipboard string, because a
  // button labelled 导出 that leaves nothing on disk is a lie.
  assert.ok(source.includes("fileInput.current?.click()"), 'the import button opens the picker')
  assert.ok(source.includes('type: \'file\''), 'a real file input exists')
  assert.ok(source.includes('anchor.download = name'), 'export triggers a download')
  assert.ok(source.includes('URL.createObjectURL'), 'export builds a Blob URL')
})

check('the import preview shows what will be written before writing it', () => {
  assert.ok(source.includes("postRoute('/accounts/preview'"), 'a preview route is called')
  assert.ok(source.includes('pool.previewTotal'), 'the confirmation states the count')
})

check('the settings nav glyph is registered under the section\'s own id', () => {
  // The shell addresses the glyph by id: an id that does not equal the
  // settings.section id never renders, and nothing reports it. Both come from
  // one inject callback so the pairing cannot drift.
  assert.ok(source.includes("'settings.section.icon'"), 'the icon seat is used')
  assert.ok(
    source.includes("name: 'settings.section.icon', id: 'dsh-codearts-dock'"),
    'the glyph id must equal the section id',
  )
  assert.ok(source.includes('NAV_ICON'), 'the glyph has artwork')
  assert.ok(source.includes("data:image/png;base64,"), 'embedded as a data URL, not fetched at paint time')
  assert.ok(
    source.includes('settings nav icon failed to register (page unaffected)'),
    'a host without the icon seat must still get the page',
  )
})

check('account rows expose manual switch buttons', () => {
  assert.ok(!source.includes("'pool.enabled':"), 'the retired automatic-selection switch is removed')
  assert.ok(!source.includes("'pool.chooseAccount':"), 'the account dropdown is removed')
  assert.ok(source.includes("}, t('pool.activate'))"), 'manual switching is available on each row')
  assert.ok(source.includes("postRoute('/checkin/claim-all'"), 'manual check-in remains')
})

check('automatic check-in retains the compact tinted settings bar', () => {
  has('.dca-pool-modebar{display:flex;flex-direction:column;padding:12px 14px;gap:8px;', 'one compact settings block')
  has('border:1px solid rgba(86,134,254,.36);border-radius:12px;background:linear-gradient(180deg,rgba(86,134,254,.10),rgba(86,134,254,.02))', 'reference border and brand tint')
  has('width:38px;height:22px', 'reference switch geometry')
  has('top:3px;left:3px;width:16px;height:16px', 'reference thumb geometry')
  has('.dca-switch-on::after{transform:translateX(16px)}', 'thumb travel matches the compact track')
  has('.dca-pool-modebar-label{font-size:13px;font-weight:600;', 'reference label type')
  assert.ok(!source.includes('width:72px;height:40px'), 'the oversized switches are removed')
})

check('the provider is declared, so Settings → Models renders a card for it', () => {
  // THE BUG THIS CATCHES: `registerAdapter` alone makes the route routable and
  // feeds the model picker, but Settings → Models builds its rows from the
  // configurable-provider DIRECTORY. With only an adapter the plugin is
  // half-installed: models selectable, no card in the page where a user manages
  // providers. The two symptoms look unrelated and have one cause.
  const host = readSource('../src/index.js')
  assert.ok(host.includes('registerConfigurableProviders'), 'the directory entry is declared')
  assert.ok(host.includes('registerModelDiscovery'), 'discovery is offered to that page')
  assert.ok(
    host.includes('registerAdapter'),
    'the adapter is registered too — all three, or the plugin is half-installed',
  )
})

check('a model row carries its own selection and capability switches', () => {
  // The row is where a user decides what this provider may send, so the controls
  // live on the row: selection checkbox, image, and "can disable thinking".
  assert.ok(source.includes('dca-model-check'), 'per-row selection checkbox')
  assert.ok(source.includes("setOverride(model.id, { images:"), 'per-row image switch')
  assert.ok(source.includes("setOverride(model.id, { allowOff:"), 'per-row thinking switch')
  assert.ok(source.includes('dca-model-off'), 'an unticked model recedes but stays visible')
})

check('an unticked model leaves the picker, a reset restores everything', () => {
  // `null` is "offer everything" and is NOT the same as an empty array, which
  // would empty the picker with no way back.
  const host = readSource('../src/index.js')
  assert.ok(host.includes("route('/models/select'"), 'a save route exists')
  assert.ok(host.includes('validateSelection({ enabledModelIds: body.enabledIds'), 'the save route uses shared selection validation')
  const preferences = readSource('../src/preferences.js')
  assert.ok(preferences.includes('ids !== null') && preferences.includes('!ids.length'), 'null is distinguished from an empty list')
  assert.ok(host.includes("emit('llm/models-updated'"), 'the picker is told to reload, without a restart')
})

check('edits are a draft until saved, with a visible dirty marker', () => {
  assert.ok(source.includes('models.dirty'), 'unsaved edits are marked')
  assert.ok(source.includes('models.discard'), 'they can be discarded')
  assert.ok(source.includes("postRoute('/models/select'"), 'saving writes them')
})

check('account names are editable and replace imported cloud names when customized', () => {
  assert.ok(source.includes("h('b', { className: 'dca-pool-account-name' }, account.label)"), 'saved account names remain visible as text')
  assert.ok(source.includes('dca-account-name-editor'), 'the row contains an inline name editor')
  assert.ok(source.includes("postRoute('/accounts/rename', { id: account.id, label })"), 'saving calls the existing rename route')
  assert.ok(source.includes('account.renameable\n                      ? h(\'span\', null, account.akMasked)'), 'a custom name hides the original cloud name')
  assert.ok(!source.includes("'pool.addLabel'"), 'the add form has no name field')
  assert.ok(source.includes("postRoute('/accounts/add', { ak, sk })"), 'new accounts submit only their credentials')
  assert.ok(source.includes("}, t('pool.activate'))"), 'manual switching remains available in each account row')
})

check('save and discard live in a persistent action bar', () => {
  // A bar that appears only once something is dirty moves under the pointer at
  // the exact moment the user is looking for it. The reference keeps it present
  // and disables it, which is also what the shared `.dca-btn` disabled style is
  // for.
  assert.ok(source.includes('dca-model-actions'), 'the bar exists')
  assert.ok(source.includes('dca-model-actions-buttons'), 'buttons sit together at the end')
  assert.ok(source.includes('disabled: !dirty || busy !== null'), 'disabled when there is nothing to save')
  assert.ok(source.includes('position:sticky;bottom:0;z-index:3'), 'the save bar remains at the viewport edge')
  assert.ok(source.includes('dca-save-status'), 'the persistent bar explains saved and unsaved state')
})

check('the composer panel lists every account, not just the serving one', () => {
  // The reference's panel is a table of the whole pool: "which account" and "how
  // many credits" are the same fact about the same thing, so splitting them made
  // the panel read as two unrelated blocks.
  assert.ok(source.includes('dca-pop-table'), 'a real table, so balances align in one column')
  assert.ok(source.includes('dca-pop-num'), 'the figure column is right-aligned and tabular')
  assert.ok(source.includes('dca-pop-dot'), 'each row carries a state dot')
  assert.ok(source.includes('dca-pop-mark-reason'), 'a reason sits UNDER the name, not beside it')
  assert.ok(source.includes("postRoute('/accounts/activate'"), 'a row switches the pool on click')
  assert.ok(source.includes("getRoute('/accounts')"), 'the panel reads the pool, not just /account')
})

check('the panel header carries refresh and settings, in that order', () => {
  // Refresh acts on the table right below it (local, repeatable); settings leaves
  // the panel. A navigating control goes LAST so a press meant for "bring this up
  // to date" cannot land on "leave".
  const head = source.slice(source.indexOf("className: 'dca-pop-head'"))
  const refreshAt = head.indexOf('dca-pop-refresh')
  const settingsAt = head.indexOf('dca-pop-settings')
  assert.ok(refreshAt > 0, 'refresh is in the header')
  assert.ok(settingsAt > refreshAt, 'settings comes after refresh')
  assert.ok(source.includes('dca-pop-refresh-icon-spin'), 'refresh spins while it runs')
  assert.ok(source.includes('dca-pop-soon'), 'a lapsing balance warns on its own line')
})

check('reasoning levels are shown in the reader\'s language, not their ids', () => {
  // The model page printed `model.defaultStrength` raw, so the same level read
  // `high` there and 高 in the picker. One fact must read the same everywhere.
  assert.ok(source.includes('EFFORT_LABELS'), 'a label table exists')
  assert.ok(source.includes('function effortLabel('), 'and a resolver reads it')
  assert.ok(source.includes('isChinese() ? pair[0] : pair[1]'), 'it follows the document language')
  assert.ok(!source.includes('${t(\'models.effort\')} ${model.defaultStrength'), 'the raw id is not printed')
  for (const zh of ['关闭', '低', '中', '高', '最高']) {
    assert.ok(source.includes(`'${zh}'`), `${zh} must be in the label table`)
  }
})

check('the add-account fields are one row, named by their placeholders', () => {
  // Form labels remain visible after input. The drawer is compact when closed,
  // while helper text is revealed only when a user asks for it.
  assert.ok(source.includes("className: 'dca-fields'"), 'the fields share a row')
  assert.ok(source.includes("className: 'dca-form-field'"), 'visible labels remain after typing')
  assert.ok(source.includes("placeholder: t('account.placeholderAk')"), 'the AK field has a useful hint')
  assert.ok(source.includes("htmlFor: 'dca-ak2'"), 'the visible label remains after typing')
  assert.ok(source.includes("type: showSecret ? 'text' : 'password'"), 'the secret can be revealed on demand')
  assert.ok(source.includes("placeholder: t('account.placeholderSk')"), 'so does the SK field')
})

check('the panel has one refresh, in its header, and no instruction label', () => {
  // The bottom refresh duplicated the header one; two controls for one action
  // invite the question of whether they differ. The old label —
  // 「点击查看码道账号与积分」 — was an instruction printed INSIDE the thing it
  // told you to click, which reads as a leftover from the trigger.
  assert.ok(!source.includes("className: 'dca-pop-foot'"), 'no bottom action row')
  assert.ok(!source.includes('点击查看码道账号与积分'), 'the click instruction is gone')
  assert.ok(source.includes("'chip.panelTitle': ['码道账号与积分'"), 'the panel names itself instead')
  assert.ok(source.includes("className: 'dca-pop-refresh'"), 'the header refresh remains')
  // Exactly one refresh control INSIDE THE PANEL. The model page has its own,
  // which is a different surface with its own refresh route.
  const panel = source.slice(source.indexOf('function ComposerChip('))
  const inPanel = [...panel.matchAll(/onClick: refresh/g)].length
  assert.equal(inPanel, 1, `expected one refresh control in the panel, found ${inPanel}`)
})

check('an account row lights up on hover, and the serving row does not', () => {
  // Hover belongs to the SWITCH, not the row: the credits cell is not clickable,
  // so lighting it up would promise an action it cannot perform.
  assert.ok(source.includes('.dca-pop-switch:hover:not(:disabled){background'), 'the row body fills on hover')
  assert.ok(source.includes('.dca-pop-switch:focus-visible'), 'keyboard gets the same affordance')
  assert.ok(source.includes('.dca-pop-switch:active:not(:disabled)'), 'and a pressed state')
  assert.ok(!source.includes('.dca-pop-table tbody tr:hover'), 'the row itself never lights up')
  // The serving row's switch is disabled, so it must not offer a click target.
  assert.ok(source.includes('.dca-pop-row-current .dca-pop-name{font-weight:600}'), 'the serving row reads as current')
  assert.ok(source.includes("className: account.active ? 'dca-pop-row-current'"), 'and is marked')
})

check('the settings button opens this plugin\'s own settings section', () => {
  // Two routes, best first, exactly as the reference does it.
  //
  // Route 1 reads the shell's STORE SEAT — verified against the shipped client:
  // ui-settings-general registers `{ name: 'sidebar.settings', store: shellStore }`
  // whose actions are { open, close, select, openSection }. NOT `settings.section`
  // (that slot lists the pages and carries no store), and NOT
  // `pluginNavigation.openBundle` (that lands on the bundle's PAGE, not the section).
  assert.ok(source.includes("SETTINGS_SLOT = 'sidebar.settings'"), 'reads the real seat slot')
  assert.ok(!source.includes("entries('settings.section')"), 'not the pages slot — it has no store')
  assert.ok(source.includes('actions?.openSection'), 'calls openSection on the shell instance')
  assert.ok(source.includes('openSection(sectionId)'), 'opens the section named by its id')
  assert.ok(
    source.includes("openThroughStoreSeat(softGet, 'dsh-codearts-dock')"),
    'and that id is this plugin\'s own section',
  )
  // The shell pins create() to its one live instance; a bare handle would move a
  // dialog nobody renders. The comment says so, and the code uses create().
  assert.ok(source.includes('seat.create()'), 'goes through the pinned instance')
  // 'shell' + `open` is the older-shell path: the dialog opens without
  // preselection, and route 2 clicks the row.
  assert.ok(source.includes("return 'shell'"), 'reports the partially-opened shell')
  assert.ok(source.includes('actions?.open'), 'falls back to plain open on an older store')
  // Route 2: drive the chrome, guarded so an already-open panel is not toggled shut.
  assert.ok(source.includes('data-shortcut-modal="settings"'), 'the shell\'s own panel attribute')
  assert.ok(source.includes('aria-haspopup="dialog"'), 'the sidebar trigger selector')
  assert.ok(source.includes('=== null) {'), 'only clicks the trigger when the panel is absent')
  assert.ok(!source.includes('navigation.openBundle('), 'the bundle-page route is gone')
})

check('the settings jump is a standing function, not a conditional prop', () => {
  // A click that does nothing beats a button that is sometimes absent: the shell
  // may still be applying when this module runs, so the button must exist always.
  const chip = source.slice(source.indexOf('function ComposerChip('))
  assert.ok(chip.includes('const openSettings = () => {'), 'declared unconditionally')
  assert.ok(!chip.includes('openSettings\n            ? h('), 'no render branch on its presence')
})

check('the default thinking level is chosen, not captioned', () => {
  // A caption told the user what upstream decided. A reasoning model's default
  // is a decision the user makes per model, and the picker cannot express a
  // per-model default on its own.
  assert.ok(source.includes("className: 'dca-effort-select'"), 'a select, not a label')
  assert.ok(source.includes("setOverride(model.id, { defaultStrength:"), 'it writes the override')
  assert.ok(source.includes('dca-effort'), 'and carries the inline effort styling')
})

check('an override the model cannot honour is ignored, not sent upstream', () => {
  // A stale preference, or one hand-edited in preferences.json, must not become
  // a request the gateway rejects.
  const catalog = readSource('../src/catalog.js')
  assert.ok(catalog.includes("(model.strengths ?? []).includes(override.defaultStrength)"), 'the level is validated')
  assert.ok(catalog.includes(': model.defaultStrength'), 'and falls back to upstream')
})

check('the model page reports the EFFECTIVE default, not upstream\'s', () => {
  // Showing one value while the adapter sends another is the "shows A, bills B"
  // trap this plugin keeps guarding against.
  const host = readSource('../src/index.js')
  assert.ok(host.includes('deps.catalog.effective(model)'), 'the row is the effective model')
})

check('the model catalog has search, active filter, and useful sorting', () => {
  assert.ok(source.includes("type: 'search', className: 'dca-input dca-search'"), 'searches name and id')
  assert.ok(source.includes("'aria-pressed': filter === value"), 'filter state is accessible')
  assert.ok(source.includes("['ratio', 'models.sortRatio']"), 'can compare models by multiplier')
  assert.ok(source.includes('visibleModels.map'), 'only filtered models render')
})

check('diagnostics lead with health and offer redacted copy', () => {
  assert.ok(source.includes('dca-diagnostic-summary'), 'health summary is above machine details')
  assert.ok(source.includes('navigator.clipboard.writeText(reportText)'), 'one action copies the redacted report')
  assert.ok(source.includes("h('details', { className: 'dca-card dca-details' }"), 'technical internals are collapsed')
})

check('settings tab panels stay mounted and have matching controls', () => {
  assert.ok(source.includes('hidden: tab !== id'), 'switching tabs keeps component state')
  assert.ok(source.includes("'aria-controls': `${panelId}-panel-${id}`"), 'each tab points to its own panel')
  assert.ok(source.includes('tabButtons.current[next]?.focus()'), 'keyboard navigation moves focus as well as selection')
})

check('settings routes populate independently and can be retried', () => {
  assert.ok(source.includes('getRoute(path, { signal: controller.signal })'), 'the four reads are cancellable')
  assert.ok(source.includes('if (controller.signal.aborted) return false'), 'a superseded response cannot replace fresh data')
  assert.ok(source.includes('setData((current) => ({ ...current, [path]: mergeCredits(path, current[path], value) }))'), 'fast status does not wait for account probes')
  assert.ok(source.includes('onSaved: loadModels'), 'model saves reload only the model catalog')
  assert.ok(source.includes("t('common.retry')"), 'a failed read can be retried in place')
})
