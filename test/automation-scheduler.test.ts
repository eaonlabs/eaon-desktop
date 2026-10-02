import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { store } from '../src/main/store'
import { createScheduler, type SchedulerService } from '../src/main/features/scheduler/service'
import type { RunAgent } from '../src/main/features/scheduler/runner'
import type { FeatureContext } from '../src/main/features/types'
import { WEEKDAYS, type TaskDraft } from '@shared/scheduler'
import type { Chat } from '@shared/types'

/**
 * Regressions from the 2026.6 bug pass over scheduled tasks: runs that hang,
 * stops that arrive early, chats held in memory after a windowless run, and a
 * one-off whose time passes during a manual run. `runAgent` is faked; see
 * scheduler-engine.test.ts for the real loop.
 */

const TASKS = 'scheduled-tasks.json'
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }

let service: SchedulerService | null = null

beforeEach(() => {
  store.setJson(TASKS, [])
  store.saveChats([])
})

afterEach(async () => {
  service?.stop()
  await service?.engine.whenIdle()
  service = null
  await store.flushWrites()
})

async function until(check: () => boolean, timeout = 5000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** A FeatureContext whose window can be opened and closed by the test. */
function fakeContext() {
  const sent: { channel: string; payload: unknown }[] = []
  const sender = { isDestroyed: () => false, once: () => sender }
  const window = { webContents: sender, isDestroyed: () => false, isFocused: () => false, isMinimized: () => false, show() {}, focus() {}, restore() {} }
  const state = { open: false }
  const ctx = {
    ipcMain: { handle: () => {} },
    getWindow: () => (state.open ? window : null),
    send: (channel: string, ...args: unknown[]) => sent.push({ channel, payload: structuredClone(args[0]) }),
    emitStream: () => {}
  } as unknown as FeatureContext
  return { ctx, sent, state, sender: sender as unknown as Electron.WebContents }
}

function draft(overrides: Partial<TaskDraft> = {}): TaskDraft {
  return {
    name: 'Digest',
    prompt: 'Summarise my notifications.',
    schedule: { kind: 'daily', time: '09:00', days: WEEKDAYS },
    mode: 'chat',
    model: { providerId: 'ollama', modelId: 'fake-model' },
    cwd: null,
    allowChanges: false,
    enabled: true,
    ...overrides
  }
}

/** Like the real runAgent: returns (without an error) only once its signal aborts. */
function hangingAgent(): { runAgent: RunAgent; calls: number } {
  const state = { calls: 0 }
  const runAgent: RunAgent = (request, emit, options) =>
    new Promise((resolve) => {
      state.calls++
      emit({ type: 'delta', messageId: request.messageId, text: 'Looking' })
      options.signal!.addEventListener('abort', () => {
        emit({ type: 'done', messageId: request.messageId })
        resolve({ text: 'Looking', usage })
      })
    })
  return {
    runAgent,
    get calls() {
      return state.calls
    }
  }
}

test('a run that stops making progress is ended and recorded as failed, so the task is not stuck running', async () => {
  const { ctx } = fakeContext()
  const agent = hangingAgent()
  service = createScheduler(ctx, { runAgent: agent.runAgent, stallMs: 150 })
  service.start()
  service.engine.start()
  const task = service.engine.save(draft())
  service.engine.runNow(task.id)
  await until(() => service!.engine.list()[0].history[0].status !== 'running', 3000)

  const run = service.engine.list()[0].history[0]
  assert.equal(run.status, 'failed')
  assert.match(run.error ?? '', /No progress/)
  assert.equal(service.engine.isRunning(task.id), false, 'the next slot can run')
  await store.flushWrites()
  const chat = store.getChats().find((c) => c.id === run.chatId)
  assert.match(chat?.messages[1].error ?? '', /No progress/, 'the chat says why it stopped')
})

test('a run that keeps streaming is not cut off by the stall limit', async () => {
  const { ctx } = fakeContext()
  const runAgent: RunAgent = async (request, emit) => {
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 60))
      emit({ type: 'delta', messageId: request.messageId, text: `${i} ` })
    }
    emit({ type: 'done', messageId: request.messageId })
    return { text: 'done', usage }
  }
  service = createScheduler(ctx, { runAgent, stallMs: 150 })
  service.start()
  service.engine.start()
  const task = service.engine.save(draft())
  service.engine.runNow(task.id)
  await service.engine.whenIdle()
  assert.equal(service.engine.list()[0].history[0].status, 'succeeded')
})

test('Stop pressed while the run is still being set up cancels it before the agent starts', async () => {
  const { ctx } = fakeContext()
  const agent = hangingAgent()
  service = createScheduler(ctx, { runAgent: agent.runAgent })
  service.start()
  service.engine.start()
  const task = service.engine.save(draft())
  // With no window, the run's chat is written to disk before the agent is
  // called; the stop lands in that gap.
  service.engine.runNow(task.id)
  service.engine.cancel(task.id)
  await until(() => service!.engine.list()[0].history[0].status !== 'running', 3000)
  assert.equal(service.engine.list()[0].history[0].status, 'cancelled')
  assert.equal(agent.calls, 0, 'the agent never ran')
})

test('a run the loop reports as cancelled (Emergency Stop) is recorded as cancelled, not succeeded', async () => {
  const { ctx } = fakeContext()
  // Emergency Stop aborts the loop's own controller; the task's signal never fires.
  const runAgent: RunAgent = async (request, emit) => {
    emit({ type: 'delta', messageId: request.messageId, text: 'Clicking' })
    emit({ type: 'done', messageId: request.messageId })
    return { text: 'Clicking', usage, cancelled: true }
  }
  service = createScheduler(ctx, { runAgent })
  service.start()
  service.engine.start()
  const task = service.engine.save(draft())
  service.engine.runNow(task.id)
  await service.engine.whenIdle()
  assert.equal(service.engine.list()[0].history[0].status, 'cancelled')
})

test('a run that finished with no window open is left in chats.json, not held and re-sent when a window opens', async () => {
  const { ctx, sent, state, sender } = fakeContext()
  service = createScheduler(ctx, {
    runAgent: async (request, emit) => {
      emit({ type: 'delta', messageId: request.messageId, text: 'All quiet.' })
      emit({ type: 'done', messageId: request.messageId })
      return { text: 'All quiet.', usage }
    }
  })
  service.start()
  service.engine.start()
  const task = service.engine.save(draft())
  service.engine.runNow(task.id)
  await service.engine.whenIdle()
  await store.flushWrites()
  const chatId = service.engine.list()[0].history[0].chatId
  assert.ok(store.getChats().some((c) => c.id === chatId), 'on disk, where a new window reads it')

  state.open = true
  service.rendererReady(sender)
  assert.equal(sent.filter((s) => s.channel === 'scheduler:chat').length, 0)
})

test('a run that finished while a window was still loading is sent once it is ready', async () => {
  const { ctx, sent, state, sender } = fakeContext()
  state.open = true // open, but it has not said it is ready
  service = createScheduler(ctx, {
    runAgent: async (request, emit) => {
      emit({ type: 'delta', messageId: request.messageId, text: 'All quiet.' })
      emit({ type: 'done', messageId: request.messageId })
      return { text: 'All quiet.', usage }
    }
  })
  service.start()
  service.engine.start()
  const task = service.engine.save(draft())
  service.engine.runNow(task.id)
  await service.engine.whenIdle()
  // The window may have read chats.json before this run wrote it.
  service.rendererReady(sender)
  const chats = sent.filter((s) => s.channel === 'scheduler:chat').map((s) => s.payload as Chat)
  assert.equal(chats.length, 1)
  assert.equal(chats[0].messages[1].parts.map((p) => (p.type === 'text' ? p.text : '')).join(''), 'All quiet.')
})

test('a one-off whose time comes and goes during a manual run is used up, not left on with nothing scheduled', async () => {
  let clock = Date.now()
  const { ctx } = fakeContext()
  const agent = hangingAgent()
  service = createScheduler(ctx, { runAgent: agent.runAgent, now: () => clock })
  service.start()
  service.engine.start()
  const task = service.engine.save(draft({ schedule: { kind: 'once', at: clock + 60_000 } }))
  service.engine.runNow(task.id)
  await until(() => agent.calls === 1)

  clock += 61_000
  service.engine.tick()
  const after = service.engine.list()[0]
  assert.equal(after.nextRunAt, null)
  assert.equal(after.enabled, false, 'switched off like any one-off that has had its turn')
  service.engine.cancel(task.id)
})
