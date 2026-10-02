import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Notification } from 'electron'
import '../src/main/agent/sources'
import { toolsFor, type ToolContext } from '../src/main/agent/tools'
import { store } from '../src/main/store'
import { secrets } from '../src/main/secrets'
import { createScheduler, type SchedulerService } from '../src/main/features/scheduler/service'
import type { RunAgent } from '../src/main/features/scheduler/runner'
import { scheduleTool } from '../src/main/features/scheduler/tool'
import { summariseReply } from '../src/main/features/scheduler/transcript'
import type { FeatureContext } from '../src/main/features/types'
import { nextRunAfter, WEEKDAYS, WORKDAYS, type ScheduledTask, type TaskDraft } from '@shared/scheduler'
import type { Chat, ChatToolPart, Settings, StreamEvent, StreamRequest } from '@shared/types'
import { chunk, sseServer } from './helpers'

/**
 * The scheduler end to end: a due task fires on its own timer, runs the agent
 * headlessly and leaves a chat behind — in chats.json with no window, or over
 * IPC to a ready renderer. `runAgent` is mocked for most of these; the last
 * tests run the real agent loop against a fake HTTP model to prove the
 * unattended approval policy.
 */

const TASKS = 'scheduled-tasks.json'
const HOUR = 3_600_000
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }
const REPLY = 'Three new notifications, one needs a review.\n\n- **repo/a**: review requested'

let service: SchedulerService | null = null

beforeEach(() => {
  store.setJson(TASKS, [])
  store.saveChats([])
  Notification.supported = false
  Notification.shown.length = 0
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

/** A FeatureContext with an optional fake window. Sends are cloned, as Electron serialises them at send time. */
function fakeContext(withWindow: boolean) {
  const sent: { channel: string; payload: unknown }[] = []
  const streamed: StreamEvent[] = []
  const sender = { isDestroyed: () => false, once: () => sender }
  const window = withWindow
    ? { webContents: sender, isDestroyed: () => false, isFocused: () => false, isMinimized: () => false, show() {}, focus() {}, restore() {} }
    : null
  const ctx = {
    ipcMain: { handle: () => {} },
    getWindow: () => window,
    send: (channel: string, ...args: unknown[]) => sent.push({ channel, payload: structuredClone(args[0]) }),
    emitStream: (event: StreamEvent) => streamed.push(structuredClone(event))
  } as unknown as FeatureContext
  return { ctx, sent, streamed, sender: sender as unknown as Electron.WebContents }
}

function fakeAgent(reply = REPLY) {
  const calls: { request: StreamRequest; options: Parameters<RunAgent>[2] }[] = []
  const runAgent: RunAgent = async (request, emit, options) => {
    calls.push({ request, options })
    const messageId = request.messageId
    emit({ type: 'reasoning', messageId, text: 'Checking notifications…' })
    emit({ type: 'tool-call', messageId, toolId: 't1', name: 'web_search', input: { query: 'github' } })
    emit({ type: 'tool-result', messageId, toolId: 't1', output: '3 results', status: 'done' })
    for (let i = 0; i < reply.length; i += 7) emit({ type: 'delta', messageId, text: reply.slice(i, i + 7) })
    emit({ type: 'usage', messageId, usage })
    emit({ type: 'done', messageId })
    return { text: reply, usage }
  }
  return { runAgent, calls }
}

function draft(overrides: Partial<TaskDraft> = {}): TaskDraft {
  return {
    name: 'Morning digest',
    prompt: 'Summarise my GitHub notifications.',
    schedule: { kind: 'daily', time: '09:00', days: WEEKDAYS },
    mode: 'chat',
    model: { providerId: 'ollama', modelId: 'fake-model' },
    cwd: null,
    allowChanges: false,
    enabled: true,
    ...overrides
  }
}

const text = (chat: Chat): string =>
  chat.messages[1].parts.map((p) => (p.type === 'text' ? p.text : '')).join('')

test('a due task fires on its own timer and leaves a chat in chats.json when no window is open', async () => {
  const { ctx, sent } = fakeContext(false)
  const agent = fakeAgent()
  service = createScheduler(ctx, { runAgent: agent.runAgent })
  service.start()
  service.engine.start()

  const created = service.engine.save(draft({ schedule: { kind: 'once', at: Date.now() + 400 } }))
  assert.equal(created.nextRunAt, created.schedule.kind === 'once' ? created.schedule.at : NaN)
  assert.equal(agent.calls.length, 0, 'not before its time')

  await until(() => service!.engine.list()[0].lastStatus === 'succeeded')
  const task = service.engine.list()[0]
  const run = task.history[0]
  assert.equal(agent.calls.length, 1)
  assert.equal(run.trigger, 'schedule')
  assert.equal(run.summary, 'Three new notifications, one needs a review.')
  assert.ok(run.finishedAt! >= run.startedAt)
  // A one-off is used up.
  assert.equal(task.enabled, false)
  assert.equal(task.nextRunAt, null)

  // What the agent was asked to do.
  const { request, options } = agent.calls[0]
  assert.equal(request.mode, 'chat')
  assert.equal(request.providerId, 'ollama')
  assert.equal(request.modelId, 'fake-model')
  assert.equal(request.history.length, 1)
  assert.equal(request.history[0].scheduledTaskId, task.id)
  assert.deepEqual(request.work, { swarm: false, plan: false })
  assert.match(request.projectInstructions, /running unattended/)
  assert.equal(options.unattended, 'read-only')
  assert.equal(await options.approver!('computer', {}), false)

  // The chat, written by main because there was no renderer to hand it to.
  await store.flushWrites()
  const chat = store.getChats().find((c) => c.id === run.chatId)
  assert.ok(chat, 'the run chat is in chats.json')
  assert.equal(chat.title, 'Morning digest')
  assert.equal(chat.workspaceId, 'work', 'Chat-mode tasks land in the Chat workspace')
  assert.equal(chat.unread, true)
  assert.deepEqual(chat.messages.map((m) => [m.role, m.scheduledTaskId]), [
    ['user', task.id],
    ['assistant', task.id]
  ])
  assert.equal(text(chat), REPLY)
  const tool = chat.messages[1].parts.find((p) => p.type === 'tool') as ChatToolPart
  assert.equal(tool.status, 'done')
  assert.equal(tool.output, '3 results')
  assert.deepEqual(chat.messages[1].usage, usage)
  assert.ok(!sent.some((s) => s.channel === 'scheduler:chat'), 'nothing sent to a window that does not exist')
  assert.ok(sent.some((s) => s.channel === 'scheduler:tasks'), 'task changes are broadcast')
})

test('with the window open the chat goes to the renderer, streams live, and the notification opens it', async () => {
  Notification.supported = true
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-sched-'))
  const { ctx, sent, streamed, sender } = fakeContext(true)
  const agent = fakeAgent()
  service = createScheduler(ctx, { runAgent: agent.runAgent })
  service.start()
  service.rendererReady(sender)

  const task = service.engine.save(draft({ name: 'Repo check', mode: 'work', allowChanges: true, cwd }))
  service.engine.runNow(task.id)
  await service.engine.whenIdle()

  const chats = sent.filter((s) => s.channel === 'scheduler:chat').map((s) => s.payload as Chat)
  assert.equal(chats.length, 2, 'once when the run starts, once when it ends')
  assert.equal(chats[0].id, chats[1].id)
  assert.equal(chats[0].workspaceId, 'work', 'every run lands in Chat, which is the agent now')
  assert.equal(chats[0].messages[1].parts.length, 0, 'inserted empty, before any event')
  assert.equal(text(chats[1]), REPLY)

  const assistantId = chats[0].messages[1].id
  const deltas = streamed.filter((e) => e.type === 'delta' && e.messageId === assistantId)
  assert.equal(deltas.map((e) => (e as { text: string }).text).join(''), REPLY)
  assert.equal(streamed[streamed.length - 1].type, 'done')

  await store.flushWrites()
  assert.equal(store.getChats().length, 0, 'main never writes chats.json under a live renderer')

  const { request, options } = agent.calls[0]
  assert.equal(request.mode, 'work')
  assert.equal(request.cwd, cwd)
  assert.equal(options.unattended, 'safe')
  const finished = service.engine.list()[0]
  assert.equal(finished.history[0].trigger, 'manual')
  assert.equal(finished.nextRunAt, task.nextRunAt, 'a manual run does not use up the next slot')

  assert.equal(Notification.shown.length, 1)
  const notification = Notification.shown[0]
  assert.equal(notification.options.title, 'Repo check')
  assert.equal(notification.options.body, 'Three new notifications, one needs a review.')
  notification.click()
  assert.deepEqual(sent[sent.length - 1], { channel: 'scheduler:open-chat', payload: chats[0].id })
})

test('a window that opens mid-run is sent the live chat once it is ready', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const windowed = fakeContext(true)
  let windowOpen = false
  const ctx = { ...windowed.ctx, getWindow: () => (windowOpen ? windowed.ctx.getWindow() : null) } as FeatureContext
  const runAgent: RunAgent = async (request, emit) => {
    emit({ type: 'delta', messageId: request.messageId, text: 'Part one. ' })
    await gate
    emit({ type: 'delta', messageId: request.messageId, text: 'Part two.' })
    emit({ type: 'done', messageId: request.messageId })
    return { text: 'Part one. Part two.', usage }
  }
  service = createScheduler(ctx, { runAgent })
  service.start()
  service.engine.start()
  const task = service.engine.save(draft())
  service.engine.runNow(task.id)
  await until(() => service!.engine.list()[0].history[0].chatId !== null)
  await store.flushWrites()
  await until(() => store.getChats().length === 1)

  windowOpen = true
  service.rendererReady(windowed.sender)
  const early = windowed.sent.filter((s) => s.channel === 'scheduler:chat').map((s) => s.payload as Chat)
  assert.equal(early.length, 1)
  assert.equal(text(early[0]), 'Part one. ', 'the copy sent on ready includes what streamed while no window was open')

  release()
  await service.engine.whenIdle()
  const all = windowed.sent.filter((s) => s.channel === 'scheduler:chat').map((s) => s.payload as Chat)
  assert.equal(text(all[all.length - 1]), 'Part one. Part two.')
})

test('slots missed while Eaon was closed: one catch-up run if under a day late, otherwise recorded as missed', async () => {
  const now = Date.now()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const slot = (t: number): { at: number; time: string; day: number } => {
    const d = new Date(t)
    d.setSeconds(0, 0)
    return { at: d.getTime(), time: `${pad(d.getHours())}:${pad(d.getMinutes())}`, day: d.getDay() }
  }
  const base = (id: string, schedule: ScheduledTask['schedule'], nextRunAt: number): ScheduledTask => ({
    id,
    name: id,
    prompt: `run ${id}`,
    schedule,
    mode: 'chat',
    model: { providerId: 'ollama', modelId: 'fake-model' },
    cwd: null,
    allowChanges: false,
    enabled: true,
    createdAt: now - 30 * 24 * HOUR,
    updatedAt: now - 30 * 24 * HOUR,
    nextRunAt,
    lastRunAt: null,
    lastStatus: null,
    history: []
  })
  const threeHoursAgo = slot(now - 3 * HOUR)
  const threeDaysAgo = slot(now - 72 * HOUR)
  const inTwoHours = slot(now + 2 * HOUR)
  const tenHoursAgo = now - 10 * HOUR
  const crashed = base('crashed', { kind: 'daily', time: inTwoHours.time, days: WEEKDAYS }, inTwoHours.at)
  crashed.history = [{ id: 'r0', startedAt: now - HOUR, finishedAt: null, status: 'running', chatId: 'c0', trigger: 'schedule' }]
  store.setJson(TASKS, [
    base('daily', { kind: 'daily', time: threeHoursAgo.time, days: WEEKDAYS }, threeHoursAgo.at),
    base('weekly', { kind: 'weekly', time: threeDaysAgo.time, day: threeDaysAgo.day }, threeDaysAgo.at),
    base('interval', { kind: 'interval', every: 1, unit: 'hours', startAt: tenHoursAgo }, tenHoursAgo),
    base('future', { kind: 'daily', time: inTwoHours.time, days: WEEKDAYS }, inTwoHours.at),
    crashed
  ])

  const { ctx } = fakeContext(false)
  const agent = fakeAgent()
  service = createScheduler(ctx, { runAgent: agent.runAgent })
  service.start()
  service.engine.start()
  await service.engine.whenIdle()

  const byId = new Map(service.engine.list().map((t) => [t.id, t]))
  assert.deepEqual(agent.calls.map((c) => c.request.history[0].parts[0]).map((p) => (p as { text: string }).text).sort(), ['run daily', 'run interval'])

  const daily = byId.get('daily')!
  assert.equal(daily.history.length, 1)
  assert.equal(daily.history[0].trigger, 'catch-up')
  assert.equal(daily.history[0].status, 'succeeded')
  assert.equal(daily.nextRunAt, nextRunAfter(daily.schedule, daily.history[0].startedAt), 'back on its normal cadence')
  assert.ok(daily.nextRunAt! > now)

  const interval = byId.get('interval')!
  assert.equal(interval.history.length, 1, 'ten missed hours run once, not ten times')
  assert.ok(interval.nextRunAt! > now && interval.nextRunAt! <= now + HOUR)
  assert.equal((interval.nextRunAt! - tenHoursAgo) % HOUR, 0, 'still on its grid')

  const weekly = byId.get('weekly')!
  assert.equal(weekly.history[0].status, 'missed', 'more than a day late: skipped')
  assert.equal(weekly.lastStatus, 'missed')
  assert.equal(weekly.nextRunAt, nextRunAfter(weekly.schedule, threeDaysAgo.at + 24 * HOUR))

  const future = byId.get('future')!
  assert.equal(future.history.length, 0)
  assert.equal(future.nextRunAt, inTwoHours.at)

  const recovered = byId.get('crashed')!
  assert.equal(recovered.history[0].status, 'failed')
  assert.match(recovered.history[0].error!, /quit before/)
})

test('one run at a time: a second start is refused and a slot that comes due mid-run is skipped', async () => {
  let clock = Date.now()
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  let calls = 0
  const runAgent: RunAgent = async (request, emit) => {
    calls++
    await gate
    emit({ type: 'delta', messageId: request.messageId, text: 'ok' })
    emit({ type: 'done', messageId: request.messageId })
    return { text: 'ok', usage }
  }
  const { ctx } = fakeContext(false)
  service = createScheduler(ctx, { runAgent, now: () => clock })
  service.start()
  service.engine.start()
  const task = service.engine.save(draft({ schedule: { kind: 'interval', every: 1, unit: 'minutes' } }))
  assert.equal(task.nextRunAt, clock + 60_000)

  service.engine.runNow(task.id)
  assert.throws(() => service!.engine.runNow(task.id), /already running/)
  await until(() => calls === 1)

  clock += 61_000
  service.engine.tick()
  assert.equal(calls, 1, 'no overlapping run')
  assert.ok(service.engine.list()[0].nextRunAt! > clock, 'the slot is skipped, not queued')

  release()
  await service.engine.whenIdle()
  assert.equal(calls, 1)
  assert.equal(service.engine.list()[0].history.length, 1)
  assert.equal(service.engine.list()[0].lastStatus, 'succeeded')
})

test('Stop cancels a run in progress', async () => {
  let started = false
  const runAgent: RunAgent = (request, emit, options) =>
    new Promise((resolve) => {
      started = true
      emit({ type: 'delta', messageId: request.messageId, text: 'Starting' })
      options.signal!.addEventListener('abort', () => {
        emit({ type: 'done', messageId: request.messageId })
        resolve({ text: 'Starting', usage })
      })
    })
  const { ctx } = fakeContext(false)
  service = createScheduler(ctx, { runAgent })
  service.start()
  service.engine.start()
  const task = service.engine.save(draft())
  service.engine.runNow(task.id)
  await until(() => started)
  service.engine.cancel(task.id)
  await service.engine.whenIdle()
  assert.equal(service.engine.list()[0].history[0].status, 'cancelled')
})

test('an unavailable model fails the run with a readable error in the chat', async () => {
  const { ctx } = fakeContext(false)
  service = createScheduler(ctx, { runAgent: fakeAgent().runAgent })
  service.start()
  service.engine.start()
  const task = service.engine.save(draft({ model: { providerId: 'openai', modelId: 'gpt-x' } }))
  service.engine.runNow(task.id)
  await service.engine.whenIdle()
  const run = service.engine.list()[0].history[0]
  assert.equal(run.status, 'failed')
  assert.match(run.error!, /no key/)
  await store.flushWrites()
  assert.match(store.getChats()[0].messages[1].error!, /no key/)
})

test('editing and toggling keep the schedule honest', () => {
  const { ctx } = fakeContext(false)
  service = createScheduler(ctx, { runAgent: fakeAgent().runAgent })
  service.start()
  const engine = service.engine
  assert.throws(() => engine.save(draft({ prompt: '  ' })), /prompt/)
  assert.throws(() => engine.save(draft({ schedule: { kind: 'once', at: Date.now() - 1000 } })), /passed/)

  const task = engine.save(draft({ schedule: { kind: 'interval', every: 2, unit: 'hours' } }))
  const anchor = task.schedule.kind === 'interval' ? task.schedule.startAt : 0
  // Renaming keeps the grid; changing the interval starts a new one.
  const renamed = engine.save({ ...draft(), id: task.id, name: 'Renamed', schedule: task.schedule })
  assert.equal(renamed.nextRunAt, task.nextRunAt)
  assert.equal(renamed.schedule.kind === 'interval' && renamed.schedule.startAt, anchor)
  const paused = engine.setEnabled(task.id, false)
  assert.equal(paused.nextRunAt, null)
  const resumed = engine.setEnabled(task.id, true)
  assert.ok(resumed.nextRunAt! > Date.now())
  engine.remove(task.id)
  assert.equal(engine.list().length, 0)
  // Saved to disk, where the next launch reads it.
  assert.deepEqual(store.getJson(TASKS, null), [])
})

test('run summaries are the first real line, without markdown', () => {
  assert.equal(summariseReply('**Word:** *quixotic*\n\nMeaning: …'), 'Word: quixotic')
  assert.equal(summariseReply('# Report\n\n- Found `snake_case_name` in [the docs](https://x.y)'), 'Report')
  assert.equal(summariseReply('```\ncode\n```\n---\n_Nothing_ changed in my_file.ts'), 'Nothing changed in my_file.ts')
  assert.equal(summariseReply('a'.repeat(200)).length, 140)
  assert.equal(summariseReply(''), '')
})

test('the schedule tool creates, lists, updates and deletes tasks, and is not offered to scheduled runs', async () => {
  const { ctx } = fakeContext(false)
  service = createScheduler(ctx, { runAgent: fakeAgent().runAgent })
  service.start()
  const tool = scheduleTool(service.engine)
  const toolCtx = { cwd: '/tmp/project' } as ToolContext

  assert.equal(typeof tool.mutating === 'function' && tool.mutating({ action: 'list' }, toolCtx), false)
  assert.equal(typeof tool.mutating === 'function' && tool.mutating({ action: 'create' }, toolCtx), true)

  const created = await tool.run(
    {
      action: 'create',
      name: 'GitHub digest',
      prompt: 'Summarise my GitHub notifications with the gh CLI.',
      schedule: { type: 'daily', time: '9am', days: ['mon', 'tue', 'wed', 'thu', 'fri'] },
      allow_changes: true
    },
    toolCtx
  )
  assert.match(String(created), /GitHub digest/)
  const [task] = service.engine.list()
  assert.deepEqual(task.schedule, { kind: 'daily', time: '09:00', days: WORKDAYS })
  assert.equal(task.mode, 'work')
  assert.equal(task.cwd, '/tmp/project')
  assert.equal(task.allowChanges, true)
  assert.equal(tool.describe!({ action: 'create', name: 'GitHub digest', schedule: { type: 'daily', time: '09:00', days: 'weekdays' } }).startsWith('Create “GitHub digest” — Weekdays at'), true)

  assert.match(String(await tool.run({ action: 'list' }, toolCtx)), new RegExp(task.id))
  await tool.run({ action: 'update', id: task.id, schedule: { type: 'weekly', day: 'fri', time: '17:00' } }, toolCtx)
  assert.deepEqual(service.engine.list()[0].schedule, { kind: 'weekly', time: '17:00', day: 5 })
  await assert.rejects(tool.run({ action: 'create', prompt: 'x', schedule: { type: 'daily', time: 'noonish' } }, toolCtx), /HH:MM|time/)
  await tool.run({ action: 'delete', id: task.id }, toolCtx)
  assert.equal(service.engine.list().length, 0)

  // Offered in Work turns; not in Chat, and not to a scheduled run itself.
  const settings = store.getSettings()
  const query = (history: StreamRequest['history'], mode: 'chat' | 'work' = 'work') => ({
    mode,
    cwd: '/tmp/project',
    depth: 0,
    readOnly: false,
    settings,
    request: { history, work: { swarm: false, plan: false }, goal: null } as unknown as StreamRequest
  })
  const names = (q: ReturnType<typeof query>): string[] => toolsFor(q).map((t) => t.name)
  const user = { id: 'u', role: 'user' as const, parts: [], createdAt: 0 }
  assert.ok(names(query([user])).includes('schedule'))
  assert.ok(!names(query([user], 'chat')).includes('schedule'))
  assert.ok(!names(query([{ ...user, scheduledTaskId: 't' }])).includes('schedule'))
})

/* --------------------------------------------- the real agent loop, fake model */

async function fakeModel(): Promise<{ url: string; close: () => void; requests: Record<string, unknown>[] }> {
  // Round 1 writes a file, round 2 tries a risky command, round 3 answers.
  const { url, server, requests } = await sseServer((body) => {
    const toolTurns = (body.messages as { role: string }[]).filter((m) => m.role === 'tool').length
    if (toolTurns === 0) {
      const args = JSON.stringify({ path: 'note.txt', content: 'hello from a schedule' })
      return [chunk({ tool_calls: [{ index: 0, id: 'w1', function: { name: 'write_file', arguments: args } }] }), chunk({}, 'tool_calls'), '[DONE]']
    }
    if (toolTurns === 1) {
      const args = JSON.stringify({ command: 'git push origin main' })
      return [chunk({ tool_calls: [{ index: 0, id: 'r1', function: { name: 'run_command', arguments: args } }] }), chunk({}, 'tool_calls'), '[DONE]']
    }
    return [chunk({ content: 'Done: wrote note.txt.' }), chunk({}, 'stop'), '[DONE]']
  })
  store.saveProviderConfig({
    fake: { name: 'Fake', kind: 'openai-compatible', baseUrl: url, enabled: true, models: [{ id: 'fake-1', label: 'Fake 1', providerId: 'fake' }] }
  })
  secrets.set('fake', 'test-key')
  return { url, requests, close: () => server.close() }
}

async function realRun(allowChanges: boolean): Promise<{ chat: Chat; cwd: string; streamed: StreamEvent[]; requests: Record<string, unknown>[] }> {
  const model = await fakeModel()
  const cwd = mkdtempSync(join(tmpdir(), 'eaon-sched-real-'))
  const { ctx, streamed } = fakeContext(false)
  // No runAgent override: this is the real loop, tools and approval gate.
  service = createScheduler(ctx)
  service.start()
  service.engine.start()
  const task = service.engine.save(draft({ mode: 'work', allowChanges, cwd, model: { providerId: 'fake', modelId: 'fake-1' } }))
  service.engine.runNow(task.id)
  await service.engine.whenIdle()
  model.close()
  await store.flushWrites()
  const chat = store.getChats().find((c) => c.id === service!.engine.list()[0].history[0].chatId)!
  return { chat, cwd, streamed, requests: model.requests }
}

const toolParts = (chat: Chat): ChatToolPart[] => chat.messages[1].parts.filter((p): p is ChatToolPart => p.type === 'tool')

test('real loop: a read-only scheduled run is refused every change, without asking anyone', async () => {
  const settings: Settings = store.getSettings()
  assert.equal(settings.approvalMode, 'ask', 'the interactive setting would normally prompt')
  const { chat, cwd, streamed, requests } = await realRun(false)
  const [write, command] = toolParts(chat)
  assert.equal(write.name, 'write_file')
  assert.equal(write.status, 'denied')
  assert.match(write.output!, /read-only/)
  assert.equal(command.status, 'denied')
  assert.ok(!existsSync(join(cwd, 'note.txt')), 'nothing was written')
  assert.ok(!streamed.some((e) => e.type === 'approval-request'), 'no approval prompt was raised')
  assert.equal(service!.engine.list()[0].history[0].status, 'succeeded')
  const offered = ((requests[0].tools as { function: { name: string } }[]) ?? []).map((t) => t.function.name)
  assert.ok(offered.includes('write_file'))
  assert.ok(!offered.includes('schedule'), 'a scheduled run cannot schedule more runs')
  assert.match(JSON.stringify(requests[0].messages), /running unattended/)
})

test('real loop: with changes allowed, ordinary edits run and risky commands are still refused', async () => {
  const { chat, cwd, streamed } = await realRun(true)
  const [write, command] = toolParts(chat)
  assert.equal(write.status, 'done')
  assert.equal(readFileSync(join(cwd, 'note.txt'), 'utf8'), 'hello from a schedule')
  assert.equal(command.name, 'run_command')
  assert.equal(command.status, 'denied')
  assert.match(command.output!, /nobody to ask/)
  assert.ok(!streamed.some((e) => e.type === 'approval-request'))
  assert.equal(text(chat), 'Done: wrote note.txt.')
})
