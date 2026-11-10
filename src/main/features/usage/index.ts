import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, dialog, Notification, shell } from 'electron'
import type { Billing, CursorImport, UsageAccountState, UsageBudget, UsageBudgetState, UsageDay, UsageSignIn, UsageSpan, UsageSummary, UsageSync } from '@shared/usage'
import { FREE_PROVIDER_ID, GATEWAY_PROVIDER_ID } from '@shared/freeCredits'
import { getProvider, onBeforeModelRequest, onModelUsage } from '../../providers'
import { ProviderIssueError } from '../../providers/errors'
import { shownProviderId } from '../../eaonAddress'
import { LOCAL_PROVIDER_ID } from '../../llama/models'
import { store } from '../../store'
import type { TokenUsage } from '@shared/types'
import type { Feature, FeatureContext } from '../types'
import { afterToknSignIn, onToknCliSynced, syncToknCli, toknCliLastSync, toknCliStatus } from '../toknCli'
import { agentRunDays, flushAgentRuns, onAgentRun } from './agentRuns'
import { flushLedger, ledgerDays, ledgerProjects, ledgerSources, onLedgerChange, recordUsage } from './ledger'
import { budgetBlockMessage, budgetNotice, budgetState, monthOf, monthUse, nextAlert, normalizeAlerts, normalizeBudget, type BudgetAlerts } from './budget'
import { usageCsv, usageCsvName } from './exportCsv'
import { cliLogs, flushCliLogs, importCursorCsv, onCliLogsChange } from './cliLogs'
import {
  activity,
  agentStats,
  calendar,
  costOf,
  dailyTotals,
  normalizeSpan,
  priceOf,
  rangeDays,
  spanDays,
  summarize,
  summarizeProjects,
  summarizeSources,
  summarizeTools,
  syncAgents,
  syncRows,
  withCliDays,
  type BillingOf,
  type ToknPricing
} from './rows'
import { fetchPricing, fetchProfileDays, refreshAccount, signIn, signOut, submitCode, toknAccount, toknPageUrl, upload, type ToknProfileDay } from './tokn'

/**
 * Settings → Usage, and the Tokn account that is Eaon's account. Every model
 * request Eaon makes for itself is counted on this computer (`ledger.ts`), and
 * every agent run (`agentRuns.ts`); signing in with Tokn shows the counts
 * priced at Tokn's rates and uploads them as daily totals under the `eaon`
 * tool, a few minutes after new usage and whenever the user asks.
 *
 * Channels (all `usage:`): `summary`, `account`, `sign-in`, `cancel-sign-in`,
 * `submit-code`, `sign-out`, `sync`, `open-profile`, `export-csv`, `budget`,
 * `set-budget`, and the `changed` event.
 *
 * The monthly budget (budget.ts) warns from the ledger and can refuse
 * pay-per-token requests before they are sent: it registers a gate on the
 * provider adapters (`onBeforeModelRequest`).
 */

const PRICING_FILE = 'tokn-pricing.json'
const SYNC_FILE = 'tokn-sync.json'
const BUDGET_FILE = 'usage-budget.json'
const BUDGET_ALERTS_FILE = 'usage-budget-alerts.json'
const PROFILE_FILE = 'tokn-profile.json'
/** The profile is read again when Settings → Usage asks and the last copy is older than this. */
const PROFILE_MAX_AGE_MS = 5 * 60_000
/** After a failed read, the next waits this long, so a page that refreshes often doesn't hammer Tokn. */
const PROFILE_RETRY_MS = 60_000
const PRICING_MAX_AGE_MS = 24 * 3_600_000
/** New usage is uploaded this long after it happens, so a busy hour is one upload. */
const SYNC_AFTER_USAGE_MS = 5 * 60_000
/** Started after launch, when the last upload is older than this. */
const SYNC_ON_LAUNCH_AFTER_MS = 60 * 60_000

let ctx: FeatureContext | null = null
let pricing: { fetchedAt: number; models: ToknPricing } = savedPricing()
let pricingLoad: Promise<void> | null = null
let signInState: UsageSignIn = { state: 'idle' }
let signInAbort: AbortController | null = null
let sync: UsageSync = savedSync()
let syncTimer: ReturnType<typeof setTimeout> | null = null
let syncing: Promise<void> | null = null
let changedTimer: ReturnType<typeof setTimeout> | null = null
let profile: SavedProfile | null = savedProfile()
let profileLoad: Promise<void> | null = null
let profileTriedAt = 0
let budget: UsageBudget = normalizeBudget(store.getJson(BUDGET_FILE, {}))
let budgetAlerts: BudgetAlerts = normalizeAlerts(store.getJson(BUDGET_ALERTS_FILE, {}))
/** Bumped on every recorded request, so the budget's month total is worked out once per change, not once per request. */
let ledgerVersion = 0
let budgetCache: { key: string; state: UsageBudgetState } | null = null
const budgetNotifications = new Set<Notification>()

/** The signed-in profile's days as last read from Tokn, and whose they are. */
interface SavedProfile {
  accountId: string
  at: number
  days: ToknProfileDay[]
}

function savedProfile(): SavedProfile | null {
  const saved = store.getJson<Record<string, unknown>>(PROFILE_FILE, {})
  if (typeof saved.accountId !== 'string' || typeof saved.at !== 'number' || !Array.isArray(saved.days)) return null
  const days = (saved.days as Partial<ToknProfileDay>[]).filter(
    (d): d is ToknProfileDay => typeof d?.day === 'string' && typeof d.costUsd === 'number' && typeof d.tokens === 'number' && typeof d.requests === 'number'
  )
  return { accountId: saved.accountId, at: saved.at, days }
}

/**
 * Reads the profile from Tokn when the last copy is stale (or `force`). It is
 * what toknhq.com draws: every computer and tool, Eaon's uploads and the tokn
 * command's, priced by Tokn. Keeps the last copy when Tokn can't be reached.
 */
function loadProfile(force = false): Promise<void> {
  const account = toknAccount()
  if (!account) return Promise.resolve()
  const fresh = profile?.accountId === account.id && Date.now() - profile.at < PROFILE_MAX_AGE_MS
  if (profileLoad || (!force && (fresh || Date.now() - profileTriedAt < PROFILE_RETRY_MS))) return profileLoad ?? Promise.resolve()
  profileTriedAt = Date.now()
  profileLoad = fetchProfileDays()
    .then((days) => {
      if (toknAccount()?.id !== account.id) return
      profile = { accountId: account.id, at: Date.now(), days }
      store.setJson(PROFILE_FILE, profile)
      changed()
    })
    .catch((error) => console.warn('[usage] Tokn profile:', error instanceof Error ? error.message : error))
    .finally(() => {
      profileLoad = null
    })
  return profileLoad
}

/** The profile's days the way the calendar and the streaks count them. */
function profileByDay(days: ToknProfileDay[]): Map<string, UsageDay> {
  const byDay = new Map<string, UsageDay>()
  for (const d of days) if (d.requests > 0 || d.tokens > 0 || d.costUsd > 0) byDay.set(d.day, { day: d.day, costUsd: d.costUsd, tokens: d.tokens, requests: d.requests })
  return byDay
}

/**
 * The sync state to show: when the profile last took this computer's usage,
 * from Eaon's own upload or the tokn command's (the CLIs), whichever is later.
 * Eaon uploads only after its own use, so on a day spent in Claude Code the
 * tokn command's sync is the recent one.
 */
function shownSync(): UsageSync {
  const account = toknAccount()
  const cli = toknCliLastSync()
  if (!account || !cli || (cli.handle && cli.handle !== account.handle)) return sync
  return !sync.at || Date.parse(cli.at) > Date.parse(sync.at) ? { ...sync, at: cli.at } : sync
}

/** Tokn's prices as last fetched; anything that isn't a price table counts as never fetched. */
function savedPricing(): { fetchedAt: number; models: ToknPricing } {
  const saved = store.getJson<Record<string, unknown>>(PRICING_FILE, {})
  const models = saved.models
  const fetchedAt = typeof saved.fetchedAt === 'number' && Number.isFinite(saved.fetchedAt) ? saved.fetchedAt : 0
  if (!models || typeof models !== 'object' || Array.isArray(models)) return { fetchedAt: 0, models: {} }
  return { fetchedAt, models: models as ToknPricing }
}

function savedSync(): UsageSync {
  const saved = store.getJson<Record<string, unknown>>(SYNC_FILE, {})
  const finite = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
  return {
    state: 'idle',
    at: typeof saved.at === 'string' && !Number.isNaN(Date.parse(saved.at)) ? saved.at : null,
    accepted: finite(saved.accepted),
    rejected: finite(saved.rejected),
    rank: finite(saved.rank) ?? null
  }
}

/**
 * How a provider's requests are paid for. Subscriptions (ChatGPT, Copilot,
 * the coding plans) are `plan`: Tokn's rates on them are an equivalent, not a
 * bill. Looked up once per summary: getProvider reads providers.json.
 */
function billingLookup(): BillingOf {
  const known = new Map<string, Billing>()
  return (providerId) => {
    let billing = known.get(providerId)
    if (!billing) {
      // An agent engine's turns (workers on Codex) are recorded under the
      // engine's name plus how it was paid for: the user's plan (the default),
      // their API key, or a provider the engine was set up with, which Eaon
      // can't price.
      // Claude Code and Codex in a terminal (their own logs) are taken as on
      // a plan: at API rates, what the use stands for, never spend.
      // Codex and Claude both, as engines: neither id is a provider's.
      const [engineId, paidFor] = providerId.split(':')
      const engineTurn = engineId === 'codex' || engineId === 'claude'
      const engineBilling = providerId.startsWith('cli:')
        ? 'plan'
        : engineTurn && paidFor === undefined
          ? 'plan'
          : engineTurn && paidFor === 'api'
            ? 'api'
            : engineTurn && paidFor === 'provider'
              ? 'local'
              : null
      const provider = engineBilling || providerId === LOCAL_PROVIDER_ID ? null : getProvider(providerId)
      billing = engineBilling ?? (providerId === LOCAL_PROVIDER_ID || provider?.local ? 'local' : provider?.category === 'subscription' ? 'plan' : 'api')
      known.set(providerId, billing)
    }
    return billing
  }
}

/**
 * What one run cost at published rates, for a worker's dollar cap: null when
 * it isn't billed per token (a plan, or a model on this computer) or Tokn's
 * rates have no price for the model (not read yet, or not listed). A cap
 * counts only what the app can really price.
 */
export function estimateCostUsd(providerId: string, modelId: string, usage: TokenUsage): number | null {
  if (billingLookup()(providerId) !== 'api') return null
  const priced = priceOf(modelId, pricing.models)
  if (!priced) return null
  return costOf({ requests: 1, input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite }, priced.price)
}

/** Picks Cursor's usage export (one or more CSVs) and imports it; null when the picker was closed. */
async function chooseCursorCsv(): Promise<CursorImport | null> {
  const win = ctx?.getWindow()
  const options = { title: 'Import Cursor usage', filters: [{ name: 'CSV', extensions: ['csv'] }], properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[] }
  const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  if (picked.canceled || picked.filePaths.length === 0) return null
  let result: CursorImport = { added: 0, total: cliLogs().cursorImported }
  for (const file of picked.filePaths) {
    const one = await importCursorCsv(await readFile(file, 'utf8'))
    result = { added: result.added + one.added, total: one.total, ...(one.error ? { error: one.error } : {}) }
  }
  return result
}

/** Saves what the Usage page shows for `range` as a CSV, where the person says; null when the dialog was closed. */
async function exportCsv(range: UsageSpan): Promise<{ path: string } | null> {
  const shaped = summary(range)
  const win = ctx?.getWindow()
  const options = {
    title: 'Save usage as CSV',
    defaultPath: join(app.getPath('downloads'), usageCsvName(shaped)),
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  }
  const picked = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
  if (picked.canceled || !picked.filePath) return null
  try {
    await writeFile(picked.filePath, usageCsv(shaped), 'utf8')
  } catch (error) {
    throw new Error(`Couldn’t save the file: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { path: picked.filePath }
}

/** Tells every window to read the summary again; coalesced, since a busy agent records many requests a second. */
function changed(): void {
  if (changedTimer) return
  changedTimer = setTimeout(() => {
    changedTimer = null
    ctx?.send('usage:changed')
  }, 400)
}

/** Loads Tokn's prices when they are a day old or missing; the last copy stays in use if Tokn can't be reached. */
function loadPricing(force = false): Promise<void> {
  if (!force && Date.now() - pricing.fetchedAt < PRICING_MAX_AGE_MS) return Promise.resolve()
  pricingLoad ??= fetchPricing()
    .then((models) => {
      if (Object.keys(models).length === 0) return
      pricing = { fetchedAt: Date.now(), models }
      store.setJson(PRICING_FILE, pricing)
      changed()
    })
    .catch((error) => console.warn('[usage] Tokn prices:', error instanceof Error ? error.message : error))
    .finally(() => {
      pricingLoad = null
    })
  return pricingLoad
}

/**
 * The pay-per-token requests the budget counts and can refuse: a provider
 * paid by the token with a key of the user's. Plans, local models and Eaon's
 * own free tiers (Eaon Lite, Eaon Event) are never charged per token.
 */
function countsTowardBudget(billingOf: BillingOf): (providerId: string) => boolean {
  return (providerId) => {
    const shown = shownProviderId(providerId)
    return billingOf(providerId) === 'api' && shown !== GATEWAY_PROVIDER_ID && shown !== FREE_PROVIDER_ID
  }
}

/** The budget and this month's use of it. */
function budgetNow(now: Date = new Date()): UsageBudgetState {
  const month = monthOf(now)
  const key = `${month} ${ledgerVersion} ${pricing.fetchedAt} ${JSON.stringify(budget)}`
  if (budgetCache?.key === key) return budgetCache.state
  const billingOf = billingLookup()
  const use = monthUse(ledgerDays(), ledgerSources(), month, budget.unit, pricing.models, billingOf, countsTowardBudget(billingOf))
  const state = budgetState(budget, month, use, pricing.fetchedAt > 0)
  budgetCache = { key, state }
  return state
}

/**
 * Says so, once, when the month's use reaches the warning or the limit. With
 * `quiet` (the person just changed the budget and can see the meter) it only
 * brings what was said up to date.
 */
function checkBudget(quiet = false): void {
  if (!budget.enabled) return
  const state = budgetNow()
  const { alert, alerts } = nextAlert(state, budgetAlerts)
  if (JSON.stringify(alerts) !== JSON.stringify(budgetAlerts)) {
    budgetAlerts = alerts
    store.setJson(BUDGET_ALERTS_FILE, alerts)
  }
  const notice = alert && !quiet ? budgetNotice(state) : null
  if (!notice || !Notification.isSupported()) return
  const notification = new Notification(notice)
  // Held until clicked or closed: a notification that is garbage-collected loses its click handler.
  budgetNotifications.add(notification)
  notification.on('click', () => {
    budgetNotifications.delete(notification)
    const win = ctx?.getWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
  notification.on('close', () => budgetNotifications.delete(notification))
  notification.show()
}

/** Refuses a pay-per-token request once the budget's hard cap is reached, saying why. */
function budgetGate(providerId: string): void {
  if (!budget.enabled || !budget.hardCap) return
  void loadPricing()
  if (!countsTowardBudget(billingLookup())(providerId)) return
  const state = budgetNow()
  if (state.blocked) throw new ProviderIssueError({ kind: 'other', message: budgetBlockMessage(state), action: 'choose-model', providerId })
}

function summary(range: UsageSpan): UsageSummary {
  void loadPricing()
  const days = ledgerDays()
  const billingOf = billingLookup()
  const shaped = summarize(days, range, pricing.models, billingOf)
  const shown = spanDays(range)
  // The chart, the calendar and the streaks count Claude Code and Codex too;
  // the tiles, the models and the upload stay Eaon's own.
  const cli = cliLogs()
  const everything = withCliDays(days, cli.days, cli.found.includes('codex'), cli.found.includes('claude-code'))
  const byDay = dailyTotals(everything, pricing.models, billingOf, true)
  // Signed in, the calendar, the streaks and the all-time tiles are the
  // profile's, so they match toknhq.com: every computer and tool, priced by
  // Tokn. This computer's own counts stand in until it has been read.
  const account = toknAccount()
  void loadProfile()
  const fromTokn = account && profile?.accountId === account.id ? profile : null
  const activityDays = fromTokn ? profileByDay(fromTokn.days) : byDay
  return {
    account,
    signIn: signInState,
    sync: shownSync(),
    range: shown.length,
    span: { from: shown[0], to: shown[shown.length - 1], custom: typeof range !== 'number' },
    priced: pricing.fetchedAt > 0,
    ...shaped,
    sources: summarizeSources(ledgerSources(), range, pricing.models, billingOf),
    projects: summarizeProjects(days, ledgerProjects(), range, pricing.models, billingOf),
    chart: rangeDays(byDay, range),
    tools: summarizeTools(everything, range, pricing.models, billingOf),
    cliLogs: { reading: cli.reading, found: cli.found, cursorImported: cli.cursorImported },
    calendar: calendar(activityDays),
    activity: activity(activityDays, range),
    activityFrom: fromTokn ? { source: 'tokn', at: fromTokn.at } : { source: 'local' },
    agents: agentStats(agentRunDays(), range)
  }
}

/** The last seven days, today last, with Claude Code and Codex counted as in the chart: the sidebar's foot. */
function week(): UsageDay[] {
  void loadPricing()
  const cli = cliLogs()
  const everything = withCliDays(ledgerDays(), cli.days, cli.found.includes('codex'), cli.found.includes('claude-code'))
  return rangeDays(dailyTotals(everything, pricing.models, billingLookup(), true), 7)
}

function setSync(next: UsageSync): void {
  sync = next
  const { state: _state, error: _error, ...kept } = next
  store.setJson(SYNC_FILE, kept)
  changed()
}

/**
 * Uploads every day's totals now, then reads the profile again. With
 * `withCli` (Sync now), the tokn command syncs the coding CLIs alongside.
 * One at a time; a second ask while one runs waits for it.
 */
function syncNow(withCli = false): Promise<void> {
  if (syncTimer) {
    clearTimeout(syncTimer)
    syncTimer = null
  }
  if (!toknAccount()) return Promise.resolve()
  syncing ??= (async () => {
    setSync({ ...sync, state: 'syncing', error: undefined })
    const cli = withCli && store.getSettings().toknCli.sync && toknCliStatus().linked ? syncToknCli() : null
    try {
      await loadPricing(Object.keys(pricing.models).length === 0)
      const rows = syncRows(ledgerDays(), pricing.models, billingLookup())
      const agents = syncAgents(agentRunDays())
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
      const result = rows.length > 0 || agents.length > 0 ? await upload(rows, timezone, agents) : { accepted: 0, rejected: 0, rank: null }
      await cli
      await loadProfile(true)
      setSync({ state: 'idle', at: new Date().toISOString(), accepted: result.accepted, rejected: result.rejected, rank: result.rank ?? sync.rank ?? null })
    } catch (error) {
      await cli
      setSync({ ...sync, state: 'error', error: error instanceof Error ? error.message : String(error) })
    }
  })().finally(() => {
    syncing = null
  })
  return syncing
}

function scheduleSync(delay: number): void {
  if (syncTimer || !toknAccount()) return
  syncTimer = setTimeout(() => {
    syncTimer = null
    void syncNow()
  }, delay)
}

async function startSignIn(): Promise<UsageSummary['account']> {
  signInAbort?.abort()
  const controller = new AbortController()
  signInAbort = controller
  signInState = { state: 'pending' }
  changed()
  try {
    const account = await signIn((url) => {
      signInState = { state: 'pending', url }
      changed()
      void shell.openExternal(url)
    }, controller.signal)
    signInState = { state: 'idle' }
    changed()
    // Approved in the browser: bring Eaon back, where the numbers now show.
    const win = ctx?.getWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
    app.focus({ steal: true })
    // Straight onto the profile, with everything counted so far.
    void syncNow()
    // And the tokn command, when the person said yes to tracking the coding CLIs too.
    afterToknSignIn()
    return account
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    signInState = controller.signal.aborted ? { state: 'idle' } : { state: 'error', error: message }
    changed()
    return null
  } finally {
    if (signInAbort === controller) signInAbort = null
  }
}

export const usageFeature: Feature = {
  id: 'usage',

  register(context) {
    ctx = context
    const { ipcMain } = context
    onModelUsage((providerId, modelId, usage) => recordUsage(providerId, modelId, usage))
    onBeforeModelRequest((provider) => budgetGate(provider.id))
    onLedgerChange((source) => {
      ledgerVersion++
      checkBudget()
      changed()
      // Other apps' requests are never uploaded, so they are no reason to sync.
      if (source !== 'gateway') scheduleSync(SYNC_AFTER_USAGE_MS)
    })
    onCliLogsChange(changed)
    // The tokn command published the CLIs: the profile has changed.
    onToknCliSynced(() => void loadProfile(true))
    onAgentRun(() => {
      changed()
      scheduleSync(SYNC_AFTER_USAGE_MS)
    })

    ipcMain.handle('usage:summary', (_e, range: unknown) => summary(normalizeSpan(range)))
    ipcMain.handle('usage:export-csv', (_e, range: unknown) => exportCsv(normalizeSpan(range)))
    // Loads the price table first when it is missing, so a dollar total isn't read as zero.
    ipcMain.handle('usage:budget', async (): Promise<UsageBudgetState> => {
      await loadPricing()
      return budgetNow()
    })
    ipcMain.handle('usage:set-budget', async (_e, patch: unknown): Promise<UsageBudgetState> => {
      const asked = typeof patch === 'object' && patch !== null && !Array.isArray(patch) ? patch : {}
      budget = normalizeBudget({ ...budget, ...asked })
      store.setJson(BUDGET_FILE, budget)
      await loadPricing()
      checkBudget(true)
      changed()
      return budgetNow()
    })
    ipcMain.handle('usage:week', () => week())
    // The account entry (sidebar, Settings) without the numbers, which it doesn't show.
    ipcMain.handle('usage:account', (): UsageAccountState => ({ account: toknAccount(), signIn: signInState, sync: shownSync() }))
    ipcMain.handle('usage:sign-in', () => startSignIn())
    ipcMain.handle('usage:cancel-sign-in', () => signInAbort?.abort())
    ipcMain.handle('usage:submit-code', (_e, input: string) => submitCode(String(input ?? '')))
    ipcMain.handle('usage:sign-out', async () => {
      if (syncTimer) clearTimeout(syncTimer)
      syncTimer = null
      await signOut()
      profile = null
      store.setJson(PROFILE_FILE, {})
      setSync({ state: 'idle', at: null })
    })
    // Sync now: Eaon's own usage, the coding CLIs through the tokn command, then the profile.
    ipcMain.handle('usage:sync', () => syncNow(true))
    ipcMain.handle('usage:import-cursor', () => chooseCursorCsv())
    ipcMain.handle('usage:open-profile', () => {
      const url = toknPageUrl('profile')
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    })

    if (toknAccount()) {
      // A handle changed on the website, or Eaon was removed from the account there.
      void refreshAccount()
        .then(changed)
        .catch((error) => {
          if (!toknAccount()) changed()
          console.warn('[usage] Tokn account:', error instanceof Error ? error.message : error)
        })
      const last = sync.at ? Date.parse(sync.at) : 0
      if (Date.now() - last > SYNC_ON_LAUNCH_AFTER_MS) scheduleSync(30_000)
    }
  },

  dispose() {
    signInAbort?.abort()
    if (syncTimer) clearTimeout(syncTimer)
    if (changedTimer) clearTimeout(changedTimer)
    flushLedger()
    flushAgentRuns()
    flushCliLogs()
  }
}

/**
 * Tokn's price table, for what Chat prices a conversation's tokens with
 * (chatContext/cost.ts). The last copy is used at once while a stale one is
 * fetched again; only a computer that has never had one waits for it.
 */
export async function loadedPricing(): Promise<ToknPricing> {
  const loading = loadPricing()
  if (Object.keys(pricing.models).length === 0) await loading
  return pricing.models
}
