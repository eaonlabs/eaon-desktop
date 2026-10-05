import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, Notification } from 'electron'
import '../src/main/agent/sources'
import { toolsFor, type ToolContext, type ToolQuery } from '../src/main/agent/tools'
import type { RunOptions, RunOutcome } from '../src/main/agent/loop'
import { store } from '../src/main/store'
import { secrets } from '../src/main/secrets'
import { createWorkersService, type WorkersOverrides, type WorkersService } from '../src/main/features/workers/service'
import { workersToolSource } from '../src/main/features/workers/tools'
import type { RunAgent } from '../src/main/features/workers/runner'
import type { FeatureContext } from '../src/main/features/types'
import { MAX_WORKERS, TRADING_DESK, TRADING_ROUTINE_NAME, describeWorker, mentionedWorkers, workerMood, type Worker, type WorkerDraft } from '@shared/workers'
import { routineNextAt } from '../src/main/features/workers/engine'
import { brokerOf, brokerWriteNeedsUser, setTradingHalted, tradingHalted, writesToBroker } from '../src/main/features/trading/access'
import { isOpen } from '../src/main/features/trading/marketHours'
import type { ChatToolPart, StreamEvent, StreamRequest } from '@shared/types'
import { chunk, sseServer } from './helpers'
import { MAX_ROOM_CHAIN, finalReply } from '../src/main/features/workers/engine'
import { teamToolSource } from '../src/main/features/workers/team'
import { WORKER_CONCURRENCY, WORKER_TEMPLATES } from '@shared/workers'
import { buildTurnMessage } from '../src/main/features/workers/runner'

/**
 * Workers as a team: four turns at once, group chats (who hears what, replies
 * posted back, catch-up context, the cap on bots waking bots), handoffs that
 * report back, shared thread context, teams made from templates, and the chat
 * agent's team tool.
 */

const WORKERS = 'workers.json'
const MODEL = { providerId: 'ollama', modelId: 'fake-model' }
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }

let service: WorkersService | null = null
let root = ''

beforeEach(() => {
  store.setJson(WORKERS, [])
  store.setJson('worker-rooms.json', null)
  root = mkdtempSync(join(tmpdir(), 'eaon-workers-'))
  const settings = store.getSettings()
  store.patchSettings({ work: { ...settings.work, defaultFolder: root } })
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
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const settle = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function fakeContext(focused = false) {
  const sent: { channel: string; payload: unknown }[] = []
  const window = {
    isFocused: () => focused,
    isDestroyed: () => false,
    isMinimized: () => false,
    show() {},
    focus() {},
    restore() {},
    webContents: { isLoading: () => false, once() {} }
  }
  const ctx = {
    ipcMain: { handle: () => {} },
    getWindow: () => window,
    send: (channel: string, ...args: unknown[]) => sent.push({ channel, payload: structuredClone(args[0]) }),
    emitStream: () => {}
  } as unknown as FeatureContext
  return { ctx, sent }
}

type Behaviour = (request: StreamRequest, emit: (event: StreamEvent) => void, options: RunOptions) => Promise<RunOutcome> | RunOutcome

/** A fake runAgent that records what it was asked; `behave` decides each reply. */
function fakeAgent(behave: Behaviour | string = 'Done.') {
  const requests: StreamRequest[] = []
  const options: RunOptions[] = []
  const runAgent: RunAgent = async (request, emit, opts) => {
    requests.push(structuredClone(request))
    options.push(opts)
    if (typeof behave === 'string') {
      emit({ type: 'delta', messageId: request.messageId, text: behave })
      emit({ type: 'done', messageId: request.messageId })
      return { text: behave, usage }
    }
    return behave(request, emit, opts)
  }
  return { runAgent, requests, options }
}

/** Replies only once released, or returns cancelled when its signal aborts — like the real loop. */
function heldAgent() {
  const releases: (() => void)[] = []
  const agent = fakeAgent(
    (request, emit, opts) =>
      new Promise<RunOutcome>((resolve) => {
        emit({ type: 'delta', messageId: request.messageId, text: 'Working on it' })
        const finish = (cancelled: boolean): void => {
          emit({ type: 'done', messageId: request.messageId })
          resolve({ text: 'Working on it', usage, ...(cancelled ? { cancelled: true } : {}) })
        }
        const release = (): void => finish(false)
        // An aborted turn is over; its release must not be the one the test pulls next.
        opts.signal!.addEventListener(
          'abort',
          () => {
            releases.splice(releases.indexOf(release), 1)
            finish(true)
          },
          { once: true }
        )
        releases.push(release)
      })
  )
  return { ...agent, release: () => releases.shift()?.() }
}

function start(runAgent: RunAgent, overrides: WorkersOverrides = {}, focused = false) {
  const { ctx, sent } = fakeContext(focused)
  service = createWorkersService(ctx, { runAgent, startDelayMs: 60_000, ...overrides })
  service.start()
  service.engine.start()
  return { engine: service.engine, sent }
}

function draft(name: string, extra: Partial<WorkerDraft> = {}): WorkerDraft {
  return { name, color: '#3E86C6', personality: 'Calm and plain-spoken.', purpose: `${name}'s job`, model: MODEL, ...extra }
}
const textOf = (request: StreamRequest): string => {
  const last = request.history[request.history.length - 1]
  return last.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
}

test('four workers work at the same time; the fifth waits for a free slot', async () => {
  assert.equal(WORKER_CONCURRENCY, 4)
  const agent = heldAgent()
  const { engine } = start(agent.runAgent)
  const ids = ['Ada', 'Bo', 'Cy', 'Di', 'Ed'].map((name) => engine.save(draft(name)).id)
  for (const id of ids) engine.send(id, 'go')
  await until(() => agent.requests.length === 4)
  await settle()
  assert.equal(agent.requests.length, 4, 'only four at once')
  agent.release()
  await until(() => agent.requests.length === 5)
  for (let i = 0; i < 4; i++) agent.release()
  await engine.whenIdle()
})

test('a group chat: the user is heard by every member, and each final reply is posted back to the room', async () => {
  const agent = fakeAgent((request, emit) => {
    emit({ type: 'delta', messageId: request.messageId, text: 'Let me look. ' })
    emit({ type: 'tool-call', messageId: request.messageId, toolId: 't1', name: 'web_search', input: {} })
    emit({ type: 'tool-result', messageId: request.messageId, toolId: 't1', output: 'ok', status: 'done' })
    emit({ type: 'delta', messageId: request.messageId, text: `Here is my part (${request.chatTitle}).` })
    emit({ type: 'done', messageId: request.messageId })
    return { text: 'all of it', usage }
  })
  const { engine, sent } = start(agent.runAgent)
  const a = engine.save(draft('Ada'))
  const b = engine.save(draft('Bo'))
  const room = engine.saveRoom({ name: 'Launch', members: [a.id, b.id] })
  engine.postAsUser(room.id, 'Plan the launch.')
  await until(() => engine.roomPosts(room.id).length === 3)
  await engine.whenIdle()
  assert.equal(agent.requests.length, 2)
  for (const request of agent.requests) assert.match(textOf(request), /\[In the group chat "Launch", from the user\] Plan the launch\./)
  const posts = engine.roomPosts(room.id)
  assert.deepEqual(posts.map((p) => p.fromName).sort(), ['Ada', 'Bo', 'You'])
  assert.ok(posts.filter((p) => p.from !== 'user').every((p) => /^Here is my part/.test(p.text)), 'only the final answer, not the narration')
  assert.ok(sent.some((s) => s.channel === 'workers:room-post'))
  assert.ok(agent.requests.every((r) => r.persona?.includes('"Launch"')), 'the persona lists its group chats')
  assert.ok(engine.list().every((w) => w.unread === 0), 'replies read in the room are not unread on each worker')
})

test('an @mention in the room reaches only that member; the other catches up the next time', async () => {
  const agent = fakeAgent('Noted.')
  const { engine } = start(agent.runAgent)
  const a = engine.save(draft('Ada'))
  const b = engine.save(draft('Bo'))
  const room = engine.saveRoom({ name: 'Ops', members: [a.id, b.id] })
  engine.postAsUser(room.id, '@Ada check the logs')
  await engine.whenIdle()
  await until(() => agent.requests.length === 1)
  assert.equal(agent.requests[0].chatTitle, 'Ada')
  await engine.whenIdle()
  engine.postAsUser(room.id, 'Status, everyone?')
  await until(() => agent.requests.length === 3)
  await engine.whenIdle()
  const bo = agent.requests.find((r, i) => i > 0 && r.chatTitle === 'Bo')!
  assert.match(textOf(bo), /Said in "Ops" since you last looked:\nThe user: @Ada check the logs\nAda: Noted\./)
  const ada = agent.requests.slice(1).find((r) => r.chatTitle === 'Ada')!
  assert.doesNotMatch(textOf(ada), /since you last looked/, 'Ada already saw all of it')
})

test('workers waking each other in a room stops after MAX_ROOM_CHAIN, until the user posts again', async () => {
  const { engine } = start(fakeAgent('ok').runAgent)
  const a = engine.save(draft('Ada'))
  const b = engine.save(draft('Bo'))
  engine.setPaused(b.id, true)
  const room = engine.saveRoom({ name: 'Loop', members: [a.id, b.id] })
  for (let i = 0; i < MAX_ROOM_CHAIN + 2; i++) await engine.postAsWorker(a.id, 'Loop', `@Bo ping ${i}`)
  const posts = engine.roomPosts(room.id)
  assert.equal(posts.filter((p) => p.mentions?.length).length, MAX_ROOM_CHAIN)
  assert.equal(engine.list().find((w) => w.id === b.id)!.inbox.length, MAX_ROOM_CHAIN)
  engine.postAsUser(room.id, 'carry on')
  await engine.postAsWorker(a.id, 'Loop', '@Bo one more')
  assert.equal(engine.roomPosts(room.id).find((p) => p.text === '@Bo one more')!.mentions?.length, 1, 'the user posting resets the chain')
  await assert.rejects(engine.postAsWorker(a.id, 'Elsewhere', 'hi'), /not in a group chat called "Elsewhere"/)
})

test('a handoff carries the sender\'s thread and files, and finish_handoff sends the result straight back', async () => {
  // Bo's turn stays open until it has reported, as a real turn calling finish_handoff would.
  let releaseBo = (): void => {}
  const agent = fakeAgent((request, emit) => {
    const text = /You are Bo,/.test(request.persona ?? '') ? 'Reported.' : 'On it.'
    const reply = (): RunOutcome => {
      emit({ type: 'delta', messageId: request.messageId, text })
      return { text, usage }
    }
    return /You are Bo,/.test(request.persona ?? '') ? new Promise<RunOutcome>((resolve) => (releaseBo = () => resolve(reply()))) : reply()
  })
  const { engine } = start(agent.runAgent)
  const a = engine.save(draft('Ada'))
  const b = engine.save(draft('Bo'))
  engine.send(a.id, 'We are fixing the login crash on Safari.')
  await engine.whenIdle()
  writeFileSync(join(a.folder, 'trace.txt'), 'stack')
  // Delegations share only what the parent writes (context), plus its recent
  // thread when it asks for that (share_context), and run in a thread of their own.
  const { delegation: handoff, delivered } = await engine.handOff(a.id, 'Bo', 'Reproduce the crash and send me exact steps.', ['trace.txt'], {
    shareContext: true,
    context: 'Only Safari 27 is affected.'
  })
  assert.equal(delivered.length, 1)
  assert.ok(existsSync(delivered[0]))
  assert.equal(engine.delegations().filter((d) => d.recipient.workerId === b.id && d.state !== 'completed').length, 1)
  await until(() => agent.requests.length === 2)
  const bo = textOf(agent.requests[1])
  assert.ok(agent.requests[1].workerThreadId, 'Bo works on it in its own thread')
  assert.match(bo, new RegExp(`\\[Task ${handoff.id}, handed to you by Ada\\] Reproduce the crash`))
  assert.match(bo, /Background from Ada:\nOnly Safari 27 is affected\./)
  assert.match(bo, /Ada's recent thread, shared with you so you have the background:[\s\S]*login crash on Safari/)
  assert.match(bo, new RegExp(`finish_handoff \\{task_id: "${handoff.id}"`))

  const said = await engine.finishHandoff(b.id, handoff.id, 'Steps: open Safari 27, click Log in.')
  assert.match(said, /Sent the result to Ada/)
  assert.equal(engine.delegations().find((d) => d.id === handoff.id)!.state, 'completed')
  releaseBo()
  await until(() => agent.requests.length === 3)
  await engine.whenIdle()
  assert.match(textOf(agent.requests[2]), new RegExp(`\\[Bo finished task ${handoff.id} you handed over \\("Reproduce the crash`))
  await assert.rejects(engine.finishHandoff(b.id, handoff.id, 'again'), /No open task/)
})

test('message_worker can share context, and check_worker reads a colleague\'s recent thread', async () => {
  const agent = fakeAgent('Done the research: three options.')
  const { engine } = start(agent.runAgent)
  const a = engine.save(draft('Ada'))
  engine.save(draft('Bo'))
  engine.send(a.id, 'Research note apps.')
  await engine.whenIdle()
  await engine.message(a.id, 'Bo', 'Write it up.', [], { shareContext: true })
  await until(() => agent.requests.length === 2)
  await engine.whenIdle()
  assert.match(textOf(agent.requests[1]), /Ada's recent thread[\s\S]*Research note apps\.[\s\S]*Ada: Done the research/)
  const report = engine.inspect('Ada', 4)
  assert.match(report, /Recent thread:\nIncoming: \[From the user\] Research note apps\./)
})

test('a team from templates: workers, a group chat and the kickoff, all at once', async () => {
  const agent = fakeAgent('Starting.')
  const { engine } = start(agent.runAgent)
  engine.save(draft('Researcher'))
  const templates = WORKER_TEMPLATES.filter((t) => ['researcher', 'writer', 'bug-reproducer'].includes(t.id))
  const { room, workers } = engine.createTeam({ name: 'Ship it', roles: templates, kickoff: 'Ship the v2 docs.', model: MODEL })
  assert.deepEqual(workers.map((w) => w.name), ['Researcher 2', 'Writer', 'Bug Reproducer'])
  assert.equal(room.members.length, 3)
  assert.match(workers[1].purpose, /Part of the "Ship it" team\./)
  await until(() => agent.requests.length === 3)
  await engine.whenIdle()
  assert.ok(agent.requests.every((r) => /Ship the v2 docs\./.test(textOf(r))))
  assert.throws(() => engine.createTeam({ name: 'Too big', roles: Array.from({ length: 9 }, () => templates[0]) }), /up to 8/)
})

test('group chat tools are offered only to a worker in one; removing a worker takes it out of rooms; rooms survive a restart', async () => {
  const { engine } = start(fakeAgent().runAgent)
  const a = engine.save(draft('Ada'))
  const b = engine.save(draft('Bo'))
  const source = workersToolSource(engine)
  const names = (id: string): string[] =>
    source.tools({ mode: 'work', cwd: root, depth: 0, readOnly: false, settings: store.getSettings(), request: { workerId: id } as StreamRequest } as ToolQuery).map((t) => t.name)
  assert.ok(names(a.id).includes('hand_off') && names(a.id).includes('finish_handoff'))
  assert.ok(!names(a.id).includes('post_to_room'))
  const room = engine.saveRoom({ name: 'Pair', members: [a.id, b.id] })
  assert.ok(names(a.id).includes('post_to_room') && names(a.id).includes('read_room'))
  engine.postAsUser(room.id, 'hello')
  await engine.whenIdle()
  await engine.remove(b.id)
  assert.deepEqual(engine.rooms()[0].members, [a.id])
  service!.stop()
  await store.flushWrites()
  const again = start(fakeAgent().runAgent)
  assert.equal(again.engine.rooms()[0].name, 'Pair')
  assert.ok(again.engine.roomPosts(room.id).some((p) => p.text === 'hello'))
})

test('the chat agent\'s team tool starts a team and reads its group chat', async () => {
  const { engine } = start(fakeAgent('Researching now.').runAgent)
  const opened: string[] = []
  const tool = teamToolSource(engine, (id) => opened.push(id)).tools({ mode: 'work', cwd: root, depth: 0, readOnly: false, settings: store.getSettings(), request: { chatId: 'c1' } as StreamRequest } as ToolQuery)[0]
  assert.equal(tool.name, 'team')
  const ctx = {} as ToolContext
  const made = (await tool.run({ action: 'create_team', name: 'Docs', roles: ['researcher', 'Editor: Edits the docs for clarity.'], kickoff: 'Audit the docs.' }, ctx)) as string
  assert.match(made, /Created the "Docs" group chat with Researcher, Editor/)
  assert.equal(opened.length, 1)
  // Team workers follow the app's model, which the test stub has none of: each
  // turn fails, and the room says so rather than leaving the user waiting.
  await until(() => engine.roomPosts(opened[0]).length === 3)
  await engine.whenIdle()
  const read = (await tool.run({ action: 'read', room: 'Docs' }, ctx)) as string
  assert.match(read, /User: Audit the docs\./)
  assert.match(read, /Researcher: I hit a problem and couldn’t finish: No model is available/)
  const none = teamToolSource(engine).tools({ mode: 'work', cwd: root, depth: 0, readOnly: false, settings: store.getSettings(), request: { chatId: 'w', workerId: 'x' } as StreamRequest } as ToolQuery)
  assert.equal(none.length, 0, 'workers use their own tools')
})

test('the turn message labels room mail, handoffs and results', () => {
  const message = buildTurnMessage(
    [
      { id: '1', from: 'user', fromName: 'You', text: 'Go', files: [], at: 0, room: { id: 'r', name: 'Crew' }, roomContext: 'Bo: earlier' },
      { id: '2', from: 'w2', fromName: 'Bo', text: 'Fix it', files: [], at: 0, handoff: { id: 'task_1', task: 'Fix it' }, context: 'Bo: background' }
    ],
    null,
    Date.UTC(2026, 9, 4, 12)
  )
  const text = message.parts[0].type === 'text' ? message.parts[0].text : ''
  assert.match(text, /\[In the group chat "Crew", from the user\] Go\nSaid in "Crew" since you last looked:\nBo: earlier/)
  assert.match(text, /\[Task task_1, handed to you by Bo\] Fix it\nBo's recent thread/)
  assert.match(text, /\[Group chat\] Your final reply is posted to the group chat/)
  assert.equal(finalReply({ id: 'm', role: 'assistant', createdAt: 0, parts: [{ type: 'text', text: 'a' }, { type: 'tool', id: 't', name: 'x', input: {}, output: '', status: 'done' }, { type: 'text', text: 'b' }] }), 'b')
})
