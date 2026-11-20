/**
 * Browser half of the 码道 connector.
 *
 * Two surfaces, both inside slots the Host already allocates:
 *
 *   • a settings page (`settings.section`) for credentials, the model
 *     catalog, and diagnostics;
 *   • a credit chip beside the composer (`conversation.composer.dock`) that
 *     stays out of the way unless a 码道 model is selected.
 *
 * The Host half does all gateway work; this file only reads the small JSON
 * routes under `/plugins/dsh-connect-codearts/`. Nothing here touches
 * credentials beyond posting them once.
 *
 * Written as a plain-JS module for the Client module table: React comes from
 * the browser module table, no bundler and no duplicate React install.
 */

window.__ModuleLoader__.load({
  id: 'dsh-connect-codearts',
  factory(require) {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    /** Route root served by the plugin's Host half. */
    const ROUTE = '/plugins/dsh-connect-codearts'

    /** Provider route this plugin owns; the chip only shows for these models. */
    const PROVIDER_ID = 'codearts'

    /**
     * The settings-nav glyph.
     *
     * Embedded as a data URL rather than fetched from the package's icon file:
     * a Client module cannot import assets, and fetching at paint time would
     * leave the nav row blank until the request resolved. 64px covers 2x/3x
     * displays; the 128px source would add 26 KB for detail nobody can see at
     * a 16px edge.
     */
    const NAV_ICON = 'data:image/png;base64,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'

    /** Localisation text, with an English fallback per key. */
    const STRINGS = {
      'meta.title': ['码道连接器', 'CodeArts connector'],
      'meta.description': [
        '把华为云码道（CodeArts Agent）的模型接入 DSH：原生适配器直连网关，带凭证管理、模型目录与只读积分概览。',
        'Connects Huawei Cloud CodeArts models to DSH through a native adapter, with credential management, a model catalog, and a read-only credit overview.',
      ],
      'nav.label': ['码道', 'CodeArts'],
      'tab.account': ['凭证', 'Credentials'],
      'tab.models': ['模型', 'Models'],
      'tab.diagnostics': ['诊断', 'Diagnostics'],

      'account.title': ['华为云凭证', 'Huawei Cloud credentials'],
      'account.hint': [
        '填一次永久 AK/SK 即可长期使用：插件会自动换 STS 临时令牌并在到期前续期，不需要你手动维护。不填也行——装过并登录过码道客户端的话，插件会借用它的登录态。',
        'One permanent AK/SK pair is enough: the plugin exchanges it for STS and renews before expiry. Leaving it empty also works when the CodeArts client is installed and signed in on this machine.',
      ],
      'account.ak': ['Access Key ID', 'Access Key ID'],
      'account.sk': ['Secret Access Key', 'Secret Access Key'],
      'account.placeholdersuffix': ['（要改就整对重填）', ' (re-enter the whole pair to change)'],
      'account.placeholderAk': ['粘贴 Access Key ID', 'Paste the Access Key ID'],
      'account.placeholderSk': ['粘贴 Secret Access Key', 'Paste the Secret Access Key'],
      'account.save': ['保存', 'Save'],
      'account.saving': ['保存中…', 'Saving…'],
      'account.saved': ['已保存并立即生效', 'Saved and in effect'],
      'account.saveFail': ['保存失败', 'Save failed'],
      'account.clear': ['清除已保存的凭证', 'Clear saved credentials'],
      'account.clearConfirm': [
        '清除后插件会立刻改用其它凭证来源（环境变量或码道登录态）。确定清除？',
        'After clearing, the plugin falls back to other credential sources. Clear anyway?',
      ],
      'account.cleared': ['已清除保存的凭证', 'Saved credentials cleared'],
      'account.clearFail': ['清除失败', 'Clear failed'],
      'account.test': ['测试连接', 'Test connection'],
      'account.testing': ['测试中…', 'Testing…'],
      'account.refreshing': ['刷新中…', 'Refreshing…'],
      'account.refresh': ['刷新目录与积分', 'Refresh catalog and credit'],
      'account.needBoth': ['Access Key ID 和 Secret Access Key 都要填。', 'Both fields are required.'],
      'account.whereToGet': ['怎么拿到 AK/SK', 'Where to get an AK/SK'],
      'account.whereToGetBody': [
        '华为云控制台 → 右上角账号名 → 我的凭证 → 访问密钥 → 新增访问密钥。下载的 credentials.csv 里 Access Key Id 和 Secret Access Key 对应上面两栏（Secret 只在创建时显示一次）。不需要填 STS。',
        'Huawei Cloud console → account menu → My credentials → Access keys → Add access key. The downloaded credentials.csv holds the Access Key Id and Secret Access Key (the secret is shown once). No STS value is needed.',
      ],
      'account.sourceTitle': ['当前生效的凭证来源', 'Credential source in effect'],
      'account.sourceNone': ['尚未解析到可用凭证', 'No usable credential resolved yet'],
      'account.temporary': [
        '正在使用从码道登录态借来的临时凭证，几小时后会失效。失效后打开一次码道客户端让它刷新即可恢复；填上永久 AK/SK 可以免去这一步。',
        'Running on a temporary credential borrowed from the CodeArts client. It expires in a few hours; opening the client refreshes it. A permanent AK/SK removes this step.',
      ],
      'account.identity': ['账号', 'Account'],
      'account.credit': ['积分', 'Credits'],
      'account.creditBalance': ['剩余 {remain} / 共 {total}', '{remain} of {total} remaining'],
      'account.creditUnread': ['读不到积分（不影响对话）', 'Credits unreadable (chatting still works)'],
      'account.roles': ['企业角色', 'Enterprise roles'],

      'models.title': ['模型目录', 'Model catalog'],
      'models.pickerHint': [
        '这些模型会出现在输入框的模型选择器里，分组名是「码道 CodeArts」。若选择器里看不到，先确认本页目录不是「兜底清单」——兜底清单只在连不上网关时使用。',
        'These models appear in the composer model picker under the group 码道 CodeArts. If the picker does not show them, check this page is not on the fallback list — the fallback is only used when the gateway cannot be reached.',
      ],
      'models.hint': [
        '目录每次刷新都从网关重新读取，上游上新或调价会自动跟上；下面看到的倍率就是上游此刻给出的。',
        'The catalog is re-read from the gateway on every refresh, so new models and price changes follow automatically. The multiplier shown is the one upstream reports right now.',
      ],
      'models.refresh': ['重读模型目录', 'Reload catalog'],
      'models.source': ['来源', 'Source'],
      'models.sourceGateway': ['上游网关', 'Upstream gateway'],
      'models.sourceFallback': ['兜底清单（未连上网关）', 'Fallback list (gateway unreachable)'],
      'models.refreshedAt': ['上次刷新', 'Last refreshed'],
      'models.refreshed': ['已从上游重读模型目录', 'Catalog re-read from upstream'],
      'models.saved': ['已保存，模型选择器已更新', 'Saved; the model picker has been updated'],
      'models.save': ['保存', 'Save'],
      'models.discard': ['放弃修改', 'Discard'],
      'models.saveFailed': ['保存失败', 'Save failed'],
      'models.dirty': ['未保存', 'unsaved'],
      'models.images': ['图片', 'Image'],
      'models.allowOff': ['可关闭思考', 'Can disable'],
      'models.effort': ['默认推理强度', 'Default reasoning'],
      'models.cheer': ['鼓励一下', 'Star the project'],
      'models.footnote': [
        '只列上游接口明确公布的模型能力；勾选的模型才会出现在模型选择器里。',
        'Only capabilities the upstream interface publishes are shown; a model appears in the picker only while it is ticked.',
      ],
      'models.empty': [
        '上游没有返回任何模型。先确认凭证可用，再重读目录。',
        'Upstream returned no models. Check the credential, then reload the catalog.',
      ],
      'models.refreshFailed': ['刷新失败', 'Refresh failed'],
      'models.count': ['个数', 'Count'],
      'models.colName': ['模型', 'Model'],
      'models.colContext': ['上下文', 'Context'],
      'models.colOutput': ['输出上限', 'Output cap'],
      'models.colRatio': ['倍率', 'Multiplier'],
      'models.colImages': ['图片', 'Images'],
      'models.colThinking': ['思考档位', 'Thinking levels'],
      'models.imagesYes': ['支持', 'Yes'],
      'models.imagesNo': ['不支持', 'No'],
      'models.thinkingNone': ['无', 'None'],

      'diag.title': ['诊断', 'Diagnostics'],
      'diag.hint': [
        '这一栏是只读事实，用来贴进问题反馈：每个值都来自宿主自己的回答，不经过前端推测。',
        'Read-only facts for a bug report: every value is the Host’s own answer, not a front-end guess.',
      ],
      'diag.provider': ['Provider 路由', 'Provider route'],
      'diag.gateway': ['网关', 'Gateway'],
      'diag.credentialPath': ['凭证文件', 'Credential file'],
      'diag.catalogError': ['目录错误', 'Catalog error'],
      'diag.credentialError': ['凭证错误', 'Credential error'],
      'diag.rawTitle': ['原始数据（已隐去凭证）', 'Raw data (credentials removed)'],
      'diag.rawHint': [
        '下面这段可以直接贴进问题反馈：凭证位只保留「是否已设置」，账号 id 已去掉。',
        'This block can be pasted into a report: credential fields keep only whether a value is set, and the account id is removed.',
      ],
      'diag.none': ['（无）', '(none)'],
      'diag.configSchema': ['Config schema（模型页显示卡片的前提）', 'Config schema (required for the model card)'],
      'diag.schemaMissing': ['缺失（模型页不会显示本插件的卡片）', 'missing (the model page will not show this provider)'],
      'diag.gatewayDefault': ['默认（cn-north-4）', 'Default (cn-north-4)'],

      'common.loading': ['加载中…', 'Loading…'],
      'common.retry': ['重试', 'Retry'],
      'common.retryHint': [
        '读不到宿主的这条路由，可能插件刚装好还没挂上。',
        'Could not reach this plugin\'s Host route; it may not be mounted yet.',
      ],
      'pool.title': ['账号池', 'Accounts'],
      'pool.tagline': [
        '每个账号独立计费与签到；请求只用「当前」那一个。',
        'Each account bills and checks in on its own; requests use only the current one.',
      ],
      'pool.inUse': ['当前使用：', 'In use: '],
      'pool.expiring': ['{amount} 积分即将到期', '{amount} credits expiring'],
      'pool.expiringHint': [
        '上游会报告有多少积分将要过期，但不下发具体到期时间，所以这里只显示金额。',
        'The upstream reports how many credits are expiring but never when, so only the amount is shown.',
      ],
      'pool.colAccount': ['账号', 'Account'],
      'pool.colCredits': ['积分', 'Credits'],
      'pool.colCheckin': ['签到', 'Check-in'],
      'pool.current': ['当前', 'Current'],
      'pool.rename': ['账号备注', 'Account name'],
      'pool.renameHint': ['点一下改备注，方便认出是哪个账号', 'Click to rename, so you can tell accounts apart'],
      'pool.renamePlaceholder': ['例如：个人 / 公司', 'e.g. personal / work'],
      'pool.renameFailed': ['改备注失败', 'Rename failed'],
      'pool.use': ['切换', 'Use'],
      'pool.remove': ['移除', 'Remove'],
      'pool.removeConfirm': [
        '移除这个账号？它保存的 AK/SK 会从本机删除。',
        'Remove this account? Its saved AK/SK is deleted from this machine.',
      ],
      'pool.empty': [
        '还没有账号。在下面填一对 AK/SK，或者从华为云导出的 credentials.csv 导入。',
        'No accounts yet. Add an AK/SK pair below, or import the credentials.csv exported from the Huawei Cloud console.',
      ],
      'pool.addTitle': ['添加账号', 'Add an account'],
      'pool.addLabel': ['名称（可选）', 'Name (optional)'],
      'pool.addLabelPlaceholder': ['例如：个人 / 公司', 'e.g. personal / work'],
      'pool.add': ['添加', 'Add'],
      'pool.importTitle': ['导入', 'Import'],
      'pool.importHint': [
        '粘贴华为云 console 下载的 credentials.csv 内容、每行一对 AK,SK、或本插件导出的 JSON。',
        'Paste the contents of a credentials.csv from the Huawei Cloud console, one AK,SK pair per line, or JSON exported by this plugin.',
      ],
      'pool.importPlaceholder': ['AK,SK（每行一对）', 'AK,SK (one pair per line)'],
      'pool.import': ['导入', 'Import'],
      'pool.importResult': [
        '导入完成：新增 {added}，更新 {updated}，跳过 {skipped}',
        'Imported: {added} added, {updated} updated, {skipped} skipped',
      ],
      'pool.importEmpty': ['没有认出任何 AK/SK 对。', 'No AK/SK pair recognised.'],
      'pool.export': ['导出', 'Export'],
      'pool.exportHint': [
        '导出的内容含明文密钥，只贴到你自己信任的地方。',
        'The export contains plain-text keys — only paste it somewhere you trust.',
      ],
      'pool.exported': ['已导出文件 {name}', 'Saved {name}'],
      'pool.importHint': [
        '选一个华为云 credentials.csv、每行 AK,SK 的文本、或本插件导出的 JSON。选完会先显示预览，确认后再写入。',
        'Pick a Huawei Cloud credentials.csv, a text file with one AK,SK per line, or JSON exported by this plugin. You see a preview before anything is written.',
      ],
      'pool.checkinPending': ['待签', 'Due'],
      'pool.added': ['已添加账号', 'Account added'],
      'pool.updated': ['已更新该账号的密钥', 'That account was updated'],
      'pool.importing': ['导入中…', 'Importing…'],
      'pool.previewTotal': ['这个文件里有 {total} 个账号，确认后写入：', 'This file holds {total} accounts; confirm to write them:'],
      'pool.importConfirm': ['导入 {count} 个', 'Import {count}'],
      'pool.cancel': ['取消', 'Cancel'],
      'pool.exportFailed': ['导出失败', 'Export failed'],
      'pool.importShow': ['批量导入', 'Bulk import'],
      'pool.importHide': ['收起批量导入', 'Hide bulk import'],
      'pool.checkinClaim': ['签到', 'Check in'],
      'pool.checkinDone': ['今日已签', 'Checked in'],
      'pool.checkinUnavailable': ['不可领取', 'Unavailable'],
      'pool.checkinNone': ['无活动', 'No campaign'],
      'pool.autoTitle': ['每日自动签到', 'Daily auto check-in'],
      'pool.autoToday': ['今天 {done}/{total}', '{done}/{total} today'],
      'pool.autoRun': ['立刻签到一次', 'Check in now'],
      'pool.autoRunning': ['签到中…', 'Checking in…'],
      'pool.autoOff': ['已关闭', 'Off'],
      'pool.result': ['{claimed} 个账号签到了，{failed} 个失败', '{claimed} checked in, {failed} failed'],
      'chip.loading': ['读取中…', 'Reading…'],
      'chip.credits': ['积分', 'credits'],
      'chip.panelTitle': ['码道账号与积分', 'CodeArts accounts and credits'],
      'chip.refreshHint': ['重新读取所有账号的积分', 'Re-read every account\'s credits'],
      'chip.settings': ['设置', 'Settings'],
      'chip.switchTo': ['切换到 {account}', 'Switch to {account}'],
      'chip.current': ['当前选用', 'In use'],
      'chip.refresh': ['刷新', 'Refresh'],
      'chip.noCredential': ['未配置凭证', 'No credentials'],
      'chip.noCredentialHint': [
        '还没有可用的码道凭证。到「设置 → 码道」填 AK/SK，或登录码道客户端。',
        'No usable 码道 credential yet. Add an AK/SK in Settings → 码道, or sign in to the CodeArts client.',
      ],

    }

    /**
     * Resolve a string for the active locale.
     *
     * Read from `document.documentElement.lang` rather than the Host's locale
     * service: this module renders inside the same document, and reading the
     * attribute avoids depending on a service whose signature may change.
     */
    /** Whether the surrounding document is in Chinese. */
    function isChinese() {
      const lang = (
        (typeof document !== 'undefined' && document.documentElement.lang) ||
        (typeof navigator !== 'undefined' && navigator.language) ||
        'en'
      ).toLowerCase()
      return lang.startsWith('zh')
    }

    function t(key) {
      const entry = STRINGS[key]
      if (!entry) return key
      return isChinese() ? entry[0] : entry[1]
    }

    /** Fetch one plugin route, tolerating a non-JSON answer. */
    async function getRoute(path) {
      const response = await fetch(`${ROUTE}${path}`, { headers: { accept: 'application/json' } })
      const text = await response.text()
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(`${path}: ${response.status} ${text.slice(0, 120)}`)
      }
    }

    /** POST JSON to one plugin route. */
    async function postRoute(path, body) {
      const response = await fetch(`${ROUTE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const text = await response.text()
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(`${path}: ${response.status} ${text.slice(0, 120)}`)
      }
    }

    /** Format an epoch-ms instant in the browser's own zone. */
    function formatTime(ms) {
      if (!ms) return '—'
      try {
        return new Date(ms).toLocaleString()
      } catch {
        return String(ms)
      }
    }

    /**
     * Render a credit balance.
     *
     * One format string per locale instead of gluing a translated noun between
     * two numbers: word order differs by language, and the previous shape
     * produced "7425.22 剩余 / 7600 共" in Chinese and "7425.22 remaining /
     * 7600 of" in English. Grouping separators keep five-figure balances
     * readable at a glance.
     */
    function formatBalance(credit) {
      if (!credit) return ''
      const remain = Number(credit.remain ?? 0).toLocaleString()
      const total = Number(credit.total ?? 0).toLocaleString()
      return t('account.creditBalance').replace('{remain}', remain).replace('{total}', total)
    }

    /** Compact a token count: 1048576 -> "1M". */
    function formatTokens(value) {
      if (typeof value !== 'number' || value <= 0) return '—'
      if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`
      if (value >= 1000) return `${Math.round(value / 100) / 10}K`
      return String(value)
    }

    /**
     * The plugin's stylesheet.
     *
     * The layout rules for the card, the section tabs, the account table and the
     * model rows are taken from dsh-connect-workbuddy (MIT, Copyright (c) 2026
     * LaoDing, https://github.com/dingminhua/dsh-connect-workbuddy) so that the
     * two connector cards read as siblings in the same settings panel. Class
     * names are this plugin's own (`dca-` prefix); the declarations, the values
     * and the reasoning behind them are that project's.
     *
     * Shipped through the Client `styles` builtin rather than as inline style
     * objects: the Client contract cannot import the design system, so the
     * design system is reproduced here in CSS. Inline styles cannot express
     * `:hover`, `:focus-visible`, `:has()` or media queries, which is exactly
     * the feedback a control needs to feel like part of the shell.
     *
     * Every colour is a theme token with a literal fallback, so the page also
     * survives a host that renames one.
     */
    const CSS = `
/* The app ships no global reset, so a padded, bordered element with width:100%
   overflows its container by exactly its padding plus border. Every box here
   opts in explicitly. */
.dca-page,.dca-page *{box-sizing:border-box}

/* ---- shared shell ------------------------------------------------------ */
.dca-page{display:flex;flex-direction:column;gap:18px;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;line-height:1.6}
.dca-head{display:flex;flex-direction:column;gap:4px}
.dca-title{margin:0;font-size:16px;font-weight:500;line-height:24px}
.dca-hint{margin:0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
.dca-card{
  box-sizing:border-box;
  border:1px solid var(--dsw-alias-border-l2,#36373b);
  border-radius:12px;background:var(--dsw-alias-bg-layer-3,#202126);
  padding:14px 16px;display:flex;flex-direction:column;gap:12px;
  transition:border-color .16s;
}
.dca-card:hover{border-color:var(--dsw-alias-label-dimmed,#777)}

/* ---- account pool rows ------------------------------------------------
   One row per account, two lines each: identity on the first, what the account
   can do right now on the second. The reference lays its pool out this way, so
   a long account name never pushes the figures out of alignment. */
.dca-pool-card-head{
  display:flex;align-items:center;justify-content:space-between;
  gap:8px 12px;flex-wrap:wrap;
}
.dca-pool-actions-group{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dca-pool-card-title{margin:0;font-size:13px;font-weight:600;line-height:20px}
.dca-pool-tagline{flex:1 1 auto;min-width:0}
.dca-pool-account-row{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
/* The account name is a BUTTON that looks like text: the pencil only appears on
   hover or focus, so the table does not read as a form with three inputs a row. */
.dca-rename-btn{
  appearance:none;font:inherit;display:inline-flex;align-items:center;gap:5px;
  padding:1px 6px;margin:-1px -6px;border:1px solid transparent;border-radius:6px;
  background:transparent;color:var(--dsw-alias-label-primary,#e6e6e6);
  cursor:pointer;min-width:0;max-width:100%;
}
.dca-rename-btn:hover{border-color:var(--dsw-alias-border-l2,#3a3d45);background:var(--dsw-alias-bg-layer-2,#232529)}
.dca-rename-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dca-rename-btn b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dca-rename-glyph{
  flex:none;font-size:11px;line-height:16px;
  color:var(--dsw-alias-label-tertiary,#999);opacity:0;transition:opacity .15s;
}
.dca-rename-btn:hover .dca-rename-glyph,
.dca-rename-btn:focus-visible .dca-rename-glyph{opacity:1}
.dca-rename{max-width:220px;font-family:inherit;font-size:13px}
.dca-pool-probe{
  display:flex;align-items:center;gap:7px 12px;flex-wrap:wrap;
  font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#999);
  min-width:0;overflow-wrap:anywhere;
}
.dca-pool-probe-cell{grid-area:probe;min-width:0}
.dca-pool-probe-main{
  font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#999);
  min-width:0;overflow-wrap:anywhere;
}
.dca-pool-credits-row{
  display:flex;flex-direction:row;flex-wrap:wrap;align-items:baseline;
  justify-content:flex-end;gap:0 6px;min-width:0;
  justify-self:end;text-align:right;font-variant-numeric:tabular-nums;
}
/* A small state chip on the name line, and a filled pill for "current". */
.dca-pool-tag{
  flex:none;padding:1px 7px;border-radius:6px;
  background:var(--dsw-alias-bg-layer-3,#2a2c33);
  font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary,#999);
}
.dca-badge{
  flex:none;padding:2px 9px;border-radius:999px;
  font-size:12px;line-height:18px;font-weight:500;
  color:var(--dsw-alias-brand-primary,#5686fe);
  background:rgba(86,134,254,.12);
  border:1px solid rgba(86,134,254,.32);
}

/* ---- switch row -------------------------------------------------------
   The platform checkbox, sized and drawn by the engine via accent-color. The
   reference never paints its own toggle: that is what makes the box match the
   reader's OS instead of looking like a painted square. */
/* The file input is visually hidden, not display:none: a display:none input
   cannot be opened by script in every engine, and this one is clicked by the
   button above it. */
.dca-file-input{
  position:absolute;width:1px;height:1px;padding:0;margin:-1px;
  overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;
}
.dca-transfer-dialog{
  margin-top:8px;padding:10px 12px;
  border:1px solid var(--dsw-alias-border-l2,#3a3d45);
  border-radius:10px;background:var(--dsw-alias-bg-secondary,transparent);
}
.dca-transfer-list{
  list-style:none;margin:0 0 8px;padding:0;
  max-height:180px;overflow-y:auto;
}
.dca-transfer-list label{
  display:flex;align-items:center;gap:6px;
  font-size:12px;color:var(--dsw-alias-label-primary,#e8e9ed);
  cursor:pointer;padding:2px 0;
}
.dca-transfer-list input[type="checkbox"]{flex:none;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dca-transfer-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
/* The pool switches: a 38x22 track with a 16px knob that slides 16px. The input
   itself is present but invisible — it keeps the accessible role, the keyboard
   handling and the checked state, while the track and knob are drawn here. */
.dca-sw{position:relative;display:inline-block;width:38px;height:22px;flex:none;cursor:pointer}
.dca-sw input{position:absolute;opacity:0;width:0;height:0}
.dca-sw-track{position:absolute;inset:0;border-radius:999px;background:var(--dsw-alias-border-l2,#3a3d45);transition:background .18s}
.dca-sw-track::after{
  content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;
  background:#fff;transition:transform .18s;box-shadow:0 1px 3px rgba(0,0,0,.3);
}
.dca-sw input:checked + .dca-sw-track{background:var(--dsw-alias-brand-primary,#5686fe)}
.dca-sw input:checked + .dca-sw-track::after{transform:translateX(16px)}
.dca-sw input:disabled + .dca-sw-track{opacity:.4}
.dca-sw input:focus-visible + .dca-sw-track{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:2px}

.dca-modebar-label{font-size:13px;font-weight:600;line-height:20px}

/* A plain row: no card, no border, no inset padding. It used to carry the
   padding and hairline of the card that wrapped it, and with the card gone those
   would leave a control floating under a stray rule. */
.dca-switchrow{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dca-switchrow input[type="checkbox"]{
  margin:0;flex:none;width:16px;height:16px;
  accent-color:var(--dsw-alias-brand-primary,#5686fe);
  cursor:pointer;
}
.dca-switchrow label{font-weight:600;font-size:13px;line-height:20px;cursor:pointer}

/* A dashed strip for secondary tools: "these are utilities, not the table". */

/* ---- model rows -------------------------------------------------------
   Line one: enable box, name, ratio, flags on the left; the row's own switches
   on the right. Line two: facts, indented to the name (22px = the box plus its
   8px gap) so the two lines read as one block. */
.dca-model-head{
  display:flex;align-items:center;justify-content:space-between;
  flex-wrap:wrap;gap:12px;row-gap:8px;min-width:0;
}
.dca-model-controls{
  display:flex;align-items:center;flex-wrap:wrap;
  gap:12px;row-gap:8px;min-width:0;flex:none;
}
.dca-model-details{
  display:flex;align-items:center;justify-content:space-between;
  gap:12px;min-width:0;padding-inline-start:22px;
}
.dca-model-check{
  margin:0;flex:none;width:16px;height:16px;
  accent-color:var(--dsw-alias-brand-primary,#5686fe);
}
.dca-model-ratio{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;font-weight:400;line-height:16px;flex:none}
.dca-model-flag{
  display:inline-flex;align-items:center;gap:5px;flex:none;
  font-size:11px;line-height:16px;
  color:var(--dsw-alias-label-secondary,#c6c9d0);
}
.dca-card-plain{border-color:transparent;background:transparent;padding:0}
.dca-card-title{margin:0;font-size:13px;font-weight:600;line-height:20px}
.dca-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dca-fields{display:flex;gap:8px;flex-wrap:wrap}
/* Every field grows equally and may shrink: a fixed 220px basis forced the row to
   wrap on a narrow card even when the inputs would have fitted. */
.dca-fields .dca-input{flex:1 1 160px;min-width:120px}
.dca-label{font-size:12px;color:var(--dsw-alias-label-tertiary,#999);line-height:18px}
.dca-input{
  box-sizing:border-box;width:100%;
  font-size:12px;line-height:20px;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  padding:4px 8px;border-radius:6px;
  border:1px solid var(--dsw-alias-border-l2,#3a3d45);
  background:var(--dsw-alias-bg-l1,transparent);
  color:var(--dsw-alias-label-primary,#e8e9ed);
  transition:border-color .15s;
}
.dca-input:hover{border-color:var(--dsw-alias-label-dimmed,#777)}
.dca-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px;border-color:var(--dsw-alias-brand-primary,#5686fe)}

/* ---- buttons -----------------------------------------------------------
   A shared base plus one modifier per weight, so a row of buttons has one
   height, one radius and one transition instead of three copies. */
.dca-btn{
  box-sizing:border-box;appearance:none;font:inherit;font-size:13px;line-height:20px;
  padding:5px 14px;border-radius:8px;min-height:32px;font-weight:500;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2,#3a3d45);
  background:var(--dsw-alias-bg-layer-2,#232529);
  color:var(--dsw-alias-label-primary,#e6e6e6);
  transition:background .15s,border-color .15s,opacity .15s;
  white-space:nowrap;
}
.dca-btn:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed,#777)}
.dca-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dca-btn:disabled{opacity:.55;cursor:default}
.dca-btn-primary{
  border-color:transparent;
  /* An INVERTED surface, not a brand fill — the reference's primary is
     label-primary on bg-layer-3, two tokens that are opposite by definition in
     every theme, so the label can never vanish into its own background. */
  background:var(--dsw-alias-label-primary,#e6e6e6);
  color:var(--dsw-alias-bg-layer-3,#2a2c33);
  font-weight:600;
}
.dca-btn-primary:hover:not(:disabled){opacity:.9}
/* If a host omits bg-base, the fallback must follow the theme too, or the
   light theme turns this into dark-on-dark. Inert when the token exists. */
@media (prefers-color-scheme: light){
  .dca-btn-primary{color:var(--dsw-alias-bg-base,#fff)}
}
.dca-btn-quiet{background:transparent;border-color:transparent;color:var(--dsw-alias-label-tertiary,#999)}
.dca-btn-quiet:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#e6e6e6)}

/* ---- tabs -------------------------------------------------------------
   A TABS STRIP pinned above scrolling content, matched to the reference: 7px
   11px tabs with a 2px transparent bottom border that the active tab fills with
   the accent, a hairline rule under the strip, and sticky positioning so the
   labels stay put while the panel scrolls. The opaque background is
   load-bearing — without it rows slide under the strip and show through the
   gaps between labels. (An earlier revision drew card-shaped cells here; the
   reference does not, and at four sections the cards read as buttons.) */
.dca-tabs{
  position:sticky;top:-1px;z-index:2;
  display:flex;align-items:stretch;gap:2px;margin:0;
  border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));
  background:var(--dsw-alias-bg-layer-1,#17181b);
}
.dca-tab{
  appearance:none;font:inherit;cursor:pointer;border:0;background:transparent;
  padding:7px 11px;margin-bottom:-1px;
  border-bottom:2px solid transparent;
  color:var(--dsw-alias-label-tertiary,#999);
  font-size:13px;font-weight:600;line-height:20px;white-space:nowrap;
  transition:color .15s,border-color .15s;
}
.dca-tab:hover:not(.dca-tab-on){color:var(--dsw-alias-label-primary,#e6e6e6)}
.dca-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dca-tab-on{
  color:var(--dsw-alias-label-primary,#e6e6e6);
  border-bottom-color:var(--dsw-alias-brand-primary,#5686fe);
}

/* ---- data table -------------------------------------------------------
   Tabular figures so the multiplier column lines up digit for digit. */
/* Model rows are CARDS, not table rows — the reference lists models this way and
   a settings column cannot hold six nowrap columns. Each row is a surface on
   bg-layer-2, its facts on one 11px meta line, exactly like the reference. */
/* One bordered box; its rows are divided by hairlines. The rounded corners are
   drawn by this box, so overflow:hidden is load-bearing — without the clip the
   first and last row would paint square corners over them. */
.dca-models{
  display:flex;flex-direction:column;
  border:1px solid var(--dsw-alias-border-l2,#36373b);
  border-radius:10px;overflow:hidden;
}
.dca-model{
  box-sizing:border-box;display:grid;grid-template-columns:minmax(0,1fr);gap:7px;
  padding:10px 12px;background:var(--dsw-alias-bg-layer-2,#232529);
  transition:opacity .16s;
}
.dca-model + .dca-model{border-top:1px solid var(--dsw-alias-border-l2,#36373b)}
/* An unticked model stays visible but recedes: it is still a thing you can
   enable, so hiding it would make the catalog feel arbitrary. */
.dca-model-off{opacity:.55}
/* The model panel's action bar: always present, disabled when clean. */
.dca-model-actions{
  display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;
  gap:12px;row-gap:8px;
  border-top:1px solid var(--dsw-alias-border-l2,#36373b);
  padding-top:12px;
}
.dca-model-actions-buttons{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.dca-cheer{
  display:inline-flex;align-items:center;gap:4px;flex:none;
  text-decoration:underline;text-underline-offset:2px;
  color:var(--dsw-alias-label-tertiary,#999);
  font-size:13px;line-height:1.5;transition:color .16s;
}
.dca-cheer:hover{color:var(--dsw-alias-label-primary,#e6e6e6)}
.dca-cheer:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:2px;border-radius:4px}
.dca-cheer-star{font-size:12px}
.dca-model-save-error{
  flex:1;min-width:0;font-size:12px;line-height:16px;text-align:right;
  color:var(--dsw-alias-state-error-primary,#ef4444);
}
.dca-dirty{
  margin-left:8px;padding:0 6px;border-radius:6px;
  font-size:10px;line-height:16px;font-weight:600;
  color:var(--dsw-alias-state-warn-primary,#e8b34b);
  border:1px solid currentColor;
}
.dca-model-controls label{cursor:pointer}
.dca-model-controls input[type="checkbox"]{
  margin:0 5px 0 0;width:14px;height:14px;flex:none;
  accent-color:var(--dsw-alias-brand-primary,#5686fe);
}
.dca-model-controls input[type="checkbox"]:disabled{cursor:default}
.dca-model-name{
  display:inline-flex;align-items:baseline;gap:7px;
  color:var(--dsw-alias-label-primary,#e6e6e6);
  font-size:13px;font-weight:500;line-height:19px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  min-width:0;
}
.dca-model-name b{font-size:13px;font-weight:500}
.dca-effort{display:inline-flex;align-items:center;gap:5px;cursor:pointer}
/* A quiet pill, not a boxed form control: the row already carries two checkboxes,
   and a third bordered control would make a settings table look like a form. */
.dca-effort-select{
  font:inherit;font-size:11px;line-height:15px;
  color:var(--dsw-alias-label-secondary,#c6c9d0);
  background:rgba(174,179,187,.11);
  border:1px solid transparent;border-radius:999px;
  padding:1px 6px;cursor:pointer;max-width:180px;
}
.dca-effort-select:hover:not(:disabled){border-color:var(--dsw-alias-border-l2,#3a3d45)}
.dca-effort-select:focus-visible{
  outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px;
}
.dca-effort-select:disabled{opacity:.55;cursor:default}
.dca-model-meta{
  display:flex;align-items:center;gap:7px 12px;flex-wrap:wrap;
  color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px;
}
.dca-model-meta .dca-num{font-variant-numeric:tabular-nums}
.dca-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary,#999);line-height:16px}

/* ---- pills, key/value, messages --------------------------------------- */

/* DIAGNOSTICS: a two-column FACT TABLE, not prose. One row per thing the plugin
   actually read, so a bug report can quote a line instead of paraphrasing the
   UI. No control lives here on purpose — a diagnostics panel that can change
   settings is a settings panel with a worse name. */
.dca-diag{
  display:flex;flex-direction:column;
  border:1px solid var(--dsw-alias-border-l2,#36373b);
  border-radius:10px;overflow:hidden;
  background:var(--dsw-alias-bg-layer-2,#232529);
}
.dca-diag-row{display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding:8px 12px}
.dca-diag-row + .dca-diag-row{border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24))}
.dca-diag-label{flex:none;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
.dca-diag-value{
  min-width:0;color:var(--dsw-alias-label-primary,#e6e6e6);
  font-size:12px;line-height:18px;text-align:right;overflow-wrap:anywhere;
}
.dca-diag-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dca-diag-bad{color:var(--dsw-alias-state-warn-primary,#e8b34b)}
.dca-diag-hint{margin:10px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
.dca-msg{font-size:12px;line-height:18px;margin:0;white-space:pre-wrap}
.dca-msg-error{color:var(--dsw-alias-state-error-primary,#e5534b)}
.dca-msg-ok{color:var(--dsw-alias-state-success-primary,#3fb950)}
.dca-msg-warn{color:var(--dsw-alias-state-warn-primary,#d29922)}
.dca-pre{
  margin:0;padding:10px;border-radius:8px;
  background:var(--dsw-alias-bg-base,#121317);
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-word;
  max-height:240px;overflow:auto;
}

/* ---- account pool -----------------------------------------------------
   A table of accounts, styled like the settings tables around it: one row per
   account, aligned columns, the current one marked rather than reordered.
   Every row is the same height so the check-in buttons line up. */
.dca-pool{display:flex;flex-direction:column;gap:12px;margin:0;padding:0 0 4px}
/* A grid table, matched to the reference card: rounded outer frame on
   bg-layer-2, one row per account, uppercase 11px header row on bg-layer-3.
   Not a <table> — the columns reflow to two lines on a narrow panel, which a
   table cannot do. */
.dca-pool-table{
  box-sizing:border-box;container-type:inline-size;
  border:1px solid var(--dsw-alias-border-l2,#3a3d45);
  border-radius:12px;overflow:hidden;
  background:var(--dsw-alias-bg-layer-2,#24262c);
}
.dca-pool-row{
  display:grid;
  grid-template-columns:minmax(0,1fr) minmax(0,auto) 160px;
  grid-template-areas:
    "account account credits"
    "probe   probe   actions";
  column-gap:12px;row-gap:4px;align-items:center;
  padding:10px 14px;
  border-top:1px solid var(--dsw-alias-border-l1,#2c2d31);
  font-size:13px;
}
.dca-pool-row:first-of-type{border-top:0}
/* The serving row, findable at a glance: a left accent bar plus a faint tint.
   The bar is what distinguishes it in a long table — a 7% wash alone reads as
   an alternating-row stripe. */
.dca-pool-row-current{
  /* The ONLY marker for the serving account now: a tint strong enough to read at
     a glance plus the accent bar. A 7% wash alone reads as an alternating-row
     stripe in a long table. */
  background:rgba(86,134,254,.14);
  box-shadow:inset 3px 0 0 var(--dsw-alias-brand-primary,#5686fe);
}
.dca-pool-row-head{
  padding:8px 14px;row-gap:1px;
  background:var(--dsw-alias-bg-layer-3,#2a2c33);
  color:var(--dsw-alias-label-tertiary,#999);
  font-size:11px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;
}
.dca-pool-col-account{grid-area:account;min-width:0}
.dca-pool-col-credits{
  grid-area:credits;justify-self:end;text-align:right;font-variant-numeric:tabular-nums;
}
.dca-pool-col-actions{grid-area:actions;justify-self:end}
.dca-pool-card-head{
  display:flex;align-items:center;justify-content:space-between;
  gap:8px 12px;flex-wrap:wrap;
}
.dca-pool-tagline{flex:1 1 auto;min-width:0}
.dca-pool-card-title{margin:0;font-size:13px;font-weight:600;line-height:20px}

.dca-pool-sub{display:block;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#999)}
.dca-pool-actions{display:flex;gap:6px;justify-content:flex-end;align-items:center}
.dca-btn-xs{
  box-sizing:border-box;appearance:none;font:inherit;font-size:12px;line-height:20px;font-weight:500;
  padding:3px 10px;border-radius:8px;cursor:pointer;white-space:nowrap;
  border:1px solid var(--dsw-alias-border-l2,#3a3d45);
  background:var(--dsw-alias-bg-layer-2,#232529);
  color:var(--dsw-alias-label-primary,#e6e6e6);
  transition:background .15s,border-color .15s,opacity .15s;
}
.dca-btn-xs:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed,#777)}
.dca-btn-xs:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dca-btn-xs:disabled{opacity:.5;cursor:default}

.dca-tag{
  display:inline-flex;align-items:center;padding:1px 8px;border-radius:var(--dsw-radius-xl,20px);
  font-size:11px;line-height:16px;white-space:nowrap;
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));
  color:var(--dsw-alias-label-tertiary,#999);
}
.dca-tag-ok{color:var(--dsw-alias-state-success-primary,#3fb950);border-color:currentColor}
.dca-tag-warn{color:var(--dsw-alias-state-warn-primary,#d29922);border-color:currentColor}


/* ---- composer pill ----------------------------------------------------
   Plain composer text, no border or fill at rest: this row is a strip of
   compact controls and a boxed pill among them reads as a form field. The
   padding is only the click target, revealed by hover. */
/* position:relative is load-bearing, not cosmetic: the popover is absolute, and
   without a positioned owner here it anchors to the nearest positioned ancestor
   — the composer card — so it appeared at the card's far-left edge rather than
   above the trigger the user just clicked. */
.dca-chip{position:relative;display:inline-flex;align-items:center;min-width:0}
.dca-chip-trigger{
  appearance:none;display:inline-flex;align-items:center;align-self:stretch;gap:5px;
  padding:2px 6px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;
  font-family:inherit;font-size:12px;line-height:18px;
  color:var(--dsw-alias-label-tertiary,#999);
  white-space:nowrap;cursor:pointer;font-variant-numeric:tabular-nums;
}
.dca-chip-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dca-chip-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dca-chip-trigger-on{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#e6e6e6)}
.dca-chip-mark{opacity:.75;font-size:11px}
/* Anchored to .dca-chip. Right-aligned rather than left so a trigger sitting at
   the right edge of the composer does not push the panel off-screen. */
.dca-pop{
  position:absolute;bottom:calc(100% + 6px);right:0;z-index:20;min-width:250px;max-width:min(340px,80vw);
  padding:12px;border-radius:var(--dsw-radius-lg,16px);
  border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));
  background:var(--dsw-alias-bg-overlay,#26282e);
  box-shadow:0 8px 24px rgba(0,0,0,.28);
  display:flex;flex-direction:column;gap:10px;
  font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,#e6e6e6);
}
.dca-pop-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
/* nowrap: the header is a title plus a small control in a 248px popover, and
   without it the title broke across two lines the moment the control joined it. */
.dca-pop-title{
  flex:none;white-space:nowrap;
  font-size:13px;font-weight:600;
  color:var(--dsw-alias-label-primary,#e6e6e6);
}
.dca-pop-refresh{
  appearance:none;flex:none;display:inline-flex;align-items:center;gap:4px;
  padding:3px 8px 3px 6px;margin-left:auto;
  border:1px solid transparent;border-radius:999px;background:transparent;
  color:var(--dsw-alias-label-secondary,#c6c9d0);
  font:inherit;font-size:11px;line-height:16px;font-weight:500;cursor:pointer;
  transition:background-color .12s ease,border-color .12s ease,color .12s ease;
}
.dca-pop-refresh:hover:not(:disabled){
  background:rgba(127,127,127,.10);
  border-color:var(--dsw-alias-border-l2,#3a3d45);
  color:var(--dsw-alias-label-primary,#e6e6e6);
}
.dca-pop-refresh:disabled{cursor:default;opacity:.6}
.dca-pop-refresh-icon{flex:none}
.dca-pop-refresh-icon-spin{animation:dca-spin .9s linear infinite}
@keyframes dca-spin{to{transform:rotate(360deg)}}
/* The settings pill is the one control that LEAVES the panel, so it carries the
   brand tint while refresh above stays quiet: two equally loud pills would make
   the header read as a toolbar. */
.dca-pop-settings{
  appearance:none;flex:none;display:inline-flex;align-items:center;gap:4px;
  padding:3px 8px 3px 6px;
  border:1px solid rgba(86,134,254,.32);border-radius:999px;
  background:rgba(86,134,254,.12);
  color:var(--dsw-alias-brand-primary,#5686fe);
  font:inherit;font-size:11px;line-height:16px;font-weight:500;cursor:pointer;
}
.dca-pop-settings:hover{background:rgba(86,134,254,.20)}
.dca-pop-settings-icon{font-size:11px;line-height:1}
/* A real table so every balance lands in one right-aligned column. */
.dca-pop-table{width:100%;border-collapse:collapse;font-size:12px;line-height:18px}
.dca-pop-table thead th{
  padding:0 0 7px;font-weight:500;text-align:left;font-size:11px;
  color:var(--dsw-alias-label-tertiary,#999);
  border-bottom:1px solid var(--dsw-alias-border-l1,#2c2d31);
}
.dca-pop-table thead th.dca-pop-num{padding-right:0}
.dca-pop-table tbody td{padding:5px 0;border-top:1px solid transparent;vertical-align:top}
.dca-pop-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
/* The row body is a button so switching accounts is one click, but it must read
   as a row: no border, no fill at rest, the whole cell as the target. */
.dca-pop-switch{
  appearance:none;display:flex;align-items:flex-start;gap:6px;width:100%;
  /* Negative inline margin so the hover fill reaches the panel's edge while the
     text stays aligned with the header above it — the padding does the inset. */
  padding:4px 6px;margin-inline-start:-6px;
  border:0;border-radius:6px;background:transparent;font:inherit;text-align:left;
  color:var(--dsw-alias-label-primary,#e6e6e6);cursor:pointer;min-width:0;
  transition:background-color .12s ease;
}
/* Hover belongs to the SWITCH, not the row: the credits cell is not clickable, so
   lighting it up would promise an action it cannot perform. */
.dca-pop-switch:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dca-pop-switch:active:not(:disabled){background:var(--dsw-alias-interactive-bg-pressed,rgba(127,127,127,.20))}
/* Keyboard gets the same affordance as the pointer, plus an outline: tabbing to a
   row must show which one is about to be switched. */
.dca-pop-switch:focus-visible{
  outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:-1px;
  background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));
}
.dca-pop-switch:disabled{cursor:default}
/* The serving row is already in use, so it is the one row that must NOT look
   clickable: it keeps the underline-free quiet treatment. */
.dca-pop-row-current .dca-pop-name{font-weight:600}
.dca-pop-dot{flex:none;width:7px;height:7px;border-radius:50%;margin-top:6px}
.dca-pop-dot-ok{background:var(--dsw-alias-state-success-primary,#22a06b)}
.dca-pop-dot-bad{background:var(--dsw-alias-state-error-primary,#ef4444)}
.dca-pop-who{display:flex;flex-direction:column;min-width:0}
.dca-pop-name{overflow:hidden;text-overflow:ellipsis}
/* The state goes UNDER the name: a reason string is long, and beside the name in
   a 248px panel it would squeeze the name to a few characters. */
.dca-pop-mark{display:flex;flex-direction:column;gap:1px;margin-top:1px;font-size:11px;line-height:15px}
.dca-pop-mark-current{color:var(--dsw-alias-state-success-primary,#22a06b)}
.dca-pop-mark-reason{color:var(--dsw-alias-state-warn-primary,#f59e0b);min-width:0;overflow-wrap:anywhere}
/* The lapsing warning sits on its OWN line under the figure: the column is
   nowrap and tabular, so an inline span would sit beside the balance and stretch
   the column for every row. */
.dca-pop-soon{
  display:block;margin-top:1px;
  font-size:11px;line-height:15px;font-weight:400;
  color:var(--dsw-alias-state-warn-primary,#f59e0b);
}
.dca-pop-empty{margin:0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
`

    /**
     * The state every tab needs before it can show anything.
     *
     * Without this, a tab rendered while the first fetch is still in flight
     * shows an empty page with no hint that data is on its way — and a failed
     * fetch looked identical to an account with no data.
     */
    function Pending({ error, onRetry }) {
      if (error) {
        return h(
          'div',
          { className: 'dca-card' },
          h('p', { className: 'dca-msg dca-msg-error' }, `${t('common.retryHint')}（${error}）`),
          h(
            'div',
            { className: 'dca-row' },
            h('button', { type: 'button', className: 'dca-btn', onClick: onRetry }, t('common.retry')),
          ),
        )
      }
      return h(
        'div',
        { className: 'dca-card' },
        h('p', { className: 'dca-hint' }, t('common.loading')),
      )
    }

    /**
     * Strip credential material before the raw dump is copied into a bug report.
     *
     * The page's own hint invites pasting this block into an issue, and the
     * masked values are eight characters of a forty-character key — half an AK
     * and half an SK do not belong in public. Only the shape is kept: whether a
     * value is set, and where it came from.
     */
    function redactForReport(status, account) {
      const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
      const out = { status: clone(status), account: clone(account) }
      const credential = out.status?.credential
      if (credential) {
        credential.savedAk = credential.savedAk ? '(已设置)' : null
        credential.savedSk = credential.savedSk ? '(已设置)' : null
      }
      if (out.account) delete out.account.userId
      return out
    }

    /** A small labelled value row. */
    function KV({ name, children }) {
      return h(
        React.Fragment,
        null,
        h('span', { className: 'dca-diag-label' }, name),
        h('span', { className: 'dca-diag-value' }, children),
      )
    }

    /**
     * Add one account, import many, and export the pool.
     *
     * Import takes pasted text rather than a file picker: the browser can read
     * a dropped file, but a paste works for every source a user actually has
     * (the console's CSV contents, a chat message with a key in it, another
     * install's export).
     */
    /**
     * Add accounts.
     *
     * Two paths, both in the reference's shape: a pair typed by hand (this
     * plugin's own route has an AK/SK form, which WorkBuddy does not need
     * because it signs in), and a FILE IMPORT that opens the system picker
     * directly — no ceremony dialog in front of a dialog the OS is about to show
     * anyway. The confirmation appears after the file is read, which is the step
     * that actually needs the user's attention.
     *
     * Export downloads a JSON file rather than copying to the clipboard: the
     * card runs inside the settings panel, where `a[download]` on a same-origin
     * Blob is the reliable way out, and a file is what a user expects when the
     * button says 导出.
     */
    function AccountTools({ onChanged, onResult }) {
      const [ak, setAk] = useState('')
      const [sk, setSk] = useState('')
      const [label, setLabel] = useState('')
      const [busy, setBusy] = useState(null)
      const [preview, setPreview] = useState(null)
      const fileInput = useRef(null)
      /** The picked file's text, held here: the picker closes immediately, so
       *  there is no File on screen between preview and confirm. */
      const importText = useRef('')

      const add = useCallback(async () => {
        if (ak.trim() === '' || sk.trim() === '') {
          onResult({ kind: 'error', text: t('account.needBoth') })
          return
        }
        setBusy('add')
        try {
          const result = await postRoute('/accounts/add', { ak, sk, label })
          if (result.ok) {
            setAk(''); setSk(''); setLabel('')
            onResult({ kind: 'success', text: result.added ? t('pool.added') : t('pool.updated') })
            await onChanged()
          } else {
            onResult({ kind: 'error', text: result.error ?? t('account.saveFail') })
          }
        } catch (error) {
          onResult({ kind: 'error', text: `${t('account.saveFail')}：${error.message}` })
        } finally { setBusy(null) }
      }, [ak, sk, label, onChanged, onResult])

      /** Read the picked file and show what it contains before writing. */
      const readFile = useCallback(async (file) => {
        setBusy('import')
        setPreview(null)
        try {
          const text = await file.text()
          importText.current = text
          const result = await postRoute('/accounts/preview', { text })
          if (result.ok) {
            setPreview({ total: result.total, accounts: result.accounts })
          } else {
            onResult({ kind: 'error', text: result.error ?? t('pool.importEmpty') })
          }
        } catch (error) {
          onResult({ kind: 'error', text: error.message })
        } finally { setBusy(null) }
      }, [onResult])

      const confirmImport = useCallback(async () => {
        setBusy('import')
        try {
          const result = await postRoute('/accounts/import', { text: importText.current })
          setPreview(null)
          importText.current = ''
          if (result.ok) {
            onResult({
              kind: 'success',
              text: t('pool.importResult')
                .replace('{added}', result.added)
                .replace('{updated}', result.updated)
                .replace('{skipped}', result.skipped),
            })
            await onChanged()
          } else {
            onResult({ kind: 'error', text: result.error ?? t('pool.importEmpty') })
          }
        } catch (error) {
          onResult({ kind: 'error', text: error.message })
        } finally { setBusy(null) }
      }, [onChanged, onResult])

      /** Download the store as a JSON file. */
      const doExport = useCallback(async () => {
        setBusy('export')
        try {
          const result = await getRoute('/accounts/export')
          if (!result.ok || typeof result.text !== 'string') {
            onResult({ kind: 'error', text: result.error ?? t('pool.exportFailed') })
            return
          }
          if (typeof document === 'undefined' || typeof Blob === 'undefined') {
            onResult({ kind: 'warn', text: result.text })
            return
          }
          const stamp = new Date()
          const pad = (n) => String(n).padStart(2, '0')
          const name = `codearts-accounts-${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}.json`
          const blob = new Blob([result.text], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = name
          document.body.appendChild(anchor)
          anchor.click()
          anchor.remove()
          URL.revokeObjectURL(url)
          onResult({ kind: 'success', text: t('pool.exported').replace('{name}', name) })
        } catch (error) {
          onResult({ kind: 'error', text: error.message })
        } finally { setBusy(null) }
      }, [onResult])

      return h(
        'div',
        { className: 'dca-card' },
        h('h3', { className: 'dca-card-title' }, t('pool.addTitle')),
        // One row of inputs with their labels INSIDE (placeholder only). The
        // reference is this shape: three fields across, no label line above each,
        // because a card about adding an account does not need to explain what an
        // AK is a second time — the placeholders do it.
        h(
          'div',
          { className: 'dca-fields' },
          h('input', {
            id: 'dca-ak2',
            className: 'dca-input',
            value: ak,
            autoComplete: 'off',
            placeholder: t('account.ak'),
            'aria-label': t('account.ak'),
            onChange: (e) => setAk(e.target.value),
          }),
          h('input', {
            id: 'dca-sk2',
            className: 'dca-input',
            type: 'password',
            value: sk,
            autoComplete: 'off',
            placeholder: t('account.sk'),
            'aria-label': t('account.sk'),
            onChange: (e) => setSk(e.target.value),
          }),
          h('input', {
            id: 'dca-label',
            className: 'dca-input',
            value: label,
            autoComplete: 'off',
            placeholder: t('pool.addLabelPlaceholder'),
            'aria-label': t('pool.addLabel'),
            onChange: (e) => setLabel(e.target.value),
          }),
        ),
        h(
          'div',
          { className: 'dca-pool-actions-group' },
          h(
            'button',
            { type: 'button', className: 'dca-btn dca-btn-primary', onClick: add, disabled: busy !== null },
            busy === 'add' ? t('account.saving') : t('pool.add'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dca-btn',
              disabled: busy !== null,
              onClick: () => fileInput.current?.click(),
            },
            busy === 'import' ? t('pool.importing') : t('pool.import'),
          ),
          h(
            'button',
            { type: 'button', className: 'dca-btn', onClick: doExport, disabled: busy !== null },
            t('pool.export'),
          ),
        ),
        // Mounted with the section, not inside the confirmation: the button must
        // be able to open the picker before any dialog exists, and clearing the
        // value after each pick lets the same file be chosen twice.
        h('input', {
          ref: fileInput,
          type: 'file',
          accept: 'application/json,.json,.csv,.txt',
          className: 'dca-file-input',
          onChange: (event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file !== undefined) void readFile(file)
          },
        }),
        preview !== null
          ? h(
              'div',
              { className: 'dca-transfer-dialog', role: 'dialog', 'aria-label': t('pool.import') },
              h(
                'p',
                { className: 'dca-hint' },
                t('pool.previewTotal').replace('{total}', preview.total),
              ),
              h(
                'ul',
                { className: 'dca-transfer-list' },
                ...preview.accounts.map((entry) =>
                  h(
                    'li',
                    { key: entry.index },
                    h(
                      'label',
                      null,
                      h('input', { type: 'checkbox', checked: true, readOnly: true }),
                      ' ',
                      entry.label ?? entry.akMasked ?? `#${entry.index}`,
                    ),
                  ),
                ),
              ),
              h(
                'div',
                { className: 'dca-transfer-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dca-btn',
                    onClick: () => { setPreview(null); importText.current = '' },
                  },
                  t('pool.cancel'),
                ),
                h(
                  'button',
                  { type: 'button', className: 'dca-btn dca-btn-primary', onClick: confirmImport, disabled: busy !== null },
                  busy === 'import'
                    ? t('pool.importing')
                    : t('pool.importConfirm').replace('{count}', preview.accounts.length),
                ),
              ),
            )
          : null,
        h('p', { className: 'dca-hint' }, t('pool.exportHint')),
      )
    }

    /**
     * The account pool.
     *
     * Layout follows the reference card: a title row naming the account in use,
     * the switch block above the table, then a two-line row per account, then
     * the batch action. Check-in is ONE button for the whole table — never one
     * control per account, which would make one daily bonus cost one click per
     * account and report one outcome per account.
     */
    function AccountPool({
      pool,
      busyId,
      busy,
      onActivate,
      onRemove,
      autoOn,
      onToggleAuto,
      onRename,
    }) {
      /** Which row is being renamed, and its draft text. */
      const [editingId, setEditingId] = useState(null)
      const [draftLabel, setDraftLabel] = useState('')

      const beginRename = useCallback((account) => {
        setEditingId(account.id)
        // Start from the current name, EXCEPT when it is the derived fallback
        // (a masked AK): that is a placeholder, not a name the user chose, and
        // prefilling it would make them delete it before typing.
        setDraftLabel(account.renameable === false ? '' : (account.label ?? ''))
      }, [])

      const cancelRename = useCallback(() => {
        setEditingId(null)
        setDraftLabel('')
      }, [])

      const commitRename = useCallback(async (id) => {
        const next = draftLabel.trim()
        setEditingId(null)
        setDraftLabel('')
        // An unchanged or empty draft is a cancel, not a request.
        if (next === '') return
        await onRename(id, next)
      }, [draftLabel, onRename])
      const accounts = pool?.accounts ?? []
      const active = accounts.find((account) => account.active)
      return h(
        'div',
        { className: 'dca-pool' },

        h(
          'div',
          { className: 'dca-pool-card-head' },
          h('h2', { className: 'dca-title' }, t('pool.title')),
          h('p', { className: 'dca-hint dca-pool-tagline' }, t('pool.tagline')),
          active ? h('span', { className: 'dca-badge' }, `${t('pool.inUse')}${active.label}`) : null,
        ),

        // One switch, no card around it and no explanatory paragraph under it:
        // the label says what it does, and the paragraph restated the same thing
        // in a box that made a single control look like a section.
        h(
          'div',
          { className: 'dca-switchrow' },
          h(
            'label',
            { className: 'dca-sw' },
            h('input', {
              type: 'checkbox',
              checked: autoOn === true,
              disabled: busy,
              onChange: () => onToggleAuto(autoOn !== true),
            }),
            h('span', { className: 'dca-sw-track' }),
          ),
          h('b', { className: 'dca-modebar-label' }, t('pool.autoTitle')),
        ),

        accounts.length === 0
          ? h('p', { className: 'dca-hint' }, t('pool.empty'))
          : h(
              'div',
              { className: 'dca-pool-table' },
              h(
                'div',
                { className: 'dca-pool-row dca-pool-row-head' },
                h('span', { className: 'dca-pool-col-account' }, t('pool.colAccount')),
                h('span', { className: 'dca-pool-col-credits' }, t('pool.colCredits')),
                // An empty cell on purpose: the grid template names an `actions`
                // area, and without a box the credits label would claim that
                // track and stop lining up with the values below it. The buttons
                // speak for themselves, so it carries no text.
                h('span', { className: 'dca-pool-col-actions', 'aria-hidden': true }),
              ),
              ...accounts.map((account) => {
                const rowBusy = busyId === account.id
                const checkin = account.checkin
                return h(
                  'div',
                  {
                    key: account.id,
                    className: `dca-pool-row${account.active ? ' dca-pool-row-current' : ''}`,
                  },
                  h(
                    'div',
                    { className: 'dca-pool-col-account' },
                    h(
                      'div',
                      { className: 'dca-pool-account-row' },
                      editingId === account.id
                        ? h('input', {
                            type: 'text',
                            className: 'dca-input dca-rename',
                            value: draftLabel,
                            autoFocus: true,
                            'aria-label': t('pool.rename'),
                            placeholder: t('pool.renamePlaceholder'),
                            onChange: (event) => setDraftLabel(event.target.value),
                            onKeyDown: (event) => {
                              if (event.key === 'Enter') void commitRename(account.id)
                              // Escape must not save: an accidental click into the
                              // field is the common way a user arrives here.
                              else if (event.key === 'Escape') cancelRename()
                            },
                            onBlur: () => void commitRename(account.id),
                          })
                        : h(
                            'button',
                            {
                              type: 'button',
                              className: 'dca-rename-btn',
                              title: t('pool.renameHint'),
                              onClick: () => beginRename(account),
                            },
                            h('b', null, account.label),
                            h('span', { className: 'dca-rename-glyph', 'aria-hidden': true }, '✎'),
                          ),
                    ),
                    h(
                      'div',
                      { className: 'dca-pool-probe' },
                      account.error
                        ? h('span', { className: 'dca-msg-error' }, account.error)
                        : h('span', null, account.accountName ?? account.akMasked),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'dca-pool-credits-row' },
                    h('span', null, account.credit ? Number(account.credit.remain).toLocaleString() : '—'),
                    account.credit?.plan ? h('span', { className: 'dca-pool-sub' }, account.credit.plan) : null,
                    // Warn about credits that lapse. The amount is real; the
                    // deadline is not knowable from this gateway, so the chip
                    // states the amount and never a date it would have to invent.
                    account.credit?.expiring > 0
                      ? h(
                          'span',
                          {
                            className: 'dca-tag dca-tag-warn',
                            title: t('pool.expiringHint'),
                          },
                          t('pool.expiring').replace(
                            '{amount}',
                            Number(account.credit.expiring).toLocaleString(),
                          ),
                        )
                      : null,
                  ),
                  h(
                    'div',
                    { className: 'dca-pool-probe-cell' },
                    h(
                      'div',
                      { className: 'dca-pool-probe-main' },
                      checkin?.claimedToday
                        ? t('pool.checkinDone')
                        : checkin?.claimable
                          ? t('pool.checkinPending')
                          : '—',
                    ),
                  ),
                  h(
                    'div',
                    { className: 'dca-pool-col-actions' },
                    h(
                      'div',
                      { className: 'dca-pool-actions' },
                      account.active
                        ? null
                        : h(
                            'button',
                            {
                              type: 'button',
                              className: 'dca-btn-xs',
                              disabled: rowBusy || busy,
                              onClick: () => onActivate(account.id),
                            },
                            t('pool.use'),
                          ),
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dca-btn-xs',
                          disabled: rowBusy || busy,
                          onClick: () => onRemove(account),
                        },
                        t('pool.remove'),
                      ),
                    ),
                  ),
                )
              }),
            ),

      )
    }

    // ── credentials tab ────────────────────────────────────────────────────

    function AccountTab({ status, account, pool, onChanged }) {
      const [busy, setBusy] = useState(null)
      const [busyId, setBusyId] = useState(null)
      const [notice, setNotice] = useState(null)

      const credential = status?.credential
      const reload = onChanged

      /** One place to report an outcome, so every action gets the same voice. */
      const report = useCallback((next) => setNotice(next), [])

      const activate = useCallback(async (id) => {
        setBusyId(id)
        try {
          const result = await postRoute('/accounts/activate', { id })
          if (!result.ok) report({ kind: 'error', text: result.error ?? t('common.retry') })
          await reload()
        } catch (error) {
          report({ kind: 'error', text: error.message })
        } finally { setBusyId(null) }
      }, [reload, report])

      const remove = useCallback(async (account) => {
        const ask = t('pool.removeConfirm')
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(ask)) return
        setBusyId(account.id)
        try {
          await postRoute('/accounts/remove', { id: account.id })
          report({ kind: 'success', text: t('pool.remove') })
          await reload()
        } catch (error) {
          report({ kind: 'error', text: error.message })
        } finally { setBusyId(null) }
      }, [reload, report])

      /** Rename one account; the pool's inline editor calls this. */
      const rename = useCallback(async (id, label) => {
        try {
          const result = await postRoute('/accounts/rename', { id, label })
          if (!result.ok) report({ kind: 'error', text: result.error ?? t('pool.renameFailed') })
          await reload()
        } catch (error) {
          report({ kind: 'error', text: `${t('pool.renameFailed')}：${error.message}` })
        }
      }, [reload, report])

      const toggleAuto = useCallback(async (enabled) => {
        setBusy('auto')
        try {
          const result = await postRoute('/checkin/auto', { enabled })
          if (result.summary) {
            report({
              kind: result.summary.failures.length === 0 ? 'success' : 'warn',
              text: t('pool.result')
                .replace('{claimed}', result.summary.claimed)
                .replace('{failed}', result.summary.failures.length),
            })
          }
          await reload()
        } catch (error) {
          report({ kind: 'error', text: error.message })
        } finally { setBusy(null) }
      }, [reload, report])

      const test = useCallback(async () => {
        setBusy('test')
        setNotice(null)
        try {
          const result = await getRoute('/test')
          const lines = (result.steps ?? []).map((step) => `${step.ok ? '✓' : '✗'} ${step.step}：${step.detail}`)
          setNotice({ kind: result.ok ? 'success' : 'error', text: lines.join('\n') || t('diag.none'), pre: true })
          await onChanged()
        } catch (error) {
          setNotice({ kind: 'error', text: error.message })
        } finally {
          setBusy(null)
        }
      }, [onChanged])

      const refresh = useCallback(async () => {
        setBusy('refresh')
        setNotice(null)
        try {
          const result = await getRoute('/refresh')
          setNotice({
            kind: result.ok ? 'success' : 'warning',
            text: result.ok
              ? `${t('models.count')}：${result.models}`
              : (result.error ?? t('diag.none')),
          })
          await onChanged()
        } catch (error) {
          setNotice({ kind: 'error', text: error.message })
        } finally {
          setBusy(null)
        }
      }, [onChanged])

      // Destructive and irreversible from the UI, so it asks first — the button
      // sits at the same weight as the harmless refresh beside it.
      const clear = useCallback(async () => {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          if (!window.confirm(t('account.clearConfirm'))) return
        }
        setBusy('clear')
        setNotice(null)
        try {
          await postRoute('/clear', {})
          setNotice({ kind: 'success', text: t('account.cleared') })
          await onChanged()
        } catch (error) {
          setNotice({ kind: 'error', text: `${t('account.clearFail')}：${error.message}` })
        } finally {
          setBusy(null)
        }
      }, [onChanged])

      const accounts = pool?.accounts ?? []
      return h(
        'div',
        { className: 'dca-page' },
        // The pool below renders its own head — title, tagline and the in-use
        // badge — so the page must not render a second one above it. It did, and
        // the two read as a duplicated heading with two different sentences
        // under it.

        // One line for every outcome of every action on this tab, announced.
        notice
          ? h(
              'p',
              {
                className: `dca-msg dca-msg-${
                  notice.kind === 'error' ? 'error' : notice.kind === 'success' ? 'ok' : 'warn'
                }`,
                role: notice.kind === 'error' ? 'alert' : 'status',
                'aria-live': notice.kind === 'error' ? 'assertive' : 'polite',
              },
              notice.text,
            )
          : null,

        // The pool renders its own head, its own switch block, the table and the
        // batch action — the order the reference card uses. The daily switch is
        // passed in rather than drawn as a separate card, so it sits above the
        // table where the reference puts it.
        h(AccountPool, {
          pool,
          busyId,
          busy: busy === 'checkin' || busy === 'auto',
          onActivate: activate,
          onRemove: remove,
          autoOn: pool?.autoCheckin === true,
          onToggleAuto: toggleAuto,
          onRename: rename,
        }),

        h(AccountTools, { onChanged, onResult: report }),

        accounts.length === 0 || credential?.error
          ? null
          : h(
              'div',
              { className: 'dca-card dca-card-plain' },
              h(
                'div',
                { className: 'dca-row' },
                h('button', { type: 'button', className: 'dca-btn', onClick: test, disabled: busy !== null },
                  busy === 'test' ? t('account.testing') : t('account.test')),
                h('button', { type: 'button', className: 'dca-btn', onClick: clear, disabled: busy !== null },
                  t('account.clear')),
              ),
              h('p', { className: 'dca-hint' }, t('account.whereToGetBody')),
            ),
      )
    }

    // ── models tab ─────────────────────────────────────────────────────────

    /**
     * The model catalog.
     *
     * Row layout follows the reference: line one carries the enable checkbox,
     * the name, its ratio and any badge on the left, with the row's own flags on
     * the right; line two carries the facts on the left, indented to the name so
     * the two lines read as one block rather than a checkbox beside two toppled
     * fragments.
     */
    /**
     * The model catalog.
     *
     * Each row carries its own selection checkbox and its own capability
     * switches, exactly as the reference does — a model row is where a user
     * decides what this provider may send, so the controls live on the row
     * rather than behind an edit dialog. Edits are local until saved; the
     * reference uses the same save/discard posture for this panel.
     */
    function ModelsTab({ models, status, onRefresh, onSaved }) {
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      /** Local draft: null means "no unsaved edits". */
      const [enabledIds, setEnabledIds] = useState(null)
      const [overrides, setOverrides] = useState({})

      const list = models?.models ?? []
      const selectionIsDefault = models?.enabledIds === null || models?.enabledIds === undefined
      // The rows as they should LOOK: the draft when there is one, the saved
      // state otherwise. Without this the first paint after an edit would snap
      // back to the saved state.
      const isEnabled = (id) => {
        if (enabledIds !== null) return enabledIds.includes(id)
        // No draft: trust what the Host said about the saved selection. When it
        // sent no list at all, everything is offered.
        const saved = models?.enabledIds
        if (Array.isArray(saved)) return saved.includes(id)
        return true
      }
      const dirty = enabledIds !== null || Object.keys(overrides).length > 0

      const toggle = useCallback((id, next) => {
        setEnabledIds((current) => {
          const base = current ?? (selectionIsDefault ? list.map((m) => m.id) : (models?.enabledIds ?? []))
          return next ? [...new Set([...base, id])] : base.filter((entry) => entry !== id)
        })
      }, [list, models, selectionIsDefault])

      const setOverride = useCallback((id, patch) => {
        setOverrides((current) => ({
          ...current,
          [id]: { ...(current[id] ?? {}), ...patch },
        }))
      }, [])

      const save = useCallback(async () => {
        setBusy(true)
        try {
          const payload = {
            // A draft that matches the whole roster is the same thing as "all",
            // and storing `null` keeps the user's intent ("everything") intact
            // so a model the upstream adds later still appears.
            enabledIds:
              enabledIds === null
                ? (selectionIsDefault ? null : (models?.enabledIds ?? []))
                : enabledIds.length === list.length
                  ? null
                  : enabledIds,
            overrides,
          }
          const result = await postRoute('/models/select', payload)
          // NOT just `result.ok`: a mis-routed request can land on a read route
          // that also answers `ok: true`, which makes a save look successful
          // while nothing was written. The acknowledgement carries the counts.
          if (result.ok && typeof result.enabled === 'number') {
            setEnabledIds(null)
            setOverrides({})
            setNotice({ kind: 'success', text: t('models.saved') })
            await onSaved()
          } else {
            setNotice({ kind: 'error', text: result.error ?? t('models.saveFailed') })
          }
        } catch (error) {
          setNotice({ kind: 'error', text: `${t('models.saveFailed')}：${error.message}` })
        } finally {
          setBusy(false)
        }
      }, [enabledIds, overrides, list, models, onSaved, selectionIsDefault])

      const discard = useCallback(() => {
        setEnabledIds(null)
        setOverrides({})
        setNotice(null)
      }, [])

      const refresh = useCallback(async () => {
        setBusy(true)
        try {
          const result = await getRoute('/refresh')
          setNotice(
            result.ok
              ? { kind: 'success', text: t('models.refreshed') }
              : { kind: 'warn', text: result.error ?? t('models.refreshFailed') },
          )
          await onRefresh()
        } catch (error) {
          setNotice({ kind: 'error', text: `${t('models.refreshFailed')}：${error.message}` })
        } finally {
          setBusy(false)
        }
      }, [onRefresh])

      const source =
        models?.source === 'gateway' ? t('models.sourceGateway') : t('models.sourceFallback')

      return h(
        'div',
        { className: 'dca-page' },
        h(
          'div',
          { className: 'dca-pool-card-head' },
          h(
            'div',
            null,
            h(
              'h2',
              { className: 'dca-title' },
              t('models.title'),
              dirty ? h('span', { className: 'dca-dirty' }, t('models.dirty')) : null,
            ),
          ),
          h(
            'div',
            { className: 'dca-pool-actions-group' },
            h('span', { className: 'dca-pool-tag' }, source),
            h(
              'button',
              { type: 'button', className: 'dca-btn', onClick: refresh, disabled: busy },
              busy ? t('account.refreshing') : t('models.refresh'),
            ),
          ),
        ),
        h('p', { className: 'dca-hint' }, t('models.hint')),
        h('p', { className: 'dca-hint' }, t('models.pickerHint')),
        models?.error ? h('p', { className: 'dca-msg dca-msg-warn' }, models.error) : null,
        notice
          ? h(
              'p',
              {
                className: `dca-msg dca-msg-${
                  notice.kind === 'error' ? 'error' : notice.kind === 'success' ? 'ok' : 'warn'
                }`,
                role: 'status',
                'aria-live': 'polite',
              },
              notice.text,
            )
          : null,
        h(
          'div',
          { className: 'dca-models' },
          list.length === 0
            ? h('p', { className: 'dca-hint' }, t('models.empty'))
            : h(
                React.Fragment,
                null,
                ...list.map((model) => {
                  const on = isEnabled(model.id)
                  const override = overrides[model.id] ?? model.overrides ?? {}
                  const images = typeof override.images === 'boolean' ? override.images : model.supportsImages
                  return h(
                    'div',
                    { key: model.id, className: `dca-model${on ? '' : ' dca-model-off'}` },
                    h(
                      'div',
                      { className: 'dca-model-head' },
                      h(
                        'div',
                        { className: 'dca-model-name' },
                        h('input', {
                          type: 'checkbox',
                          checked: on,
                          'aria-label': model.name,
                          className: 'dca-model-check',
                          onChange: (event) => toggle(model.id, event.target.checked),
                        }),
                        h('b', null, model.name),
                        model.ratio
                          ? h(
                              'span',
                              { className: 'dca-model-ratio' },
                              `x${String(model.ratio).replace(/x$/i, '')}`,
                            )
                          : null,
                      ),
                      h(
                        'div',
                        { className: 'dca-model-controls' },
                        h(
                          'label',
                          { className: 'dca-model-flag' },
                          h('input', {
                            type: 'checkbox',
                            checked: images === true,
                            disabled: !on,
                            onChange: (event) =>
                              setOverride(model.id, { images: event.target.checked }),
                          }),
                          t('models.images'),
                        ),
                        model.strengths?.length
                          ? h(
                              'label',
                              { className: 'dca-model-flag' },
                              h('input', {
                                type: 'checkbox',
                                checked: override.allowOff !== false,
                                disabled: !on,
                                onChange: (event) =>
                                  setOverride(model.id, { allowOff: event.target.checked }),
                              }),
                              t('models.allowOff'),
                            )
                          : null,
                      ),
                    ),
                    h(
                      'div',
                      { className: 'dca-model-details' },
                      h(
                        'div',
                        { className: 'dca-model-meta' },
                        h(
                          'span',
                          { className: 'dca-num' },
                          `${t('models.colContext')} ${formatTokens(model.context)}`,
                        ),
                        h(
                          'span',
                          { className: 'dca-num' },
                          `${t('models.colOutput')} ${formatTokens(model.maxOutput)}`,
                        ),
                        // The default thinking level is a CHOICE, not a caption:
                        // a user running a reasoning model wants to decide how
                        // much it thinks before each request, and the picker
                        // cannot express a per-model default on its own.
                        model.strengths?.length
                          ? h(
                              'label',
                              { className: 'dca-effort' },
                              h('span', null, t('models.effort')),
                              h(
                                'select',
                                {
                                  className: 'dca-effort-select',
                                  value: override.defaultStrength ?? model.defaultStrength ?? model.strengths[0],
                                  disabled: !on,
                                  'aria-label': `${t('models.effort')} — ${model.name}`,
                                  onChange: (event) =>
                                    setOverride(model.id, { defaultStrength: event.target.value }),
                                },
                                ...(model.allowOff !== false ? ['off'] : []).map((level) =>
                                  h('option', { key: level, value: level }, effortLabel(level)),
                                ),
                                ...model.strengths.map((level) =>
                                  h('option', { key: level, value: level }, effortLabel(level)),
                                ),
                              ),
                            )
                          : null,
                        h('span', { className: 'dca-id' }, model.id),
                      ),
                    ),
                  )
                }),
              ),
        ),
        h('p', { className: 'dca-hint' }, t('models.footnote')),

        // The action bar is ALWAYS present and merely disabled when there is
        // nothing to save. A bar that appears only once something is dirty moves
        // under the pointer exactly when the user is looking for it.
        h(
          'div',
          { className: 'dca-model-actions' },
          h(
            'a',
            {
              className: 'dca-cheer',
              href: 'https://github.com/Jensen0925/dsh-connect-codearts',
              target: '_blank',
              rel: 'noopener noreferrer',
            },
            t('models.cheer'),
            h('span', { className: 'dca-cheer-star', 'aria-hidden': true }, '★'),
          ),
          notice?.kind === 'error'
            ? h('span', { className: 'dca-model-save-error' }, notice.text)
            : null,
          h(
            'div',
            { className: 'dca-model-actions-buttons' },
            h(
              'button',
              {
                type: 'button',
                className: 'dca-btn',
                disabled: !dirty || busy,
                onClick: discard,
              },
              t('models.discard'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dca-btn dca-btn-primary',
                // Never let the last enabled model be removed: an empty picker
                // has no model to select and no way back from inside the picker.
                disabled: !dirty || busy || (enabledIds !== null && enabledIds.length === 0),
                onClick: save,
              },
              busy ? t('account.saving') : t('models.save'),
            ),
          ),
        ),
      )
    }

    // ── diagnostics tab ────────────────────────────────────────────────────

    function DiagnosticsTab({ status, account }) {
      // `mono` marks a machine value a user copies verbatim; `bad` marks a field
      // that is reporting a failure, so a wall of same-coloured rows still shows
      // where the problem is. Both are the reference's own conventions.
      const rows = [
        { label: t('diag.provider'), value: status?.provider ?? '—' },
        { label: t('diag.gateway'), value: status?.settings?.gateway ?? t('diag.gatewayDefault'), mono: true },
        { label: t('diag.credentialPath'), value: status?.credential?.pathInUse ?? status?.credential?.path ?? '—', mono: true },
        { label: t('models.source'), value: status?.catalog?.source ?? '—' },
        { label: t('models.count'), value: String(status?.catalog?.models ?? 0) },
        { label: t('models.refreshedAt'), value: formatTime(status?.catalog?.refreshedAt) },
        {
          label: t('diag.catalogError'),
          value: status?.catalog?.error ?? t('diag.none'),
          bad: Boolean(status?.catalog?.error),
        },
        {
          label: t('diag.credentialError'),
          value: status?.credential?.error ?? t('diag.none'),
          bad: Boolean(status?.credential?.error),
        },
        // The settings-page gates, reported rather than guessed: without a Config
        // schema the Host emits no namespace, and Settings → Models then hides
        // this provider's row with no error anywhere.
        {
          label: t('diag.configSchema'),
          value: status?.registration?.configSchema
            ? (status.registration.settingsNs ?? t('diag.none'))
            : t('diag.schemaMissing'),
          bad: status?.registration?.configSchema !== true,
          mono: status?.registration?.configSchema === true,
        },
      ]

      return h(
        'div',
        { className: 'dca-page' },
        h(
          'div',
          { className: 'dca-pool-card-head' },
          h('h2', { className: 'dca-title' }, t('diag.title')),
          h('p', { className: 'dca-hint dca-pool-tagline' }, t('diag.hint')),
        ),
        h(
          'div',
          { className: 'dca-diag' },
          ...rows.map((row) =>
            h(
              'div',
              { key: row.label, className: 'dca-diag-row' },
              h('span', { className: 'dca-diag-label' }, row.label),
              h(
                'span',
                {
                  className: `dca-diag-value${row.mono ? ' dca-diag-mono' : ''}${
                    row.bad ? ' dca-diag-bad' : ''
                  }`,
                },
                row.value,
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dca-card' },
          h('h3', { className: 'dca-card-title' }, t('diag.rawTitle')),
          h('p', { className: 'dca-hint' }, t('diag.rawHint')),
          h('pre', { className: 'dca-pre' }, JSON.stringify(redactForReport(status, account), null, 2)),
        ),
      )
    }

    // ── the settings nav glyph ────────────────────────────────────────────

    /**
     * The row's icon.
     *
     * The shell asks for a square edge and says whether this row is selected;
     * honouring both keeps the glyph on the same rhythm as the built-in rows'
     * own icons. It is registered under the SAME id as the settings section —
     * that pairing is how the shell knows which row the glyph belongs to, and an
     * unmatched id never renders at all.
     */
    function NavIcon(props) {
      const edge = typeof props?.size === 'number' ? props.size : 16
      return h('img', {
        src: NAV_ICON,
        alt: '',
        'aria-hidden': true,
        width: edge,
        height: edge,
        style: {
          display: 'block',
          borderRadius: '4px',
          flexShrink: 0,
          opacity: props?.active === false ? 0.75 : 1,
        },
      })
    }

    // ── the settings page ──────────────────────────────────────────────────

    function SettingsPage() {
      const [tab, setTab] = useState('account')
      const [status, setStatus] = useState(null)
      const [models, setModels] = useState(null)
      const [account, setAccount] = useState(null)
      const [pool, setPool] = useState(null)
      const [error, setError] = useState(null)

      const load = useCallback(async () => {
        // Three independent reads. Settled rather than all: no single route may
        // blank the whole page, and each surface decides for itself what it can
        // show.
        const [statusR, modelsR, accountR, poolR] = await Promise.allSettled([
          getRoute('/status'),
          getRoute('/models'),
          getRoute('/account'),
          getRoute('/accounts'),
        ])
        if (statusR.status === 'fulfilled') setStatus(statusR.value)
        if (modelsR.status === 'fulfilled') setModels(modelsR.value)
        if (accountR.status === 'fulfilled') setAccount(accountR.value)
        if (poolR.status === 'fulfilled') setPool(poolR.value)

        const failed = [
          statusR.status === 'rejected' ? `/status：${statusR.reason.message}` : null,
          modelsR.status === 'rejected' ? `/models：${modelsR.reason.message}` : null,
        ].filter(Boolean)
        // /account failing is expected before a credential exists, and the
        // credentials tab already explains that state, so it is not an error.
        setError(failed.length > 0 ? failed.join('；') : null)
      }, [])

      useEffect(() => {
        void load()
        // The page is only on screen while Settings is open; re-reading it on
        // the same five-minute cadence as the Host keeps the balance and the
        // catalog from going stale under a user who leaves the panel open.
        const timer = setInterval(() => void load(), 5 * 60 * 1000)
        return () => clearInterval(timer)
      }, [load])

      const tabs = [
        ['account', t('tab.account')],
        ['models', t('tab.models')],
        ['diagnostics', t('tab.diagnostics')],
      ]

      return h(
        'div',
        { className: 'dca-page' },
        h(
          'div',
          { role: 'tablist', className: 'dca-tabs' },
          ...tabs.map(([id, label]) =>
            h(
                'button',
                {
                  key: id,
                  type: 'button',
                  role: 'tab',
                  id: `dca-tab-${id}`,
                  'aria-selected': tab === id,
                  'aria-controls': 'dca-tabpanel',
                  // Roving tabindex: the strip is one tab stop, arrows move
                  // within it. Without this a keyboard user tabs three times
                  // where they expect to arrow once.
                  tabIndex: tab === id ? 0 : -1,
                  className: `dca-tab${tab === id ? ' dca-tab-on' : ''}`,
                  onClick: () => setTab(id),
                  onKeyDown: (event) => {
                    const order = tabs.map(([key]) => key)
                    const at = order.indexOf(tab)
                    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                      event.preventDefault()
                      setTab(order[(at + 1) % order.length])
                    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                      event.preventDefault()
                      setTab(order[(at - 1 + order.length) % order.length])
                    } else if (event.key === 'Home') {
                      event.preventDefault()
                      setTab(order[0])
                    } else if (event.key === 'End') {
                      event.preventDefault()
                      setTab(order[order.length - 1])
                    }
                  },
                },
                label,
            ),
          ),
        ),
        h(
          'div',
          { role: 'tabpanel', id: 'dca-tabpanel', 'aria-labelledby': `dca-tab-${tab}` },
          // Nothing has loaded yet: show one honest pending card instead of
          // three tabs that each render a blank page.
          status === null && models === null
            ? h(Pending, { error, onRetry: load })
            : tab === 'account'
              ? h(AccountTab, { status, account, pool, onChanged: load })
              : tab === 'models'
                ? h(ModelsTab, { models, status, onRefresh: load, onSaved: load })
                : h(DiagnosticsTab, { status, account }),
        ),
        // A later refresh failure keeps the loaded content on screen and only
        // adds the error line, so the page does not flash back to empty.
        status !== null || models !== null
          ? error
            ? h('p', { className: 'dca-msg dca-msg-error', role: 'alert' }, error)
            : null
          : null,
      )
    }

    // ── the composer chip ──────────────────────────────────────────────────

    /**
     * The credit reading beside the composer.
     *
     * Rendered as a slot entry inside the composer dock, so it takes the
     * space the Host allocates instead of floating over other controls.
     */
    /**
     * Display names for reasoning levels.
     *
     * The picker already localises these via the adapter's reasoning metadata;
     * the model page printed the raw id, so the same level read `high` in one
     * place and 高 in the other.
     */
    const EFFORT_LABELS = {
      off: ['关闭', 'Off'],
      low: ['低', 'Low'],
      medium: ['中', 'Medium'],
      high: ['高', 'High'],
      max: ['最高', 'Max'],
      xhigh: ['极高', 'Extra high'],
    }

    /** One reasoning level in the active language, falling back to its id. */
    function effortLabel(id) {
      const pair = EFFORT_LABELS[id]
      if (!pair) return id
      return isChinese() ? pair[0] : pair[1]
    }

    /** Credits with the grouping a balance deserves: 7,424.92. */
    function formatCredits(value) {
      const n = Number(value)
      if (!Number.isFinite(n)) return '—'
      return n.toLocaleString(undefined, { maximumFractionDigits: 2 })
    }

    /**
     * Which colour the row's dot takes.
     *
     * Green means "this account can serve a request right now", red means it
     * cannot — a failed probe or a credential the gateway rejected. Amber is
     * reserved for "usable but something to know" (nothing can be claimed, a
     * balance lapsing), so the panel does not paint a healthy account as broken.
     */
    function dotTone(account) {
      if (account.error) return ' dca-pop-dot-bad'
      return ' dca-pop-dot-ok'
    }

    function ComposerChip(props) {
      const [usage, setUsage] = useState(null)
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState(false)
      const container = useRef(null)
      const openSettings = props?.openSettings

      // Only speak up when this session is actually pointed at a 码道 model.
      // Without this the readout would sit in every session's composer,
      // including sessions that can never route a request here — noise for
      // anyone not using this provider, and a misleading figure for anyone
      // who is using a different one.
      //
      // `next` wins over `lastUsed`: a selection that has landed but not yet
      // been sent is still the one the composer is displaying. Both are
      // optional, so a host without this projection simply renders the pill
      // (fail-open) rather than hiding a working readout.
      const projection = props?.useProjection ? props.useProjection('modelSelection') : undefined
      const selected = projection?.next ?? projection?.lastUsed
      const selectedProvider = typeof selected?.provider === 'string' ? selected.provider : undefined
      const ownsSelection = selectedProvider === undefined || selectedProvider === PROVIDER_ID

      const load = useCallback(async () => {
        // Two reads: `/account` is the serving credential and the balance the
        // pill shows, `/accounts` is the pool the panel lists. Settled rather
        // than all — a pool read failing must not blank a working pill.
        const [accountR, poolR] = await Promise.allSettled([
          getRoute('/account'),
          getRoute('/accounts'),
        ])
        setUsage({
          ...(accountR.status === 'fulfilled' ? accountR.value : { ok: false }),
          pool: poolR.status === 'fulfilled' ? poolR.value : null,
        })
      }, [])

      useEffect(() => {
        // Nothing is fetched while another provider is selected: the readout is
        // hidden then, and a 5-minute poll would ask the gateway on behalf of
        // every session in the app.
        if (!ownsSelection) return undefined
        void load()
        const timer = setInterval(() => void load(), 5 * 60 * 1000)
        return () => clearInterval(timer)
      }, [load, ownsSelection])

      // Closing on an outside click keeps the panel from being modal: it is a
      // reading, not a task.
      useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          if (container.current && !container.current.contains(event.target)) setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      const refresh = useCallback(async () => {
        setBusy(true)
        try {
          await load()
        } finally {
          setBusy(false)
        }
      }, [load])

      /** Move the pool to another account; the panel's rows call this. */
      const activateAccount = useCallback(async (account) => {
        setBusy(true)
        try {
          await postRoute('/accounts/activate', { id: account.id })
          await load()
        } finally {
          setBusy(false)
        }
      }, [load])

      const accounts = usage?.pool?.accounts ?? []

      // Nothing to show until the Host answers, and nothing to show when no
      // credential is configured: an empty pill on every composer would be
      // noise for anyone not using this provider.
      if (!usage) return null
      if (!ownsSelection) return null
      // With a 码道 model selected but no usable credential, saying nothing was
      // the worst option: the user picked this provider and the readout simply
      // is not there. Show the state and where to fix it instead.
      const hasCredential = usage?.ok === true || usage?.source || usage?.account
      if (!hasCredential) {
        const body = [
          h('span', { key: 'm', 'aria-hidden': true, className: 'dca-chip-mark' }, '◈'),
          h('span', { key: 'l' }, t('chip.noCredential')),
        ]
        // No credential: the pill becomes the way to fix that. The jump is
        // soft-probed at press time, so it works whenever the settings shell is
        // present and does nothing when it is not.
        return h(
          'div',
          { className: 'dca-chip' },
          h(
            'button',
            {
              type: 'button',
              className: 'dca-chip-trigger',
              title: usage?.error ?? t('chip.noCredentialHint'),
              onClick: openSettings,
            },
            ...body,
          ),
        )
      }

      const credits = usage.credit
      const label = credits
        ? `${t('chip.credits')} ${credits.remain}`
        : t('chip.loading')

      return h(
        'div',
        { ref: container, className: 'dca-chip' },
        h(
          'button',
          {
            type: 'button',
            title: t('chip.panelTitle'),
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            onClick: () => setOpen((value) => !value),
            // Borderless at rest (see .dca-chip-trigger): this row is a strip of
            // compact controls, and a boxed pill among them reads as a form
            // field. Hover and focus come from the stylesheet, which inline
            // styles cannot express.
            className: `dca-chip-trigger${open ? ' dca-chip-trigger-on' : ''}`,
          },
          h('span', { 'aria-hidden': true, className: 'dca-chip-mark' }, '◈'),
          h('span', null, label),
        ),
        open
          ? h(
              'div',
              {
                role: 'dialog',
                'aria-label': t('chip.panelTitle'),
                className: 'dca-pop',
              },
              h(
                'div',
                { className: 'dca-pop-head' },
                h('span', { className: 'dca-pop-title' }, t('chip.panelTitle')),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dca-pop-refresh',
                    disabled: busy,
                    title: t('chip.refreshHint'),
                    'aria-label': t('chip.refreshHint'),
                    onClick: refresh,
                  },
                  h(
                    'svg',
                    {
                      className: `dca-pop-refresh-icon${busy ? ' dca-pop-refresh-icon-spin' : ''}`,
                      viewBox: '0 0 16 16',
                      width: 12,
                      height: 12,
                      fill: 'none',
                      'aria-hidden': 'true',
                      focusable: 'false',
                    },
                    h('path', {
                      d: 'M13.3 8a5.3 5.3 0 1 1-1.55-3.75',
                      stroke: 'currentColor',
                      strokeWidth: 1.5,
                      strokeLinecap: 'round',
                    }),
                    h('path', {
                      d: 'M13.3 2.2v3.1h-3.1',
                      stroke: 'currentColor',
                      strokeWidth: 1.5,
                      strokeLinecap: 'round',
                      strokeLinejoin: 'round',
                    }),
                  ),
                  t('chip.refresh'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dca-pop-settings',
                    onClick: () => {
                      openSettings()
                      setOpen(false)
                    },
                  },
                  h('span', { 'aria-hidden': true, className: 'dca-pop-settings-icon' }, '⚙'),
                  t('chip.settings'),
                ),
              ),
              // One row per account, in a real table so the balances line up in a
              // single right-aligned column. The serving account is a row, not a
              // header: "which account" and "how many credits" are the same fact
              // about the same thing, and splitting them made the panel read as
              // two unrelated blocks.
              accounts.length === 0
                ? h(
                    'p',
                    { className: 'dca-pop-empty' },
                    usage.credits ? formatBalance(usage.credits) : t('account.creditUnread'),
                  )
                : h(
                    'table',
                    { className: 'dca-pop-table' },
                    h(
                      'thead',
                      null,
                      h(
                        'tr',
                        null,
                        h('th', { scope: 'col' }, t('pool.colAccount')),
                        h('th', { scope: 'col', className: 'dca-pop-num' }, t('pool.colCredits')),
                      ),
                    ),
                    h(
                      'tbody',
                      null,
                      ...accounts.map((account) =>
                        h(
                          'tr',
                          {
                            key: account.id,
                            // The serving row: bold name, and its switch is
                            // disabled, so it never takes the hover fill either.
                            className: account.active ? 'dca-pop-row-current' : undefined,
                          },
                          h(
                            'td',
                            null,
                            h(
                              'button',
                              {
                                type: 'button',
                                className: 'dca-pop-switch',
                                disabled: busy || account.active,
                                title: t('chip.switchTo').replace('{account}', account.label),
                                'aria-label': t('chip.switchTo').replace('{account}', account.label),
                                onClick: () => void activateAccount(account),
                              },
                              h('span', {
                                className: `dca-pop-dot${dotTone(account)}`,
                                'aria-hidden': 'true',
                              }),
                              h(
                                'span',
                                { className: 'dca-pop-who' },
                                h('span', { className: 'dca-pop-name' }, account.label),
                                // The state goes UNDER the name, not beside it: a
                                // reason string ("约 21 小时后恢复") is long, and in a
                                // 248px panel it would squeeze the name to nothing.
                                account.active || account.error || account.checkin
                                  ? h(
                                      'span',
                                      { className: 'dca-pop-mark' },
                                      account.active
                                        ? h('span', { className: 'dca-pop-mark-current' }, t('chip.current'))
                                        : null,
                                      account.error
                                        ? h('span', { className: 'dca-pop-mark-reason' }, account.error)
                                        : null,
                                    )
                                  : null,
                              ),
                            ),
                          ),
                          h(
                            'td',
                            { className: 'dca-pop-num' },
                            account.credit ? formatCredits(account.credit.remain) : '—',
                            account.credit?.expiring > 0
                              ? h(
                                  'span',
                                  { className: 'dca-pop-soon' },
                                  t('pool.expiring').replace(
                                    '{amount}',
                                    Number(account.credit.expiring).toLocaleString(),
                                  ),
                                )
                              : null,
                          ),
                        ),
                      ),
                    ),
                  ),
            )
          : null,
      )
    }

    // ── registration ───────────────────────────────────────────────────────

    const name = 'dsh-connect-codearts-client'
    const inject = ['slots']

    /**
     * Register both surfaces.
     *
     * Every registration is installed through `ctx.slots.inject`, so the Host
     * disposes it when the owning declaration collapses, and re-installs it
     * when the declaration returns.
     *
     * The stylesheet is mounted FIRST, as a tagged <style> element.
     *
     * NOT through a `styles.insert(css)` builtin: that symbol belongs to the
     * dynamic client-runner lane, which evaluates a definition with
     * `new Function('React','console','styles',…)`. This file is a Module
     * Loader bundle — `window.__ModuleLoader__.load({ factory(require) })` —
     * and no such binding exists here. A `typeof styles` guard would have made
     * that mistake silent: markup would render with class names that no rule
     * matches, giving unstyled buttons and a popover in normal flow.
     *
     * The tag is claimed by data attributes and re-written in place rather than
     * appended twice, so a hot reload refreshes the rules instead of stacking
     * copies of them.
     */
    function apply(ctx) {
      if (typeof document !== 'undefined') {
        ctx.effect(() => {
          const cssId = 'dsh-connect-codearts/client.css'
          const selector = `style[data-plugin-css="${cssId}"]`
          const existing = document.querySelector(selector)
          if (existing !== null) {
            existing.textContent = CSS
          } else {
            const tag = document.createElement('style')
            tag.dataset.plugin = 'dsh-connect-codearts'
            tag.dataset.pluginCss = cssId
            tag.textContent = CSS
            document.head.appendChild(tag)
          }
          return () => {
            const owned = document.querySelector(selector)
            if (owned !== null) owned.remove()
          }
        }, 'dsh-connect-codearts: stylesheet')
      }

      // The page and its glyph come from ONE callback: the section's
      // declaration is what makes the glyph addressable, and registering both
      // here means neither can outlive the other. The glyph is decoration — a
      // host that declares the section but not its icon seat must still get the
      // page — so its failure is logged, not thrown.
      ctx.slots.inject('settings.section', () => {
        const disposers = [
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'dsh-connect-codearts',
              order: 36,
              label: () => t('nav.label'),
            },
            SettingsPage,
          ),
        ]
        try {
          const iconInject = ctx.slots.inject('settings.section.icon', () => {
            const dispose = ctx.slots.register(
              { name: 'settings.section.icon', id: 'dsh-connect-codearts' },
              NavIcon,
            )
            disposers.push(dispose)
            return dispose
          })
          if (typeof iconInject === 'function') disposers.push(iconInject)
        } catch (error) {
          console.error('[dsh-connect-codearts] settings nav icon failed to register (page unaffected):', error)
        }
        return () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {
              // Already disposed by the slot service.
            }
          }
        }
      })

      // Where the panel's 「设置」 button goes: this plugin's own section INSIDE
      // the settings dialog.
      //
      // The old route called `pluginNavigation.openBundle(...)`, which asks the
      // Plugins page to select a bundle — it lands on that bundle's page, not on
      // this plugin's section, and it only works while that page's own service
      // exists. The supported route is the settings shell's store seat: read the
      // `settings.section` entry's store, create its handle, and ask it to open
      // the section by id. Everything here is soft-probed and wrapped, because it
      // is another bundle's service on a composed profile.
      const softGet = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined)

      /**
       * The shipped slot whose STORE SEAT is the settings shell's state handle.
       *
       * Verified against the shipped client, not assumed: ui-settings-general
       * registers `{ name: 'sidebar.settings', store: shellStore, ... }`, and that
       * store's actions are `{ open, close, select, openSection }`. NOT
       * `settings.section` — that slot lists the PAGES and carries no store.
       *
       * `openSection` is otherwise handed only to onboarding steps and section
       * owner props (`close`), so reading a seat the shell published is the
       * supported way in rather than registering a fake first-run step.
       */
      const SETTINGS_SLOT = 'sidebar.settings'

      /**
       * The panel container. `data-shortcut-modal="settings"` is the shell's OWN
       * attribute — its shortcut router keys off it — so it is far more stable
       * than any class name, which is a CSS-module hash.
       */
      const SETTINGS_PANEL_SELECTOR = '[data-shortcut-modal="settings"]'

      /** The sidebar's settings trigger: dialog semantics plus an expanded state. */
      const TRIGGER_SELECTOR = 'button[aria-haspopup="dialog"][aria-expanded]'

      /**
       * Budget for "panel mounted + nav row rendered". The panel mounts
       * synchronously on the click, but the nav rows' labels wait for a locale
       * snapshot, so a same-frame query is often one tick too early.
       */
      const RETRY_DELAYS_MS = [0, 60, 70, 80, 90]

      const schedule = (run, ms) => {
        try {
          window.setTimeout(run, ms)
        } catch {
          run()
        }
      }

      /**
       * Route 1: the shell's own store seat — one call, exact, no timing.
       *
       * @returns 'opened' when the dialog is on the right section, 'shell' when
       *   the dialog opened but without preselection (route 2 can still click the
       *   row), and undefined when the seat is absent or unusable.
       */
      const openThroughStoreSeat = (get, sectionId) => {
        let slots
        try {
          slots = get('slots')
        } catch {
          return undefined
        }
        if (slots === undefined || typeof slots.entries !== 'function') return undefined

        let seat
        try {
          // A plain ledger read, but it is another bundle's service: a composed
          // profile can replace `slots` with something that throws here.
          seat = slots.entries(SETTINGS_SLOT)[0]?.store
        } catch {
          return undefined
        }
        if (seat === null || typeof seat !== 'object') return undefined
        if (typeof seat.create !== 'function') return undefined

        try {
          // The shell pins `create()` to its ONE live instance. A bare handle
          // would mint a private copy per call, and `openSection` on that copy
          // would move a dialog nobody renders.
          const instance = seat.create()
          const openSection = instance?.actions?.openSection
          if (typeof openSection === 'function') {
            openSection(sectionId)
            return 'opened'
          }
          // A shell whose store predates `openSection`. Pressing still opens the
          // dialog, so hand back 'shell' and let route 2 click the nav row.
          const open = instance?.actions?.open
          if (typeof open === 'function') {
            open()
            return 'shell'
          }
        } catch {
          // `create()` or a baked action threw. Nothing left here.
        }
        return undefined
      }

      /** Find the nav-row button whose label is this plugin's. */
      const findSectionRow = (scope, label) => {
        const want = String(label ?? '').trim()
        if (want === '') return undefined
        return Array.from(scope.querySelectorAll('button')).find(
          (button) => (button.textContent ?? '').trim() === want,
        )
      }

      /**
       * Route 2: drive the chrome — click the trigger, then this plugin's nav row.
       * Kept for a shell whose store predates the seat: deleting it would trade a
       * working route for nothing on those hosts.
       */
      const openThroughChrome = () => {
        try {
          // The panel may ALREADY be open (the user was on another section).
          // Clicking the trigger then would CLOSE it — the jump would turn into a
          // disappearing act — so only drive the trigger when it is absent.
          if (document.querySelector(SETTINGS_PANEL_SELECTOR) === null) {
            const triggers = Array.from(document.querySelectorAll(TRIGGER_SELECTOR))
            const collapsed = triggers.find((button) => button.getAttribute('aria-expanded') !== 'true')
            // No trigger at all: this host has no settings panel to open. Do not
            // guess — report that nothing was driven.
            if (collapsed === undefined) return false
            collapsed.click()
          }

          let clicked = false
          for (const delay of RETRY_DELAYS_MS) {
            schedule(() => {
              if (clicked) return
              try {
                const scope = document.querySelector(SETTINGS_PANEL_SELECTOR) ?? document
                const row = findSectionRow(scope, t('nav.label'))
                if (row !== undefined) {
                  clicked = true
                  row.click()
                }
              } catch {
                // Shell shaped differently: this attempt is done, the next runs.
              }
            }, delay)
          }
          return true
        } catch {
          return false
        }
      }

      /**
       * Open Settings on this plugin's section.
       *
       * Two routes, best first. Every step is wrapped: this runs from a RENDER
       * path (a click handler in the composer panel), so a throw here would take
       * out the whole readout rather than one button. A shell of a different shape
       * degrades to a silent no-op.
       *
       * Probed PER PRESS rather than captured during apply: the seat belongs to
       * another bundle whose apply order is not ours to assume, and a captured
       * `undefined` would leave the button dead for the whole session.
       */
      const openSettings = () => {
        let seatResult
        try {
          seatResult = openThroughStoreSeat(softGet, 'dsh-connect-codearts')
        } catch {
          seatResult = undefined
        }
        if (seatResult === 'opened') return
        try {
          openThroughChrome()
        } catch {
          // A navigation failure must not break the composer row.
        }
      }

      ctx.slots.inject('conversation.input.right', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.right',
            id: 'dsh-connect-codearts-chip',
            order: 6,
            inject: () => ({ openSettings }),
          },
          ComposerChip,
        ),
      )
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    exports.STRINGS = STRINGS
    return module.exports
  },
})
