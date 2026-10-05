import { app, shell } from 'electron'
import type { Billing, UsageRange, UsageSignIn, UsageSummary, UsageSync } from '@shared/usage'
import { getProvider, onModelUsage } from '../../providers'
import { LOCAL_PROVIDER_ID } from '../../llama/models'
import { store } from '../../store'
import type { Feature, FeatureContext } from '../types'
import { flushLedger, ledgerDays, ledgerSources, onLedgerChange, recordUsage } from './ledger'
import { activity, calendar, dailyTotals, summarize, summarizeSources, syncRows, type BillingOf, type ToknPricing } from './rows'
import { fetchPricing, refreshAccount, signIn, signOut, submitCode, toknAccount, toknHost, upload } from './tokn'

/**
 * Settings → Usage. Every model request Eaon makes for itself is counted on
 * this computer (`ledger.ts`); signing in with Tokn shows the counts priced at
 * Tokn's rates and uploads them as daily totals under the `eaon` tool, a few
 * minutes after new usage and whenever the user asks.
 *
 * Channels (all `usage:`): `summary`, `sign-in`, `cancel-sign-in`,
 * `submit-code`, `sign-out`, `sync`, `open-profile`, and the `changed` event.
 */

const PRICING_FILE = 'tokn-pricing.json'
const SYNC_FILE = 'tokn-sync.json'
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
      const provider = providerId === LOCAL_PROVIDER_ID ? null : getProvider(providerId)
      billing = providerId === LOCAL_PROVIDER_ID || provider?.local ? 'local' : provider?.category === 'subscription' ? 'plan' : 'api'
      known.set(providerId, billing)
    }
    return billing
  }
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

function summary(range: UsageRange): UsageSummary {
  void loadPricing()
  const days = ledgerDays()
  const billingOf = billingLookup()
  const shaped = summarize(days, range, pricing.models, billingOf)
  const byDay = dailyTotals(days, pricing.models, billingOf)
  return {
    account: toknAccount(),
    signIn: signInState,
    sync,
    range,
    priced: pricing.fetchedAt > 0,
    ...shaped,
    sources: summarizeSources(ledgerSources(), range, pricing.models, billingOf),
    calendar: calendar(byDay),
    activity: activity(byDay, range)
  }
}

function setSync(next: UsageSync): void {
  sync = next
  const { state: _state, error: _error, ...kept } = next
  store.setJson(SYNC_FILE, kept)
  changed()
}

/** Uploads every day's totals now. One at a time; a second ask while one runs waits for it. */
function syncNow(): Promise<void> {
  if (syncTimer) {
    clearTimeout(syncTimer)
    syncTimer = null
  }
  if (!toknAccount()) return Promise.resolve()
  syncing ??= (async () => {
    setSync({ ...sync, state: 'syncing', error: undefined })
    try {
      await loadPricing(Object.keys(pricing.models).length === 0)
      const rows = syncRows(ledgerDays(), pricing.models, billingLookup())
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
      const result = rows.length > 0 ? await upload(rows, timezone) : { accepted: 0, rejected: 0, rank: null }
      setSync({ state: 'idle', at: new Date().toISOString(), accepted: result.accepted, rejected: result.rejected, rank: result.rank })
    } catch (error) {
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
    onLedgerChange(() => {
      changed()
      scheduleSync(SYNC_AFTER_USAGE_MS)
    })

    ipcMain.handle('usage:summary', (_e, range: UsageRange) => summary(range === 7 || range === 90 ? range : 30))
    ipcMain.handle('usage:sign-in', () => startSignIn())
    ipcMain.handle('usage:cancel-sign-in', () => signInAbort?.abort())
    ipcMain.handle('usage:submit-code', (_e, input: string) => submitCode(String(input ?? '')))
    ipcMain.handle('usage:sign-out', async () => {
      if (syncTimer) clearTimeout(syncTimer)
      syncTimer = null
      await signOut()
      setSync({ state: 'idle', at: null })
    })
    ipcMain.handle('usage:sync', () => syncNow())
    ipcMain.handle('usage:open-profile', () => {
      const url = toknAccount()?.profileUrl ?? toknHost()
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
  }
}
