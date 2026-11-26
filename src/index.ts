// @ts-nocheck
/**
 * Host half of the 码道 (CodeArts) connector.
 *
 * Responsibilities, in order of importance:
 *
 *   1. Register a native LLM adapter for the `codearts` provider route, so
 *      the 码道 models appear in the model selector and answer real traffic.
 *   2. Refresh the model catalog from the gateway, on a timer and on demand.
 *   3. Serve the small read-only HTTP surface the settings page and the
 *      composer chip call: credentials, catalog, credit, and diagnostics.
 *
 * There is no local bridge process: the adapter speaks the gateway's
 * encrypted protocol in-process, so a model selection takes effect without a
 * restart and no port is occupied.
 */

import { randomUUID, createHash } from 'node:crypto'
import { join } from 'node:path'
import { CredentialProvider, CredentialError } from './credentials.js'
import { Catalog, validateContextOverrides } from './catalog.js'
import { MadaoClient, GatewayError } from './gateway.js'
import { createCodeArtsAdapter, PROVIDER_ID, PROVIDER_NAME } from './adapter.js'
import {
  claimBenefit,
  listBenefits,
  parseIdentity,
  readCredit,
  readRoles,
} from './account.js'
import {
  CREDENTIAL_PATH,
  clearCredentials,
  listCandidates,
  maskKey,
  readSavedCredentials,
  saveCredentials,
} from './credentials.js'
import {
  STORE_VERSION,
  activeAccount,
  accountIdOf,
  addAccount,
  addAccounts,
  defaultLabel,
  exportStore,
  parseImport,
  locateStore,
  publicAccount,
  readStore,
  rememberAccountName,
  removeAccount,
  renameAccount,
  setActiveAccount,
} from './accounts.js'
import {
  claimDaily,
  readCheckin,
  readCheckinState,
  claimAllDaily,
  todaySummary,
} from './checkin.js'
import { getSts } from './sts.js'
import { CONFIG_DIR } from './paths.js'
import { FEATURE_DEFAULTS, InputError, readPreferences, validatePreferences, validateSelection } from './preferences.js'
import { registerFeatureRoutes, applyPreferences, recordActivity, recordOperation, activityReason } from './features.js'
import { accountHealth } from './health.js'
import { ACTIVITY_LIMIT, createActivityStore } from './activity.js'
import { resolveModelPromo } from './promo.js'

/** Plugin name; also the client module id. */
export const name = 'dsh-codearts-dock'

/** Services this plugin needs before it can activate. */
import z from '@deepseek-ai/schemastery'

/**
 * The plugin's Config schema.
 *
 * REQUIRED, and not only for typing. Settings → Models builds one row per
 * configurable provider and resolves that row's form by looking its
 * `settingsNs` up in the Host's settings service — which only holds namespaces
 * for plugins that declare a Config schema. No schema means no namespace, and
 * the page then skips the row with `return null`: the provider is routable and
 * its models are selectable, yet the card where a user manages it never appears,
 * with no error anywhere. Declaring this is what makes the row render at all.
 *
 * `volatile()` is deliberately NOT used: this plugin's fields are simple scalars,
 * and the volatile path exists for plugins that must rebuild a running stack on
 * change. Values here are read live at each use, so a plain schema suffices.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).description('关掉即禁用这个 provider，无需卸载插件'),
  gateway: z.string().description('网关地址，留空用内置地址'),
  refreshIntervalMs: z.number().description('模型目录与积分的刷新间隔（毫秒）'),
  composerChip: z.boolean().default(true).description('在输入框旁显示积分'),
  dailyCheckinEnabled: z.boolean().default(false).description('开启后每天自动领取可领取的每日签到活动'),
  registerProvider: z.boolean().default(true).description('是否注册码道这个 provider 路由'),
  enabledModelIds: z.array(z.string()).description('启用的模型；留空表示全部'),
  modelOverrides: z.dict(z.object({
    images: z.boolean(),
    allowOff: z.boolean(),
    defaultStrength: z.string(),
  })).description('按模型覆盖能力开关与默认推理强度'),
})

export const inject = ['llm']

/** Route prefix for this plugin's HTTP surface. */
const ROUTE_PREFIX = '/plugins/dsh-codearts-dock'

/** Default refresh period for the catalog and the credit reading. */
const DEFAULT_REFRESH_MS = 5 * 60 * 1000

/**
 * Default configuration.
 *
 * Deliberately a plain object rather than a Schemastery schema: this bundle is
 * installed as a LINKED directory outside the profile, so a package it
 * imported would have to resolve from its real path — where the profile's own
 * dependency tree is not visible. Adding a schema dependency would make the
 * plugin fail to import on exactly the setup it is shipped in. The row's
 * `config` block is read field-by-field at activation instead, and the real
 * configuration surface is this plugin's own settings page.
 */
export const DEFAULTS = {
  ...FEATURE_DEFAULTS,
  /** Turn the provider off without uninstalling the bundle. */
  enabled: true,
  /**
   * The user's model selection.
   *
   * `null` means "everything the gateway offers", which is the right default:
   * a user who has never opened the card should see the whole catalog, not an
   * empty picker because nothing was ever ticked.
   *
   * Once edited this is a list of ids; a model the upstream withdrew but the
   * user is still running stays offered, and a model the upstream added shows up
   * only after the user ticks it.
   */
  enabledModelIds: null,
  /** Per-model capability overrides: image input and whether "off" is offered. */
  modelOverrides: {},
  /** Gateway root, for a proxy or a regional deployment. */
  gateway: undefined,
  /** Catalog and credit refresh period, in milliseconds. */
  refreshIntervalMs: DEFAULT_REFRESH_MS,
  /** Show the credit reading beside the composer. */
  composerChip: true,
  /** Register the 码道 provider route at all. */
  registerProvider: true,
}

/**
 * Activate the plugin.
 * @param {any} ctx the Host plugin context.
 * @param {any} config the row's configuration.
 */
export function apply(ctx, config = {}) {
  /**
   * The settings namespace this plugin owns.
   *
   * Read from the Loader entry rather than hard-coded: the entry id is what the
   * profile patch names, and a hard-coded string silently stops matching the
   * moment a user renames the row. `ctx.fiber.entry` is added by the Loader, so
   * it is absent on a host that mounts the plugin directly — hence the probe
   * with a documented fallback, which mirrors the first-party plugins.
   */
  const settingsNs =
    typeof ctx?.fiber?.entry?.options?.id === 'string' && ctx.fiber.entry.options.id !== ''
      ? ctx.fiber.entry.options.id
      : name

  const settings = { ...DEFAULTS, ...config }
  // Restore before timers and adapters start; preferences never include credentials.
  try { Object.assign(settings, validatePreferences(readPreferences())) } catch {}
  const healthChecks = new Map()
  const healthCache = new Map()
  let checkinMutation = Promise.resolve()
  const serializeCheckin = (operation) => {
    const result = checkinMutation.then(operation)
    checkinMutation = result.catch(() => {})
    return result
  }
  let rescheduleCatalog = () => {}
  let rescheduleDailyCheckin = () => {}
  if (settings.enabled === false) return

  const logger = createLogger()
  const activityStore = createActivityStore()
  const pendingActivity = new Set()
  let activityDisposed = false
  const activity = {
    ...activityStore,
    record(...args) {
      if (activityDisposed) return Promise.resolve(false)
      const write = Promise.resolve().then(() => activityStore.record(...args)).catch(() => false)
      pendingActivity.add(write)
      void write.finally(() => pendingActivity.delete(write))
      return write
    },
  }
  ctx.effect(() => async () => {
    activityDisposed = true
    await Promise.allSettled([...pendingActivity])
  }, 'codearts: activity history')
  const credentials = new CredentialProvider()
  const catalog = new Catalog({ log: logger })
  // A restart begins on the fallback table until the first refresh lands. A
  // persisted catalog means the picker is right the moment the plugin loads.
  catalog.configure({ enabledIds: settings.enabledModelIds, overrides: settings.modelOverrides })
  const CATALOG_CACHE = join(CONFIG_DIR, 'catalog.json')
  if (catalog.loadPersisted(CATALOG_CACHE)) {
    logger(`已加载上次的模型清单（${catalog.models().length} 个），等待刷新确认`)
  }

  // One gateway client for the read-only endpoints, rebuilt when the
  // credential is renewed.
  /** @type {{client: MadaoClient, signature: string}|null} */
  let shared = null
  const client = async () => {
    const resolved = await credentials.resolve()
    const signature = `${resolved.key.ak}:${resolved.key.securityToken}`
    if (shared?.signature === signature) return { client: shared.client, resolved }
    const next = new MadaoClient({
      credentials: resolved.key,
      gateway: settings.gateway,
    })
    shared = { client: next, signature }
    return { client: next, resolved }
  }

  // ── the LLM adapter ──────────────────────────────────────────────────────
  if (settings.registerProvider !== false) {
    // Reasons are a fixed six-value vocabulary; retries cannot flood history.
    const modelFailureAt = new Map()
    const adapter = createCodeArtsAdapter({
      credentials,
      catalog,
      gateway: () => settings.gateway,
      attachments: () => ctx.get('attachments'),
      log: logger,
      onError: (error) => {
        const reason = activityReason(error)
        const now = Date.now()
        const last = modelFailureAt.get(reason)
        if (last !== undefined && now >= last && now - last < 60000) return
        modelFailureAt.set(reason, now)
        return recordActivity({ activity }, 'models.request', 'error', { reason })
      },
    })
    ctx.effect(() => ctx.llm.registerAdapter([PROVIDER_ID], adapter), 'codearts: llm adapter')

    // The adapter alone is NOT enough. Settings → Models builds its rows by
    // joining the registered routes with this directory and then rendering the
    // DIRECTORY: a provider with an adapter but no directory entry has no row
    // there at all, so the plugin looked half-installed — its models routable
    // from the picker yet invisible in the page where a user inspects and edits
    // providers. One registration, two surfaces.
    ctx.effect(
      () =>
        ctx.llm.registerConfigurableProviders([
          {
            provider: PROVIDER_ID,
            displayName: PROVIDER_NAME,
            settingsNs,
            settingsPath: [],
            declared: false,
          },
        ]),
      'codearts: configurable provider directory',
    )

    // Offer model discovery in the shape that settings surface expects, so a
    // provider edited there can interrogate this plugin's catalog.
    ctx.effect(
      () =>
        ctx.llm.registerModelDiscovery(settingsNs, async () => {
          if (catalog.source !== 'gateway') return []
          return catalog.models().map((model) => ({
            id: model.id,
            name: model.ratio ? `${model.name} · ${model.ratio}` : model.name,
            contextWindow: model.context,
            maxTokens: model.maxOutput,
            inputModalities: model.supportsImages ? ['text', 'image'] : ['text'],
          }))
        }),
      'codearts: model discovery',
    )
  }

  // ── catalog refresh ──────────────────────────────────────────────────────
  let refreshing = null
  let catalogFailed = false
  const catalogActivity = async (result, error) => {
    const failed = Boolean(error || result.error || result.source !== 'gateway')
    if (failed && !catalogFailed) {
      await recordActivity({ activity }, 'catalog.refresh', 'error', { reason: activityReason(error ?? (result.error ? { message: result.error } : null)) })
    } else if (!failed && (catalogFailed || result.changed)) {
      await recordActivity({ activity }, 'catalog.update', 'success', { total: catalog.models().length, enabled: catalog.visible().length })
    }
    catalogFailed = failed
  }
  const refresh = async () => {
    if (refreshing) return refreshing
    refreshing = (async () => {
      try {
        const { client: gateway } = await client()
        const result = await catalog.refresh(gateway)
        if (result.changed) {
          // Persist before announcing, so a crash between the two leaves the
          // cache consistent with what listeners were told.
          catalog.persist(CATALOG_CACHE)
          // Advertise the new catalog; the selector reloads on this event.
          ctx.emit('llm/models-updated', PROVIDER_ID)
        }
        await catalogActivity(result)
        return result
      } catch (error) {
        logger(`刷新失败：${error?.message ?? error}`)
        await catalogActivity({ source: catalog.source }, error)
        return { changed: false, source: catalog.source, error: String(error?.message ?? error) }
      } finally {
        refreshing = null
      }
    })()
    return refreshing
  }

  // A first refresh that fails must not prevent activation: the plugin still
  // serves its settings page, which is where the user fixes the credential.
  void refresh()

  ctx.effect(() => {
    let timer
    let disposed = false
    const schedule = () => {
      clearTimeout(timer)
      if (disposed) return
      timer = setTimeout(async () => { await refresh(); schedule() }, Math.max(60000, Number(settings.refreshIntervalMs) || DEFAULT_REFRESH_MS))
      timer.unref?.()
    }
    rescheduleCatalog = schedule
    schedule()
    return () => { disposed = true; clearTimeout(timer); rescheduleCatalog = () => {} }
  }, 'codearts: catalog refresh timer')

  // Automatic check-in is opt-in and belongs to the plugin lifecycle. It runs
  // once after activation (to cover today's sign-in), then shortly after each
  // local midnight while the plugin remains active.
  ctx.effect(() => {
    let disposed = false
    let timer
    let running = null
    const enabled = () => !disposed && settings.dailyCheckinEnabled === true
    const run = () => {
      if (!enabled()) return Promise.resolve(null)
      if (running) return running
      running = (async () => {
        const targets = []
        const credentialFailures = []
        for (const account of readStore().accounts) {
          if (!enabled()) break
          if (!hasAccount(account.id)) continue
          try {
            targets.push({
              id: account.id,
              client: new MadaoClient({ credentials: await tripleOf(account), gateway: settings.gateway }),
            })
          } catch (error) {
            credentialFailures.push({ id: account.id, reason: message(error) })
            logger(`每日自动签到跳过账号「${account.label ?? defaultLabel(account.ak)}」：${error?.message ?? error}`)
          }
        }
        if (!enabled()) return null
        const summary = await serializeCheckin(() => claimAllDaily({ targets, dailyOnly: true, shouldContinue: enabled, shouldInclude: hasAccount }))
        summary.attempted += credentialFailures.length
        summary.failures.push(...credentialFailures)
        if (summary.claimed > 0) {
          healthCache.clear()
          healthChecks.clear()
        }
        logger(`每日自动签到完成：${summary.claimed} 个账号已签到，${summary.failures.length} 项失败`)
        const outcome = checkinActivityOutcome(summary)
        await recordActivity({ activity }, 'checkin.auto', outcome.status, outcome.details)
        return summary
      })().catch((error) => {
        logger(`每日自动签到失败：${error?.message ?? error}`)
        void recordActivity({ activity }, 'checkin.auto', 'error', { reason: activityReason(error) })
        return null
      }).finally(() => { running = null })
      return running
    }
    const schedule = () => {
      clearTimeout(timer)
      timer = undefined
      if (!enabled()) return
      const now = new Date()
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 5, 0, 0)
      timer = setTimeout(async () => {
        timer = undefined
        await run()
        schedule()
      }, Math.max(1000, next.getTime() - now.getTime()))
      timer.unref?.()
    }
    rescheduleDailyCheckin = (runNow = false) => {
      clearTimeout(timer)
      timer = undefined
      if (!enabled()) return
      if (runNow) void (running ? running.then(() => run()) : run())
      schedule()
    }
    if (enabled()) {
      void run()
      schedule()
    }
    return () => {
      disposed = true
      clearTimeout(timer)
      rescheduleDailyCheckin = () => {}
    }
  }, 'codearts: daily check-in timer')

  // ── HTTP surface for the settings page and the chip ──────────────────────
  ctx.inject(['webServer'], (webCtx) => {
    const route = (path, handler) => {
      webCtx.effect(
        () =>
          webCtx.webServer.register({
            // EXACT, not prefix: each of these is one path. A prefix registration
            // makes `/models` also claim `/models/select`, so a missing route
            // silently answers with a neighbour's payload instead of a 404 —
            // which is exactly how "saving the model selection did nothing"
            // looked like a save bug.
            kind: 'exact',
            path: `${ROUTE_PREFIX}${path}`,
            handler: (req, res) => {
              void handleRoute(req, res, handler)
            },
          }),
        `codearts: route ${path}`,
      )
    }

    const deps = { credentials, catalog, client, refresh, logger, settings, ctx, settingsNs, activity, healthChecks, healthCache, serializeCheckin, rescheduleCatalog: () => rescheduleCatalog(), rescheduleDailyCheckin: (runNow) => rescheduleDailyCheckin(runNow), invalidateAccounts: () => { healthCache.clear(); healthChecks.clear(); tripleCache.clear() } }

    registerFeatureRoutes(route, deps, readJsonBody)

    route('/activities', () => ({ ok: true, records: activity.read(), limit: ACTIVITY_LIMIT }))
    route('/activities/clear', async (req) => {
      await readJsonBody(req)
      if (!await activity.clear()) throw new HttpError(500, '无法清空活动记录，请重试')
      return { ok: true }
    })

    route('/status', () => buildStatus(deps))
    route('/models', () => buildModels(deps))
    route('/models/test', (req) => recordOperation(deps, 'models.test', () => handleModelTest(req, deps)))
    route('/account', () => buildAccount(deps))
    route('/save', (req) => recordOperation(deps, 'credentials.save', () => handleSave(req, deps)))
    route('/test', () => recordOperation(deps, 'connection.test', () => handleTest(deps), (result) => result.ok ? {} : { details: { reason: activityReason({ message: result.steps.find((step) => !step.ok)?.detail ?? '' }) } }))
    route('/refresh', () => handleRefresh(deps))
    route('/benefits', () => handleBenefits(deps))
    route('/claim', (req) => recordOperation(deps, 'checkin.manual', () => handleClaim(req, deps)))
    route('/clear', () => recordOperation(deps, 'credentials.clear', () => handleClear(deps)))

    // The account pool.
    route('/accounts', () => handleAccounts(deps))
    route('/accounts/add', (req) => recordOperation(deps, 'account.add', () => handleAccountAdd(req, deps), (result) => ({ action: result.added ? 'account.add' : 'account.update', details: { added: result.added ? 1 : 0, updated: result.added ? 0 : 1 } })))
    route('/accounts/preview', (req) => handleAccountPreview(req, deps))
    route('/accounts/import', (req) => recordOperation(deps, 'account.import', () => handleAccountImport(req, deps), (result) => ({ details: { added: result.added, updated: result.updated, skipped: result.skipped, total: result.total } })))
    route('/accounts/remove', (req) => recordOperation(deps, 'account.remove', () => handleAccountRemove(req, deps)))
    route('/accounts/activate', (req) => recordOperation(deps, 'account.activate', () => handleAccountActivate(req, deps)))
    route('/accounts/rename', (req) => recordOperation(deps, 'account.rename', () => handleAccountRename(req, deps)))
    route('/accounts/check', (req) => recordOperation(deps, 'account.check', () => handleAccountCheck(req, deps), (result) => accountCheckActivityOutcome([result.account])))
    route('/accounts/check-all', (req) => recordOperation(deps, 'account.check', () => handleAccountCheckAll(req, deps), (result) => accountCheckActivityOutcome(result.accounts)))
    route('/accounts/export', () => recordOperation(deps, 'account.export', () => handleAccountExport(deps), () => ({ details: { total: readStore().accounts.length } })))

    // Daily check-in.
    route('/models/select', (req) => recordOperation(deps, 'models.save', () => handleModelSelection(req, deps), (result) => ({ details: { enabled: result.enabled, total: result.total } })))
    route('/checkin', () => handleCheckinStatus(deps))
    route('/checkin/claim', (req) => recordOperation(deps, 'checkin.manual', () => handleCheckinClaim(req, deps), (result) => {
      const reasons = result.reasons?.filter((reason) => reason !== NO_CLAIMABLE_BENEFITS) ?? []
      const skipped = result.ok !== false && result.reasons?.includes(NO_CLAIMABLE_BENEFITS) ? 1 : 0
      const failed = result.ok === false || reasons.length > 0
      return { status: failed ? (result.claimed ? 'warning' : 'error') : 'success', details: { attempted: 1, claimed: result.claimed ? 1 : 0, skipped, failed: failed ? 1 : 0, ...(failed ? { reason: activityReason({ message: reasons[0] ?? result.reason ?? '' }) } : {}) } }
    }))
    route('/checkin/claim-all', (req) => recordOperation(deps, 'checkin.manual', () => handleCheckinClaimAll(req, deps), (result) => checkinActivityOutcome(result.summary)))
  })

  // Release the renewal timer when the plugin unloads.
  ctx.effect(() => () => credentials.dispose(), 'codearts: credential renewal')

  logger(`已注册 provider "${PROVIDER_ID}"；目录来源：${catalog.source}`)
}

// ── route handlers ─────────────────────────────────────────────────────────

/** Aggregate checks expose counts and a fixed cause without account identity. */
function accountCheckActivityOutcome(accounts) {
  const available = accounts.filter((account) => account.health?.state === 'available').length
  const unavailable = accounts.length - available
  const reason = accounts.find((account) => account.health?.state !== 'available')?.health?.state ?? 'unknown'
  return {
    status: unavailable === 0 ? 'success' : available > 0 ? 'warning' : 'error',
    details: { total: accounts.length, available, unavailable, ...(unavailable ? { reason } : {}) },
  }
}

const NO_CLAIMABLE_BENEFITS = '上游当前没有可领取的福利活动'

/** No available welfare is a skipped action; several failures still count once. */
function checkinActivityOutcome(summary) {
  const failures = summary.failures.filter((failure) => failure.reason !== NO_CLAIMABLE_BENEFITS)
  const failed = new Set(failures.map((failure) => failure.id)).size
  const skipped = summary.skipped + new Set(summary.failures.filter((failure) => failure.reason === NO_CLAIMABLE_BENEFITS).map((failure) => failure.id)).size
  return {
    status: failed === 0 ? 'success' : summary.claimed > 0 || skipped > 0 ? 'warning' : 'error',
    details: {
      attempted: summary.attempted, claimed: summary.claimed, skipped, failed,
      ...(failed ? { reason: activityReason({ message: failures[0].reason }) } : {}),
    },
  }
}

/**
 * A handler receives the parsed request and returns a JSON-serialisable value.
 * Throwing answers 500 with the message, so error reporting is one code path.
 */

async function buildStatus(deps) {
  const located = locateStore()
  const saved = readSavedCredentials()
  const candidates = listCandidates()
  return {
    ok: true,
    provider: PROVIDER_ID,
    providerName: PROVIDER_NAME,
    catalog: {
      source: deps.catalog.source,
      models: deps.catalog.models().length,
      refreshedAt: deps.catalog.refreshedAt ?? null,
      error: deps.catalog.lastError ?? null,
    },
    credential: {
      configured: candidates.length > 0,
      // The file actually read, and where a save would go. They differ on an
      // install that predates the account store, and saying only the latter
      // makes a path-based diagnosis report a file that does not exist.
      pathInUse: located.path,
      path: CREDENTIAL_PATH,
      source: deps.credentials.source ?? null,
      sourceLabel: deps.credentials.sourceLabel ?? null,
      savedAk: saved ? maskKey(saved.ak) : null,
      savedSk: saved ? maskKey(saved.sk) : null,
      path: CREDENTIAL_PATH,
      error: deps.credentials.errorText ?? null,
      candidates: candidates.map((candidate) => ({
        source: candidate.source,
        label: candidate.label,
      })),
    },
    // What the settings page gates on, reported rather than guessed. A missing
    // model card has exactly two silent causes, and this answers both:
    // Settings → Models emits a namespace only for an entry whose
    // `fiber.runtime.Config` exists AND has `toJSON`, then hides any row whose
    // namespace did not resolve.
    registration: {
      provider: PROVIDER_ID,
      settingsNs: deps.settingsNs,
      // Gate 1: the Host's `schema(entry)` returns undefined without this.
      configSchema: typeof Config === 'function' && typeof Config.toJSON === 'function',
      // Gate 2: the row is skipped when its namespace is absent.
      settingsPath: [],
    },
    settings: {
      composerChip: deps.settings.composerChip !== false,
      dailyCheckinEnabled: deps.settings.dailyCheckinEnabled === true,
      refreshIntervalMs: deps.settings.refreshIntervalMs ?? DEFAULT_REFRESH_MS,
      gateway: deps.settings.gateway ?? null,
    },
  }
}

async function buildModels(deps) {
  // Effective models, not the raw roster: `defaultStrength` here is what the
  // ADAPTER will use, so a page that reported the upstream value would show one
  // thing and send another.
  const all = deps.catalog.models().map((model) => deps.catalog.effective(model))
  const overrides = deps.settings.modelOverrides ?? {}
  const selectionIsDefault = deps.settings.enabledModelIds === null
  return {
    ok: true,
    source: deps.catalog.source,
    refreshedAt: deps.catalog.refreshedAt ?? null,
    error: deps.catalog.lastError ?? null,
    // The selection, so the card can render the ticks and the "changed" marker.
    enabledIds: selectionIsDefault ? null : deps.catalog.visible().map((model) => model.id),
    total: all.length,
    models: all.map((model) => ({
      enabled: deps.catalog.isEnabled(model.id),
      overrides: overrides[model.id] ?? null,
      id: model.id,
      name: model.name,
      context: model.context,
      maxOutput: model.maxOutput,
      defaults: {
        context: deps.catalog.find(model.id)?.context,
      },
      ratio: model.ratio ?? null,
      supportsImages: model.supportsImages,
      allowOff: model.allowOff !== false,
      strengths: model.strengths,
      defaultStrength: model.defaultStrength ?? null,
      description: model.description ?? null,
      promo: resolveModelPromo(model) ?? null,
      busyLevel: model.busyLevel ?? 'unknown',
    })),
  }
}

async function buildAccount(deps) {
  try {
    const { client, resolved } = await deps.client()
    const identity = parseIdentity(resolved.key.securityToken)
    const accountId = resolved.accountId ?? deps.credentials.accountId ?? resolved.source
    const [credit, roles] = await Promise.all([readCredit(client), readRoles(client)])
    return {
      ok: true,
      account: identity.accountName ?? null,
      accountId,
      userId: identity.userId ?? null,
      source: resolved.source,
      sourceLabel: resolved.label,
      temporary: resolved.source === 'codearts',
      expiresAt: resolved.expiresAtMs ?? null,
      credit,
      creditCheckedAt: credit ? Date.now() : null,
      creditIdentity: createHash('sha256').update(JSON.stringify([resolved.source, resolved.accountId ?? identity.userId ?? resolved.key.ak, deps.settings.gateway ?? ''])).digest('hex'),
      roles,
      composerChip: deps.settings.composerChip !== false,
      health: accountHealth({ credit }),
    }
  } catch (error) {
    return {
      ok: false,
      composerChip: deps.settings.composerChip !== false,
      stage: error instanceof CredentialError ? 'credentials' : 'gateway',
      error: error?.message ?? String(error),
    }
  }
}

async function handleSave(req, deps) {
  const body = await readJsonBody(req)
  if (typeof body.ak !== 'string' || typeof body.sk !== 'string') {
    throw new HttpError(400, 'ak 和 sk 都必须是字符串')
  }
  const saved = await saveCredentials(body.ak, body.sk)
  // A new pair must be exchanged before the next request, so drop the cache.
  deps.credentials.invalidate()
  void deps.refresh()
  return { ok: true, ak: maskKey(saved.ak), sk: maskKey(saved.sk) }
}

async function handleClear(deps) {
  await clearCredentials()
  deps.invalidateAccounts()
  deps.credentials.invalidate()
  return { ok: true }
}

// ── account pool ───────────────────────────────────────────────────────────

/** A removed account must not be included in a queued batch operation. */
function hasAccount(id) {
  return readStore().accounts.some((account) => account.id === id)
}

/**
 * The pool, with per-account credit and check-in state.
 *
 * Credit and check-in are read per account, which costs one gateway round trip
 * each — so they are read only when this route is called (the settings page is
 * open), never on a timer.
 */
async function inspectAccount(account, deps, force = false) {
  const signature = createHash('sha256').update(`${account.ak}:${account.sk}`).digest('hex')
  const existing = deps.healthChecks.get(account.id)
  if (existing?.signature === signature) return existing.promise
  const operation = (async () => {
    if (force) tripleCache.delete(account.id)
    const entry = { ...publicAccount(account, readStore()), credit: null, creditCheckedAt: null, creditIdentity: signature, checkin: null, error: null }
    let failure
    try {
      const client = new MadaoClient({ credentials: await tripleOf(account), gateway: deps.settings.gateway })
      const credit = await readCredit(client, { strict: true })
      if (credit) {
        entry.credit = { remain: credit.remain, total: credit.total, plan: credit.plan ?? null, expiring: credit.expiringTotal ?? 0 }
        entry.creditCheckedAt = Date.now()
      }
      const checkin = await readCheckin(client, { now: new Date(), state: readCheckinState(), accountId: account.id })
      entry.checkin = {
        available: checkin.available,
        claimable: checkin.claimable,
        claimedToday: checkin.claimedToday,
        amount: checkin.amount,
        title: checkin.title,
        reason: checkin.reason ?? null,
        // The eligible campaigns, discovered from the upstream list rather than
        // hardcoded, are what the row expands into; the fields above stay as the
        // aggregate the compact row was built around.
        campaigns: checkin.campaigns.map(({ key, campaignId, label, claimable, claimedToday, amount, reason, description }) => ({
          key,
          campaignId,
          label,
          claimable,
          claimedToday,
          amount,
          description: description ?? null,
          reason: reason ?? null,
        })),
        // Campaigns that exist upstream but cannot be claimed by this account
        // (student certification, auto-grant) so the UI can explain the gap.
        unavailable: checkin.unavailable ?? [],
      }
      const identity = parseIdentity(tripleCache.get(account.id)?.securityToken)
      if (!account.accountName && identity.accountName) {
        entry.accountName = identity.accountName
        await rememberAccountName(account.id, identity.accountName)
      }
    } catch (error) {
      failure = error
      entry.error = message(error)
    }
    entry.health = accountHealth({ error: failure, credit: entry.credit })
    const current = readStore().accounts.find((item) => item.id === account.id)
    if (current?.sk === account.sk && deps.healthChecks.get(account.id)?.promise === operation) deps.healthCache.set(account.id, entry)
    return entry
  })()
  deps.healthChecks.set(account.id, { signature, promise: operation })
  try { return await operation } finally {
    if (deps.healthChecks.get(account.id)?.promise === operation) deps.healthChecks.delete(account.id)
  }
}
/** Keep pool reads responsive while limiting the burst sent to the upstream gateway. */
const READ_ONLY_ACCOUNT_CONCURRENCY = 3

async function mapAccountsWithConcurrency(accounts, worker) {
  const results = new Array(accounts.length)
  let next = 0
  const workers = Array.from({ length: Math.min(READ_ONLY_ACCOUNT_CONCURRENCY, accounts.length) }, async () => {
    while (true) {
      const index = next++
      if (index >= accounts.length) return
      results[index] = await worker(accounts[index])
    }
  })
  await Promise.all(workers)
  return results
}

async function handleAccounts(deps) {
  const store = readStore()
  const accounts = await mapAccountsWithConcurrency(store.accounts, async (account) => {
    const cached = deps.healthCache.get(account.id)
    return cached && Date.now() - cached.health.checkedAt < 60000 ? { ...cached, ...publicAccount(account, store) } : inspectAccount(account, deps)
  })
  // The user can switch or remove an account while the probes are running.
  const current = readStore()
  return {
    ok: true, version: STORE_VERSION, activeId: current.activeId,
    accounts: accounts.filter((account) => current.accounts.some((entry) => entry.id === account.id))
      .map((account) => ({ ...account, active: account.id === current.activeId })),
    today: todaySummary(current.accounts.map(({ id, label, ak }) => ({ id, label: label ?? defaultLabel(ak) })), new Date()),
  }
}
async function handleAccountCheck(req, deps) {
  const { id } = await readJsonBody(req)
  const account = readStore().accounts.find((entry) => entry.id === id)
  if (!account) throw new HttpError(404, '账号不存在')
  return { ok: true, account: await inspectAccount(account, deps, true) }
}
async function handleAccountCheckAll(req, deps) {
  await readJsonBody(req)
  const store = readStore()
  const accounts = await mapAccountsWithConcurrency(store.accounts, (account) =>
    hasAccount(account.id) ? inspectAccount(account, deps, true) : null)
  return { ok: true, accounts: accounts.filter(Boolean) }
}

/**
 * Cached signed triples, keyed by account id.
 *
 * The pool reads credit and check-in for several accounts in one pass; without
 * a cache that is one STS exchange per account per refresh, which both wastes
 * requests and risks the IAM rate limit. Renewal is the provider's job for the
 * active account; this cache only serves the read-only pool view.
 */
const tripleCache = new Map()

/** Resolve a signed triple for one account, reusing it while it is fresh. */
async function tripleOf(account) {
  const signature = createHash('sha256').update(`${account.ak}:${account.sk}`).digest('hex')
  const cached = tripleCache.get(account.id)
  if (cached && cached.sourceSignature === signature && Date.now() < cached.expiresAt - 300_000) return cached
  const sts = await getSts(account.ak, account.sk)
  const triple = {
    sourceSignature: signature,
    ak: sts.ak,
    sk: sts.sk,
    securityToken: sts.securityToken,
    expiresAt: Date.parse(sts.expiresAt) || Date.now() + 3600_000,
  }
  tripleCache.set(account.id, triple)
  return triple
}

async function handleAccountAdd(req, deps) {
  const body = await readJsonBody(req)
  const result = await addAccount({
    ak: typeof body.ak === 'string' ? body.ak : '',
    sk: typeof body.sk === 'string' ? body.sk : '',
    label: typeof body.label === 'string' ? body.label : undefined,
  })
  deps.healthCache.delete(result.account.id)
  deps.healthChecks.delete(result.account.id)
  tripleCache.delete(result.account.id)
  deps.credentials.invalidate()
  deps.rescheduleDailyCheckin(true)
  void deps.refresh()
  return { ok: true, added: result.added, id: result.account.id }
}

/**
 * Import accounts from pasted text or an uploaded file's contents.
 *
 * The browser sends the text; parsing lives on the Host so the same rules apply
 * to a CSV dropped in and to one pasted into the box.
 */
/**
 * Parse a picked file and report what it holds, writing nothing.
 *
 * The confirmation is what needs the user's attention, so the parsed entries are
 * shown before anything is written: an import that silently took a file the user
 * mis-clicked is worse than one that asks. Only display fields come back — the
 * secrets stay on the Host and never enter the browser.
 */
async function handleAccountPreview(req, deps) {
  const body = await readJsonBody(req)
  const text = typeof body.text === 'string' ? body.text : ''
  const parsed = parseImport(text)
  if (parsed.accounts.length === 0) {
    throw new HttpError(400, '没有从这段内容里认出任何 AK/SK 对。支持华为云 credentials.csv、每行 AK,SK、或本插件导出的 JSON。')
  }
  const store = readStore()
  const known = new Set(store.accounts.map((account) => account.id))
  return {
    ok: true,
    total: parsed.accounts.length,
    skipped: parsed.skipped,
    accounts: parsed.accounts.map((entry, index) => ({
      index,
      label: entry.label ?? null,
      akMasked: maskKey(entry.ak),
      // Whether this entry would update an existing account rather than add one.
      existing: known.has(accountIdOf(entry.ak)),
    })),
  }
}

async function handleAccountImport(req, deps) {
  const body = await readJsonBody(req)
  const parsed = parseImport(typeof body.text === 'string' ? body.text : '')
  if (parsed.accounts.length === 0) {
    throw new HttpError(400, '没有从这段内容里认出任何 AK/SK 对。支持华为云 credentials.csv、每行 AK,SK、或导出过的 JSON。')
  }
  const result = await addAccounts(parsed.accounts)
  deps.invalidateAccounts()
  deps.credentials.invalidate()
  deps.rescheduleDailyCheckin(true)
  void deps.refresh()
  return {
    ok: true,
    added: result.added,
    updated: result.updated,
    skipped: result.skipped + parsed.skipped,
    total: result.store.accounts.length,
  }
}

async function handleAccountRemove(req, deps) {
  const body = await readJsonBody(req)
  if (typeof body.id !== 'string') throw new HttpError(400, '缺少账号 id')
  await removeAccount(body.id)
  tripleCache.delete(body.id)
  deps.healthCache.delete(body.id)
  deps.healthChecks.delete(body.id)
  deps.credentials.invalidate()
  void deps.refresh()
  return { ok: true }
}

async function handleAccountActivate(req, deps) {
  const body = await readJsonBody(req)
  if (typeof body.id !== 'string') throw new HttpError(400, '缺少账号 id')
  if (!readStore().accounts.some((account) => account.id === body.id)) throw new HttpError(404, '账号不存在')
  await setActiveAccount(body.id)
  deps.credentials.invalidate()
  void deps.refresh()
  return { ok: true }
}

async function handleAccountRename(req, deps) {
  const body = await readJsonBody(req)
  if (typeof body.id !== 'string') throw new HttpError(400, '缺少账号 id')
  await renameAccount(body.id, typeof body.label === 'string' ? body.label : '')
  return { ok: true }
}

/**
 * Export the store as text the user can paste into another install.
 *
 * Returns the real keys: an export that cannot be re-imported would be useless.
 * The route is loopback-only, like every other route here.
 */
async function handleAccountExport(deps) {
  return { ok: true, text: exportStore(readStore()) }
}

// ── daily check-in ─────────────────────────────────────────────────────────

/**
 * Save the model selection and apply it without a restart.
 *
 * `enabledIds: null` restores "offer everything", which is what a user gets by
 * pressing reset — distinct from an empty array, which would mean "offer
 * nothing" and leave the picker empty with no way back.
 */
async function handleModelSelection(req, deps) {
  const body = await readJsonBody(req)
  const selection = validateSelection({ enabledModelIds: body.enabledIds, modelOverrides: body.overrides ?? {} })
  await applyPreferences(deps, selection)
  // Announce the new catalog so the picker reloads without a restart.
  deps.ctx.emit('llm/models-updated', PROVIDER_ID)
  return { ok: true, enabled: deps.catalog.visible().length, total: deps.catalog.models().length }
}

/** Probe a draft with an isolated session; never write it into preferences. */
async function handleModelTest(req, deps) {
  const body = await readJsonBody(req)
  const model = typeof body.modelId === 'string' ? deps.catalog.find(body.modelId) : undefined
  if (!model) throw new HttpError(400, '请选择目录中的模型进行测试')
  if (body.overrides !== undefined && (body.overrides === null || typeof body.overrides !== 'object' || Array.isArray(body.overrides))) {
    throw new InputError('模型覆盖配置格式不正确')
  }
  const { modelOverrides } = validateSelection({
    enabledModelIds: null,
    modelOverrides: { [model.id]: { ...deps.settings.modelOverrides?.[model.id], ...body.overrides } },
  })
  if (body.overrides && Object.hasOwn(body.overrides, 'context')) validateContextOverrides(deps.catalog, { [model.id]: modelOverrides[model.id] ?? {} })
  const preview = new Catalog()
  preview.configure({ overrides: modelOverrides })
  const effective = preview.effective(model)
  const controller = new AbortController()
  const started = Date.now()
  let timer
  const run = async () => {
    const resolved = await deps.credentials.resolve()
    controller.signal.throwIfAborted()
    const sessionId = `codearts-test-${randomUUID()}`
    const client = new MadaoClient({
      credentials: resolved.key,
      gateway: deps.settings.gateway,
      sessionId,
      fetch: (input, init) => globalThis.fetch(input, { ...init, signal: controller.signal }),
    })
    let sawText = false
    try {
      await client.heartbeat('busy')
      controller.signal.throwIfAborted()
      for await (const event of client.streamChat({
        model: model.id,
        messages: [{ role: 'user', content: '请只回复 OK。' }],
        maxTokens: effective.maxOutput,
        reasoningEffort: (effective.strengths ?? []).includes(effective.defaultStrength)
          ? effective.defaultStrength : effective.strengths?.[0],
        signal: controller.signal,
      })) {
        if (event.text?.trim()) sawText = true
        if (event.error) throw new Error(event.error)
      }
      controller.signal.throwIfAborted()
      if (!sawText) throw new Error('模型未返回正文，请稍后重试或检查推理设置')
    } finally {
      // Release only this probe's session, even when its main request timed out.
      client.fetch = (input, init) => globalThis.fetch(input, { ...init, signal: AbortSignal.timeout(5000) })
      void client.heartbeat('idle').catch(() => {})
    }
  }
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('模型测试超时（30 秒），请稍后重试')
        reject(error)
        controller.abort(error)
      }, 30000)
    })
    await Promise.race([run(), deadline])
    return { ok: true, elapsedMs: Date.now() - started }
  } catch (error) {
    return { ok: false, elapsedMs: Date.now() - started, error: message(error) }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

async function handleCheckinStatus(deps) {
  const store = readStore()
  const now = new Date()
  const state = readCheckinState()
  const accounts = await mapAccountsWithConcurrency(store.accounts, async (account) => {
    const entry = { id: account.id, label: account.label ?? defaultLabel(account.ak), state: null, error: null }
    try {
      const client = new MadaoClient({ credentials: await tripleOf(account), gateway: deps.settings.gateway })
      entry.state = await readCheckin(client, { now, state, accountId: account.id })
    } catch (error) {
      // Keep one account's gateway/credential failure isolated from the pool.
      entry.error = error?.message ?? String(error)
    }
    return entry
  })
  return {
    ok: true,
    accounts,
    today: todaySummary(accounts, now),
  }
}

/** Claim the daily bonuses for one account, on an explicit click. */
async function handleCheckinClaim(req, deps) {
  const body = await readJsonBody(req)
  const id = typeof body.id === 'string' ? body.id : undefined
  const store = readStore()
  const account = id ? store.accounts.find((entry) => entry.id === id) : activeAccount(store)
  if (!account) throw new HttpError(400, '没有这个账号')
  try {
    const client = new MadaoClient({ credentials: await tripleOf(account), gateway: deps.settings.gateway })
    const result = await deps.serializeCheckin(() => claimDaily(client, { accountId: account.id }))
    deps.healthCache.delete(account.id)
    deps.healthChecks.delete(account.id)
    return {
      ok: true,
      ...result,
      // `reason` stays the single-line summary the one-campaign UI showed;
      // `reasons` carries every campaign that was not claimed.
      reason: result.reasons.join('；') || undefined,
      label: account.label ?? defaultLabel(account.ak),
    }
  } catch (error) {
    return { ok: false, claimed: false, reason: error?.message ?? String(error) }
  }
}

/** Claim the daily bonus for the pool, only on an explicit click. */
async function handleCheckinClaimAll(req, deps) {
  await readJsonBody(req)
  const store = readStore()
  const targets = []
  const credentialFailures = []
  for (const account of store.accounts) {
    if (!hasAccount(account.id)) continue
    try {
      targets.push({
        id: account.id,
        client: new MadaoClient({ credentials: await tripleOf(account), gateway: deps.settings.gateway }),
      })
    } catch (error) {
      // An account whose key cannot be exchanged is skipped, not fatal.
      credentialFailures.push({ id: account.id, reason: message(error) })
    }
  }
  const summary = await deps.serializeCheckin(() => claimAllDaily({ targets, shouldInclude: hasAccount }))
  summary.attempted += credentialFailures.length
  summary.failures.push(...credentialFailures)
  deps.healthCache.clear()
  deps.healthChecks.clear()
  return { ok: true, summary }
}

async function handleTest(deps) {
  const steps = []
  try {
    const { client, resolved } = await deps.client()
    steps.push({ step: '凭证', ok: true, detail: resolved.label })

    try {
      const key = await client.ensureSessionKey()
      steps.push({
        step: '会话密钥',
        ok: true,
        detail: `keyId ${key.keyId}，剩余 ${Math.round((key.expiresAt - Date.now()) / 1000)} 秒`,
      })
    } catch (error) {
      steps.push({ step: '会话密钥', ok: false, detail: message(error) })
      return { ok: false, steps }
    }

    const refreshResult = await deps.refresh()
    steps.push({
      step: '模型清单',
      ok: refreshResult.source === 'gateway' && !refreshResult.error,
      detail:
        refreshResult.source === 'gateway' && !refreshResult.error
          ? `${deps.catalog.models().length} 个模型`
          : (refreshResult.error ?? '退回兜底清单'),
    })

    const credit = await readCredit(client)
    steps.push({
      step: '积分',
      ok: credit !== null,
      detail: credit ? `剩余 ${credit.remain} / 共 ${credit.total}` : '读不到积分（不影响对话）',
    })

    const identity = parseIdentity(resolved.key.securityToken)
    if (identity.accountName) {
      steps.push({ step: '账号', ok: true, detail: identity.accountName })
    }

    return { ok: steps.every((step) => step.ok), steps }
  } catch (error) {
    steps.push({
      step: '凭证',
      ok: false,
      detail: error instanceof CredentialError ? error.message : message(error),
    })
    return { ok: false, steps }
  }
}

async function handleRefresh(deps) {
  const result = await deps.refresh()
  return {
    ok: result.source === 'gateway',
    source: result.source,
    models: deps.catalog.models().length,
    error: result.error ?? null,
  }
}

async function handleBenefits(deps) {
  try {
    const { client } = await deps.client()
    const items = await listBenefits(client)
    return { ok: true, items }
  } catch (error) {
    return { ok: false, error: message(error), items: [] }
  }
}

async function handleClaim(req, deps) {
  const body = await readJsonBody(req)
  const campaignId = Number(body.campaignId)
  if (!Number.isInteger(campaignId)) throw new HttpError(400, 'campaignId 必须是整数')
  try {
    const { client } = await deps.client()
    const result = await claimBenefit(client, campaignId)
    if (!result.ok) return { ok: false, error: result.reason }
    return { ok: true, reply: result.reply }
  } catch (error) {
    return { ok: false, error: message(error) }
  }
}

// ── plumbing ───────────────────────────────────────────────────────────────

/** An HTTP failure with an explicit status. */
class HttpError extends Error {
  constructor(status, messageText) {
    super(messageText)
    this.status = status
  }
}

/**
 * Whether a request came from this Host's own page rather than from another site.
 *
 * `isLoopback` alone does not answer this: a page on any site can send
 * `fetch('http://127.0.0.1:PORT/plugins/...')`, and the request then arrives over
 * loopback carrying that page's credentials — same loopback socket, someone
 * else's code. These routes read and can export credentials, so the browser has
 * to say where the request came from and it has to be this Host.
 *
 * The Host half ships no server-side authentication (DSH's webserver documents
 * that route owners enforce their own request policy), so this is the only fence
 * a plugin route has. It stops the cross-site case, which is the one that turns
 * "any page you have open" into "your exported AK/SK". It does not establish
 * identity and does not replace the Host's own authentication.
 *
 * Signals, in order of authority:
 *   - `Sec-Fetch-Site: cross-site` — a cross-site caller is refused outright.
 *   - `Origin`, else `Referer` — must name exactly the Host header's authority.
 *   - Neither header — allowed: a browser fetch always sends at least one, so
 *     this is a non-browser client (curl, a script), which is the user's own
 *     action on their own machine and outside what this fence covers.
 */
function isSameOrigin(req) {
  const site = String(req.headers?.['sec-fetch-site'] ?? '').toLowerCase()
  if (site === 'cross-site') return false

  /** `host:port` for a URL string, or null when it does not parse. */
  const authorityOf = (value) => {
    try {
      const parsed = new URL(value)
      // Default ports collapse, so `http://h:80` equals `http://h`.
      const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
      return `${parsed.hostname.toLowerCase()}:${port}`
    } catch {
      return null
    }
  }

  const host = String(req.headers?.host ?? '')
  const own = host === '' ? null : authorityOf(`http://${host}`)

  for (const header of ['origin', 'referer']) {
    const value = req.headers?.[header]
    if (typeof value !== 'string' || value === '') continue
    // 'null' is the opaque origin of a sandboxed frame or a `file://` page.
    if (value === 'null') return false
    const seen = authorityOf(value)
    if (seen === null) return false
    // A browser always sends Host, so an absent Host plus an Origin is not a
    // same-page request; refuse it rather than skipping the comparison.
    if (own === null) return false
    if (seen !== own) return false
  }
  return true
}

/**
 * Run one handler and answer in JSON.
 *
 * Every route is loopback-only: the settings surface reads credentials and
 * the account balance, and a hostname resolving to 127.0.0.1 must not reach
 * it from a browser.
 */
async function handleRoute(req, res, handler) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  try {
    if (!isLoopback(req)) {
      return json(res, 403, { ok: false, error: '只接受本机请求' })
    }
    if (!isSameOrigin(req)) {
      return json(res, 403, { ok: false, error: '拒绝跨站请求' })
    }

    const path = resolveHandlerPath(url.pathname)
    if (path === null) return json(res, 404, { ok: false, error: 'unknown route' })

    // Mutating routes are POST-only: a read route may answer GET so a link in
    // the page still works, but nothing that changes state answers a GET, or a
    // prefetch or an accidental refresh could clear the saved credentials.
    const mutating = MUTATING_PATHS.has(path)
    if (mutating ? req.method === 'POST' : req.method === 'GET' || req.method === 'POST') {
      const value = await handler(req, url)
      return json(res, 200, value)
    }
    if (mutating) res.setHeader('Allow', 'POST')
    return json(res, 405, { ok: false, error: 'method not allowed' })
  } catch (error) {
    const status = error instanceof HttpError ? error.status : error instanceof InputError ? 400 : 500
    return json(res, status, { ok: false, error: message(error) })
  }
}

/** Routes that change state and therefore accept POST only. */
const MUTATING_PATHS = new Set([
  '/activities/clear',
  '/preferences/save', '/accounts/check', '/accounts/check-all',
  '/models/select',
  '/models/test',
  '/save',
  '/clear',
  '/claim',
  '/accounts/add',
  // Returns every account's plaintext AK/SK, so it must not answer a GET: a
  // link, a prefetch, or an <img src> must never be able to pull credentials.
  '/accounts/export',
  '/accounts/import',
  '/accounts/remove',
  '/accounts/activate',
  '/accounts/rename',
  '/checkin/claim',
  '/checkin/claim-all',
])

/** The exact sub-path of a plugin route, or null when it is not one. */
function resolveHandlerPath(pathname) {
  if (!pathname.startsWith(ROUTE_PREFIX)) return null
  const rest = pathname.slice(ROUTE_PREFIX.length)
  return rest === '' ? null : rest
}

/** Whether the request arrived over the loopback interface. */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.')
  )
}

/** Read and parse a JSON request body. */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) throw new HttpError(413, '请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  let body
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '请求体必须为 JSON 对象')
  return body
}

/** Answer with JSON. */
function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/** Extract a message from any thrown value. */
function message(error) {
  if (error instanceof GatewayError) return error.message
  return error?.message ?? String(error)
}

/**
 * A bounded diagnostic logger.
 *
 * Writes to the Host log only; the settings page reads state through the
 * routes, so nothing here is the source of truth.
 */
function createLogger() {
  const prefix = '[dsh-codearts-dock]'
  return (line) => {
    try {
      console.log(`${prefix} ${line}`)
    } catch {
      // A closed stdout must not break the plugin.
    }
  }
}

/** Expose a stable id for the client half's lazy factory. */
export const meta = {
  PROVIDER_ID,
  PROVIDER_NAME,
  credentialPath: CREDENTIAL_PATH,
  requestId: () => randomUUID(),
}
