import { app, dialog, Notification, powerMonitor, powerSaveBlocker, shell, type BrowserWindow } from 'electron'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChatMessage, StreamEvent } from '@shared/types'
import {
  threadKey,
  type RoomPostEvent,
  type Worker,
  type WorkerDraft,
  type WorkerExecutionEvent,
  type WorkerMessageEvent,
  type WorkerSendOptions,
  type WorkerStreamEvent,
  type WorkerThread,
  type WorkerWatch
} from '@shared/workers'
import { engine as engineAdapter } from '../../engines'
import { withUsageSource } from '../usage/attribution'
import { recordUsage } from '../usage/ledger'
import { trackAgentRun } from '../usage/agentRuns'
import { setLeaseNames } from '../computer/tool'
import { EngineError } from '../../engines/types'
import { pauseGoal, runAgent } from '../../agent/loop'
import { registerToolSource, safeToolName } from '../../agent/tools'
import { BROKERS } from '@shared/trading'
import { mcpCatalogEntry } from '@shared/mcpCatalog'
import { TRADING_DESK } from '@shared/workers'
import { getStatuses, serverName } from '../../mcp'
import { tradingEngine } from '../trading'
import { setWorkerTradingLookup, type TradingVenue } from '../trading/access'
import { store } from '../../store'
import type { FeatureContext } from '../types'
import { WorkersEngine, type TeamDraft } from './engine'
import { createWorkersHub, type WorkersHub } from './hub'
import { teamToolSource } from './team'
import type { RunAgent, RunEngineTurn } from './runner'
import { workersToolSource } from './tools'
import { createPurchaseRoutines, purchaseWorkerProblem, routineName, type PurchaseRoutineDraft } from './purchases'
import { purchasePlanError } from '@shared/scheduler'
import { formatMoney } from '@shared/payments'
import { paymentsEngine } from '../payments'
import { WorkerBrowsers, workerBrowserToolSource } from './browser'
import { createJobHost, type JobHost } from './jobs'
import { look, type WatchReading } from './watch'
import { isReadOnlyCommand } from '../../agent/approvals'
import { refreshBrowserStatus, reportBrowserStep, setWorkerBrowsers } from '../agentBrowser'
import { workerBrowserTarget } from '@shared/agentBrowser'
import { setWorkerPluginFilter } from '../../agent/pluginTools'
import { secrets } from '../../secrets'
import { readAppData, workerAppSecret, type WorkerAppData } from '@shared/workerHost'
import { workerApp, workerAppsEnabled } from '@shared/workerApps'
import { appsToolSource, signedInByHand, signInApp } from './apps'
import { createHue, type HueBridge } from './hue'
import { createLists } from './lists'
import { createHousehold } from './household'
import { createConnectors } from './connectors'
import { createVault } from './vault'
import { isSealed, openVault, sealVault, setVaultKey } from './vaultSeal'
import { readFile } from 'node:fs/promises'
import type { ConnectorId } from '@shared/workerConnectors'

/**
 * Glue between the workers engine and the app: files, the renderer, IPC and
 * notifications.
 *
 * Unlike chats, main owns workers outright — the renderer only displays them
 * and sends commands — so there is no hand-off of who may write what: the
 * list is `workers.json`, and each thread is its own `worker-<id>.json`
 * (threads grow without bound, so they are written off the main thread and
 * only loaded when first needed).
 */

const WORKERS_FILE = 'workers.json'
const ROOMS_FILE = 'worker-rooms.json'
const DELEGATIONS_FILE = 'worker-delegations.json'
const LISTS_FILE = 'worker-lists.json'
/** The Hue bridge's address and app key, kept with the other secrets. */
const HUE_SECRET = 'worker-apps:hue-bridge'
const VAULT_SECRET = 'worker-vault'
/** A thread's file, by threadKey: `worker-<id>.json` for the main thread, `worker-<id>.t-<thread>.json` for the others. */
const threadFile = (key: string): string => `worker-${key.replace('#', '.t-')}.json`
const runsFile = (id: string): string => `worker-${id}-runs.json`
const str = (value: unknown): string => (typeof value === 'string' ? value : '')
/** An id from the renderer: a non-empty string, or a clear refusal rather than a lookup of `undefined`. */
const idOf = (value: unknown): string => {
  if (typeof value !== 'string' || !value) throw new Error('That worker no longer exists.')
  return value
}
const optionalThread = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)
/** Lets the login shell's PATH settle before the first turn spawns anything. */
const START_DELAY_MS = 4000

export interface WorkersOverrides {
  runAgent?: RunAgent
  runEngineTurn?: RunEngineTurn
  now?: () => number
  stallMs?: number
  maxTurnsPerHour?: number
  concurrency?: number
  startDelayMs?: number
  jobs?: JobHost
  look?: (worker: Worker, watch: WorkerWatch) => Promise<WatchReading>
  /**
   * Where a worker's news goes instead of a notification on this computer:
   * the worker host sends it to the desktop that is watching (see
   * `src/host/`).
   */
  notifier?: { notify: (worker: Worker, outcome: { ok: boolean; text: string }) => void; reachOut: (worker: Worker, message: { title: string; body: string }) => void }
}

export interface WorkersService {
  engine: WorkersEngine
  /** What the engine reports, for listeners other than the renderer (the remote server). */
  hub: WorkersHub
  /** Forgets a worker and closes its browser, as the Remove button does. */
  remove: (id: string) => Promise<void>
  registerIpc: () => void
  /** Every IPC channel `registerIpc` serves, so another backend can stand in for them (the worker computer). */
  readonly channels: readonly string[]
  /** Each worker's own browser. */
  browsers: WorkerBrowsers
  start: () => void
  stop: () => void
  /**
   * Stops every turn, job and browser and keeps the engine from running,
   * while the workers run on a linked computer instead. `resume` reads
   * everything from storage again and starts.
   */
  suspend: () => void
  resume: () => void
  readonly suspended: boolean
  openWorker: (id: string) => void
  /**
   * The workers' passwords, passkeys, app connections, Hue pairing and shared
   * lists, which move with them to a worker computer and back
   * (features/workerHost.ts). Import replaces what's here; clear forgets it,
   * for a worker computer the workers have left.
   */
  exportAppData: () => WorkerAppData
  importAppData: (data: unknown) => void
  clearAppData: () => void
  /** On a worker computer: the desktop's key for the sealed vault (vaultSeal.ts), kept in memory only. */
  unlockVault: (key: string) => void
}

/**
 * Stream events, coalesced like `chat:event` (see `frameBatched` in
 * main/index.ts): consecutive text deltas for one message go out as one IPC
 * message per frame, and anything else flushes what is queued first so it
 * never overtakes the text before it.
 */
function eventBatcher(send: (payload: WorkerStreamEvent) => void): { emit: (payload: WorkerStreamEvent) => void; flush: () => void } {
  let queue: WorkerStreamEvent[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    if (queue.length === 0) return
    const batch = queue
    queue = []
    for (const payload of batch) send(payload)
  }
  return {
    emit(payload) {
      const event = payload.event
      if (event.type === 'delta' || event.type === 'reasoning') {
        const last = queue[queue.length - 1]
        if (last && last.workerId === payload.workerId && last.threadId === payload.threadId && last.event.type === event.type && last.event.messageId === event.messageId) {
          ;(last.event as Extract<StreamEvent, { type: 'delta' }>).text += event.text
        } else {
          queue.push({ workerId: payload.workerId, ...(payload.threadId ? { threadId: payload.threadId } : {}), event: { ...event } })
        }
        if (!timer) timer = setTimeout(flush, 16)
        return
      }
      flush()
      send(payload)
    },
    flush
  }
}

/**
 * A trading worker's account, as its prompt describes it: the trading desk's
 * broker, or a broker plugin with what that broker really allows and whether
 * it is connected right now.
 */
function tradingVenue(via: string): TradingVenue | null {
  if (via === TRADING_DESK) {
    const kind = tradingEngine()?.brokerKind ?? 'simulator'
    const broker = BROKERS.find((b) => b.id === kind)
    return { kind: 'desk', label: `the trading desk’s ${broker?.label ?? 'Simulator'} account`, realMoney: broker?.real ?? false, note: null, toolPrefix: null, connected: true }
  }
  const server = store.getMcpServers().find((s) => s.id === via)
  if (!server) return null
  const entry = server.pluginId ? mcpCatalogEntry(server.pluginId) : undefined
  const name = serverName(via)
  return {
    kind: 'plugin',
    label: name,
    realMoney: entry ? entry.realMoney !== false : true,
    note: entry?.tradingNote ?? null,
    toolPrefix: safeToolName(name.toLowerCase()),
    connected: server.enabled && getStatuses().find((s) => s.serverId === via)?.state === 'ready'
  }
}

export function createWorkersService(ctx: FeatureContext, overrides: WorkersOverrides = {}): WorkersService {
  /**
   * The worker whose page is on screen, as the renderer reports it
   * (workers:viewing): its own questions don't also pop up a banner. Cleared
   * when the page goes away, so another tab still hears from that worker.
   */
  let openWorkerId: string | null = null
  const notifications = new Set<Notification>()
  let startTimer: ReturnType<typeof setTimeout> | null = null
  const hub = createWorkersHub()
  // The hub hears what the renderer hears, batching included, so a remote
  // phone gets the same merged deltas the window does.
  const batch = eventBatcher((payload) => {
    ctx.send('workers:event', payload)
    // A phone follows the main conversation only (no threadId), as with messages.
    if (!payload.threadId) hub.emitEvent(payload.workerId, payload.event)
  })

  const openWorker = (id: string): void => {
    const window = ctx.getWindow()
    if (window) {
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
      ctx.send('workers:open', id)
      return
    }
    // macOS keeps running with no window; a notification click does not send
    // 'activate', so raise the window the way a Dock click would, then tell
    // the new renderer once it has loaded and bound its listeners.
    app.emit('activate')
    const started = Date.now()
    const deliver = (): void => {
      const created = ctx.getWindow()
      if (!created) {
        if (Date.now() - started < 5000) setTimeout(deliver, 100)
        return
      }
      const send = (): void => void setTimeout(() => ctx.send('workers:open', id), 600)
      if (created.webContents.isLoading()) created.webContents.once('did-finish-load', send)
      else send()
    }
    deliver()
  }

  const notify = (worker: Worker, outcome: { ok: boolean; text: string }): void => {
    if (overrides.notifier) return overrides.notifier.notify(worker, outcome)
    if (!store.getSettings().notifications.taskComplete || !Notification.isSupported()) return
    // No banner for something already on screen.
    if (ctx.getWindow()?.isFocused()) return
    const notification = new Notification({
      title: outcome.ok ? worker.name : `${worker.name} hit a problem`,
      body: outcome.text
    })
    // Held until clicked or closed: a collected notification loses its click handler.
    notifications.add(notification)
    notification.on('click', () => {
      notifications.delete(notification)
      openWorker(worker.id)
    })
    notification.on('close', () => notifications.delete(notification))
    notification.show()
  }

  /**
   * A worker reaching out on its own — a question (ask_user) or news
   * (notify_user). Shown even while Eaon is focused on another tab: nobody is
   * looking at that worker's page, and it is waiting on the user.
   */
  const reachOut = (worker: Worker, message: { title: string; body: string }): void => {
    if (overrides.notifier) return overrides.notifier.reachOut(worker, message)
    if (!Notification.isSupported()) return
    const window = ctx.getWindow()
    if (window?.isFocused() && window.isVisible() && openWorkerId === worker.id) return
    const notification = new Notification({ title: message.title, body: message.body })
    notifications.add(notification)
    notification.on('click', () => {
      notifications.delete(notification)
      openWorker(worker.id)
    })
    notification.on('close', () => notifications.delete(notification))
    notification.show()
  }

  const jobs = overrides.jobs ?? createJobHost()
  /** Held while a worker is on a timed goal or a job runs (engine `keepAwake`). */
  let blocker: number | null = null
  const keepAwake = (on: boolean): void => {
    if (on && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension')
    else if (!on && blocker !== null) {
      powerSaveBlocker.stop(blocker)
      blocker = null
    }
  }
  /**
   * A watch's look. A command watch runs unattended over and over, so a
   * worker whose access was turned down to Look only after setting one may
   * only keep the read-only ones.
   */
  const lookAt = async (worker: Worker, watch: WorkerWatch): Promise<WatchReading> => {
    if (watch.kind === 'command' && worker.access === 'read-only' && !isReadOnlyCommand(watch.target)) {
      return { ok: false, content: '', summary: 'not run: this worker may only look, and the command changes things' }
    }
    return look(watch, worker.folder)
  }

  const removeStoreFile = async (name: string): Promise<void> => {
    // A save may still be queued for it; let it land, then remove the file.
    await store.flushWrites()
    await rm(join(app.getPath('userData'), 'store', name), { force: true })
  }
  // Purchase schedules are routines on a worker (workers/purchases.ts); the engine is made just below.
  const purchases = createPurchaseRoutines({
    put: (workerId, routine) => engine.putRoutine(workerId, routine),
    remove: (workerId, routineId) => engine.removeRoutineById(workerId, routineId),
    reachOut,
    now: overrides.now
  })
  const engine = new WorkersEngine({
    // Everything a worker's run asks of a model — its loop, sub-agents,
    // compaction — is counted as the workers' (Settings → Usage).
    runAgent: overrides.runAgent ?? ((request, emit, options) => withUsageSource('worker', () => runAgent(request, emit, options))),
    runEngineTurn:
      overrides.runEngineTurn ??
      (async (id, input) => {
        const adapter = engineAdapter(id)
        if (!adapter) throw new EngineError('not-installed', `The ${id} engine isn't available in this version of Eaon.`)
        // A turn that called a tool is one of the workers' agent runs (Settings → Usage).
        const run = trackAgentRun('worker', input.emit)
        let result: Awaited<ReturnType<typeof adapter.runTurn>>
        try {
          result = await adapter.runTurn({ ...input, emit: run.emit })
        } finally {
          run.finish()
        }
        // An agent engine bypasses Eaon's providers, so its tokens are counted
        // here: once per turn, under the engine's own name, as the workers'.
        // A turn that reported no tokens is left out rather than counted as free.
        if (result.usage.input + result.usage.output + result.usage.cacheRead + result.usage.cacheWrite > 0) {
          const paidFor = result.billing === 'api-key' ? ':api' : result.billing === 'provider' ? ':provider' : ''
          recordUsage(`${id}${paidFor}`, input.model ?? 'default', result.usage, new Date(), 'worker')
        }
        return result
      }),
    getSettings: () => store.getSettings(),
    loadWorkers: () => store.getJson<unknown>(WORKERS_FILE, []),
    saveWorkers: (workers) => store.setJson(WORKERS_FILE, workers),
    loadThread: (key) => store.getJson<unknown>(threadFile(key), null),
    saveThread: (thread: WorkerThread) => store.setJsonAsync(threadFile(threadKey(thread.workerId, thread.threadId)), thread),
    deleteThread: (key) => removeStoreFile(threadFile(key)),
    loadRuns: (id) => store.getJson<unknown>(runsFile(id), []),
    saveRuns: (id, runs) => store.setJsonAsync(runsFile(id), runs),
    deleteRuns: (id) => removeStoreFile(runsFile(id)),
    onExecution: (execution) => ctx.send('workers:execution', { workerId: execution.workerId, execution } satisfies WorkerExecutionEvent),
    loadDelegations: () => store.getJson<unknown>(DELEGATIONS_FILE, []),
    saveDelegations: (delegations) => store.setJsonAsync(DELEGATIONS_FILE, delegations),
    onDelegations: (delegations) => ctx.send('workers:delegations', delegations),
    onChange: (workers) => {
      ctx.send('workers:changed', workers)
      hub.emitChanged(workers)
    },
    onEvent: (workerId, event, threadId) => batch.emit({ workerId, ...(threadId !== 'main' ? { threadId } : {}), event }),
    onMessage: (workerId, message: ChatMessage, threadId) => {
      batch.flush()
      ctx.send('workers:message', { workerId, ...(threadId !== 'main' ? { threadId } : {}), message } satisfies WorkerMessageEvent)
      // A phone follows the main conversation, the one it can show.
      if (threadId === 'main') hub.emitMessage(workerId, message)
    },
    notify,
    reachOut,
    routineTurn: purchases.routineTurn,
    routineEnded: purchases.routineEnded,
    pauseGoal,
    tradingVenue,
    loadRooms: () => store.getJson<unknown>(ROOMS_FILE, null),
    saveRooms: (data) => store.setJsonAsync(ROOMS_FILE, data),
    onRoomsChange: (rooms) => ctx.send('workers:rooms-changed', rooms),
    onRoomPost: (roomId, post) => {
      batch.flush()
      ctx.send('workers:room-post', { roomId, post } satisfies RoomPostEvent)
    },
    jobs,
    look: overrides.look ?? lookAt,
    keepAwake,
    now: overrides.now,
    stallMs: overrides.stallMs,
    maxTurnsPerHour: overrides.maxTurnsPerHour,
    concurrency: overrides.concurrency
  })
  setWorkerTradingLookup((id) => engine.tradingOf(id))

  /** Each worker's own browser (BetterWright), created on its first web_browser call. */
  const browsers = new WorkerBrowsers()

  // Linked apps' own doors (workers/apps.ts): the Hue bridge, the shared lists, Calendar and Reminders.
  const hue = createHue({
    load: () => {
      try {
        const saved = JSON.parse(secrets.get(HUE_SECRET) ?? 'null') as HueBridge | null
        return saved && typeof saved.ip === 'string' && typeof saved.username === 'string' ? saved : null
      } catch {
        return null
      }
    },
    save: (bridge) => secrets.set(HUE_SECRET, bridge ? JSON.stringify(bridge) : '')
  })
  const lists = createLists({
    load: () => store.getJson<unknown>(LISTS_FILE, []),
    save: (all) => store.setJsonAsync(LISTS_FILE, all),
    onChange: (all) => ctx.send('workers:lists-changed', all)
  })
  const household = createHousehold()
  // The workers' password vault (vault.ts): one encrypted secrets entry.
  const vault = createVault({
    // Sealed at rest on a worker computer, with the desktop's key (vaultSeal.ts); as is on the desktop.
    load: () => openVault(secrets.get(VAULT_SECRET)),
    save: (value) => secrets.set(VAULT_SECRET, sealVault(value)),
    onChange: (state) => ctx.send('workers:vault-changed', state)
  })
  // Each worker's browser keeps the passkeys it makes in the vault, and gets them back when it starts.
  // Called from the browser's debugger events, so never throwing: a locked vault (vaultSeal.ts) gives no passkeys for now.
  const quietly = <T>(work: () => T, fallback: T): T => {
    try {
      return work()
    } catch (error) {
      console.error('[workers] passkeys:', error instanceof Error ? error.message : error)
      return fallback
    }
  }
  // Only where the vault is (labs): an armed authenticator says yes to every
  // "Create a passkey?", and without a vault to keep it, the site would be left
  // holding a passkey nobody has.
  if (workerAppsEnabled()) {
    browsers.setPasskeyStore({
      credentials: (workerId) => quietly(() => vault.passkeyCredentials(workerId), []),
      added: (workerId, credential) => void quietly(() => vault.addPasskey(workerId, credential), null),
      asserted: (_workerId, credential) => quietly(() => vault.passkeyUsed(credential.credentialId, credential.signCount), undefined)
    })
  }
  /** The export file last imported from Apple's Passwords app, which the user may move to the Trash. */
  let importedFile: string | null = null
  const importFor = (workers: unknown): string[] | 'all' => (workers === 'all' ? 'all' : Array.isArray(workers) ? workers.filter((x): x is string => typeof x === 'string') : 'all')
  // Services connected for the apps (connectors.ts): their keys stay in the vault.
  const connectors = createConnectors({
    load: (id) => secrets.get(`worker-apps:conn:${id}`),
    save: (id, value) => secrets.set(`worker-apps:conn:${id}`, value ?? ''),
    onChange: (statuses) => ctx.send('workers:connections-changed', statuses)
  })

  const remove = async (id: string): Promise<void> => {
    await engine.remove(id)
    // Not just closed: its cookies and cache go too, so a later worker never inherits its sign-ins.
    await browsers.forget(id)
    if (workerAppsEnabled()) vault.forgetWorker(id)
  }

  const channels: string[] = []
  const registerIpc = (): void => {
    const ipcMain = {
      handle: (channel: string, handler: Parameters<FeatureContext['ipcMain']['handle']>[1]): void => {
        if (!channels.includes(channel)) channels.push(channel)
        ctx.ipcMain.handle(channel, handler)
      }
    }
    // Shows a worker's browser, to watch it or to sign it in somewhere; false when it has none yet.
    ipcMain.handle('workers:show-browser', (_e, id: string) => browsers.show(id))
    ipcMain.handle('workers:has-browser', (_e, id: string) => browsers.has(id))
    ipcMain.handle('workers:list', () => engine.list())
    ipcMain.handle('workers:thread', (_e, id: unknown, threadId?: unknown) => engine.getThread(idOf(id), optionalThread(threadId)))
    ipcMain.handle('workers:save', (_e, draft: WorkerDraft) => {
      if (!draft || typeof draft !== 'object') throw new Error('Give the worker a name.')
      return engine.save(draft)
    })
    ipcMain.handle('workers:remove', (_e, id: unknown) => remove(idOf(id)))
    ipcMain.handle('workers:send', (_e, id: unknown, text: unknown, files: unknown, options?: WorkerSendOptions) =>
      engine.send(
        idOf(id),
        str(text),
        Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string') : [],
        options && typeof options === 'object'
          ? {
              goal: options.goal === true,
              ...(typeof options.until === 'number' && Number.isFinite(options.until) ? { until: options.until } : {}),
              ...(optionalThread(options.threadId) ? { threadId: options.threadId } : {})
            }
          : {}
      )
    )
    ipcMain.handle('workers:clear', (_e, id: unknown, threadId?: unknown) => engine.clear(idOf(id), optionalThread(threadId)))
    // Threads, run receipts and delegations.
    ipcMain.handle('workers:executions', (_e, id: unknown) => engine.executions(idOf(id)))
    ipcMain.handle('workers:retry', (_e, id: unknown, executionId: unknown) => engine.retry(idOf(id), str(executionId)))
    ipcMain.handle('workers:delegations', () => engine.delegations())
    ipcMain.handle('workers:thread-close', (_e, id: unknown, threadId: unknown, closed: unknown) => engine.closeThread(idOf(id), str(threadId), closed !== false))
    ipcMain.handle('workers:thread-remove', (_e, id: unknown, threadId: unknown) => engine.removeThread(idOf(id), str(threadId)))
    ipcMain.handle('workers:set-goal', (_e, id: string, status: 'active' | 'paused' | null) => engine.setGoal(id, status === 'active' || status === 'paused' ? status : null))
    // What the worker remembers — its goal and notes — edited by the user, and a routine stopped by the user.
    ipcMain.handle('workers:set-memory', (_e, id: unknown, memory: unknown) => {
      const m = (memory && typeof memory === 'object' ? memory : {}) as { goal?: unknown; notes?: unknown }
      return engine.setMemory(idOf(id), { ...(typeof m.goal === 'string' ? { goal: m.goal } : {}), ...(typeof m.notes === 'string' ? { notes: m.notes } : {}) })
    })
    ipcMain.handle('workers:remove-routine', (_e, id: unknown, name: unknown) => engine.removeRoutine(idOf(id), str(name)))
    ipcMain.handle('workers:remove-routine-id', (_e, id: unknown, routineId: unknown) => engine.removeRoutineById(idOf(id), str(routineId)))
    ipcMain.handle('workers:run-routine', (_e, id: unknown, routineId: unknown) => engine.runRoutineNow(idOf(id), str(routineId)))
    // The /purchase dialog: a purchase schedule saved as one of the worker's routines.
    ipcMain.handle('workers:save-purchase', (_e, id: unknown, draft: PurchaseRoutineDraft) => {
      const worker = engine.list().find((w) => w.id === idOf(id))
      if (!worker) throw new Error('That worker isn’t there any more.')
      const plan = draft?.plan
      const problem = (plan && purchasePlanError(plan)) ?? null
      if (!plan || problem) throw new Error(problem ?? 'Say what to buy.')
      const status = paymentsEngine()?.status()
      const cardReady = Boolean(status?.card) && status?.effectiveMode !== 'off'
      const unfit = purchaseWorkerProblem(worker, plan, cardReady)
      if (unfit) throw new Error(unfit)
      const everyMs = typeof draft.everyMs === 'number' && draft.everyMs > 0 ? draft.everyMs : null
      return engine.putRoutine(worker.id, {
        ...(typeof draft.id === 'string' ? { id: draft.id } : {}),
        name: routineName(plan),
        task: `Buy ${plan.item} from ${plan.merchant}, ${plan.maxAmount === 0 ? 'free orders only' : `up to ${formatMoney(plan.maxAmount, plan.currency)} an order`}.`,
        everyMs,
        daily: null,
        nextAt: Number(draft.firstAt),
        purchase: plan,
        ...(everyMs ? { anchorAt: Number(draft.anchorAt) } : {}),
        // Editing keeps the thread its orders went in.
        ...(typeof draft.id === 'string' ? { threadId: worker.routines.find((r) => r.id === draft.id)?.threadId } : {})
      })
    })
    ipcMain.handle('workers:set-paused', (_e, id: string, paused: boolean) => engine.setPaused(id, paused))
    ipcMain.handle('workers:wake', (_e, id: string) => engine.wake(id))
    ipcMain.handle('workers:stop', (_e, id: unknown, threadId?: unknown) => engine.stopTurn(idOf(id), optionalThread(threadId)))
    ipcMain.handle('workers:mark-read', (_e, id: unknown, threadId?: unknown) => engine.markRead(idOf(id), optionalThread(threadId)))
    ipcMain.handle('workers:viewing', (_e, id: unknown) => {
      openWorkerId = typeof id === 'string' && id ? id : null
    })
    // The user answering a worker's question: a reply, or approving the one action it asked about.
    ipcMain.handle('workers:answer', (_e, id: string, askId: string, answer: { text?: string; approved?: boolean }) =>
      engine.answer(id, askId, { text: typeof answer?.text === 'string' ? answer.text : undefined, approved: answer?.approved === true })
    )
    // Group chats.
    ipcMain.handle('workers:rooms', () => engine.rooms())
    ipcMain.handle('workers:room-posts', (_e, roomId: string) => engine.roomPosts(roomId))
    ipcMain.handle('workers:room-save', (_e, draft: { id?: string; name: string; members: string[] }) => engine.saveRoom(draft))
    ipcMain.handle('workers:room-remove', (_e, roomId: string) => engine.removeRoom(roomId))
    ipcMain.handle('workers:room-post', (_e, roomId: string, text: string, files: string[]) => engine.postAsUser(roomId, text, files))
    ipcMain.handle('workers:room-read', (_e, roomId: string) => engine.markRoomRead(roomId))
    ipcMain.handle('workers:create-team', (_e, draft: TeamDraft) => engine.createTeam(draft))
    // What a worker runs, watches and knows, as the user manages it from its page.
    ipcMain.handle('workers:stop-job', (_e, id: unknown, jobId: unknown) => engine.stopJob(idOf(id), str(jobId), 'user'))
    ipcMain.handle('workers:job-log', (_e, id: unknown, jobId: unknown) => engine.jobStatus(idOf(id), str(jobId), 200))
    ipcMain.handle('workers:remove-watch', (_e, id: unknown, watchId: unknown) => engine.removeWatch(idOf(id), str(watchId)))
    ipcMain.handle('workers:remove-playbook', (_e, id: unknown, playbookId: unknown) => engine.removePlaybook(idOf(id), str(playbookId)))
    // Teach: the user shows the worker a task in its browser, which records the steps.
    ipcMain.handle('workers:teach-start', async (_e, id: unknown) => {
      const workerId = idOf(id)
      if (!engine.has(workerId)) throw new Error('That worker no longer exists.')
      const started = await browsers.startRecording(workerId)
      refreshBrowserStatus(workerBrowserTarget(workerId))
      return started
    })
    ipcMain.handle('workers:teach-stop', (_e, id: unknown, task: unknown) => {
      const workerId = idOf(id)
      const steps = browsers.stopRecording(workerId)
      refreshBrowserStatus(workerBrowserTarget(workerId))
      // Cancelled: nothing is sent.
      if (typeof task !== 'string') return 0
      engine.teach(workerId, { task, steps })
      return steps.length
    })
    ipcMain.handle('workers:teach-steps', (_e, id: unknown) => browsers.recordedSteps(idOf(id)))
    // Linked apps (labs: not in release builds).
    if (workerAppsEnabled()) {
      ipcMain.handle('workers:link-app', (_e, id: unknown, appId: unknown, options?: { url?: unknown }) => {
        const workerId = idOf(id)
        if (!workerApp(str(appId))) throw new Error('There is no such app.')
        return engine.updateApp(workerId, str(appId), typeof options?.url === 'string' && options.url ? { url: options.url } : {})
      })
      ipcMain.handle('workers:unlink-app', (_e, id: unknown, appId: unknown) => engine.unlinkApp(idOf(id), str(appId)))
      ipcMain.handle('workers:app-sign-in', (_e, id: unknown, appId: unknown, login: { username?: unknown; password?: unknown; remember?: unknown }, threadId?: unknown) =>
        signInApp({ engine, browsers }, idOf(id), str(appId), { username: str(login?.username), password: str(login?.password), remember: login?.remember === true }, optionalThread(threadId), vault)
      )
      // The password vault. Nothing that leaves here carries a password, a 2FA secret or a key.
      ipcMain.handle('workers:vault', () => vault.state())
      ipcMain.handle('workers:vault-save', (_e, draft: unknown) => {
        const d = (draft && typeof draft === 'object' ? draft : {}) as Record<string, unknown>
        return vault.saveLogin({
          ...(typeof d.id === 'string' ? { id: d.id } : {}),
          site: str(d.site),
          ...(Array.isArray(d.domains) ? { domains: d.domains.filter((x): x is string => typeof x === 'string') } : {}),
          username: str(d.username),
          ...(typeof d.password === 'string' && d.password ? { password: d.password } : {}),
          ...(typeof d.code === 'string' ? { code: d.code } : {}),
          workers: d.workers === 'all' ? 'all' : Array.isArray(d.workers) ? d.workers.filter((x): x is string => typeof x === 'string') : [],
          ask: d.ask === true,
          source: d.source === 'chat' ? 'chat' : 'manual'
        })
      })
      ipcMain.handle('workers:vault-remove', (_e, loginId: unknown) => vault.removeLogin(str(loginId)))
      ipcMain.handle('workers:vault-access', (_e, loginId: unknown, access: { workers?: unknown; ask?: unknown }) =>
        vault.setAccess(str(loginId), {
          ...(access?.workers === 'all' ? { workers: 'all' as const } : Array.isArray(access?.workers) ? { workers: access.workers.filter((x): x is string => typeof x === 'string') } : {}),
          ...(typeof access?.ask === 'boolean' ? { ask: access.ask } : {})
        })
      )
      ipcMain.handle('workers:vault-remove-passkey', async (_e, passkeyId: unknown) => {
        const passkey = vault.state().passkeys.find((p) => p.id === str(passkeyId))
        vault.removePasskey(str(passkeyId))
        if (passkey) await browsers.resetPasskeys(passkey.workerId)
      })
      // Apple's Passwords app → File → Export All Passwords to File: read here, so the renderer never holds the file.
      ipcMain.handle('workers:vault-import-apple', async (_e, workers: unknown) => {
        const picked = await pickPasswordsExport(ctx.getWindow())
        if (!picked) return null
        const result = vault.importApple(picked.text, importFor(workers))
        importedFile = picked.file
        return { ...result, file: picked.file }
      })
      // The same export's text, read on the desktop: a worker computer has no screen to pick a file on (workerHost.ts).
      ipcMain.handle('workers:vault-import-csv', (_e, text: unknown, workers: unknown) => vault.importApple(str(text), importFor(workers)))
      ipcMain.handle('workers:vault-trash-import', async () => {
        if (!importedFile) return false
        await shell.trashItem(importedFile)
        importedFile = null
        return true
      })
      // "Use the browser instead": the worker's browser on the app's sign-in page, in front, for the user to sign in themselves.
      ipcMain.handle('workers:app-browser', async (_e, id: unknown, appId: unknown) => {
        const workerId = idOf(id)
        const app = workerApp(str(appId))
        const link = engine.appsOf(workerId).find((l) => l.id === str(appId))
        if (!app || !link) throw new Error('That app isn’t linked to this worker any more.')
        const url = app.signIn ?? (app.id === 'bank' ? link.url : app.url) ?? app.url
        if (url) await browsers.open(workerId, url)
        refreshBrowserStatus(workerBrowserTarget(workerId))
        return true
      })
      ipcMain.handle('workers:app-signed-in', (_e, id: unknown, appId: unknown, threadId?: unknown) => signedInByHand(engine, idOf(id), str(appId), optionalThread(threadId)))
      ipcMain.handle('workers:hue-status', () => ({ paired: hue.paired() ? { ip: hue.paired()!.ip } : null }))
      ipcMain.handle('workers:hue-pair', async (_e, ip?: unknown) => {
        const bridge = await hue.pair(typeof ip === 'string' && ip.trim() ? ip : undefined)
        return { ip: bridge.ip, lights: (await hue.lights().catch(() => [])).length }
      })
      ipcMain.handle('workers:hue-forget', () => hue.forget())
      ipcMain.handle('workers:lists', () => lists.all())
      ipcMain.handle('workers:list-toggle', (_e, listId: unknown, itemId: unknown, done: unknown) => lists.toggle(str(listId), str(itemId), done === true))
      ipcMain.handle('workers:connections', () => connectors.statuses())
      ipcMain.handle('workers:connect', (_e, id: unknown, fields: unknown) =>
        connectors.connect(str(id) as ConnectorId, fields && typeof fields === 'object' ? (Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, str(v)])) as Record<string, string>) : {})
      )
      ipcMain.handle('workers:disconnect', (_e, id: unknown) => connectors.disconnect(str(id) as ConnectorId))
      ipcMain.handle('workers:list-add', (_e, listId: unknown, text: unknown) => lists.edit(str(listId), { action: 'add', items: [str(text)] }, 'You').list)
    }
  }

  let suspended = false
  const halt = (): void => {
    if (startTimer) clearTimeout(startTimer)
    startTimer = null
    batch.flush()
    engine.stop()
    jobs.stopAll()
    keepAwake(false)
    void browsers.closeAll()
  }

  return {
    engine,
    hub,
    remove,
    registerIpc,
    channels,
    browsers,
    get suspended() {
      return suspended
    },
    suspend: () => {
      suspended = true
      halt()
    },
    resume: () => {
      if (!suspended) return
      suspended = false
      engine.reload()
      engine.start()
    },
    exportAppData: () => {
      const theirs = Object.entries(secrets.entries()).filter(([id]) => workerAppSecret(id))
      const out: WorkerAppData = { secrets: {}, lists: lists.all() }
      for (const [id, value] of theirs) {
        if (id !== VAULT_SECRET) {
          out.secrets[id] = value
          continue
        }
        // Sent opened, over the link; the desktop keeps it in its keychain. One that won't open is left out, and
        // the desktop keeps its own copy rather than losing it.
        try {
          const opened = openVault(value)
          if (opened) out.secrets[id] = opened
        } catch {
          out.kept = [VAULT_SECRET]
        }
      }
      return out
    },
    importAppData: (raw) => {
      const data = readAppData(raw)
      const kept = new Set(data.kept)
      const own = Object.keys(secrets.entries()).filter((id) => workerAppSecret(id) && !kept.has(id))
      // Sealed before anything is written, so a locked vault stops the import with nothing changed.
      const incoming = Object.fromEntries(Object.entries(data.secrets).filter(([id]) => !kept.has(id)).map(([id, value]) => [id, id === VAULT_SECRET ? sealVault(value) : value]))
      // Exactly what came: one removed there is removed here too.
      secrets.setMany({ ...Object.fromEntries(own.map((id) => [id, ''])), ...incoming })
      lists.replace(data.lists)
      ctx.send('workers:vault-changed', vault.state())
      ctx.send('workers:connections-changed', connectors.statuses())
    },
    unlockVault: (key) => {
      setVaultKey(key)
      // A vault written before it was sealed here is sealed now.
      const stored = secrets.get(VAULT_SECRET)
      if (stored && !isSealed(stored)) secrets.set(VAULT_SECRET, sealVault(stored))
      try {
        ctx.send('workers:vault-changed', vault.state())
      } catch {
        // Sealed with another key: it stays locked, and says so when it's used.
      }
    },
    clearAppData: () => {
      const own = Object.keys(secrets.entries()).filter((id) => workerAppSecret(id))
      if (own.length > 0) secrets.setMany(Object.fromEntries(own.map((id) => [id, ''])))
      lists.replace([])
    },
    start: () => {
      engine.load()
      // The computer's one pointer is leased to a run at a time; its indicator names the worker.
      setLeaseNames((id) => engine.list().find((w) => w.id === id)?.name ?? null)
      registerToolSource(workersToolSource(engine))
      // Cards in a worker's thread, and its linked apps (workers/apps.ts).
      registerToolSource(appsToolSource({ engine, browsers, hue, lists, household, connectors, vault }))
      // Each worker's own choice of plugins (Edit → Plugins).
      setWorkerPluginFilter((id) => engine.pluginsOf(id))
      // The chat agent's way to start a team and talk to it.
      registerToolSource(teamToolSource(engine, (roomId) => ctx.send('workers:open-room', roomId)))
      // Live view and take-over for each worker's browser (features/agentBrowser.ts).
      setWorkerBrowsers(browsers)
      registerToolSource(workerBrowserToolSource(browsers, (toolCtx, step) => toolCtx.request.workerId && reportBrowserStep(workerBrowserTarget(toolCtx.request.workerId), toolCtx, step)))
      // Sleep suspends timers; check the moment the machine wakes.
      powerMonitor.on('resume', () => engine.tick())
      startTimer = setTimeout(() => {
        startTimer = null
        if (!suspended) engine.start()
      }, overrides.startDelayMs ?? START_DELAY_MS)
      startTimer.unref?.()
    },
    stop: halt,
    openWorker
  }
}

/** The file exported from Apple's Passwords, picked on this computer's screen, and its text. Null when nothing was picked. */
export async function pickPasswordsExport(window: BrowserWindow | null): Promise<{ file: string; text: string } | null> {
  const options = { title: 'Choose the file exported from Passwords', properties: ['openFile' as const], filters: [{ name: 'Passwords export', extensions: ['csv'] }] }
  const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  const file = picked.filePaths[0]
  if (picked.canceled || !file) return null
  return { file, text: await readFile(file, 'utf8') }
}
