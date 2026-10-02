import { app, Notification, powerMonitor, type WebContents } from 'electron'
import { mergeRunChat, type ScheduledTask, type TaskDraft } from '@shared/scheduler'
import type { Chat } from '@shared/types'
import { runAgent } from '../../agent/loop'
import { registerToolSource } from '../../agent/tools'
import { store } from '../../store'
import type { FeatureContext } from '../types'
import { SchedulerEngine, type RunResult } from './engine'
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
 * the message.
 */

const TASKS_FILE = 'scheduled-tasks.json'
/** How long launch waits for the renderer before catching up missed runs anyway. */
const STARTUP_GRACE_MS = 10_000

export interface SchedulerOverrides {
  runAgent?: RunAgent
  now?: () => number
  stallMs?: number
}

export interface SchedulerService {
  engine: SchedulerEngine
  sink: ChatSink
  registerIpc: () => void
  /** Loads tasks now; firing starts once the renderer is ready, or after a grace period. */
  start: () => void
  stop: () => void
  /** The renderer's `scheduler:ready`; exposed for tests. */
  rendererReady: (sender: WebContents) => void
  openChat: (chatId: string) => void
}

export function createScheduler(ctx: FeatureContext, overrides: SchedulerOverrides = {}): SchedulerService {
  let readySender: WebContents | null = null
  /** Live chats the renderer has not seen yet, by id. Sent (current state) when it becomes ready. */
  const undelivered = new Map<string, Chat>()
  let pendingOpen: string | null = null
  let startTimer: ReturnType<typeof setTimeout> | null = null
  const notifications = new Set<Notification>()

  const rendererReady = (): boolean => {
    const window = ctx.getWindow()
    return Boolean(window && readySender && !readySender.isDestroyed() && window.webContents === readySender)
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
      if (index === -1) chats.unshift(chat)
      else chats[index] = mergeRunChat(chats[index], chat)
      store.saveChats(chats)
      await store.flushWrites()
    })
    chatsLock = next.catch((error) => console.error('[scheduler] failed to save a run chat:', error))
    return chatsLock
  }

  const sink: ChatSink = {
    put: async (chat, done) => {
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

  const engine = new SchedulerEngine({
    load: () => store.getJson<unknown>(TASKS_FILE, []),
    save: (tasks) => store.setJson(TASKS_FILE, tasks),
    onChange: (tasks) => ctx.send('scheduler:tasks', tasks),
    now: overrides.now,
    execute: (task, handle) =>
      runScheduledTask(task, handle, { runAgent: overrides.runAgent ?? runAgent, sink, notify, stallMs: overrides.stallMs })
  })

  const startEngine = (): void => {
    if (startTimer) clearTimeout(startTimer)
    startTimer = null
    engine.start()
  }

  const ready = (sender: WebContents): void => {
    readySender = sender
    // A reload drops the renderer's listeners until it says ready again.
    sender.once?.('did-start-loading', () => {
      if (readySender === sender) readySender = null
    })
    for (const chat of undelivered.values()) ctx.send('scheduler:chat', chat)
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
    ipcMain.handle('scheduler:remove', (_e, id: string) => engine.remove(id))
    ipcMain.handle('scheduler:set-enabled', (_e, id: string, enabled: boolean) => engine.setEnabled(id, enabled))
    ipcMain.handle('scheduler:run-now', (_e, id: string) => engine.runNow(id))
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
    ipcMain.handle('scheduler:ready', (event) => ready(event.sender))
  }

  return {
    engine,
    sink,
    registerIpc,
    start: () => {
      engine.load()
      registerToolSource(scheduleToolSource(engine))
      // Sleep suspends timers; check the moment the machine wakes.
      powerMonitor.on('resume', () => engine.tick())
      startTimer = setTimeout(startEngine, STARTUP_GRACE_MS)
      startTimer.unref?.()
    },
    stop: () => {
      if (startTimer) clearTimeout(startTimer)
      engine.stop()
    },
    rendererReady: ready,
    openChat
  }
}
