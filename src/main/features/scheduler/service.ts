import { app, Notification, powerMonitor, type WebContents } from 'electron'
import { mergeRunChat, ORDER_WATCH_MS, type HookStatus, type ScheduledTask, type TaskDraft, type TaskRun } from '@shared/scheduler'
import { orderSettled } from '@shared/payments'
import type { Chat } from '@shared/types'
import { runAgent } from '../../agent/loop'
import { registerToolSource } from '../../agent/tools'
import { HookError, setHookTarget } from '../../control/hooks'
import { secrets } from '../../secrets'
import { store } from '../../store'
import { currentZone } from '../../timezone'
import { findPurchase, mayHaveBoughtSince, planPurchases, purchasesKnown } from '../payments/plans'
import type { FeatureContext } from '../types'
import { SchedulerEngine, type RunResult } from './engine'
import { AutomationHooks, HOOK_PATH, HOOK_VAULT_PREFIX } from './hooks'
import { RUNS_FILE, TASKS_FILE } from './migrate'
import { runScheduledTask, type ChatSink, type RunAgent } from './runner'
import { scheduleToolSource } from './tool'

/**
 * Glue between the scheduler engine and the app: where tasks are stored,
 * where a run's chat goes, notifications, and the IPC the page uses.
 *
 * Chats are the delicate part. While a window is open the renderer owns
 * chats.json — it keeps every chat in memory and rewrites the whole file on
 * each save, so anything main wrote there would be overwritten. So:
 *
 * - renderer ready → the chat is sent over `scheduler:chat` and the renderer
 *   inserts or merges it and saves;
 * - no renderer → main merges the chat into chats.json itself, and remembers
 *   it so a window that opens mid-run is sent the live copy once it is ready.
 *
 * "Ready" is the renderer saying so over `scheduler:ready` after its
 * listeners are bound; a window that exists but is still loading would drop
 * the message. With several windows, each one says so, and a window that
 * becomes ready mid-run is sent the runs still going.
 */

/** How long launch waits for the renderer before catching up missed runs anyway. */
const STARTUP_GRACE_MS = 10_000
/** A placed order is first checked a few hours later, then twice a day. */
const WATCH_FIRST_CHECK_MS = 4 * 60 * 60_000
const WATCH_EVERY_HOURS = 12

/** What the page needs to give a webhook's address: where the Local API Server answers, and whether it is running. */
export interface HookBase {
  url: string
  running: boolean
}

export interface SchedulerOverrides {
  runAgent?: RunAgent
  hooks?: AutomationHooks
  hookBase?: () => HookBase
  now?: () => number
  monotonic?: () => number
  zone?: () => string
  stallMs?: number
}

export interface SchedulerService {
  engine: SchedulerEngine
  hooks: AutomationHooks
  /** An automation's webhook as the page shows it. */
  hookStatus: (taskId: string) => HookStatus
  sink: ChatSink
  registerIpc: () => void
  /** Loads tasks now; firing starts once the renderer is ready, or after a grace period. */
  start: () => void
  stop: () => void
  /** The renderer's `scheduler:ready`; exposed for tests. */
  rendererReady: (sender: WebContents) => void
  openChat: (chatId: string) => void
}

/** How late a cut-off purchase run may still be run again: the same day the catch-up rule allows. */
const CUT_OFF_RETRY_MS = 24 * 60 * 60_000

/**
 * Of the runs Eaon quitting cut off (an update, the computer restarting for
 * one), the purchase schedules' runs to start again, once. Only when:
 * - nothing can have been bought in it: no card typed, no order button
 *   pressed, nothing paid (`mayHaveBought`; null, when payments isn't
 *   running to tell, counts as maybe). One that may have bought something is
 *   left for the user to check (payments engine, settleAbandoned), so a
 *   restart never buys the same thing twice;
 * - it is within a day, like any late run;
 * - the schedule is still on, and the user hasn't changed it since the run
 *   started. A one-off's run switches it off as it starts; that alone isn't
 *   the user turning it off;
 * - nothing of the schedule has run since (a catch-up already making its
 *   order), and it hasn't placed all its orders.
 */
export function cutOffPurchasesToRetry(
  cutOff: TaskRun[],
  tasks: ScheduledTask[],
  now: number,
  mayHaveBought: (run: TaskRun, task: ScheduledTask) => boolean | null,
  paidOrders: (taskId: string) => number = () => 0
): TaskRun[] {
  return cutOff.filter((run) => {
    const task = tasks.find((t) => t.id === run.taskId)
    if (!task?.purchase || run.retryOf || now - run.startedAt > CUT_OFF_RETRY_MS) return false
    const usedUpOneOff = task.schedule.kind === 'once' && task.nextRunAt === null && task.updatedAt <= run.startedAt
    if (!task.enabled && !usedUpOneOff) return false
    if (task.history.some((r) => r.id !== run.id && r.startedAt > run.startedAt && r.status !== 'missed' && r.status !== 'skipped')) return false
    if (task.purchase.orders !== null && paidOrders(task.id) >= task.purchase.orders) return false
    return mayHaveBought(run, task) === false
  })
}

/** How often, and how many times, launch looks again for the payments engine before giving up on cut-off purchases. */
const RESUME_WAIT_MS = 2_000
const RESUME_TRIES = 30
const HOOKS_FILE = 'scheduler-hooks.json'

export function createScheduler(ctx: FeatureContext, overrides: SchedulerOverrides = {}): SchedulerService {
  /** Pages that have said they are ready (one per window), until they reload or close. */
  const readySenders = new Set<WebContents>()
  /** Live chats the renderer has not seen yet, by id. Sent (current state) when it becomes ready. */
  const undelivered = new Map<string, Chat>()
  /** Runs still going, as last sent: a window that opens mid-run gets them when it is ready. */
  const live = new Map<string, Chat>()
  let pendingOpen: string | null = null
  let startTimer: ReturnType<typeof setTimeout> | null = null
  const notifications = new Set<Notification>()

  const rendererReady = (): boolean => {
    const windows = ctx.getWindows?.() ?? [ctx.getWindow()].filter((window) => window !== null)
    return windows.some((window) => readySenders.has(window.webContents) && !window.webContents.isDestroyed())
  }

  /**
   * chats.json writes are serialised here: two runs finishing together would
   * otherwise both read the file before either wrote it, and one chat would
   * be lost.
   */
  let chatsLock: Promise<void> = Promise.resolve()
  const writeChat = (chat: Chat): Promise<void> => {
    const next = chatsLock.then(async () => {
      await store.flushWrites()
      const chats = store.getChats()
      const index = chats.findIndex((c) => c.id === chat.id)
      // A snapshot: the runner keeps writing into its own copy as the run goes.
      if (index === -1) chats.unshift(structuredClone(chat))
      else chats[index] = mergeRunChat(chats[index], structuredClone(chat))
      store.saveChats(chats)
      await store.flushWrites()
    })
    chatsLock = next.catch((error) => console.error('[scheduler] failed to save a run chat:', error))
    return chatsLock
  }

  const sink: ChatSink = {
    put: async (chat, done) => {
      if (done) live.delete(chat.id)
      else live.set(chat.id, chat)
      if (rendererReady()) {
        undelivered.delete(chat.id)
        ctx.send('scheduler:chat', chat)
        return
      }
      undelivered.set(chat.id, chat)
      await writeChat(chat)
      // Finished with no window at all: the next window reads it from
      // chats.json. Holding it would keep every windowless run's transcript
      // in memory (days of them, in background mode) to re-send on open. A
      // window that is still loading may have read the file before this
      // write, so for it the chat stays queued.
      if (done && !ctx.getWindow()) undelivered.delete(chat.id)
    },
    // Without a window this goes nowhere, which is fine: the runner applies
    // every event to its own copy as well.
    stream: (event) => ctx.emitStream(event)
  }

  const openChat = (chatId: string): void => {
    const window = ctx.getWindow()
    if (window) {
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    } else {
      // macOS keeps the app running with no window; index.ts re-creates it on
      // 'activate' (a Dock click). A notification click does not send that
      // event, so raise it ourselves rather than reach into index.ts.
      app.emit('activate')
    }
    if (rendererReady()) ctx.send('scheduler:open-chat', chatId)
    else pendingOpen = chatId
  }

  const notify = (task: ScheduledTask, chatId: string, result: RunResult): void => {
    if (result.status === 'cancelled') return
    if (!store.getSettings().notifications.taskComplete || !Notification.isSupported()) return
    // Same rule as interactive Work tasks: no banner for something already on screen.
    if (ctx.getWindow()?.isFocused()) return
    const failed = result.status === 'failed'
    const notification = new Notification({
      title: failed ? `${task.name} failed` : task.name,
      body: (failed ? result.error : result.summary) || 'Scheduled task finished.'
    })
    // Held until clicked or closed: a notification that is garbage-collected
    // loses its click handler.
    notifications.add(notification)
    notification.on('click', () => {
      notifications.delete(notification)
      openChat(chatId)
    })
    notification.on('close', () => notifications.delete(notification))
    notification.show()
  }

  /**
   * After a purchase schedule's run: each order it placed with an order
   * number gets a tracking task in the same thread, and a schedule that has
   * placed all its orders is switched off. After a tracking run: an order
   * that arrived, was cancelled, or is a month old stops being tracked.
   */
  const followUp = (task: ScheduledTask): void => {
    const now = (overrides.now ?? Date.now)()
    if (task.purchase) {
      const startedAt = task.history[0]?.startedAt ?? now
      const orders = planPurchases(task.id)
      const tracked = new Set(engine.list().map((t) => t.watch?.purchaseId).filter(Boolean))
      if (task.purchase.track) {
        for (const order of orders) {
          if (order.status !== 'paid' || !order.orderId || order.createdAt < startedAt || tracked.has(order.id)) continue
          engine.save({
            name: `Track order ${order.orderId}`,
            prompt: `Check on order ${order.orderId} from ${order.merchant}.`,
            schedule: { kind: 'interval', every: WATCH_EVERY_HOURS, unit: 'hours', startAt: now + WATCH_FIRST_CHECK_MS },
            mode: 'work',
            model: task.model,
            cwd: null,
            allowChanges: false,
            enabled: true,
            watch: {
              purchaseId: order.id,
              orderId: order.orderId,
              merchant: order.merchant,
              site: order.site,
              item: task.purchase.item,
              placedAt: order.createdAt
            },
            thread: task.thread ?? null
          })
        }
      }
      const paid = orders.filter((o) => o.status === 'paid').length
      if (task.purchase.orders !== null && paid >= task.purchase.orders && task.enabled) engine.setEnabled(task.id, false)
    }
    if (task.watch) {
      const order = findPurchase(task.watch.purchaseId)
      if (!order || orderSettled(order.tracking?.stage) || now - task.watch.placedAt > ORDER_WATCH_MS) engine.remove(task.id)
    }
  }

  const engine: SchedulerEngine = new SchedulerEngine({
    load: () => store.getJson<unknown>(TASKS_FILE, []),
    save: (tasks) => store.setJson(TASKS_FILE, tasks),
    loadRuns: () => store.getJson<unknown>(RUNS_FILE, []),
    saveRuns: (runs) => store.setJson(RUNS_FILE, runs),
    onChange: (tasks) => ctx.send('scheduler:tasks', tasks),
    onDamaged: (count) =>
      store.setAside(TASKS_FILE, `${count} ${count === 1 ? 'entry wasn’t a task and was' : 'entries weren’t tasks and were'} set aside.`),
    onFinished: followUp,
    now: overrides.now,
    monotonic: overrides.monotonic,
    // Checked on every tick, so travelling across zones moves "every day at
    // 9" to 9 where the user is now (see timezone.ts).
    zone: overrides.zone ?? (() => currentZone()),
    machine: process.platform === 'darwin' ? 'Mac' : 'computer',
    execute: (task, handle) => {
      // Tracking checks twice a day; only news is worth a banner.
      const stageBefore = task.watch ? findPurchase(task.watch.purchaseId)?.tracking?.stage : undefined
      const quietNotify: typeof notify = (t, chatId, result) => {
        if (t.watch && findPurchase(t.watch.purchaseId)?.tracking?.stage === stageBefore) return
        notify(t, chatId, result)
      }
      return runScheduledTask(task, handle, { runAgent: overrides.runAgent ?? runAgent, sink, notify: quietNotify, stallMs: overrides.stallMs })
    }
  })

  const hooks =
    overrides.hooks ??
    new AutomationHooks({
      load: () => store.getJson<unknown>(HOOKS_FILE, {}),
      save: (info) => store.setJson(HOOKS_FILE, info),
      getSecret: (taskId) => secrets.get(`${HOOK_VAULT_PREFIX}${taskId}`),
      setSecret: (taskId, secret) => secrets.set(`${HOOK_VAULT_PREFIX}${taskId}`, secret ?? '')
    })

  const hookStatus = (taskId: string): HookStatus => {
    const secret = hooks.secretOf(taskId)
    const stats = hooks.stats(taskId)
    const base = overrides.hookBase?.() ?? { url: `http://127.0.0.1:${store.getSettings().localServer.port || 1337}`, running: false }
    return {
      on: secret !== null,
      url: secret ? `${base.url}${HOOK_PATH}${secret}` : null,
      serverRunning: secret !== null && base.running,
      calls: secret ? (stats?.calls ?? 0) : 0,
      lastCalledAt: secret ? (stats?.lastCalledAt ?? null) : null
    }
  }

  /** What a call to a webhook does: finds its automation and starts it with the body as input. Refuses a paused one. */
  const startFromHook = (secret: string, text: string): { automation: string; runId: string } => {
    const taskId = hooks.find(secret)
    const task = taskId ? engine.list().find((t) => t.id === taskId) : undefined
    if (!taskId || !task) throw new HookError(404, 'No such webhook.')
    // Paused means the user stopped it; a call from outside doesn't start it again.
    if (!task.enabled) throw new HookError(409, `“${task.name}” is paused.`)
    try {
      const run = engine.runNow(taskId, { source: 'webhook', label: 'Webhook call', text })
      hooks.record(taskId)
      return { automation: task.name, runId: run.id }
    } catch (error) {
      throw new HookError(409, error instanceof Error ? error.message : String(error))
    }
  }

  const startEngine = (): void => {
    if (startTimer) clearTimeout(startTimer)
    startTimer = null
    engine.start()
    resumeCutOffPurchases()
  }

  /**
   * Once per launch: every window's page says it's ready (and again on each
   * reload), and a second pass would make a cut-off order a second time.
   * Payments starts after the scheduler, so until it runs this waits for it.
   */
  let resumed = false
  let resumeTries = 0
  let resumeTimer: ReturnType<typeof setTimeout> | null = null
  function resumeCutOffPurchases(): void {
    if (resumed || resumeTimer) return
    const cutOff = engine.interruptedAtLoad()
    if (cutOff.length === 0) {
      resumed = true
      return
    }
    if (!purchasesKnown() && ++resumeTries < RESUME_TRIES) {
      resumeTimer = setTimeout(() => {
        resumeTimer = null
        resumeCutOffPurchases()
      }, RESUME_WAIT_MS)
      resumeTimer.unref?.()
      return
    }
    resumed = true
    const runs = cutOffPurchasesToRetry(
      cutOff,
      engine.list(),
      (overrides.now ?? Date.now)(),
      (run, task) => mayHaveBoughtSince(run.chatId, task.id, run.startedAt),
      (taskId) => planPurchases(taskId).filter((p) => p.status === 'paid').length
    )
    for (const run of runs) {
      try {
        engine.retry(run.taskId!, run.id)
      } catch (error) {
        console.error('[scheduler] couldn’t run a cut-off purchase again:', error)
      }
    }
  }

  const ready = (sender: WebContents): void => {
    readySenders.add(sender)
    // A reload drops the renderer's listeners until it says ready again.
    sender.once?.('did-start-loading', () => readySenders.delete(sender))
    sender.once?.('destroyed', () => readySenders.delete(sender))
    for (const chat of undelivered.values()) ctx.send('scheduler:chat', chat)
    // Runs other windows already have: this one opened after they started.
    for (const [id, chat] of live) if (!undelivered.has(id) && !sender.isDestroyed?.()) sender.send?.('scheduler:chat', chat)
    undelivered.clear()
    if (pendingOpen) {
      ctx.send('scheduler:open-chat', pendingOpen)
      pendingOpen = null
    }
    // Catch-up runs at launch wait for this, so their chats go straight to the renderer.
    startEngine()
  }

  const registerIpc = (): void => {
    const { ipcMain } = ctx
    ipcMain.handle('scheduler:list', () => engine.list())
    ipcMain.handle('scheduler:save', (_e, draft: TaskDraft) => engine.save(draft))
    ipcMain.handle('scheduler:remove', (_e, id: string) => {
      engine.remove(id)
      hooks.prune(new Set(engine.list().map((t) => t.id)))
    })
    ipcMain.handle('scheduler:set-enabled', (_e, id: string, enabled: boolean) => engine.setEnabled(id, enabled))
    ipcMain.handle('scheduler:run-now', (_e, id: string) => engine.runNow(id))
    ipcMain.handle('scheduler:retry', (_e, id: string, runId: string) => engine.retry(String(id), String(runId)))
    ipcMain.handle('scheduler:cancel', (_e, id: string) => engine.cancel(id))
    ipcMain.handle('scheduler:import', (_e, drafts: TaskDraft[]) => {
      let imported = 0
      for (const draft of Array.isArray(drafts) ? drafts : []) {
        try {
          engine.save(draft)
          imported++
        } catch (error) {
          console.warn('[scheduler] skipped an old task:', error)
        }
      }
      return imported
    })
    ipcMain.handle('scheduler:open-chat', (_e, chatId: string) => openChat(chatId))
    // An automation's webhook: off until turned on, and its address is only given while it is on.
    ipcMain.handle('scheduler:hook', (_e, id: string) => hookStatus(String(id)))
    ipcMain.handle('scheduler:set-hook', (_e, id: string, on: boolean) => {
      const taskId = String(id)
      const task = engine.list().find((t) => t.id === taskId)
      if (!task) throw new Error('That scheduled task no longer exists.')
      if (on === true) {
        if (task.purchase || task.watch) throw new Error('This one makes purchases, so it can only run on its schedule or when you run it.')
        hooks.enable(taskId)
      } else hooks.disable(taskId)
      return hookStatus(taskId)
    })
    ipcMain.handle('scheduler:new-hook-url', (_e, id: string) => {
      hooks.rotate(String(id))
      return hookStatus(String(id))
    })
    ipcMain.handle('scheduler:ready', (event) => ready(event.sender))
  }

  return {
    engine,
    hooks,
    hookStatus,
    sink,
    registerIpc,
    start: () => {
      engine.load()
      hooks.load()
      hooks.prune(new Set(engine.list().map((t) => t.id)))
      setHookTarget({ start: startFromHook })
      registerToolSource(scheduleToolSource(engine))
      // Sleep suspends timers; check the moment the machine wakes, and say
      // so on anything that came due meanwhile.
      powerMonitor.on('resume', () => engine.wake())
      startTimer = setTimeout(startEngine, STARTUP_GRACE_MS)
      startTimer.unref?.()
    },
    stop: () => {
      setHookTarget(null)
      if (startTimer) clearTimeout(startTimer)
      if (resumeTimer) clearTimeout(resumeTimer)
      resumeTimer = null
      resumed = true
      engine.stop()
    },
    rendererReady: ready,
    openChat
  }
}
