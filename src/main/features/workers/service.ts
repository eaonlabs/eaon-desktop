import { app, Notification, powerMonitor } from 'electron'
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
  type WorkerThread
} from '@shared/workers'
import { engine as engineAdapter } from '../../engines'
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
import { teamToolSource } from './team'
import type { RunAgent, RunEngineTurn } from './runner'
import { workersToolSource } from './tools'
import { WorkerBrowsers, workerBrowserToolSource } from './browser'
import { reportBrowserStep, setWorkerBrowsers } from '../agentBrowser'
import { workerBrowserTarget } from '@shared/agentBrowser'

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
}

export interface WorkersService {
  engine: WorkersEngine
  registerIpc: () => void
  start: () => void
  stop: () => void
  openWorker: (id: string) => void
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
  /** The worker whose page the user last opened, so its own questions don't also pop up a banner. */
  let openWorkerId: string | null = null
  const notifications = new Set<Notification>()
  let startTimer: ReturnType<typeof setTimeout> | null = null
  const batch = eventBatcher((payload) => ctx.send('workers:event', payload))

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

  const removeStoreFile = async (name: string): Promise<void> => {
    // A save may still be queued for it; let it land, then remove the file.
    await store.flushWrites()
    await rm(join(app.getPath('userData'), 'store', name), { force: true })
  }
  const engine = new WorkersEngine({
    runAgent: overrides.runAgent ?? runAgent,
    runEngineTurn:
      overrides.runEngineTurn ??
      (async (id, input) => {
        const adapter = engineAdapter(id)
        if (!adapter) throw new EngineError('not-installed', `The ${id} engine isn't available in this version of Eaon.`)
        return adapter.runTurn(input)
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
    onChange: (workers) => ctx.send('workers:changed', workers),
    onEvent: (workerId, event, threadId) => batch.emit({ workerId, ...(threadId !== 'main' ? { threadId } : {}), event }),
    onMessage: (workerId, message: ChatMessage, threadId) => {
      batch.flush()
      ctx.send('workers:message', { workerId, ...(threadId !== 'main' ? { threadId } : {}), message } satisfies WorkerMessageEvent)
    },
    notify,
    reachOut,
    pauseGoal,
    tradingVenue,
    loadRooms: () => store.getJson<unknown>(ROOMS_FILE, null),
    saveRooms: (data) => store.setJsonAsync(ROOMS_FILE, data),
    onRoomsChange: (rooms) => ctx.send('workers:rooms-changed', rooms),
    onRoomPost: (roomId, post) => {
      batch.flush()
      ctx.send('workers:room-post', { roomId, post } satisfies RoomPostEvent)
    },
    now: overrides.now,
    stallMs: overrides.stallMs,
    maxTurnsPerHour: overrides.maxTurnsPerHour,
    concurrency: overrides.concurrency
  })
  setWorkerTradingLookup((id) => engine.tradingOf(id))

  /** Each worker's own browser (BetterWright), created on its first web_browser call. */
  const browsers = new WorkerBrowsers()

  const registerIpc = (): void => {
    const { ipcMain } = ctx
    // Shows a worker's browser, to watch it or to sign it in somewhere; false when it has none yet.
    ipcMain.handle('workers:show-browser', (_e, id: string) => browsers.show(id))
    ipcMain.handle('workers:has-browser', (_e, id: string) => browsers.has(id))
    ipcMain.handle('workers:list', () => engine.list())
    ipcMain.handle('workers:thread', (_e, id: unknown, threadId?: unknown) => engine.getThread(idOf(id), optionalThread(threadId)))
    ipcMain.handle('workers:save', (_e, draft: WorkerDraft) => {
      if (!draft || typeof draft !== 'object') throw new Error('Give the worker a name.')
      return engine.save(draft)
    })
    ipcMain.handle('workers:remove', async (_e, id: unknown) => {
      await engine.remove(idOf(id))
      await browsers.close(idOf(id))
    })
    ipcMain.handle('workers:send', (_e, id: unknown, text: unknown, files: unknown, options?: WorkerSendOptions) =>
      engine.send(
        idOf(id),
        str(text),
        Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string') : [],
        options && typeof options === 'object' ? { goal: options.goal === true, ...(optionalThread(options.threadId) ? { threadId: options.threadId } : {}) } : {}
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
    ipcMain.handle('workers:set-paused', (_e, id: string, paused: boolean) => engine.setPaused(id, paused))
    ipcMain.handle('workers:wake', (_e, id: string) => engine.wake(id))
    ipcMain.handle('workers:stop', (_e, id: unknown, threadId?: unknown) => engine.stopTurn(idOf(id), optionalThread(threadId)))
    ipcMain.handle('workers:mark-read', (_e, id: unknown, threadId?: unknown) => {
      openWorkerId = idOf(id)
      return engine.markRead(idOf(id), optionalThread(threadId))
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
  }

  return {
    engine,
    registerIpc,
    start: () => {
      engine.load()
      registerToolSource(workersToolSource(engine))
      // The chat agent's way to start a team and talk to it.
      registerToolSource(teamToolSource(engine, (roomId) => ctx.send('workers:open-room', roomId)))
      // Live view and take-over for each worker's browser (features/agentBrowser.ts).
      setWorkerBrowsers(browsers)
      registerToolSource(workerBrowserToolSource(browsers, (toolCtx, step) => toolCtx.request.workerId && reportBrowserStep(workerBrowserTarget(toolCtx.request.workerId), toolCtx, step)))
      // Sleep suspends timers; check the moment the machine wakes.
      powerMonitor.on('resume', () => engine.tick())
      startTimer = setTimeout(() => {
        startTimer = null
        engine.start()
      }, overrides.startDelayMs ?? START_DELAY_MS)
      startTimer.unref?.()
    },
    stop: () => {
      if (startTimer) clearTimeout(startTimer)
      startTimer = null
      batch.flush()
      engine.stop()
      void browsers.closeAll()
    },
    openWorker
  }
}
