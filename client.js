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
 * routes under `/plugins/dsh-codearts-dock/`. Nothing here touches
 * credentials beyond posting them once.
 *
 * Written as a plain-JS module for the Client module table: React comes from
 * the browser module table, no bundler and no duplicate React install.
 */

window.__ModuleLoader__.load({
  id: 'dsh-codearts-dock',
  factory(require) {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    /** Route root served by the plugin's Host half. */
    const ROUTE = '/plugins/dsh-codearts-dock'

    /** Provider route this plugin owns; the chip only shows for these models. */
    const PROVIDER_ID = 'codearts'

    /**
     * Notifications that a credit reading became stale.
     *
     * The check-in runs on the settings page while the reading sits beside the
     * composer, in a different slot with its own polling. Claiming a bonus
     * changes the balance server-side, but nothing connected the two, so the
     * composer kept showing the pre-claim figure until its next five-minute
     * poll — the one moment the user is most likely to look at it is the moment
     * it is wrong.
     *
     * A module-level fan-out rather than a Host event: both halves already run
     * in this one module scope, so this needs no slot contract, survives hosts
     * that publish no event bus, and cannot outlive the bundle.
     */
    const creditListeners = new Set()

    /**
     * A change that happened before anyone subscribed.
     *
     * The two slots mount independently, so a claim can land before the
     * composer's effect has subscribed. Dropping the event would leave the
     * reading stale until its poll — the original bug, just harder to trigger.
     */
    let creditChangePending = false

    /** Subscribe a reader; returns the unsubscribe for a cleanup function. */
    function onCreditsChanged(fn) {
      creditListeners.add(fn)
      // A late subscriber still owes a read for the change it missed.
      if (creditChangePending) {
        creditChangePending = false
        try {
          fn()
        } catch (error) {
          console.error('[dsh-codearts-dock] credit listener failed', error)
        }
      }
      return () => { creditListeners.delete(fn) }
    }

    /** Tell every reader to re-read. Listeners are isolated from each other. */
    function creditsChanged() {
      if (creditListeners.size === 0) {
        creditChangePending = true
        return
      }
      for (const fn of [...creditListeners]) {
        try {
          fn()
        } catch (error) {
          // One broken subscriber must not stop the others, and must not make
          // the action that changed the balance look like it failed.
          console.error('[dsh-codearts-dock] credit listener failed', error)
        }
      }
    }

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
      'time.justNow': ['刚刚', 'Just now'],
      'time.minutesAgo': ['{count} 分钟前', '{count} min ago'],
      'time.hoursAgo': ['{count} 小时前', '{count} hr ago'],
      'time.daysAgo': ['{count} 天前', '{count} days ago'],
      'health.details': ['查看异常详情', 'View error details'],
      'presets.saveAs': ['保存为预设', 'Save as preset'],
      'presets.details': ['配置详情', 'Configuration details'],
      'backup.mode': ['备份操作', 'Backup action'],
      'backup.encrypt': ['加密备份', 'Encrypt backup'],
      'backup.encryptionRequired': ['含账号凭证，必须加密。', 'Credentials require encryption.'],
      'backup.paste': ['粘贴 JSON（高级）', 'Paste JSON (advanced)'],
      'backup.selected': ['已选择：{name}', 'Selected: {name}'],
      'backup.encrypted': ['加密备份', 'Encrypted backup'],
      'backup.plain': ['未加密备份', 'Unencrypted backup'],
      'backup.importHint': ['选择备份文件，再预览将恢复的配置。', 'Choose a backup file, then preview the changes.'],
      'backup.pasted': ['已粘贴备份内容', 'Backup contents pasted'],
      'health.updateHint': ['更新「{name}」：填写同一个 AK 和新的 SK，将更新已有账号。', 'Update {name}: enter the same AK and the new SK to update the existing account.'],
      "features.saved": ["已保存", "Saved"],
      "health.available": ["可用", "Available"],
      "health.insufficient": ["余额不足", "Insufficient credits"],
      "health.credentials": ["凭证失效或权限不足", "Invalid credentials or permissions"],
      "health.rate_limited": ["被限流", "Rate limited"],
      "health.network": ["网络异常", "Network error"],
      "health.gateway": ["上游异常", "Gateway error"],
      "health.unknown": ["状态未确认", "Status unknown"],
      "health.checked": ["最近检查", "Last checked"],
      "health.recheck": ["重新检查", "Recheck"],
      "health.update": ["更新凭证", "Update credentials"],
      "health.switch": ["可切换备用账号", "Switch to a backup account"],
      "models.imagesOnly": ["支持图片", "Image input"],
      "models.reasoningOnly": ["支持推理", "Reasoning"],
      "presets.title": ["模型配置预设", "Model presets"],
      "presets.choose": ["选择预设…", "Choose a preset…"],
      "presets.daily": ["日常低倍率", "Everyday / lower multiplier"],
      "presets.deep": ["深度推理", "Deep reasoning"],
      "presets.images": ["图片任务", "Image tasks"],
      "presets.preview": ["预览配置", "Preview configuration"],
      "presets.previewHint": ["预览：将启用 {count} 个模型。应用后仍需点击保存。", "Preview: {count} models will be enabled. Save after applying."],
      "presets.apply": ["应用到草稿", "Apply to draft"],
      "presets.applied": ["预设已应用到草稿，请确认后保存。", "Preset applied to draft. Review and save."],
      "presets.name": ["预设名称", "Preset name"],
      "presets.save": ["保存当前草稿为预设", "Save current draft as preset"],
      "presets.delete": ["删除预设", "Delete preset"],
      "presets.deleteConfirm": ["删除这个模型预设？当前模型配置不会改变。", "Delete this preset? Current model settings will remain."],
      "presets.noModels": ["这套预设没有可用模型", "No available models for this preset"],
      "presets.missing": ["部分模型已不在当前目录中，应用时只保留可用模型。", "Some models are no longer in the catalog; only available models will be applied."],
      "backup.title": ["配置备份与迁移", "Configuration backup and migration"],
      "backup.hint": ["包含模型选择、能力开关、推理强度、预设和其他偏好。账号凭证可选，勾选后必须设置密码加密。", "Includes model selection, capabilities, reasoning, presets and other preferences. Credentials are optional and require password encryption."],
      "backup.export": ["导出配置", "Export configuration"],
      "backup.include": ["包含账号凭证（AK/SK）", "Include account credentials (AK/SK)"],
      "backup.exportPassword": ["加密密码", "Encryption password"],
      "backup.confirmPassword": ["确认加密密码", "Confirm encryption password"],
      "backup.passwordHint": ["密码至少 8 位，两次输入需一致。请妥善保存密码。", "Use at least 8 characters and matching passwords. Keep the password safe."],
      "backup.download": ["下载备份", "Download backup"],
      "backup.exported": ["备份已生成并开始下载。", "Backup generated; download started."],
      "backup.restore": ["恢复配置", "Restore configuration"],
      "backup.choose": ["选择备份文件", "Choose backup file"],
      "backup.content": ["备份内容（也可粘贴 JSON）", "Backup contents (or paste JSON)"],
      "backup.importPassword": ["解密密码", "Decryption password"],
      "backup.preview": ["读取并预览", "Read and preview"],
      "backup.summary": ["将更新 {settings} 项配置，新增 {added} 个账号，更新 {updated} 个账号。", "Updates {settings} settings, adds {added} accounts and updates {updated} accounts."],
      "backup.mergeHint": ["配置将以备份为准；账号按 AK 合并，不移除现有账号。", "Settings follow the backup; accounts merge by AK without removing existing accounts."],
      "backup.changes": ["查看将恢复的配置", "View settings to restore"],
      "backup.confirm": ["确认恢复", "Confirm restore"],
      "backup.restored": ["配置已恢复，新增 {added} 个账号，更新 {updated} 个账号。", "Restored; {added} accounts added and {updated} updated."],
      "backup.failed": ["备份操作失败", "Backup operation failed"],
      "backup.tooLarge": ["备份文件过大（最大 768 KB）", "Backup is too large (maximum 768 KB)"],

      'meta.title': ['码道连接器', 'CodeArts connector'],
      'meta.description': [
        '把华为云码道（CodeArts Agent）的模型接入 DSH：原生适配器直连网关，带凭证管理、模型目录与只读积分概览。',
        'Connects Huawei Cloud CodeArts models to DSH through a native adapter, with credential management, a model catalog, and a read-only credit overview.',
      ],
      'common.more': ['更多操作', 'More actions'],
      'pool.current': ['使用中', 'In use'],
      'pool.allSigned': ['今日全部已签', 'All checked in today'],
      'pool.manage': ['凭证管理', 'Credential management'],
      'pool.showSecret': ['显示', 'Show'],
      'pool.hideSecret': ['隐藏', 'Hide'],
      'models.search': ['搜索模型名称或 ID', 'Search model name or ID'],
      'models.all': ['全部', 'All'],
      'models.enabledOnly': ['已启用', 'Enabled'],
      'models.selectedCount': ['已启用 {enabled} / {total} 个', '{enabled} of {total} enabled'],
      'models.sort': ['模型排序', 'Sort models'],
      'models.sortDefault': ['默认顺序', 'Default order'],
      'models.sortRatio': ['倍率从低到高', 'Multiplier: low to high'],
      'models.sortName': ['名称排序', 'Name'],
      'models.noMatches': ['没有符合条件的模型', 'No matching models'],
      'models.clearFilters': ['清除筛选', 'Clear filters'],
      'models.about': ['目录说明与使用帮助', 'About the catalog'],
      'models.clean': ['模型配置已保存', 'Model settings saved'],
      'models.saveHint': ['勾选模型、能力开关和推理强度后，点击「保存模型配置」使修改生效。', 'Save model selection, capability switches and reasoning levels with “Save model settings”.'],
      'credit.lastResult': ['上次结果', 'Last result'],
      'credit.updated': ['积分更新时间', 'Credits updated'],
      'credit.refreshFailed': ['积分刷新失败，显示上次结果', 'Credits refresh failed; showing the last result'],
      'credit.unavailable': ['积分暂时无法读取，请重试', 'Credits are unavailable; please retry'],
      'chip.lastCredits': ['上次积分', 'Last credits'],
      'models.promo.halfPrice': ['限时半价', 'Limited-time half price'],
      'models.busy.idle': ['空闲', 'Idle'],
      'models.busy.label': ['繁忙程度', 'Load'],
      'models.busy.normal': ['正常', 'Normal'],
      'models.busy.busy': ['轻微拥堵', 'Slightly congested'],
      'models.busy.congested': ['极度拥堵', 'Extremely congested'],
      'models.busy.unavailable': ['不可用', 'Unavailable'],
      'models.unsaved': ['有未保存的模型配置', 'Unsaved model settings'],
      'models.needOne': ['请至少启用一个模型后保存', 'Enable at least one model to save'],
      'diag.details': ['技术详情', 'Technical details'],
      'diag.copy': ['复制脱敏诊断信息', 'Copy redacted diagnostics'],
      'diag.copied': ['已复制脱敏诊断信息', 'Redacted diagnostics copied'],
      'diag.copyFailed': ['无法自动复制，请从下方手动复制。', 'Could not copy automatically. Copy the report below.'],
      'diag.configured': ['凭证已配置', 'Credentials configured'],
      'diag.notConfigured': ['尚未配置凭证', 'Credentials not configured'],
      'diag.credentialIssue': ['凭证需要检查', 'Check credentials'],
      'diag.catalogIssue': ['模型目录需要检查', 'Check catalog'],
      'diag.catalogSynced': ['模型目录已同步', 'Catalog synced'],
      'diag.catalogFallback': ['正在使用兜底目录', 'Using fallback catalog'],
      'diag.catalogCached': ['正在使用缓存目录', 'Using cached catalog'],
      'diag.errors': ['最近错误', 'Recent errors'],
      'diag.noErrors': ['暂无错误记录', 'No errors reported'],
      'nav.label': ['码道', 'CodeArts'],
      'tab.account': ['账号', 'Accounts'],
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
      'models.sourceCache': ['本地缓存', 'Local cache'],
      'models.sourceFallback': ['兜底清单（未连上网关）', 'Fallback list (gateway unreachable)'],
      'models.refreshedAt': ['上次刷新', 'Last refreshed'],
      'models.refreshed': ['已从上游重读模型目录', 'Catalog re-read from upstream'],
      'models.saved': ['已保存，模型选择器已更新', 'Saved; the model picker has been updated'],
      'models.savedReloadFailed': ['已保存，暂时无法重读模型目录。', 'Saved, but the catalog could not be reloaded.'],
      'models.save': ['保存模型配置', 'Save model settings'],
      'models.discard': ['放弃修改', 'Discard'],
      'models.saveFailed': ['保存失败', 'Save failed'],
      'models.dirty': ['未保存', 'unsaved'],
      'models.images': ['图片', 'Image'],
      'models.allowOff': ['可关闭思考', 'Can disable'],
      'models.effort': ['默认推理强度', 'Default reasoning'],
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
      'models.colContext': ['上下文', 'Context'],
      'models.colOutput': ['输出上限', 'Output cap'],

      'diag.title': ['诊断', 'Diagnostics'],
      'diag.provider': ['Provider 路由', 'Provider route'],
      'diag.gateway': ['网关', 'Gateway'],
      'diag.credentialPath': ['凭证文件', 'Credential file'],
      'diag.catalogError': ['目录错误', 'Catalog error'],
      'diag.credentialError': ['凭证错误', 'Credential error'],
      'diag.reportTitle': ['脱敏诊断 JSON', 'Redacted diagnostics JSON'],
      'diag.reportHint': [
        '仅包含状态、来源类型和数量等诊断字段。',
        'Includes diagnostic fields such as status, source type, and counts.',
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
      'pool.switching': ['正在切换…', 'Switching…'],
      'pool.switched': ['已切换到「{account}」', 'Switched to {account}'],
      'pool.switchFailed': ['切换到「{account}」失败：{error}', 'Could not switch to {account}: {error}'],
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
      'pool.previewTotal': ['将导入以下 {count} 个账号，确认后写入：', 'The following {count} accounts will be imported after confirmation:'],
      'pool.importConfirm': ['导入 {count} 个', 'Import {count}'],
      'pool.cancel': ['取消', 'Cancel'],
      'pool.exportFailed': ['导出失败', 'Export failed'],
      'pool.importShow': ['批量导入', 'Bulk import'],
      'pool.importHide': ['收起批量导入', 'Hide bulk import'],
      'pool.checkinClaim': ['签到', 'Check in'],
      'pool.checkinDone': ['今日已签', 'Checked in'],
      'pool.checkinUnavailable': ['不可领取', 'Unavailable'],
      'pool.checkinNone': ['无活动', 'No campaign'],
      'pool.checkinUnknown': ['未读取', 'Not read'],
      'pool.checkinAll': ['一键签到', 'Check in now'],
      'pool.checkinAllHint': ['立刻为所有可签到的账号领取一次', 'Claim once for every eligible account'],
      'pool.checkinClaiming': ['签到中…', 'Claiming…'],
      'pool.checkinNoneToday': ['今天已没有可领取的签到', 'Nothing left to claim today'],
      'pool.checkinResult': ['{claimed} 个账号已签到，{failed} 个失败', '{claimed} claimed, {failed} failed'],
      'pool.checkinFailed': ['签到失败', 'Check-in failed'],
      'pool.checkinPerCampaign': ['已签 {done}/{total}', '{done}/{total} claimed'],
      'pool.checkinAuto': ['系统自动发放', 'granted automatically'],
      'pool.checkinAlreadyClaimed': ['已领取', 'already claimed'],
      'pool.checkinNeedsCondition': ['需先满足条件', 'needs a prerequisite'],
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
    async function getRoute(path, options = {}) {
      const response = await fetch(`${ROUTE}${path}`, { ...options, headers: { accept: 'application/json' } })
      const text = await response.text()
      try {
        const payload = JSON.parse(text)
        if (!response.ok) throw new Error(payload.error ?? `${path}: HTTP ${response.status}`)
        return payload
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error(`${path}: ${response.status} ${text.slice(0, 120)}`)
        throw error
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
        const payload = JSON.parse(text)
        if (!response.ok) throw new Error(payload.error ?? `${path}: HTTP ${response.status}`)
        return payload
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error(`${path}: ${response.status} ${text.slice(0, 120)}`)
        throw error
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

    /** Relative labels stay short; the full local timestamp remains in the title. */
    function relativeTime(ms, now = Date.now()) {
      if (!Number.isFinite(ms) || ms <= 0) return '—'
      const minutes = Math.floor(Math.max(0, now - ms) / 60000)
      if (minutes < 1) return t('time.justNow')
      if (minutes < 60) return t('time.minutesAgo').replace('{count}', minutes)
      if (minutes < 1440) return t('time.hoursAgo').replace('{count}', Math.floor(minutes / 60))
      return t('time.daysAgo').replace('{count}', Math.floor(minutes / 1440))
    }

    /** Keep only the last successful value for the same credential identity. */
    function keepCredit(previous, next) {
      if (!next) return next
      if (next.credit && Number.isFinite(next.credit.remain)) {
        return { ...next, creditCheckedAt: next.creditCheckedAt ?? Date.now(), creditStale: false }
      }
      const identity = (value) => value?.creditIdentity ?? value?.id ?? value?.accountId ?? value?.source
      const key = identity(next)
      if (key && key === identity(previous) && previous.credit) {
        return { ...next, credit: previous.credit, creditCheckedAt: previous.creditCheckedAt, creditStale: true }
      }
      return { ...next, credit: null, creditCheckedAt: null, creditStale: false }
    }

    function mergeCredits(path, previous, next) {
      if (path === '/account') return keepCredit(previous, next)
      if (path === '/accounts') {
        const old = new Map((previous?.accounts ?? []).map((account) => [account.id, account]))
        return { ...next, accounts: (next.accounts ?? []).map((account) => keepCredit(old.get(account.id), account)) }
      }
      return next
    }

    function staleCredits(path, previous) {
      if (!previous) return previous
      if (path === '/account') return { ...previous, creditStale: !!previous.credit }
      if (path === '/accounts') return { ...previous, accounts: previous.accounts.map((account) => ({ ...account, creditStale: !!account.credit })) }
      return previous
    }

    function CreditStatus({ account, now = Date.now() }) {
      if (!account?.creditStale) return null
      return h('span', { className: 'dca-credit-status', title: t('credit.refreshFailed') },
        t('credit.lastResult'),
        account.creditCheckedAt ? h('time', { dateTime: new Date(account.creditCheckedAt).toISOString(), title: `${t('credit.updated')} ${formatTime(account.creditCheckedAt)}` }, ` · ${relativeTime(account.creditCheckedAt, now)}`) : null,
      )
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
.dca-settings{container:dca-settings / inline-size;width:100%;min-width:0;max-width:100%}
.dca-page{min-width:0;max-width:100%;display:flex;flex-direction:column;gap:18px;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;line-height:1.6}
.dca-head{display:flex;flex-direction:column;gap:4px}
.dca-title{margin:0;font-size:16px;font-weight:500;line-height:24px}
.dca-hint{margin:0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
.dca-card{
  box-sizing:border-box;
  border:1px solid var(--dsw-alias-border-l2,#36373b);
  border-radius:12px;background:var(--dsw-alias-bg-layer-3,#202126);
  padding:14px 16px;display:flex;flex-direction:column;gap:12px;
}

/* ---- account pool rows ------------------------------------------------
   One row per account, two lines each: identity on the first, what the account
   can do right now on the second. The reference lays its pool out this way, so
   a long account name never pushes the figures out of alignment. */
.dca-pool-card-head{
  display:flex;align-items:center;justify-content:space-between;
  gap:8px 12px;flex-wrap:wrap;
}
/* The head holds a title, a sentence, a badge, and up to two buttons. Left as
   four loose flex children, the buttons wrap away from each other and the
   check-in drops onto its own line below a short row of leftovers. Wrapping the
   controls in one group keeps them together, so the head is two things side by
   side: what this card is, and what you can do to it. */
.dca-pool-card-title{margin:0;font-size:13px;font-weight:600;line-height:20px}
/* Title over sentence, kept together so the controls can sit opposite one block
   instead of being a fourth loose child that wraps away from the rest. */
.dca-pool-head-text{display:flex;align-items:baseline;gap:6px 10px;flex-wrap:wrap;min-width:0}
/* Controls stay together on one line: a badge and two buttons that wrap apart
   look like three unrelated leftovers rather than one set of actions. */
.dca-pool-actions-group{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
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
  color:var(--dsw-alias-label-tertiary,#999);opacity:.55;transition:opacity .15s;
}
.dca-rename-btn:hover .dca-rename-glyph,
.dca-rename-btn:focus-visible .dca-rename-glyph{opacity:1}
.dca-rename{max-width:220px;font-family:inherit;font-size:13px}
.dca-pool-probe{
  display:flex;align-items:center;gap:7px 12px;flex-wrap:wrap;
  font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#999);
  min-width:0;overflow-wrap:anywhere;
}
/* The check-in status spans both text rows of its column: a "1/2 个活动已签"
   line would otherwise sit on the probe row while its header sits on the name
   row. */
.dca-pool-probe-cell{
  grid-area:checkin;min-width:0;align-self:center;
  /* Flush left in its own column, like the header above it: centring the text
     made a short "今日已签" sit at a different x than a longer "1/2 个活动已签". */
  justify-self:start;text-align:left;
}
.dca-pool-checkin-label{display:none}
.dca-pool-col-checkin{grid-area:checkin;min-width:0;justify-self:start;text-align:left}
.dca-pool-probe-main{
  font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#999);
  min-width:0;overflow-wrap:anywhere;
}
.dca-pool-credits-row{
  grid-area:credits;align-self:center;
  /* The amount and its chips share a right edge. A wrapped row keeps the number
     in the same column as the header for every account: letting the chip sit
     beside it pushed a long balance left and made the column look ragged. */
  display:flex;flex-direction:row;flex-wrap:wrap;align-items:baseline;
  justify-content:flex-end;gap:2px 6px;min-width:0;
  justify-self:end;text-align:right;font-variant-numeric:tabular-nums;
}
/* The chip gets its own line rather than sharing the amount's, so the figures
   stay flush right. */
.dca-pool-credits-row .dca-tag-row{
  /* Forced onto its own line: flex-wrap alone only wraps when the row is full,
     and a short balance left the chip sitting beside it, which moved the number
     off the header's edge. */
  flex:0 0 100%;display:flex;justify-content:flex-end;margin-top:2px;
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
.dca-transfer-list li{
  font-size:12px;color:var(--dsw-alias-label-primary,#e8e9ed);
  padding:2px 0;overflow-wrap:anywhere;
}
.dca-transfer-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
/* ---- model rows -------------------------------------------------------
   Line one: enable box, name, ratio on the left; image/thinking flags on
   the right. Line two: facts, indented to the name (22px = the box plus its
   8px gap) so the two lines read as one block. */
.dca-model-head{
  display:flex;align-items:center;justify-content:space-between;
  flex-wrap:wrap;gap:12px;row-gap:8px;min-width:0;
}
.dca-model-controls{
  display:flex;align-items:center;flex-wrap:wrap;
  gap:8px;row-gap:6px;min-width:0;flex:none;margin-inline-start:auto;
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
  padding:2px 6px;border:1px solid var(--dsw-alias-border-l2,#36373b);
  border-radius:6px;background:var(--dsw-alias-bg-layer-1,#1c1d21);
  cursor:pointer;transition:border-color .15s,background .15s;
}
.dca-model-flag:hover:not(:has(input:disabled)){
  border-color:var(--dsw-alias-label-dimmed,#777);
}
.dca-model-flag input[type="checkbox"]{
  margin:0;width:13px;height:13px;flex:none;
  accent-color:var(--dsw-alias-brand-primary,#5686fe);cursor:pointer;
}
.dca-model-flag input[type="checkbox"]:disabled{cursor:default;opacity:.6}
.dca-model-flag-on{
  border-color:var(--dsw-alias-brand-primary,rgba(86,134,254,.5));
  background:rgba(86,134,254,.08);
  color:var(--dsw-alias-brand-primary,#5686fe);
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
/* One bordered box; its first and last rows receive their own corner radii so
   contextual row menus can extend beyond the table without being clipped. */
.dca-model-page{min-height:100%;padding-bottom:60px;gap:12px}
.dca-models{
  display:flex;flex-direction:column;
  border:1px solid var(--dsw-alias-border-l2,#36373b);
  border-radius:10px;overflow:hidden;
}
.dca-model{
  box-sizing:border-box;display:grid;grid-template-columns:minmax(0,1fr);gap:7px;
  padding:10px 12px;background:var(--dsw-alias-bg-layer-2,#232529);
  transition:background-color .16s;
}
.dca-model + .dca-model{border-top:1px solid var(--dsw-alias-border-l2,#36373b)}
/* An unticked model stays visible but recedes: it is still a thing you can
   enable, so hiding it would make the catalog feel arbitrary. */
.dca-model-off{background:var(--dsw-alias-bg-layer-1,#1c1d21)}
/* The model panel's action bar: always present, disabled when clean. */
.dca-model-actions{
  display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;
  position:sticky;bottom:0;z-index:3;flex-shrink:0;
  gap:12px;row-gap:8px;
  background:var(--dsw-alias-bg-layer-1,#17181b);
  box-shadow:0 -6px 16px rgba(0,0,0,.04);
  border-top:1px solid var(--dsw-alias-border-l2,#36373b);
  padding:12px 0;
}
.dca-model-actions-buttons{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.dca-dirty{
  margin-left:8px;padding:0 6px;border-radius:6px;
  font-size:10px;line-height:16px;font-weight:600;
  color:var(--dsw-alias-state-warn-primary,#e8b34b);
  border:1px solid currentColor;
}
.dca-model-controls label{cursor:pointer}
.dca-model-controls input[type="checkbox"]:disabled{cursor:default}
.dca-model-name{
  display:inline-flex;align-items:center;gap:7px;flex-wrap:wrap;
  color:var(--dsw-alias-label-primary,#e6e6e6);
  font-size:13px;font-weight:500;line-height:19px;
  min-width:0;
}
.dca-model-name b{font-size:13px;font-weight:500;min-width:0;overflow-wrap:anywhere}
.dca-model-signals{display:inline-flex;align-items:center;gap:5px;flex-wrap:wrap}
.dca-model-promo,.dca-model-busy{
  display:inline-flex;align-items:center;gap:4px;flex:none;
  border:1px solid transparent;border-radius:999px;padding:1px 7px;
  font-size:10px;font-weight:500;line-height:15px;white-space:nowrap;
}
.dca-model-promo{color:var(--dsw-alias-state-success-primary,#3fb950);border-color:rgba(63,185,80,.35);background:rgba(63,185,80,.1)}
.dca-model-promo-half{color:#ef4444;border-color:rgba(239,68,68,.38);background:rgba(239,68,68,.1)}
.dca-model-promo-info{color:var(--dsw-alias-brand-primary,#5686fe);border-color:rgba(86,134,254,.35);background:rgba(86,134,254,.1)}
.dca-model-promo-warning{color:var(--dsw-alias-state-warn-primary,#d29922);border-color:rgba(210,153,34,.38);background:rgba(210,153,34,.1)}
.dca-model-promo-neutral{color:var(--dsw-alias-label-secondary,#b6b8be);border-color:var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-1,#1c1d21)}
.dca-model-busy{color:#f59e0b;border-color:rgba(245,158,11,.34);background:rgba(245,158,11,.08)}
.dca-model-busy[data-level="busy"]{color:#f97316;border-color:rgba(249,115,22,.38);background:rgba(249,115,22,.1)}
.dca-model-busy[data-level="congested"]{color:#ef4444;border-color:rgba(239,68,68,.38);background:rgba(239,68,68,.1)}
.dca-model-busy[data-level="idle"]{color:#10b981;border-color:rgba(16,185,129,.3);background:rgba(16,185,129,.08)}
.dca-model-busy[data-level="unavailable"]{color:var(--dsw-alias-label-tertiary,#999);border-color:var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-1,#1c1d21)}
.dca-model-busy-icons{display:inline-flex;align-items:center;gap:0}
.dca-model-busy-icons svg+svg{margin-inline-start:-3px}
.dca-model-busy svg{display:block;flex:none}
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
  box-sizing:border-box;
  border:1px solid var(--dsw-alias-border-l2,#3a3d45);
  border-radius:12px;
  background:var(--dsw-alias-bg-layer-2,#24262c);
  /* The rows share these columns through subgrid. Without that each row is its
     own grid, so every row sized its columns to its own text and the header no
     longer sat above the values it names. */
  display:grid;
  grid-template-columns:minmax(0,1fr) minmax(92px,auto) minmax(120px,auto) auto;
}
.dca-pool-row{
  display:grid;
  /* Account, then check-in, then figures. The check-in gets its own column so
     its header lines up with the values and a long account name pushes the
     columns instead of the status text. */
  grid-column:1 / -1;
  grid-template-columns:subgrid;
  /* Name and its probe line on the left, the figures and the buttons on the
     right, and the check-in between them. Two content rows, as before, so the
     row height does not grow. */
  grid-template-areas:
    "account checkin credits actions"
    "probe   checkin credits actions";
  column-gap:12px;row-gap:2px;align-items:center;
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
.dca-pool-col-actions{grid-area:actions;justify-self:end;align-self:center}

.dca-pool-sub{display:block;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#999)}
.dca-pool-actions{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;align-items:center}
.dca-btn-xs{
  box-sizing:border-box;appearance:none;font:inherit;font-size:12px;line-height:20px;font-weight:500;
  padding:3px 10px;border-radius:8px;cursor:pointer;white-space:nowrap;
  border:1px solid var(--dsw-alias-border-l2,#3a3d45);
  background:var(--dsw-alias-bg-layer-2,#232529);
  color:var(--dsw-alias-label-primary,#e6e6e6);
  transition:background .15s,border-color .15s,opacity .15s;
}
/* One height for the small button, whichever spelling is used. The base button
   sets min-height:32px, so "dca-btn dca-btn-xs" stood 6px taller than a plain
   dca-btn-xs and a row mixing both looked misaligned. */
.dca-btn-xs{min-height:26px}
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



/* Compact controls share the host's colors in either theme. */
.dca-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dca-search{flex:1 1 200px;min-width:140px}
.dca-filter-group{display:inline-flex;gap:2px;padding:3px;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:9px}
.dca-filter{appearance:none;font:inherit;border:0;border-radius:6px;padding:3px 10px;cursor:pointer;background:transparent;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dca-filter[aria-pressed="true"]{background:var(--dsw-alias-label-primary,#e6e6e6);color:var(--dsw-alias-bg-layer-1,#17181b)}
.dca-filter:focus-visible,.dca-details > summary:focus-visible,.dca-account-menu > summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:2px}
.dca-sort{width:auto;max-width:100%;min-height:32px;font-family:inherit}
.dca-catalog-meta{display:flex;align-items:center;gap:6px 14px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dca-model-meta{color:var(--dsw-alias-label-secondary,#b6b8be)}
.dca-model-off .dca-model-controls,.dca-model-off .dca-effort{color:var(--dsw-alias-label-secondary,#b6b8be)}
.dca-model-controls input:disabled,.dca-effort-select:disabled,.dca-model-off .dca-model-flag{opacity:.75}
.dca-save-feedback{display:flex;flex-direction:column;gap:4px;flex:1 1 180px;min-width:0;overflow-wrap:anywhere}
.dca-save-status{font-size:12px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dca-pool-feedback{grid-column:1 / -1;min-width:0;overflow-wrap:anywhere}
.dca-empty{padding:24px 16px;display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center}
.dca-details > summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary,#c6c9d0);border-radius:4px}
.dca-details[open] > summary{margin-bottom:12px}
/* A collapsed <details> still lays out its card padding, so a closed section
   renders as a tall empty box — the collapsed sections at the bottom of the
   account page read as blanks rather than as things you can open. The padding
   belongs to the content, so it is applied only while open. */
.dca-card.dca-details:not([open]){padding-block:10px}
.dca-card.dca-details[open]{padding-block:14px}
.dca-details-body{display:flex;flex-direction:column;gap:12px;min-width:0}
.dca-add-tools > summary{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dca-form-field{display:flex;flex-direction:column;gap:5px;flex:1 1 180px;min-width:0;font-size:12px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dca-form-field .dca-input{width:100%;min-width:0;flex:none}
.dca-secret-field{display:flex;align-items:center;gap:6px}
.dca-secret-field .dca-input{flex:1;min-width:0}
.dca-form{display:flex;flex-direction:column;gap:12px}
.dca-form .dca-fields{align-items:flex-start}
.dca-account-menu{position:relative}
.dca-account-menu > summary{display:flex;align-items:center;justify-content:center;box-sizing:border-box;min-width:30px;min-height:30px;cursor:pointer;list-style:none;padding:3px 8px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:8px;font-size:16px;line-height:20px}
.dca-account-menu > summary::-webkit-details-marker{display:none}
.dca-menu-actions{position:absolute;inset-inline-end:0;top:calc(100% + 4px);z-index:4;padding:5px;min-width:110px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:8px;background:var(--dsw-alias-bg-overlay,#26282e);box-shadow:0 4px 16px rgba(0,0,0,.12)}
.dca-menu-actions .dca-btn-xs{width:100%;text-align:left;border-color:transparent}
.dca-danger{color:var(--dsw-alias-state-error-primary,#ef4444)}
.dca-pool-row-head{border-radius:11px 11px 0 0}
.dca-pool-row:last-child{border-radius:0 0 11px 11px}
.dca-current-tag{display:inline-flex;font-size:11px;font-weight:500;color:var(--dsw-alias-brand-primary,#5686fe)}
.dca-diagnostic-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(190px,100%),1fr));gap:10px}
.dca-summary-item{border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:5px;min-width:0}
.dca-summary-item strong{font-size:13px;font-weight:500}
.dca-summary-item p{overflow-wrap:anywhere}
.dca-section-error{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dca-section-error .dca-msg{flex:1;min-width:0}
@container dca-settings (max-width:640px){
  .dca-model-head{align-items:flex-start;gap:8px}
  .dca-model-controls{flex:none;margin-inline-start:0;flex-wrap:wrap;gap:6px}
  .dca-toolbar .dca-search{flex-basis:100%}
  .dca-pool-col-actions{max-width:100%}
  .dca-model-actions{gap:8px}
  .dca-model-actions-buttons{margin-inline-start:auto}
  .dca-model-meta{gap:4px 10px}
  .dca-pool-row{
    grid-template-columns:minmax(0,1fr) auto auto;
    /* On a narrow panel the check-in sits beside the balance instead of under
       it, and the buttons take the last line: two lines of height rather than
       four. */
    grid-template-areas:
      "account credits checkin"
      "probe   actions actions";
    padding:10px;
  }
  .dca-pool-row-head .dca-pool-col-checkin{display:none}
  .dca-pool-col-checkin{justify-self:end;align-self:center}
  .dca-pool-probe-cell{display:flex;grid-area:checkin;justify-self:end;text-align:right;align-self:center;align-items:center;gap:6px}
  .dca-pool-checkin-label{display:inline-flex;font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary,#999)}
  .dca-pool-col-actions{grid-area:actions}
  .dca-pool-actions{justify-content:flex-end}
}

@container dca-settings (max-width:420px){
  .dca-pool-row{
    grid-template-columns:minmax(0,1fr) minmax(60px,auto);
    grid-template-areas:
      "account credits"
      "probe   probe"
      "checkin checkin"
      "actions actions";
    row-gap:8px;
  }
  .dca-pool-row-head .dca-pool-col-checkin{display:none}
  .dca-pool-probe-cell{grid-area:checkin;justify-self:stretch;text-align:left}
  .dca-pool-col-actions{justify-self:stretch}
  .dca-pool-actions{justify-content:flex-start}
  .dca-pool-row-head .dca-pool-col-actions{display:none}
  .dca-pool-account-row{gap:4px 8px}
  .dca-model-name{white-space:normal;flex-wrap:wrap;overflow-wrap:anywhere}
  .dca-model-actions-buttons{width:100%}
  .dca-form-field{max-width:100%}
  .dca-preset-tools .dca-preset-row > .dca-input{flex-basis:100%}
}
.dca-credit-status{display:block;flex-basis:100%;font-size:11px;line-height:16px;color:var(--dsw-alias-state-warn-primary,#d49937)}
.dca-pop-notice{margin:6px 0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary,#d49937)}
/* The balance is the one number on the row, but at 16px it outranked the
   account name it belongs to and the two read as parallel headings. The
   reference keeps it at the row's own size and leans on weight alone; matching
   that puts the name back in front, which is what the row is about. */
.dca-account-credits{font-size:14px;font-weight:600;line-height:20px}
.dca-account-error{max-width:100%;font-size:12px}
.dca-account-error > summary{color:var(--dsw-alias-state-error-primary,#ef4444)}
.dca-account-error p{margin:6px 0 0;padding:8px 10px;border-inline-start:2px solid currentColor;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,#b6b8be)}
.dca-capability-filters{display:flex;align-items:center;gap:8px 14px;flex-wrap:wrap;font-size:12px}
.dca-capability-filters label{cursor:pointer;min-height:28px}
.dca-mode-switch{display:flex;flex-wrap:wrap;gap:4px;padding:4px;border-radius:9px;background:var(--dsw-alias-bg-layer-1,#17181b)}
.dca-mode-switch .dca-filter{flex:1;min-height:32px}
.dca-file-state{display:flex;flex-direction:column;gap:4px;font-size:12px;overflow-wrap:anywhere}
.dca-feature-stack.dca-backup-form{padding-top:0}
.dca-preset-tools{display:flex;flex-direction:column;gap:10px;min-width:0}
.dca-pop-dot-warn{background:var(--dsw-alias-state-warn-primary,#d49937)}

.dca-feature-stack{display:flex;flex-direction:column;gap:12px;min-width:0;padding-top:12px}
.dca-feature-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(210px,100%),1fr));gap:12px}
.dca-subtitle{font-size:13px;font-weight:600;margin:0}
.dca-preview-box{border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:8px;padding:12px;max-width:100%;overflow-wrap:anywhere}
.dca-health{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary,#b6b8be)}
.dca-health-bad{color:var(--dsw-alias-state-warn-primary,#d49937)}
.dca-preset-preview{max-height:180px;overflow:auto;margin:0;padding-inline-start:20px}
.dca-preset-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dca-preset-row .dca-input{flex:1;min-width:min(180px,100%)}

@media(prefers-reduced-motion:reduce){
  .dca-page *,.dca-pop *{animation:none!important;transition:none!important}
}

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

    /** Share only known diagnostic fields. Error strings and labels can contain secrets or paths. */
    function diagnosticReport(status, account) {
      const catalog = status?.catalog
      const credential = status?.credential
      const credentialSources = ['env', 'file', 'codearts']
      return {
        provider: PROVIDER_ID,
        catalog: {
          source: ['gateway', 'cache', 'fallback'].includes(catalog?.source) ? catalog.source : null,
          count: Number.isInteger(catalog?.models) ? catalog.models : null,
          refreshedAt: Number.isFinite(catalog?.refreshedAt) ? catalog.refreshedAt : null,
          hasError: Boolean(catalog?.error),
        },
        credential: {
          configured: credential?.configured === true,
          source: credentialSources.includes(credential?.source) ? credential.source : null,
          savedAkSet: Boolean(credential?.savedAk),
          savedSkSet: Boolean(credential?.savedSk),
          hasError: Boolean(credential?.error),
        },
        registration: { configSchema: status?.registration?.configSchema === true },
        account: account ? {
          ok: account.ok === true,
          stage: ['credentials', 'gateway'].includes(account.stage) ? account.stage : null,
          creditAvailable: Boolean(account.credit),
        } : null,
      }
    }

    function catalogSourceLabel(source) {
      if (source === 'gateway') return t('models.sourceGateway')
      if (source === 'cache') return t('models.sourceCache')
      if (source === 'fallback') return t('models.sourceFallback')
      return '—'
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
    function AccountTools({ onChanged, onResult, hasAccounts, updateTarget }) {
      const [expanded, setExpanded] = useState(false)
      useEffect(() => {
        if (hasAccounts !== null) setExpanded(!hasAccounts)
      }, [hasAccounts])
      const [showSecret, setShowSecret] = useState(false)
      const [ak, setAk] = useState('')
      const [sk, setSk] = useState('')
      const [label, setLabel] = useState('')
      const [busy, setBusy] = useState(null)
      const [preview, setPreview] = useState(null)
      const fileInput = useRef(null)
      /** The picked file's text, held here: the picker closes immediately, so
       *  there is no File on screen between preview and confirm. */
      const importText = useRef('')
      const akInput = useRef(null)
      useEffect(() => {
        if (!updateTarget) return
        setExpanded(true); setLabel(updateTarget.label ?? ''); setAk(''); setSk('')
        akInput.current?.focus()
      }, [updateTarget])

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
            setShowSecret(false)
            setExpanded(false)
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


      return h(
        'details',
        {
          className: 'dca-card dca-details dca-add-tools',
          open: expanded,
          onToggle: (event) => setExpanded(event.currentTarget.open),
        },
        h('summary', null, t('pool.addTitle')),
        updateTarget ? h('p', { className: 'dca-hint' }, t('health.updateHint').replace('{name}', updateTarget.label)) : null,
        h(
          'form',
          { className: 'dca-form', onSubmit: (event) => { event.preventDefault(); if (busy === null) void add() } },
          h(
            'div',
            { className: 'dca-fields' },
            h('label', { className: 'dca-form-field', htmlFor: 'dca-ak2' },
              t('account.ak'),
              h('input', {
                ref: akInput, id: 'dca-ak2', className: 'dca-input', value: ak, autoComplete: 'off',
                placeholder: t('account.placeholderAk'), disabled: busy !== null,
                'aria-label': t('account.ak'), onChange: (event) => setAk(event.target.value),
              }),
            ),
            h('label', { className: 'dca-form-field', htmlFor: 'dca-sk2' },
              t('account.sk'),
              h('span', { className: 'dca-secret-field' },
                h('input', {
                  id: 'dca-sk2', className: 'dca-input', type: showSecret ? 'text' : 'password',
                  value: sk, autoComplete: 'off', placeholder: t('account.placeholderSk'),
                  disabled: busy !== null, 'aria-label': t('account.sk'),
                  onChange: (event) => setSk(event.target.value),
                }),
                h('button', {
                  type: 'button', className: 'dca-btn-xs', 'aria-controls': 'dca-sk2',
                  'aria-pressed': showSecret, 'aria-label': t(showSecret ? 'pool.hideSecret' : 'pool.showSecret'), disabled: busy !== null,
                  onClick: () => setShowSecret((current) => !current),
                }, t(showSecret ? 'pool.hideSecret' : 'pool.showSecret')),
              ),
            ),
            h('label', { className: 'dca-form-field', htmlFor: 'dca-label' },
              t('pool.addLabel'),
              h('input', {
                id: 'dca-label', className: 'dca-input', value: label, autoComplete: 'off',
                placeholder: t('pool.addLabelPlaceholder'), disabled: busy !== null,
                onChange: (event) => setLabel(event.target.value),
              }),
            ),
          ),
          h('div', { className: 'dca-pool-actions-group' },
            h('button', {
              type: 'submit', className: 'dca-btn dca-btn-primary',
              disabled: busy !== null || !ak.trim() || !sk.trim(),
            }, busy === 'add' ? t('account.saving') : t('pool.add')),
            h('button', {
              type: 'button', className: 'dca-btn', disabled: busy !== null,
              onClick: () => fileInput.current?.click(),
            }, busy === 'import' ? t('pool.importing') : t('pool.import')),
          ),
        ),
        h('input', {
          ref: fileInput, type: 'file', accept: 'application/json,.json,.csv,.txt',
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
                t('pool.previewTotal').replace('{count}', preview.accounts.length),
              ),
              h(
                'ul',
                { className: 'dca-transfer-list' },
                ...preview.accounts.map((entry) =>
                  h(
                    'li',
                    { key: entry.index },
                    entry.label ?? entry.akMasked ?? `#${entry.index}`,
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
        h('details', { className: 'dca-details' },
          h('summary', null, t('account.whereToGet')),
          h('p', { className: 'dca-hint' }, t('account.whereToGetBody')),
        ),
      )
    }

    /**
     * The check-in cell text for one account.
     *
     * Two daily campaigns run at once, so a single "done / due" word would hide
     * half the state. Show the campaign count when there is more than one, and
     * keep the old single word otherwise so the cell stays as terse as before.
     */
    function checkinCampaignsOf(checkin) {
      return Array.isArray(checkin?.campaigns) ? checkin.campaigns : []
    }

    function checkinCellText(checkin, t) {
      // A bare dash here sits one column away from the credit column's own dash,
      // and two dashes side by side read as a rendering fault rather than as
      // "there is nothing to say". Every "nothing" state says what it means.
      if (!checkin) return t('pool.checkinUnknown')
      const campaigns = checkinCampaignsOf(checkin)
      if (campaigns.length === 0) {
        return checkin.claimedToday
          ? t('pool.checkinDone')
          : checkin.claimable
            ? t('pool.checkinPending')
            : t('pool.checkinNone')
      }
      const done = campaigns.filter((campaign) => campaign.claimedToday).length
      if (done === campaigns.length) return t('pool.checkinDone')
      // Nothing claimable and nothing done usually means no campaign upstream.
      // A bare dash reads as a rendering glitch next to the credit column's own
      // dash, so say what it means instead.
      if (done === 0 && !checkin.claimable) return t('pool.checkinNone')
      return t('pool.checkinPerCampaign')
        .replace('{done}', String(done))
        .replace('{total}', String(campaigns.length))
    }

    /** The tooltip listing each campaign, so the count is never a mystery. */
    function checkinTitle(checkin, t) {
      const campaigns = checkinCampaignsOf(checkin)
      const unavailable = Array.isArray(checkin?.unavailable) ? checkin.unavailable : []
      if (campaigns.length <= 1 && unavailable.length === 0) return null
      const lines = campaigns.map((campaign) => {
        const mark = campaign.claimedToday ? '✓' : campaign.claimable ? '·' : '✕'
        return `${mark} ${campaign.label}`
      })
      // Say why the others are missing instead of silently dropping them.
      for (const item of unavailable) {
        const key =
          item.reason === 'auto'
            ? 'pool.checkinAuto'
            : item.reason === 'claimed'
              ? 'pool.checkinAlreadyClaimed'
              : 'pool.checkinNeedsCondition'
        lines.push(`✕ ${item.label}（${t(key)}）`)
      }
      return lines.join('\n')
    }

    /**
     * The account pool.
     *
     * The header shows the account in use and one manual check-in action for
     * the whole pool. Two-line rows keep identity, balances and health aligned.
     */
    function AccountPool({
      pool,
      rowAction,
      rowNotice,
      busy,
      onActivate,
      onRemove,
      onCheckinAll,
      onRename,
      onExport,
      onCheck,
      onUpdateCredentials,
    }) {
      /** Which row is being renamed, and its draft text. */
      const [editingId, setEditingId] = useState(null)
      const [draftLabel, setDraftLabel] = useState('')
      // Keyboard save/cancel also causes a blur. Guard the blur path so one
      // edit can produce at most one write, and Escape can never save it.
      const renameFinished = useRef(true)
      const [now, setNow] = useState(Date.now)
      useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 30000)
        return () => clearInterval(timer)
      }, [])


      const beginRename = useCallback((account) => {
        renameFinished.current = false
        setEditingId(account.id)
        // Start from the current name, EXCEPT when it is the derived fallback
        // (a masked AK): that is a placeholder, not a name the user chose, and
        // prefilling it would make them delete it before typing.
        setDraftLabel(account.renameable === false ? '' : (account.label ?? ''))
      }, [])

      const cancelRename = useCallback(() => {
        renameFinished.current = true
        setEditingId(null)
        setDraftLabel('')
      }, [])

      const commitRename = useCallback(async (id) => {
        if (renameFinished.current) return
        renameFinished.current = true
        const next = draftLabel.trim()
        setEditingId(null)
        setDraftLabel('')
        // An unchanged or empty draft is a cancel, not a request.
        if (next === '') return
        await onRename(id, next)
      }, [draftLabel, onRename])
      const accounts = pool?.accounts ?? []
      const busyId = rowAction?.id ?? null
      // `busy` is the KIND ('checkin' | 'test' | null); most checks only care
      // whether anything is running.
      const anyBusy = busy !== null && busy !== undefined && busy !== false
      // Something to claim right now? The button is disabled otherwise, so a
      // press that cannot do anything never looks like a broken button.
      const anyClaimable = accounts.some((account) => account.checkin?.claimable)
      const allSigned = accounts.length > 0 && accounts.every((account) => account.checkin?.claimedToday === true)
      const active = accounts.find((account) => account.active)
      return h(
        'div',
        { className: 'dca-pool' },

        h(
          'div',
          { className: 'dca-pool-card-head' },
          // Title and sentence are one block so the controls opposite them are
          // a single group; four loose children let the buttons wrap apart.
          h('div', { className: 'dca-pool-head-text' },
            h('h2', { className: 'dca-title' }, t('pool.title')),
            h('p', { className: 'dca-hint dca-pool-tagline' }, t('pool.tagline')),
          ),
          h('div', { className: 'dca-pool-actions-group' },
            active ? h('span', { className: 'dca-badge' }, `${t('pool.inUse')}${active.label}`) : null,
            accounts.length === 0
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'dca-btn dca-btn-xs',
                    disabled: anyBusy || busyId !== null || !anyClaimable,
                    title: anyClaimable
                      ? t('pool.checkinAllHint')
                      : t('pool.checkinNoneToday'),
                    onClick: onCheckinAll,
                  },
                  busy === 'checkin' ? t('pool.checkinClaiming') : allSigned ? t('pool.allSigned') : t('pool.checkinAll'),
                ),
            accounts.length > 0 ? h('button', {
              type: 'button', className: 'dca-btn-xs', onClick: onExport, disabled: anyBusy || busyId !== null,
              title: t('pool.exportHint'),
            }, t('pool.export')) : null,
          ),
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
                h('span', { className: 'dca-pool-col-checkin' }, t('pool.colCheckin')),
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
                    'aria-busy': rowBusy,
                  },
                  h(
                    'div',
                    { className: 'dca-pool-col-account' },
                    h(
                      'div',
                      { className: 'dca-pool-account-row' },
                      account.active ? h('span', { className: 'dca-current-tag' }, t('pool.current')) : null,
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
                              if (event.key === 'Enter') {
                                event.preventDefault()
                                void commitRename(account.id)
                              }
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
                      h('div', { className: `dca-health${account.health?.state && account.health.state !== 'available' ? ' dca-health-bad' : ''}` },
                        h('span', null, t(`health.${account.health?.state ?? 'unknown'}`)),
                        account.health?.checkedAt ? h('time', {
                          dateTime: new Date(account.health.checkedAt).toISOString(),
                          title: `${t('health.checked')} ${formatTime(account.health.checkedAt)}`,
                        }, relativeTime(account.health.checkedAt, now)) : null,
                      ),
                      // The masked AK is only a second identity line when the
                      // name above is something the user chose. For an unnamed
                      // account `label` IS the masked AK, and printing it twice
                      // in one row just looks like a rendering bug.
                      account.accountName && account.accountName !== account.label
                        ? h('span', null, account.accountName)
                        : account.renameable
                          ? h('span', null, account.akMasked)
                          : null,
                      account.error ? h('details', { className: 'dca-details dca-account-error' },
                        h('summary', null, t('health.details')),
                        h('p', null, account.error),
                      ) : null,
                    ),
                  ),
                  h(
                    'div',
                    { className: 'dca-pool-credits-row' },
                    h('span', { className: 'dca-account-credits' }, account.credit ? formatCredits(account.credit.remain) : '—'),
                    h(CreditStatus, { account, now }),
                    account.credit?.plan ? h('span', { className: 'dca-pool-sub' }, account.credit.plan) : null,
                    // Warn about credits that lapse. The amount is real; the
                    // deadline is not knowable from this gateway, so the chip
                    // states the amount and never a date it would have to invent.
                    // It sits on its own line so the amount keeps the header's
                    // right edge.
                    account.credit?.expiring > 0
                      ? h(
                          'span',
                          { className: 'dca-tag-row' },
                          h(
                            'span',
                            {
                              className: 'dca-tag dca-tag-warn',
                              title: t('pool.expiringHint'),
                            },
                            t('pool.expiring').replace(
                              '{amount}',
                              Number(account.credit.expiring).toLocaleString(),
                            ),
                          ),
                        )
                      : null,
                  ),
                  h(
                    'div',
                    { className: 'dca-pool-probe-cell' },
                    h(
                      'div',
                      {
                        className: 'dca-pool-probe-main',
                        // The count would be a riddle without the campaign names,
                        // and a second line would break the fixed row height.
                        ...(checkinTitle(checkin, t) === null ? {} : { title: checkinTitle(checkin, t) }),
                      },
                        h('span', { className: 'dca-pool-checkin-label' }, t('pool.colCheckin')),
                        h('span', null, checkinCellText(checkin, t)),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'dca-pool-col-actions' },
                    h(
                      'div',
                      { className: 'dca-pool-actions' },
                      account.health?.state === 'credentials' ? h('button', { type: 'button', className: 'dca-btn-xs', disabled: rowBusy || anyBusy || busyId !== null, onClick: () => onUpdateCredentials(account) }, t('health.update')) : null,
                      account.health?.state === 'insufficient' ? h('span', { className: 'dca-hint' }, t('health.switch')) : null,
                      account.active
                        ? null
                        : h(
                            'button',
                            {
                              type: 'button',
                              className: 'dca-btn-xs',
                              disabled: rowBusy || anyBusy || busyId !== null,
                              onClick: () => onActivate(account),
                              'aria-busy': rowBusy && rowAction.kind === 'activate',
                            },
                            rowBusy && rowAction.kind === 'activate' ? t('pool.switching') : t('pool.use'),
                          ),
                      h('details', { className: 'dca-account-menu' },
                        h('summary', {
                          'aria-label': `${t('common.more')} — ${account.label}`,
                          title: t('common.more'),
                          'aria-disabled': anyBusy || busyId !== null,
                          onClick: (event) => { if (anyBusy || busyId !== null) event.preventDefault() },
                        }, '⋯'),
                        h('div', { className: 'dca-menu-actions' },
                          h('button', {
                            type: 'button', className: 'dca-btn-xs',
                            disabled: rowBusy || anyBusy || busyId !== null,
                            onClick: (event) => {
                              const menu = event?.currentTarget?.closest?.('details')
                              if (menu) menu.open = false
                              beginRename(account)
                            },
                          }, t('pool.rename')),
                          h('button', {
                            type: 'button', className: 'dca-btn-xs',
                            disabled: rowBusy || anyBusy || busyId !== null,
                            onClick: (event) => {
                              const menu = event?.currentTarget?.closest?.('details')
                              if (menu) menu.open = false
                              void onCheck(account.id)
                            },
                          }, rowBusy && rowAction.kind === 'check' ? t('common.loading') : t('health.recheck')),
                          h('button', {
                            type: 'button', className: 'dca-btn-xs dca-danger',
                            disabled: rowBusy || anyBusy || busyId !== null,
                            onClick: (event) => {
                              event.currentTarget.closest('details').open = false
                              void onRemove(account)
                            },
                          }, t('pool.remove')),
                        ),
                      ),
                    ),
                  ),
                  rowNotice?.id === account.id
                    ? h('div', { className: 'dca-pool-feedback' }, h(FeatureNotice, { notice: rowNotice }))
                    : null,
                )
              }),
            ),

      )
    }

    // ── credentials tab ────────────────────────────────────────────────────

    function AccountTab({ status, pool, onChanged }) {
      const [busy, setBusy] = useState(null)
      const [rowAction, setRowAction] = useState(null)
      const [rowNotice, setRowNotice] = useState(null)
      const [notice, setNotice] = useState(null)
      const [updateTarget, setUpdateTarget] = useState(null)

      const credential = status?.credential
      const reload = onChanged

      /** One place to report an outcome, so every action gets the same voice. */
      const report = useCallback((next) => setNotice(next), [])

      /** Download the store as a JSON file. */
      const doExport = useCallback(async () => {
        setBusy('export')
        try {
          // POST: this route returns plaintext credentials, so it refuses GET.
          const result = await postRoute('/accounts/export', {})
          if (!result.ok || typeof result.text !== 'string') {
            report({ kind: 'error', text: result.error ?? t('pool.exportFailed') })
            return
          }
          if (typeof document === 'undefined' || typeof Blob === 'undefined') {
            report({ kind: 'error', text: t('pool.exportFailed') })
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
          report({ kind: 'success', text: `${t('pool.exported').replace('{name}', name)} · ${t('pool.exportHint')}` })
        } catch (error) {
          report({ kind: 'error', text: error.message })
        } finally { setBusy(null) }
      }, [report])


      const activate = useCallback(async (account) => {
        setRowAction({ id: account.id, kind: 'activate' })
        setRowNotice(null); setNotice(null)
        try {
          const result = await postRoute('/accounts/activate', { id: account.id })
          if (!result.ok) throw new Error(result.error ?? t('common.retryHint'))
          // The composer's reading belongs to whichever account serves, so
          // switching accounts makes it show the previous account's balance —
          // a different number that looks like a stale one.
          creditsChanged()
          await reload()
          setRowNotice({ id: account.id, kind: 'success', text: t('pool.switched').replace('{account}', account.label) })
        } catch (error) {
          setRowNotice({ id: account.id, kind: 'error', text: t('pool.switchFailed').replace('{account}', account.label).replace('{error}', error.message) })
        } finally { setRowAction(null) }
      }, [reload])

      const remove = useCallback(async (account) => {
        const ask = t('pool.removeConfirm')
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(ask)) return
        setRowAction({ id: account.id, kind: 'remove' }); setRowNotice(null)
        try {
          await postRoute('/accounts/remove', { id: account.id })
          report({ kind: 'success', text: t('pool.remove') })
          await reload()
        } catch (error) {
          report({ kind: 'error', text: error.message })
        } finally { setRowAction(null) }
      }, [reload, report])

      /** Claim once for the pool after an explicit click. */
      const checkinAll = useCallback(async () => {
        setBusy('checkin')
        try {
          const result = await postRoute('/checkin/claim-all', {})
          const summary = result.summary
          if (summary) {
            report({
              kind: summary.failures.length === 0 ? 'success' : 'warn',
              text: t('pool.checkinResult')
                .replace('{claimed}', summary.claimed)
                .replace('{failed}', summary.failures.length),
            })
            // A claimed bonus moves the balance, so the reading beside the
            // composer is stale from here on. Announce only when something was
            // actually claimed: a run that claimed nothing changed no credits,
            // and re-reading anyway would show a spinner for no reason.
            if (summary.claimed > 0) creditsChanged()
          } else if (result.error) {
            report({ kind: 'error', text: result.error })
          }
          await reload()
        } catch (error) {
          report({ kind: 'error', text: `${t('pool.checkinFailed')}：${error.message}` })
        } finally {
          setBusy(null)
        }
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

      const checkAccount = async (id) => {
        setRowAction({ id, kind: 'check' }); setRowNotice(null)
        try {
          const result = await postRoute('/accounts/check', { id })
          if (!result.ok) throw new Error(result.error ?? t('common.retry'))
          report({ kind: result.account.health.state === 'available' ? 'success' : 'warn', text: `${result.account.label}：${t(`health.${result.account.health.state}`)}` })
          await reload()
        } catch (error) { report({ kind: 'error', text: error.message }) } finally { setRowAction(null) }
      }
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
          rowAction,
          rowNotice,
          // The pool takes the raw kind, not a collapsed boolean: the check-in
          // button must know whether IT is the one running so it can show
          // 「签到中…」 — a boolean cannot express that.
          busy,
          onActivate: activate,
          onRemove: remove,
          onCheckinAll: checkinAll,
          onRename: rename,
          onExport: doExport,
          onCheck: checkAccount,
          onUpdateCredentials: (account) => setUpdateTarget({ ...account }),
        }),

        h(AccountTools, { onChanged, onResult: report, hasAccounts: pool ? accounts.length > 0 : null, updateTarget }),
        h(BackupTools, { onRestored: onChanged }),

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

              ),
              h('details', { className: 'dca-details' },
                h('summary', null, t('pool.manage')),
                h('button', { type: 'button', className: 'dca-btn dca-danger', onClick: clear, disabled: busy !== null }, t('account.clear')),
              ),
            ),
      )
    }

    function FeatureNotice({ notice }) {
      if (!notice) return null
      return h('p', { className: `dca-msg dca-msg-${notice.kind === 'error' ? 'error' : 'ok'}`, role: notice.kind === 'error' ? 'alert' : 'status' }, notice.text)
    }

    function downloadJson(value, name) {
      const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = name
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    }

    function BackupTools({ onRestored }) {
      const [mode, setMode] = useState('export')
      const [includeCredentials, setIncludeCredentials] = useState(false)
      const [encryptExport, setEncryptExport] = useState(false)
      const [exportPassword, setExportPassword] = useState('')
      const [confirmation, setConfirmation] = useState('')
      const [text, setText] = useState('')
      const [fileName, setFileName] = useState('')
      const [password, setPassword] = useState('')
      const [preview, setPreview] = useState(null)
      const [busy, setBusy] = useState(null)
      const [notice, setNotice] = useState(null)
      const fileInput = useRef(null)
      const needsEncryption = includeCredentials || encryptExport
      const validPassword = exportPassword.length >= 8 && exportPassword.length <= 256 && exportPassword === confirmation
      let importFormat
      try { importFormat = JSON.parse(text)?.format } catch {}
      // Both ids the plugin has ever written: a backup exported before the
      // rename must still be recognised here so the dialog asks for its
      // password instead of calling the file unsupported.
      const encryptedImport = importFormat === 'dsh-codearts-dock-encrypted' || importFormat === 'dsh-connect-codearts-encrypted'
      const plainImport = importFormat === 'dsh-codearts-dock-backup' || importFormat === 'dsh-connect-codearts-backup'
      const importLabel = encryptedImport ? 'backup.encrypted' : plainImport ? 'backup.plain' : null
      const canInspect = text.trim() && (!encryptedImport || (password.length >= 8 && password.length <= 256))
      const changeMode = (next) => {
        if (busy || next === mode) return
        setMode(next); setNotice(null); setPreview(null)
        setExportPassword(''); setConfirmation(''); setPassword('')
      }
      const updateImport = (next, name = '') => {
        setText(next); setFileName(name); setPassword(''); setPreview(null); setNotice(null)
      }
      const selectFile = async (event) => {
        const file = event.target.files?.[0]; event.target.value = ''
        if (!file || busy) return
        setBusy('file'); setPreview(null); setNotice(null)
        updateImport('')
        try {
          if (file.size > 768 * 1024) throw new Error(t('backup.tooLarge'))
          updateImport(await file.text(), file.name)
        } catch (error) { setNotice({ kind: 'error', text: error.message }) } finally { setBusy(null) }
      }
      const exportBackup = async (event) => {
        event.preventDefault()
        if (busy || (needsEncryption && !validPassword)) return
        setBusy('export'); setNotice(null)
        try {
          const result = await postRoute('/backup/export', { includeCredentials, password: needsEncryption ? exportPassword : '' })
          if (!result.ok) throw new Error(result.error ?? t('backup.failed'))
          downloadJson(result.backup, `codearts-backup-${new Date().toISOString().slice(0, 10)}.json`)
          setExportPassword(''); setConfirmation('')
          setNotice({ kind: 'success', text: t('backup.exported') })
        } catch (error) { setNotice({ kind: 'error', text: error.message }) } finally { setBusy(null) }
      }
      const inspect = async () => {
        if (busy || !canInspect) return
        setBusy('preview'); setNotice(null); setPreview(null)
        try {
          const result = await postRoute('/backup/preview', { text, password: encryptedImport ? password : '' })
          if (!result.ok) throw new Error(result.error ?? t('backup.failed'))
          setPreview(result)
        } catch (error) { setNotice({ kind: 'error', text: error.message }) } finally { setBusy(null) }
      }
      const restore = async () => {
        if (!preview || busy) return
        setBusy('restore'); setNotice(null)
        try {
          const result = await postRoute('/backup/restore', { text, password: encryptedImport ? password : '' })
          if (!result.ok) throw new Error(result.error ?? t('backup.failed'))
          updateImport('')
          await onRestored()
          setNotice({ kind: 'success', text: t('backup.restored').replace('{added}', result.added).replace('{updated}', result.updated) })
        } catch (error) { setNotice({ kind: 'error', text: error.message }) } finally { setBusy(null) }
      }
      return h('details', { className: 'dca-card dca-details' },
        h('summary', null, t('backup.title')),
        h('div', { className: 'dca-feature-stack' },
          h('div', { className: 'dca-mode-switch', role: 'group', 'aria-label': t('backup.mode') },
            ...['export', 'restore'].map((value) => h('button', {
              key: value, type: 'button', className: 'dca-filter', 'aria-pressed': mode === value,
              disabled: busy !== null, onClick: () => changeMode(value),
            }, t(`backup.${value}`))),
          ),
          h(FeatureNotice, { notice }),
          mode === 'export' ? h('form', { className: 'dca-feature-stack dca-backup-form', onSubmit: exportBackup },
            h('p', { className: 'dca-hint' }, t('backup.hint')),
            h('label', { className: 'dca-row' }, h('input', {
              type: 'checkbox', checked: includeCredentials, disabled: busy !== null,
              onChange: (event) => {
                setIncludeCredentials(event.target.checked)
                if (!event.target.checked && !encryptExport) { setExportPassword(''); setConfirmation('') }
              },
            }), t('backup.include')),
            includeCredentials ? h('p', { className: 'dca-hint' }, t('backup.encryptionRequired'))
              : h('label', { className: 'dca-row' }, h('input', {
                  type: 'checkbox', checked: encryptExport, disabled: busy !== null,
                  onChange: (event) => { setEncryptExport(event.target.checked); setExportPassword(''); setConfirmation('') },
                }), t('backup.encrypt')),
            needsEncryption ? h(React.Fragment, null,
              h('div', { className: 'dca-feature-grid' },
                h('label', { className: 'dca-form-field' }, t('backup.exportPassword'), h('input', { className: 'dca-input', type: 'password', autoComplete: 'new-password', maxLength: 256, value: exportPassword, disabled: busy !== null, onChange: (event) => setExportPassword(event.target.value) })),
                h('label', { className: 'dca-form-field' }, t('backup.confirmPassword'), h('input', { className: 'dca-input', type: 'password', autoComplete: 'new-password', maxLength: 256, value: confirmation, disabled: busy !== null, onChange: (event) => setConfirmation(event.target.value) })),
              ),
              !validPassword ? h('p', { className: 'dca-hint' }, t('backup.passwordHint')) : null,
            ) : null,
            h('div', { className: 'dca-row' }, h('button', { className: 'dca-btn', type: 'submit', disabled: busy !== null || (needsEncryption && !validPassword) }, busy === 'export' ? t('common.loading') : t('backup.download'))),
          ) : h('div', { className: 'dca-feature-stack dca-backup-form' },
            h('p', { className: 'dca-hint' }, t('backup.importHint')),
            h('div', { className: 'dca-row' },
              h('button', { type: 'button', className: 'dca-btn', disabled: busy !== null, onClick: () => fileInput.current?.click() }, busy === 'file' ? t('common.loading') : t('backup.choose')),
              h('input', { ref: fileInput, type: 'file', accept: '.json,application/json', className: 'dca-file-input', disabled: busy !== null, onChange: selectFile }),
            ),
            text.trim() ? h('div', { className: 'dca-file-state', role: 'status' },
              h('span', null, fileName ? t('backup.selected').replace('{name}', fileName) : t('backup.pasted')),
              importLabel ? h('span', { className: 'dca-hint' }, t(importLabel)) : null,
            ) : null,
            h('details', { className: 'dca-details' }, h('summary', null, t('backup.paste')),
              h('label', { className: 'dca-form-field' }, t('backup.content'), h('textarea', {
                className: 'dca-input', rows: 4, maxLength: 786432, value: text, disabled: busy !== null,
                onChange: (event) => updateImport(event.target.value),
              })),
            ),
            encryptedImport ? h('label', { className: 'dca-form-field' }, t('backup.importPassword'), h('input', { className: 'dca-input', type: 'password', autoComplete: 'off', maxLength: 256, value: password, disabled: busy !== null, onChange: (event) => { setPassword(event.target.value); setPreview(null) } })) : null,
            h('div', { className: 'dca-row' }, h('button', { type: 'button', className: 'dca-btn', disabled: busy !== null || !canInspect, onClick: inspect }, busy === 'preview' ? t('common.loading') : t('backup.preview'))),
            preview ? h('div', { className: 'dca-feature-stack dca-preview-box', role: 'region', 'aria-label': t('backup.preview') },
              h('p', null, t('backup.summary').replace('{settings}', preview.changes.length).replace('{added}', preview.accounts.added).replace('{updated}', preview.accounts.updated)),
              h('p', { className: 'dca-hint' }, t('backup.mergeHint')),
              h('details', { className: 'dca-details' }, h('summary', null, t('backup.changes')), h('pre', { className: 'dca-pre', tabIndex: 0 }, JSON.stringify(preview.preferences, null, 2))),
              h('div', { className: 'dca-row' },
                h('button', { type: 'button', className: 'dca-btn dca-btn-primary', disabled: busy !== null, onClick: restore }, busy === 'restore' ? t('common.loading') : t('backup.confirm')),
                h('button', { type: 'button', className: 'dca-btn', disabled: busy !== null, onClick: () => updateImport('') }, t('pool.cancel')),
              ),
            ) : null,
          ),
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
     * Each row carries its own selection checkbox, live activity/load signals,
     * and capability switches. Edits are local until saved; the panel keeps
     * selection changes separate from the live catalog refresh.
     */
    function ModelsTab({ models, onRefresh, onSaved }) {
      const [busy, setBusy] = useState(null)
      const [query, setQuery] = useState('')
      const [filter, setFilter] = useState('all')
      const [sort, setSort] = useState('default')
      const [imagesOnly, setImagesOnly] = useState(false)
      const [reasoningOnly, setReasoningOnly] = useState(false)
      const [presetId, setPresetId] = useState('')
      const [presetName, setPresetName] = useState('')
      const [presetEditorOpen, setPresetEditorOpen] = useState(false)
      const [presetPreview, setPresetPreview] = useState(null)
      const [savedPresets, setSavedPresets] = useState(null)
      useEffect(() => { setSavedPresets(null) }, [models.presets])
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
      const dirty = (enabledIds !== null && list.some((model) =>
        enabledIds.includes(model.id) !== (selectionIsDefault || models.enabledIds.includes(model.id)))) ||
        Object.entries(overrides).some(([id, patch]) => {
          const model = list.find((entry) => entry.id === id)
          if (!model) return false
          const saved = { images: model.supportsImages, allowOff: model.allowOff !== false, defaultStrength: model.defaultStrength, ...model.overrides }
          return Object.entries(patch).some(([key, value]) => value !== saved[key])
        })
      const selectedIds = list.filter((model) => isEnabled(model.id)).map((model) => model.id)
      const selectedCount = selectedIds.length
      const normalizedQuery = query.trim().toLowerCase()
      const visibleModels = list.filter((model) =>
        (filter !== 'enabled' || isEnabled(model.id)) &&
        (!imagesOnly || (overrides[model.id]?.images ?? model.supportsImages) === true) &&
        (!reasoningOnly || model.strengths?.length > 0) &&
        (!normalizedQuery || `${model.name} ${model.id}`.toLowerCase().includes(normalizedQuery)))
      if (sort === 'ratio') {
        const ratioOf = (model) => {
          const value = Number.parseFloat(String(model.ratio ?? '').trim().replace(/^x/i, ''))
          return Number.isFinite(value) ? value : Infinity
        }
        visibleModels.sort((left, right) => ratioOf(left) - ratioOf(right))
      } else if (sort === 'name') {
        visibleModels.sort((left, right) => left.name.localeCompare(right.name))
      }

      const toggle = useCallback((id, next) => {
        setNotice(null)
        setEnabledIds((current) => {
          const base = current ?? (selectionIsDefault ? list.map((m) => m.id) : (models?.enabledIds ?? []))
          return next ? [...new Set([...base, id])] : base.filter((entry) => entry !== id)
        })
      }, [list, models, selectionIsDefault])

      const setOverride = useCallback((id, patch) => {
        setNotice(null)
        setOverrides((current) => ({
          ...current,
          [id]: { ...(current[id] ?? {}), ...patch },
        }))
      }, [])

      const save = useCallback(async () => {
        setBusy('save'); setNotice(null)
        try {
          const payload = {
            // A draft that matches the whole roster is the same thing as "all",
            // and storing `null` keeps the user's intent ("everything") intact
            // so a model the upstream adds later still appears.
            enabledIds:
              enabledIds === null
                ? (selectionIsDefault ? null : (models?.enabledIds ?? []))
                : selectedIds.length === list.length
                  ? null
                  : selectedIds,
            overrides: Object.fromEntries(list.map((model) => [model.id, { ...model.overrides, ...overrides[model.id] }])),
          }
          const result = await postRoute('/models/select', payload)
          // NOT just `result.ok`: a mis-routed request can land on a read route
          // that also answers `ok: true`, which makes a save look successful
          // while nothing was written. The acknowledgement carries the counts.
          if (result.ok && typeof result.enabled === 'number') {
            const reloaded = await onSaved()
            if (reloaded) {
              setEnabledIds(null)
              setOverrides({})
            }
            setNotice(reloaded
              ? { kind: 'success', text: t('models.saved') }
              : { kind: 'error', text: t('models.savedReloadFailed') })
          } else {
            setNotice({ kind: 'error', text: result.error ?? t('models.saveFailed') })
          }
        } catch (error) {
          setNotice({ kind: 'error', text: `${t('models.saveFailed')}：${error.message}` })
        } finally {
          setBusy(null)
        }
      }, [enabledIds, overrides, list, models, onSaved, selectedIds, selectionIsDefault])

      const discard = useCallback(() => {
        setEnabledIds(null)
        setOverrides({})
        setNotice(null)
      }, [])

      const refresh = useCallback(async () => {
        setBusy('refresh')
        try {
          const result = await getRoute('/refresh')
          const reloaded = await onRefresh()
          setNotice(result.ok && reloaded
            ? { kind: 'success', text: t('models.refreshed') }
            : { kind: 'error', text: result.error ?? t('models.refreshFailed') })
        } catch (error) {
          setNotice({ kind: 'error', text: `${t('models.refreshFailed')}：${error.message}` })
        } finally {
          setBusy(null)
        }
      }, [onRefresh])

      const ratioOf = (model) => {
        const value = Number.parseFloat(String(model.ratio ?? '').trim().replace(/^x/i, ''))
        return Number.isFinite(value) ? value : Infinity
      }
      const makeBuiltin = (id, name, targets, deep = false) => ({
        id, name, enabledModelIds: targets.map((model) => model.id),
        modelOverrides: Object.fromEntries(list.map((model) => {
          const base = model.defaults ?? model
          const strengths = model.strengths ?? []
          const strength = deep && targets.some((entry) => entry.id === model.id)
            ? (strengths.includes('max') ? 'max' : strengths.at(-1))
            : base.defaultStrength
          return [model.id, { images: base.supportsImages === true, allowOff: base.allowOff !== false,
            ...(strengths.includes(strength) ? { defaultStrength: strength } : strengths.length ? { defaultStrength: strengths[0] } : {}),
          }]
        })),
      })
      const presets = [
        makeBuiltin('builtin:daily', t('presets.daily'), [...list].sort((a, b) => ratioOf(a) - ratioOf(b)).slice(0, 3)),
        makeBuiltin('builtin:deep', t('presets.deep'), list.filter((model) => model.strengths?.length), true),
        makeBuiltin('builtin:images', t('presets.images'), list.filter((model) => (model.defaults ?? model).supportsImages)),
        ...(savedPresets ?? models.presets ?? []),
      ]
      const selectedPreset = presets.find((entry) => entry.id === presetId)
      const previewIds = presetPreview ? (presetPreview.enabledModelIds ?? list.map((entry) => entry.id)).filter((id) => list.some((entry) => entry.id === id)) : []
      const snapshotOverrides = () => Object.fromEntries(list.map((model) => {
        const patch = { ...model.overrides, ...overrides[model.id] }
        const strengths = model.strengths ?? []
        const strength = patch.defaultStrength ?? model.defaultStrength
        return [model.id, { images: patch.images ?? model.supportsImages, allowOff: patch.allowOff ?? model.allowOff ?? true,
          ...(strengths.length ? { defaultStrength: strengths.includes(strength) ? strength : strengths[0] } : {}),
        }]
      }))
      const savePreset = async () => {
        if (!presetName.trim() || !selectedCount || busy) return
        setBusy('preset')
        try {
          const result = await postRoute('/presets', { action: 'save', name: presetName.trim(), enabledModelIds: selectedCount === list.length ? null : selectedIds, modelOverrides: snapshotOverrides() })
          if (!result.ok) throw new Error(result.error ?? t('common.retry'))
          setSavedPresets(result.presets); setPresetName(''); setPresetEditorOpen(false)
          setNotice({ kind: 'success', text: t('features.saved') })
        } catch (error) { setNotice({ kind: 'error', text: error.message }) } finally { setBusy(null) }
      }
      const deletePreset = async () => {
        if (!selectedPreset || selectedPreset.id.startsWith('builtin:') || busy || !window.confirm(t('presets.deleteConfirm'))) return
        setBusy('preset')
        try {
          const result = await postRoute('/presets', { action: 'delete', id: selectedPreset.id })
          if (!result.ok) throw new Error(result.error ?? t('common.retry'))
          setSavedPresets(result.presets); setPresetId(''); setPresetPreview(null)
          setNotice({ kind: 'success', text: t('features.saved') })
        } catch (error) { setNotice({ kind: 'error', text: error.message }) } finally { setBusy(null) }
      }
      const applyPreset = () => {
        if (!previewIds.length || busy) return
        setEnabledIds(previewIds)
        setOverrides(Object.fromEntries(Object.entries(presetPreview.modelOverrides ?? {}).filter(([id]) => list.some((model) => model.id === id))))
        setPresetPreview(null); setPresetId('')
        setNotice({ kind: 'success', text: t('presets.applied') })
      }

      const source = catalogSourceLabel(models.source)

      return h(
        'div',
        { className: 'dca-page dca-model-page' },
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
              { type: 'button', className: 'dca-btn', onClick: refresh, disabled: busy !== null },
              busy === 'refresh' ? t('account.refreshing') : t('models.refresh'),
            ),
          ),
        ),
        h('div', { className: 'dca-catalog-meta' },
          h('span', null, t('models.selectedCount').replace('{enabled}', selectedCount).replace('{total}', list.length)),
          h('span', null, `${t('models.refreshedAt')}：${formatTime(models?.refreshedAt)}`),
        ),
        h('p', { className: 'dca-hint' }, t('models.saveHint')),
        h('div', { className: 'dca-toolbar' },
          h('input', {
            type: 'search', className: 'dca-input dca-search', value: query,
            placeholder: t('models.search'), 'aria-label': t('models.search'),
            onChange: (event) => setQuery(event.target.value),
          }),
          h('div', { className: 'dca-filter-group', role: 'group', 'aria-label': t('models.title') },
            ...[['all', 'models.all'], ['enabled', 'models.enabledOnly']].map(([value, key]) =>
              h('button', { type: 'button', key: value, className: 'dca-filter',
                'aria-pressed': filter === value, onClick: () => setFilter(value),
              }, t(key))),
          ),
          h('select', { className: 'dca-input dca-sort', value: sort, 'aria-label': t('models.sort'),
            onChange: (event) => setSort(event.target.value),
          }, ...[['default', 'models.sortDefault'], ['ratio', 'models.sortRatio'], ['name', 'models.sortName']].map(([value, key]) =>
            h('option', { key: value, value }, t(key)))),
        ),
        h('div', { className: 'dca-capability-filters' },
          h('label', { className: 'dca-row' }, h('input', { type: 'checkbox', checked: imagesOnly, onChange: (event) => setImagesOnly(event.target.checked) }), t('models.imagesOnly')),
          h('label', { className: 'dca-row' }, h('input', { type: 'checkbox', checked: reasoningOnly, onChange: (event) => setReasoningOnly(event.target.checked) }), t('models.reasoningOnly')),
        ),
        h('div', { className: 'dca-preset-tools' },
          h('div', { className: 'dca-preset-row' },
            h('select', {
              className: 'dca-input', value: presetId, disabled: busy !== null,
              'aria-label': t('presets.title'), onChange: (event) => {
                const next = event.target.value
                setPresetId(next); setPresetPreview(presets.find((entry) => entry.id === next) ?? null)
                setPresetEditorOpen(false)
              },
            }, h('option', { value: '' }, t('presets.choose')), ...presets.map((preset) => h('option', { key: preset.id, value: preset.id }, preset.name))),
            h('button', { type: 'button', className: 'dca-btn', disabled: busy !== null || !selectedCount,
              'aria-expanded': presetEditorOpen, onClick: () => { setPresetEditorOpen((value) => !value); setPresetPreview(null); setPresetId('') },
            }, t('presets.saveAs')),
          ),
          presetEditorOpen ? h('form', { className: 'dca-preset-row', onSubmit: (event) => { event.preventDefault(); void savePreset() } },
            h('input', { className: 'dca-input', value: presetName, maxLength: 48, autoFocus: true, placeholder: t('presets.name'), 'aria-label': t('presets.name'), disabled: busy !== null, onChange: (event) => setPresetName(event.target.value) }),
            h('button', { type: 'submit', className: 'dca-btn', disabled: busy !== null || !presetName.trim() || !selectedCount }, t('presets.save')),
            h('button', { type: 'button', className: 'dca-btn', disabled: busy !== null, onClick: () => setPresetEditorOpen(false) }, t('pool.cancel')),
          ) : null,
          presetPreview ? h('div', { className: 'dca-preview-box dca-feature-stack', role: 'region', 'aria-label': t('presets.preview') },
            h('p', { className: 'dca-hint' }, t('presets.previewHint').replace('{count}', previewIds.length)),
            !previewIds.length ? h('p', { className: 'dca-hint' }, t('presets.noModels')) : null,
            presetPreview.enabledModelIds && previewIds.length < presetPreview.enabledModelIds.length ? h('p', { className: 'dca-hint' }, t('presets.missing')) : null,
            h('ul', { className: 'dca-preset-preview' }, ...previewIds.map((id) => h('li', { key: id }, list.find((model) => model.id === id).name))),
            h('details', { className: 'dca-details' }, h('summary', null, t('presets.details')),
              h('pre', { className: 'dca-pre', tabIndex: 0 }, JSON.stringify(presetPreview.modelOverrides, null, 2)),
              selectedPreset && !selectedPreset.id.startsWith('builtin:') ? h('button', { type: 'button', className: 'dca-btn dca-danger', disabled: busy !== null, onClick: deletePreset }, t('presets.delete')) : null,
            ),
            h('div', { className: 'dca-row' },
              h('button', { type: 'button', className: 'dca-btn', disabled: busy !== null || !previewIds.length, onClick: applyPreset }, t('presets.apply')),
              h('button', { type: 'button', className: 'dca-btn', disabled: busy !== null, onClick: () => { setPresetPreview(null); setPresetId('') } }, t('pool.cancel')),
            ),
          ) : null,
        ),
        h('details', { className: 'dca-details' },
          h('summary', null, t('models.about')),
          h('div', { className: 'dca-details-body' },
            h('p', { className: 'dca-hint' }, t('models.hint')),
            h('p', { className: 'dca-hint' }, t('models.pickerHint')),
          ),
        ),
        models?.error ? h('p', { className: 'dca-msg dca-msg-warn' }, models.error) : null,
        h(
          'div',
          { className: 'dca-models' },
          list.length === 0
            ? h('p', { className: 'dca-hint' }, t('models.empty'))
            : visibleModels.length === 0
              ? h('div', { className: 'dca-empty', role: 'status' },
                  h('p', { className: 'dca-hint' }, t('models.noMatches')),
                  h('button', { type: 'button', className: 'dca-btn', onClick: () => { setQuery(''); setFilter('all'); setImagesOnly(false); setReasoningOnly(false) } }, t('models.clearFilters')),
                )
              : h(
                React.Fragment,
                null,
                ...visibleModels.map((model) => {
                  const on = isEnabled(model.id)
                  const override = { ...model.overrides, ...overrides[model.id] }
                  const images = typeof override.images === 'boolean' ? override.images : model.supportsImages
                  const strengths = model.strengths ?? []
                  const preferredStrength = override.defaultStrength ?? model.defaultStrength
                  const defaultStrength = strengths.includes(preferredStrength) ? preferredStrength : strengths[0]
                  const promo = model.promo
                  const promoTone = ['success', 'info', 'warning', 'neutral'].includes(promo?.tone) ? promo.tone : 'neutral'
                  const promoIsHalfPrice = promo?.label === '限时半价' || promo?.labelEn === 'Limited-time half price'
                  const promoLabel = promoIsHalfPrice
                    ? t('models.promo.halfPrice')
                    : isChinese() ? promo?.label : (promo?.labelEn || promo?.label)
                  const busyLevel = ['idle', 'normal', 'busy', 'congested', 'unavailable'].includes(model.busyLevel)
                    ? model.busyLevel
                    : null
                  const peopleCount = busyLevel === 'normal' ? 1 : busyLevel === 'busy' ? 2 : busyLevel === 'congested' ? 3 : busyLevel === 'unavailable' ? 1 : 0
                  const busyLabel = busyLevel ? t(`models.busy.${busyLevel}`) : ''
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
                          disabled: busy !== null,
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
                        promo || busyLevel ? h('span', { className: 'dca-model-signals' },
                          promo ? h('span', {
                            className: `dca-model-promo dca-model-promo-${promoTone}${promoIsHalfPrice ? ' dca-model-promo-half' : ''}`,
                            title: promoLabel,
                          }, promoLabel) : null,
                          busyLevel ? h('span', {
                            className: 'dca-model-busy',
                            'data-level': busyLevel,
                            title: busyLabel,
                            role: 'img',
                            'aria-label': `${t('models.busy.label')}：${busyLabel}`,
                          },
                            h('span', { className: 'dca-model-busy-icons', 'aria-hidden': true },
                              busyLevel === 'idle'
                                ? h('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
                                    h('path', { d: 'M8.3 1.4c2.4 1.6 3.7 4.2 3.8 7.3l-2.4 2.4H6.4L4 8.7c.1-3.1 1.6-5.7 4.3-7.3Z' }),
                                    h('path', { d: 'm6.1 10.2-1 3.1 2.3-1.4m2.7-1.7 1 3.1-2.3-1.4M8 4.3v2.3' }))
                                : Array.from({ length: peopleCount }, (_, index) => h('svg', { key: index, width: 10, height: 13, viewBox: '0 0 12 16', fill: 'currentColor' },
                                    h('circle', { cx: 6, cy: 3, r: 2 }),
                                    h('path', { d: 'M3.2 7.2a2.8 2.8 0 0 1 5.6 0v1.5h1.4v5.7H1.8V8.7h1.4V7.2Z' }),
                                    busyLevel === 'unavailable' ? h('path', { d: 'm2 2 8 12', fill: 'none', stroke: 'var(--dsw-alias-bg-layer-1,#1c1d21)', strokeWidth: 2.4 }) : null,
                                  )),
                            ),
                            busyLabel,
                          ) : null,
                        ) : null,
                      ),
                      h(
                        'div',
                        { className: 'dca-model-controls' },
                        h(
                          'label',
                          { className: `dca-model-flag${images === true ? ' dca-model-flag-on' : ''}` },
                          h('input', {
                            type: 'checkbox',
                            checked: images === true,
                            disabled: !on || busy !== null,
                            onChange: (event) =>
                              setOverride(model.id, { images: event.target.checked }),
                          }),
                          t('models.images'),
                        ),
                        strengths.length
                          ? h(
                              'label',
                              { className: `dca-model-flag${(override.allowOff ?? model.allowOff) !== false ? ' dca-model-flag-on' : ''}` },
                              h('input', {
                                type: 'checkbox',
                                checked: (override.allowOff ?? model.allowOff) !== false,
                                disabled: !on || busy !== null,
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
                        strengths.length
                          ? h(
                              'label',
                              { className: 'dca-effort' },
                              h('span', null, t('models.effort')),
                              h(
                                'select',
                                {
                                  className: 'dca-effort-select',
                                  value: defaultStrength,
                                  disabled: !on || busy !== null,
                                  'aria-label': `${t('models.effort')} — ${model.name}`,
                                  onChange: (event) =>
                                    setOverride(model.id, { defaultStrength: event.target.value }),
                                },
                                ...strengths.map((level) =>
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
          h('div', { className: 'dca-save-feedback' },
            h('span', { className: 'dca-save-status', role: 'status', 'aria-live': 'polite' },
              busy === 'save' ? t('account.saving') : selectedCount === 0 ? t('models.needOne') : t(dirty ? 'models.unsaved' : 'models.clean')),
            h(FeatureNotice, { notice }),
          ),
          h(
            'div',
            { className: 'dca-model-actions-buttons' },
            h(
              'button',
              {
                type: 'button',
                className: 'dca-btn',
                disabled: !dirty || busy !== null,
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
                disabled: !dirty || busy !== null || selectedCount === 0,
                onClick: save,
              },
              busy === 'save' ? t('account.saving') : t('models.save'),
            ),
          ),
        ),
      )
    }

    // ── diagnostics tab ────────────────────────────────────────────────────

    function DiagnosticsTab({ status, account, accountError }) {
      const [copyNotice, setCopyNotice] = useState(null)
      const [reportOpen, setReportOpen] = useState(false)
      const reportText = JSON.stringify(diagnosticReport(status, account), null, 2)
      const catalogSummary = status.catalog?.source === 'fallback' ? 'diag.catalogFallback'
        : status.catalog?.source === 'cache' ? 'diag.catalogCached'
          : status.catalog?.source === 'gateway' && !status.catalog.error ? 'diag.catalogSynced'
            : 'diag.catalogIssue'

      const errors = [status?.credential?.error, status?.catalog?.error, account?.error, accountError].filter(Boolean)
      const copyReport = async () => {
        try {
          if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
          await navigator.clipboard.writeText(reportText)
          setCopyNotice({ kind: 'success', text: t('diag.copied') })
        } catch {
          setReportOpen(true)
          setCopyNotice({ kind: 'error', text: t('diag.copyFailed') })
        }
      }
      // `mono` marks a machine value a user copies verbatim; `bad` marks a field
      // that is reporting a failure, so a wall of same-coloured rows still shows
      // where the problem is. Both are the reference's own conventions.
      const rows = [
        { label: t('diag.provider'), value: status?.provider ?? '—' },
        { label: t('diag.gateway'), value: status?.settings?.gateway ?? t('diag.gatewayDefault'), mono: true },
        { label: t('diag.credentialPath'), value: status?.credential?.pathInUse ?? status?.credential?.path ?? '—', mono: true },
        { label: t('models.source'), value: catalogSourceLabel(status?.catalog?.source) },
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
        'div', { className: 'dca-page' },
        h('div', { className: 'dca-pool-card-head' },
          h('h2', { className: 'dca-title' }, t('diag.title')),
          h('button', { type: 'button', className: 'dca-btn', onClick: copyReport }, t('diag.copy')),
        ),
        copyNotice ? h('p', { className: `dca-msg dca-msg-${copyNotice.kind === 'error' ? 'error' : 'ok'}`, role: 'status' }, copyNotice.text) : null,
        h('div', { className: 'dca-diagnostic-summary' },
          h('div', { className: 'dca-summary-item' },
            h('strong', null, t(status?.credential?.error ? 'diag.credentialIssue' : status?.credential?.configured ? 'diag.configured' : 'diag.notConfigured')),
            h('p', { className: 'dca-hint' }, status?.credential?.sourceLabel ?? t('account.sourceNone')),
          ),
          h('div', { className: 'dca-summary-item' },
            h('strong', null, t(catalogSummary)),
            h('p', { className: 'dca-hint' }, `${t('models.count')}：${status?.catalog?.models ?? 0}`),
            h('p', { className: 'dca-hint' }, `${t('models.refreshedAt')}：${formatTime(status?.catalog?.refreshedAt)}`),
          ),
          h('div', { className: 'dca-summary-item' },
            h('strong', null, t('diag.errors')),
            h('p', { className: errors.length ? 'dca-hint dca-danger' : 'dca-hint' }, errors.join('；') || t(account || accountError ? 'diag.noErrors' : 'common.loading')),
          ),
        ),
        h('details', { className: 'dca-card dca-details' },
          h('summary', null, t('diag.details')),
          h('div', { className: 'dca-diag' }, ...rows.map((row) =>
            h('div', { key: row.label, className: 'dca-diag-row' },
              h('span', { className: 'dca-diag-label' }, row.label),
              h('span', { className: `dca-diag-value${row.mono ? ' dca-diag-mono' : ''}${row.bad ? ' dca-diag-bad' : ''}` }, row.value),
            ),
          )),
        ),
        h('details', { className: 'dca-card dca-details', open: reportOpen, onToggle: (event) => setReportOpen(event.currentTarget.open) },
          h('summary', null, t('diag.reportTitle')),
          h('p', { className: 'dca-hint' }, t('diag.reportHint')),
          h('pre', { className: 'dca-pre', tabIndex: 0 }, reportText),
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
      const [data, setData] = useState({})
      const [errors, setErrors] = useState({})
      const requests = useRef(new Map())
      const tabButtons = useRef({})
      const panelId = React.useId()

      const loadRoute = useCallback(async (path, background = false) => {
        const previous = requests.current.get(path)
        if (previous && background) return false
        previous?.abort()
        const controller = new AbortController()
        requests.current.set(path, controller)
        setErrors((current) => ({ ...current, [path]: null }))
        try {
          const value = await getRoute(path, { signal: controller.signal })
          if (controller.signal.aborted) return false
          if (!value || (path !== '/account' && value.ok !== true)) {
            throw new Error(value?.error ?? t('common.retryHint'))
          }
          setData((current) => ({ ...current, [path]: mergeCredits(path, current[path], value) }))
          return true
        } catch (error) {
          if (!controller.signal.aborted) {
            setData((current) => ({ ...current, [path]: staleCredits(path, current[path]) }))
            setErrors((current) => ({ ...current, [path]: `${path}：${error.message}` }))
          }
          return false
        } finally {
          if (requests.current.get(path) === controller) requests.current.delete(path)
        }
      }, [])

      const loadAll = useCallback((background = false) => Promise.all(
        ['/status', '/models', '/account', '/accounts'].map((path) => loadRoute(path, background)),
      ), [loadRoute])
      const loadModels = useCallback(() => loadRoute('/models'), [loadRoute])
      const refreshModels = useCallback(() => {
        void loadRoute('/status', true)
        return loadModels()
      }, [loadModels, loadRoute])

      useEffect(() => {
        void loadAll(true)
        const timer = setInterval(() => void loadAll(true), 5 * 60 * 1000)
        const activeRequests = requests.current
        return () => {
          clearInterval(timer)
          for (const controller of activeRequests.values()) controller.abort()
          activeRequests.clear()
        }
      }, [loadAll])

      const status = data['/status']
      const models = data['/models']
      const account = data['/account']
      const pool = data['/accounts']
      const tabs = [
        { id: 'account', paths: ['/accounts'], content: pool && h(AccountTab, { status, pool, onChanged: loadAll }) },
        { id: 'models', paths: ['/models'], content: models && h(ModelsTab, { models, onRefresh: refreshModels, onSaved: loadModels }) },
        { id: 'diagnostics', paths: ['/status', '/account'], content: status && h(DiagnosticsTab, { status, account, accountError: errors['/account'] }) },
      ]

      return h(
        'div',
        { className: 'dca-page dca-settings' },
        h(
          'div',
          { role: 'tablist', className: 'dca-tabs', 'aria-label': t('nav.label') },
          ...tabs.map(({ id }, index) => h(
            'button',
            {
              key: id,
              type: 'button',
              role: 'tab',
              id: `${panelId}-tab-${id}`,
              ref: (button) => { tabButtons.current[id] = button },
              'aria-selected': tab === id,
              'aria-controls': `${panelId}-panel-${id}`,
              tabIndex: tab === id ? 0 : -1,
              className: `dca-tab${tab === id ? ' dca-tab-on' : ''}`,
              onClick: () => setTab(id),
              onKeyDown: (event) => {
                let nextIndex
                switch (event.key) {
                  case 'ArrowRight': nextIndex = (index + 1) % tabs.length; break
                  case 'ArrowLeft': nextIndex = (index - 1 + tabs.length) % tabs.length; break
                  case 'Home': nextIndex = 0; break
                  case 'End': nextIndex = tabs.length - 1; break
                  default: return
                }
                event.preventDefault()
                const next = tabs[nextIndex].id
                setTab(next)
                tabButtons.current[next]?.focus()
              },
            },
            t(`tab.${id}`),
          )),
        ),
        // Keep the panels mounted so navigation preserves edits and filters.
        ...tabs.map(({ id, paths, content }) => {
          const error = paths.map((path) => errors[path]).filter(Boolean).join('；')
          const retry = () => Promise.all(paths.filter((path) => !data[path] || errors[path]).map((path) => loadRoute(path)))
          return h(
            'div',
            { key: id, role: 'tabpanel', id: `${panelId}-panel-${id}`, 'aria-labelledby': `${panelId}-tab-${id}`, hidden: tab !== id, tabIndex: 0 },
            content ?? h(Pending, { error, onRetry: retry }),
            content && error ? h('div', { className: 'dca-section-error' },
              h('p', { className: 'dca-msg dca-msg-error', role: 'alert' }, error),
              h('button', { type: 'button', className: 'dca-btn', onClick: retry }, t('common.retry')),
            ) : null,
          )
        }),
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
     * Red marks a known credential or balance problem. Amber marks a probe
     * error or unconfirmed health; healthy accounts need no extra status text.
     */
    function dotTone(account) {
      const state = account.health?.state
      if (state === 'credentials' || state === 'insufficient') return ' dca-pop-dot-bad'
      if (account.creditStale || account.error || (state && state !== 'available')) return ' dca-pop-dot-warn'
      return ' dca-pop-dot-ok'
    }

    function ComposerChip(props) {
      const [accountInfo, setAccountInfo] = useState(null)
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState(false)
      const container = useRef(null)
      const loadSequence = useRef(0)
      const [now, setNow] = useState(Date.now())
      const [actionNotice, setActionNotice] = useState(null)
      const [switchingId, setSwitchingId] = useState(null)
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
        const sequence = ++loadSequence.current
        const [accountR, poolR] = await Promise.allSettled([getRoute('/account'), getRoute('/accounts')])
        if (sequence !== loadSequence.current) return
        setNow(Date.now())
        setAccountInfo((previous) => {
          const accountOk = accountR.status === 'fulfilled' && (accountR.value?.ok === true || accountR.value?.stage === 'credentials')
          const poolOk = poolR.status === 'fulfilled' && poolR.value?.ok === true && Array.isArray(poolR.value.accounts)
          const account = accountOk
            ? mergeCredits('/account', previous, accountR.value)
            : staleCredits('/account', previous) ?? { ok: false, stage: 'gateway' }
          return {
            ...account,
            pool: poolOk ? mergeCredits('/accounts', previous?.pool, poolR.value) : staleCredits('/accounts', previous?.pool),
            accountReadFailed: !accountOk || accountR.value?.ok !== true || !accountR.value?.credit,
            poolReadFailed: !poolOk,
          }
        })
      }, [])

      useEffect(() => {
        // Nothing is fetched while another provider is selected: the readout is
        // hidden then, and a 5-minute poll would ask the gateway on behalf of
        // every session in the app.
        if (!ownsSelection) return undefined
        void load()
        const timer = setInterval(() => void load(), 5 * 60 * 1000)
        // Claiming a bonus on the settings page changes the balance; without
        // this the figure here would stay wrong until the next poll.
        const unsubscribe = onCreditsChanged(() => { void load() })
        return () => {
          clearInterval(timer)
          unsubscribe()
          loadSequence.current += 1
        }
      }, [load, ownsSelection])

      useEffect(() => {
        if (!open) return undefined
        setNow(Date.now())
        const timer = setInterval(() => setNow(Date.now()), 30000)
        return () => clearInterval(timer)
      }, [open])

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
        setBusy(true); setActionNotice(null)
        try {
          await load()
        } finally {
          setBusy(false)
        }
      }, [load])

      /** Move the pool to another account; the panel's rows call this. */
      const activateAccount = useCallback(async (account) => {
        setBusy(true); setActionNotice(null); setSwitchingId(account.id)
        loadSequence.current += 1
        try {
          const result = await postRoute('/accounts/activate', { id: account.id })
          if (!result.ok) throw new Error(result.error ?? t('common.retry'))
          // The previous headline belongs to another account, even if the next read fails.
          setAccountInfo((previous) => previous ? { ...previous, credit: null, creditCheckedAt: null, creditStale: false, creditIdentity: null, accountId: account.id, source: undefined,
            pool: previous.pool ? { ...previous.pool, accounts: previous.pool.accounts.map((entry) => ({ ...entry, active: entry.id === account.id })) } : null,
          } : previous)
          await load()
          setActionNotice({ kind: 'success', text: t('pool.switched').replace('{account}', account.label) })
        } catch (error) {
          setActionNotice({ kind: 'error', text: t('pool.switchFailed').replace('{account}', account.label).replace('{error}', error.message) })
        } finally { setBusy(false); setSwitchingId(null) }
      }, [load])

      const accounts = accountInfo?.pool?.accounts ?? []
      const refreshing = busy && switchingId === null
      const refreshFailed = accountInfo?.accountReadFailed || accountInfo?.poolReadFailed || accountInfo?.creditStale || accounts.some((account) => account.creditStale)
      // Nothing to show until the Host answers, and nothing to show when no
      // credential is configured: an empty pill on every composer would be
      // noise for anyone not using this provider.
      if (!accountInfo || accountInfo.composerChip === false) return null
      if (!ownsSelection) return null
      // With a 码道 model selected but no usable credential, saying nothing was
      // the worst option: the user picked this provider and the readout simply
      // is not there. Show the state and where to fix it instead.
      const hasCredential = accountInfo?.ok === true || accountInfo?.source || accountInfo?.account || accountInfo?.stage === 'gateway'
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
              title: accountInfo?.error ?? t('chip.noCredentialHint'),
              onClick: openSettings,
            },
            ...body,
          ),
        )
      }

      const credits = accountInfo.credit
      const label = credits
        ? `${t(accountInfo.creditStale ? 'chip.lastCredits' : 'chip.credits')} ${formatCredits(credits.remain)}`
        : t('account.creditUnread')

      return h(
        'div',
        { ref: container, className: 'dca-chip' },
        h(
          'button',
          {
            type: 'button',
            title: accountInfo.creditStale ? t('credit.refreshFailed') : t('chip.panelTitle'),
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
                      className: `dca-pop-refresh-icon${refreshing ? ' dca-pop-refresh-icon-spin' : ''}`,
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
                  refreshFailed ? t('common.retry') : t('chip.refresh'),
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
              h(FeatureNotice, { notice: actionNotice }),
              refreshFailed ? h('p', { className: 'dca-pop-notice', role: 'status' }, accountInfo.credit || accounts.some((account) => account.credit) ? t('credit.refreshFailed') : t('credit.unavailable')) : null,
              h(CreditStatus, { account: accountInfo, now }),
              // One row per account, in a real table so the balances line up in a
              // single right-aligned column. The serving account is a row, not a
              // header: "which account" and "how many credits" are the same fact
              // about the same thing, and splitting them made the panel read as
              // two unrelated blocks.
              accounts.length === 0
                ? h(
                    'p',
                    { className: 'dca-pop-empty' },
                    accountInfo.credit ? formatBalance(accountInfo.credit) : t('account.creditUnread'),
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
                                'aria-busy': switchingId === account.id,
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
                                switchingId === account.id || account.active || account.error || (account.health?.state && account.health.state !== 'available')
                                  ? h('span', { className: 'dca-pop-mark' },
                                      switchingId === account.id ? h('span', { role: 'status' }, t('pool.switching')) : null,
                                      account.active ? h('span', { className: 'dca-pop-mark-current' }, t('chip.current')) : null,
                                      account.error || (account.health?.state && account.health.state !== 'available')
                                        ? h('span', { className: 'dca-pop-mark-reason', title: account.error || undefined }, t(`health.${account.health?.state && account.health.state !== 'available' ? account.health.state : 'unknown'}`))
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
                            h(CreditStatus, { account, now }),
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

    const name = 'dsh-codearts-dock-client'
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
          const cssId = 'dsh-codearts-dock/client.css'
          const selector = `style[data-plugin-css="${cssId}"]`
          const existing = document.querySelector(selector)
          if (existing !== null) {
            existing.textContent = CSS
          } else {
            const tag = document.createElement('style')
            tag.dataset.plugin = 'dsh-codearts-dock'
            tag.dataset.pluginCss = cssId
            tag.textContent = CSS
            document.head.appendChild(tag)
          }
          return () => {
            const owned = document.querySelector(selector)
            if (owned !== null) owned.remove()
          }
        }, 'dsh-codearts-dock: stylesheet')
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
              id: 'dsh-codearts-dock',
              order: 36,
              label: () => t('nav.label'),
            },
            SettingsPage,
          ),
        ]
        try {
          const iconInject = ctx.slots.inject('settings.section.icon', () => {
            const dispose = ctx.slots.register(
              { name: 'settings.section.icon', id: 'dsh-codearts-dock' },
              NavIcon,
            )
            disposers.push(dispose)
            return dispose
          })
          if (typeof iconInject === 'function') disposers.push(iconInject)
        } catch (error) {
          console.error('[dsh-codearts-dock] settings nav icon failed to register (page unaffected):', error)
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
          seatResult = openThroughStoreSeat(softGet, 'dsh-codearts-dock')
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
            id: 'dsh-codearts-dock-chip',
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
    // The credit-notification pair, exported so a test can assert the semantics
    // the two slots rely on without depending on how a host mounts them.
    exports.__credits = { onCreditsChanged, creditsChanged }
    return module.exports
  },
})
