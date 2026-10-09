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
import { GOAL_MAX_TURNS, MAX_SLEEP_MINUTES, MAX_WORKERS, TRADING_DESK, TRADING_ROUTINE_NAME, describeWorker, mentionedWorkers, workerMood, type Worker, type WorkerDraft } from '@shared/workers'
import { routineNextAt, workerSlug } from '../src/main/features/workers/engine'
import { brokerOf, brokerWriteNeedsUser, setTradingHalted, tradingHalted, writesToBroker } from '../src/main/features/trading/access'
import { isOpen } from '../src/main/features/trading/marketHours'
import type { ChatToolPart, StreamEvent, StreamRequest } from '@shared/types'
import { chunk, sseServer } from './helpers'

/**
 * Eaon Workers end to end: turns built from mail and heartbeats, the
 * concurrency and hourly caps, mail and files between workers, the worker
 * tools, and recovery from a quit mid-turn. `runAgent` is faked for most of
 * these; the last test runs the real agent loop against a fake HTTP model.
 */

const WORKERS = 'workers.json'
const MODEL = { providerId: 'ollama', modelId: 'fake-model' }
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }

let service: WorkersService | null = null
let root = ''

beforeEach(() => {
  store.setJson(WORKERS, [])
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

// A turn's message opens with the local time on its own line ("[Tue, Sep 29,
// 7:30 PM]"); the assertions are about what follows it.
const text = (message: { parts: { type: string; text?: string }[] }): string =>
  message.parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('')
    .replace(/^\[[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}\s?[AP]M\]\n/, '')

/* ------------------------------------------------------------ creation */

test('a worker’s folder name is one Windows accepts', () => {
  assert.equal(workerSlug('Data Wrangler'), 'Data-Wrangler')
  assert.equal(workerSlug('Con'), '_Con')
  assert.equal(workerSlug('nul.txt'), '_nul.txt')
  assert.equal(workerSlug('COM1'), '_COM1')
  assert.equal(workerSlug('Console'), 'Console')
  assert.equal(workerSlug('Wait...'), 'Wait')
  assert.equal(workerSlug('...'), 'Worker')
})

test('creating a worker validates it, gives it a folder of its own, and caps the team', () => {
  const { engine } = start(fakeAgent().runAgent)
  const nova = engine.save(draft('  Nova  '))
  assert.equal(nova.name, 'Nova')
  assert.equal(nova.folder, join(root, 'Workers', 'Nova'))
  assert.ok(existsSync(nova.folder))
  assert.equal(nova.status, 'idle', 'awake and ready for its first job')
  assert.equal(nova.access, 'autonomous', 'new workers are trusted to act alone')
  assert.deepEqual(nova.heartbeat, { nextAt: null, everyMs: null, note: '' })
  assert.deepEqual([nova.routines, nova.goal, nova.notes, nova.asks], [[], '', '', []])
  assert.deepEqual(nova.model, MODEL)

  assert.throws(() => engine.save(draft('   ')), /name/)
  assert.throws(() => engine.save(draft('NOVA')), /already a worker called/)
  assert.equal(engine.save(draft('Data Wrangler')).folder, join(root, 'Workers', 'Data-Wrangler'))

  const edited = engine.save({ ...draft('Nova'), id: nova.id, purpose: 'Research papers', color: '#E4574B' })
  assert.equal(edited.purpose, 'Research papers')
  assert.equal(edited.folder, nova.folder, 'renaming or editing never moves the folder')

  for (let i = engine.list().length; i < MAX_WORKERS; i++) engine.save(draft(`W${i}`))
  assert.throws(() => engine.save(draft('One too many')), new RegExp(`up to ${MAX_WORKERS}`))
})

/* ---------------------------------------------------------------- turns */

test('a message from the user runs one turn on the worker’s thread, as the worker', async () => {
  Notification.supported = true
  const agent = fakeAgent('Done — found three sources.')
  const { engine, sent } = start(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  engine.send(nova.id, 'Find sources on tidal power', ['/tmp/chart.png'])
  await until(() => agent.requests.length === 1)
  await engine.whenIdle()

  const request = agent.requests[0]
  assert.equal(request.mode, 'work')
  assert.equal(request.cwd, nova.folder)
  assert.equal(request.workerId, nova.id)
  assert.equal(request.chatId, `worker:${nova.id}`)
  assert.match(request.persona!, /^You are Nova, one of the user's Eaon Workers/)
  assert.match(request.persona!, /Personality: Calm/)
  assert.deepEqual(request.work, { swarm: false, plan: false })
  const asked = request.history[request.history.length - 1]
  assert.equal(text(asked), '[From the user] Find sources on tidal power')
  assert.match(asked.parts[0].type === 'text' ? asked.parts[0].text : '', /^\[\w{3}, \w{3} \d+, \d+:\d{2}\s?[AP]M\]\n/, 'each turn tells the worker the time')
  assert.deepEqual(asked.attachments, ['/tmp/chart.png'], 'user files reach the model as attachments')
  assert.equal(agent.options[0].unattended, 'autonomous')
  assert.equal(await agent.options[0].approver!('computer', {}), true, 'an autonomous worker was trusted to act')
  assert.equal(typeof agent.options[0].allowOnce, 'function', 'approved questions can let one call through')

  const thread = engine.getThread(nova.id)
  assert.equal(thread.messages.length, 2)
  assert.equal(thread.messages[0].mail![0].fromName, 'You')
  assert.equal(text(thread.messages[1]), 'Done — found three sources.')
  assert.equal(thread.messages[1].model, 'fake-model')

  const after = engine.list()[0]
  assert.equal(after.status, 'asleep', 'nothing scheduled and no mail: back to sleep')
  assert.equal(after.unread, 1)
  assert.equal(after.lastOutcome?.ok, true)
  assert.equal(after.activity, 'Done — found three sources.')
  assert.equal(after.runningMessageId, null)
  assert.equal(workerMood(after), 'happy')

  const channels = sent.map((s) => s.channel)
  assert.equal(channels.filter((c) => c === 'workers:message').length, 3, 'user message and placeholder at the start, the reply at the end')
  assert.ok(channels.includes('workers:event'))
  assert.equal(Notification.shown.length, 1)
  assert.equal(Notification.shown[0].options.title, 'Nova')
})

test('mail that arrives mid-turn waits for the next turn, and is read in one go', async () => {
  const agent = heldAgent()
  const { engine } = start(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  engine.send(nova.id, 'First')
  await until(() => agent.requests.length === 1)
  engine.send(nova.id, 'Second')
  engine.send(nova.id, 'Third')
  await settle()
  assert.equal(agent.requests.length, 1, 'never two turns at once')
  assert.equal(engine.list()[0].inbox.length, 2)
  agent.release()
  await until(() => agent.requests.length === 2)
  const asked = agent.requests[1].history[agent.requests[1].history.length - 1]
  assert.equal(text(asked), '[From the user] Second\n[From the user] Third')
  assert.equal(asked.mail!.length, 2)
  agent.release()
  await engine.whenIdle()
  assert.equal(engine.getThread(nova.id).messages.length, 4)
})

test(`at most two turns run at once, oldest waiting first`, async () => {
  const agent = heldAgent()
  const { engine } = start(agent.runAgent, { concurrency: 2 })
  const a = engine.save(draft('Ada'))
  const b = engine.save(draft('Bea'))
  const c = engine.save(draft('Cy'))
  engine.send(c.id, 'first in')
  engine.send(a.id, 'second in')
  engine.send(b.id, 'third in')
  await until(() => agent.requests.length === 2)
  await settle()
  assert.equal(agent.requests.length, 2)
  assert.deepEqual(
    agent.requests.map((r) => r.workerId),
    [c.id, a.id]
  )
  agent.release()
  await until(() => agent.requests.length === 3)
  assert.equal(agent.requests[2].workerId, b.id)
  agent.release()
  agent.release()
  await engine.whenIdle()
})

test('a due heartbeat that cannot start yet waits quietly instead of spinning the timer', async () => {
  const agent = heldAgent()
  const { engine } = start(agent.runAgent, { concurrency: 2 })
  const a = engine.save(draft('Ada'))
  const b = engine.save(draft('Bea'))
  const c = engine.save(draft('Cy'))
  engine.send(a.id, 'busy')
  engine.send(b.id, 'busy')
  await until(() => agent.requests.length === 2)
  // Both slots are taken; Cy's heartbeat comes due and has to wait.
  engine.setHeartbeat(c.id, { inMinutes: 1, note: 'check' })
  // Bring it due now; `list()` hands out copies, so reach the engine's own.
  const internal = (engine as unknown as { workers: { id: string; heartbeat: { nextAt: number | null } }[] }).workers
  internal.find((w) => w.id === c.id)!.heartbeat.nextAt = Date.now() - 1
  let ticks = 0
  const tick = engine.tick.bind(engine)
  engine.tick = () => {
    ticks++
    tick()
  }
  engine.tick()
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.ok(ticks < 5, `ticked ${ticks} times in 60 ms while blocked`)
  assert.equal(agent.requests.length, 2)
  agent.release()
  // A freed slot goes to the waiting heartbeat.
  await until(() => agent.requests.length === 3)
  assert.equal(agent.requests[2].workerId, c.id)
  agent.release()
  agent.release()
  await engine.whenIdle()
})

test('a failed turn shows the dead face; the next message tries again', async () => {
  let fail = true
  const agent = fakeAgent(async (request, emit) => {
    if (fail) {
      emit({ type: 'error', messageId: request.messageId, error: 'Model unreachable' })
      return { text: '', usage, error: 'Model unreachable' }
    }
    emit({ type: 'delta', messageId: request.messageId, text: 'Back on it.' })
    return { text: 'Back on it.', usage }
  })
  const { engine } = start(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  engine.send(nova.id, 'Go')
  await until(() => agent.requests.length === 1)
  await engine.whenIdle()
  let now = engine.list()[0]
  assert.equal(now.status, 'failed')
  assert.equal(now.lastError, 'Model unreachable')
  assert.equal(workerMood(now), 'dead')
  assert.equal(engine.getThread(nova.id).messages[1].error, 'Model unreachable')

  fail = false
  engine.send(nova.id, 'Try again')
  await until(() => agent.requests.length === 2)
  await engine.whenIdle()
  now = engine.list()[0]
  assert.equal(now.status, 'asleep')
  assert.equal(now.lastError, null)
})

test('a worker with no usable model fails its turn with a reason, instead of hanging', async () => {
  const agent = fakeAgent()
  const { engine } = start(agent.runAgent)
  const nova = engine.save(draft('Nova', { model: { providerId: 'no-such-provider', modelId: 'x' } }))
  engine.send(nova.id, 'Hello')
  await until(() => engine.list()[0].status === 'failed')
  await engine.whenIdle()
  assert.equal(agent.requests.length, 0)
  assert.match(engine.list()[0].lastError!, /This worker's model provider/)
})

/* ---------------------------------------------------------- heartbeats */

test('heartbeats: a worker schedules its own wake-ups, a steady beat repeats, and it can stop', async () => {
  let clock = Date.parse('2026-09-29T10:00:00Z')
  let plan: 'every' | 'nothing' | 'stop' = 'every'
  const agent = fakeAgent(async (request, emit) => {
    if (plan === 'every') service!.engine.setHeartbeat(request.workerId!, { everyMinutes: 1, note: 'check the training loss' })
    if (plan === 'stop') service!.engine.setHeartbeat(request.workerId!, { stop: true })
    emit({ type: 'delta', messageId: request.messageId, text: 'Loss is 0.42.' })
    return { text: 'Loss is 0.42.', usage }
  })
  const { engine } = start(agent.runAgent, { now: () => clock })
  const nova = engine.save(draft('Nova'))
  engine.send(nova.id, 'Watch the training run')
  await until(() => agent.requests.length === 1)
  await engine.whenIdle()
  let now = engine.list()[0]
  assert.deepEqual(now.heartbeat, { nextAt: clock + 60_000, everyMs: 60_000, note: 'check the training loss' })
  assert.equal(now.status, 'idle', 'something scheduled: awake, not asleep')

  plan = 'nothing'
  clock += 61_000
  engine.tick()
  await until(() => agent.requests.length === 2)
  await engine.whenIdle()
  const woke = agent.requests[1].history[agent.requests[1].history.length - 1]
  assert.equal(text(woke), '[Heartbeat] You scheduled this wake-up: "check the training loss".')
  assert.equal(engine.getThread(nova.id).messages[2].heartbeat, 'check the training loss')
  now = engine.list()[0]
  assert.equal(now.heartbeat.nextAt, clock + 60_000, 'a steady beat carries on from the end of the turn')

  plan = 'stop'
  clock += 61_000
  engine.tick()
  await until(() => agent.requests.length === 3)
  await engine.whenIdle()
  now = engine.list()[0]
  assert.deepEqual(now.heartbeat, { nextAt: null, everyMs: null, note: '' })
  assert.equal(now.status, 'asleep')
})

test('a one-off heartbeat is spent when it fires; heartbeats are clamped to at least a minute', async () => {
  let clock = Date.parse('2026-09-29T10:00:00Z')
  const agent = fakeAgent('Checked.')
  const { engine } = start(agent.runAgent, { now: () => clock })
  const nova = engine.save(draft('Nova'))
  const said = engine.setHeartbeat(nova.id, { inMinutes: 0.1, note: 'look at the deploy' })
  assert.match(said, /Adjusted/)
  assert.equal(engine.list()[0].heartbeat.nextAt, clock + 60_000)
  clock += 60_000
  engine.tick()
  await until(() => agent.requests.length === 1)
  await engine.whenIdle()
  assert.deepEqual(engine.list()[0].heartbeat, { nextAt: null, everyMs: null, note: '' })
  assert.throws(() => engine.setHeartbeat(nova.id, { note: 'when?' }), /Say when/)
})

test('a heartbeat missed while Eaon was closed runs once on launch, not as a burst', async () => {
  const clock = Date.parse('2026-09-29T15:00:00Z')
  const seed = createSeedWorker({ heartbeat: { nextAt: clock - 5 * 3_600_000, everyMs: 60_000, note: 'poll' }, status: 'idle' })
  store.setJson(WORKERS, [seed])
  const agent = fakeAgent('Polled.')
  const { engine } = start(agent.runAgent, { now: () => clock })
  await until(() => agent.requests.length === 1)
  await engine.whenIdle()
  await settle()
  assert.equal(agent.requests.length, 1)
  assert.equal(engine.list()[0].heartbeat.nextAt, clock + 60_000)
})

test('self-caused wake-ups past the hourly cap wait; the user still gets through', async () => {
  let clock = Date.parse('2026-09-29T10:00:00Z')
  const agent = fakeAgent('Tick.')
  const { engine } = start(agent.runAgent, { now: () => clock, maxTurnsPerHour: 2 })
  const nova = engine.save(draft('Nova'))
  engine.setHeartbeat(nova.id, { everyMinutes: 1, note: 'poll' })
  for (let i = 1; i <= 2; i++) {
    clock += 61_000
    engine.tick()
    await until(() => agent.requests.length === i)
    await engine.whenIdle()
  }
  clock += 61_000
  engine.tick()
  await settle()
  assert.equal(agent.requests.length, 2, 'the third heartbeat in an hour waits')
  assert.match(engine.list()[0].activity, /^Resting/)
  engine.send(nova.id, 'Are you there?')
  await until(() => agent.requests.length === 3)
  await engine.whenIdle()
  const asked = agent.requests[2].history[agent.requests[2].history.length - 1]
  assert.match(text(asked), /\[Heartbeat\][\s\S]*\[From the user\] Are you there\?/, 'the waiting heartbeat rides along with the user’s turn')
})

/* ------------------------------------------------------------- teamwork */

test('workers get their tools only on their own turns', () => {
  const { engine } = start(fakeAgent().runAgent)
  const ada = engine.save(draft('Ada'))
  const settings = store.getSettings()
  const query = (request: Partial<StreamRequest>, extra: Partial<ToolQuery> = {}): string[] =>
    toolsFor({ mode: 'work', cwd: ada.folder, depth: 0, readOnly: false, settings, request: { work: { swarm: false, plan: false }, goal: null, history: [], ...request } as StreamRequest, ...extra }).map((t) => t.name)
  const names = query({ workerId: ada.id })
  for (const name of ['list_workers', 'message_worker', 'check_worker', 'set_heartbeat', 'set_status', 'create_worker']) assert.ok(names.includes(name), name)
  assert.ok(!query({}).includes('message_worker'), 'not in an ordinary chat')
  assert.ok(!query({ workerId: ada.id }, { depth: 1 }).includes('message_worker'), 'not in a sub-agent')
  assert.ok(!query({ workerId: 'gone' }).includes('message_worker'), 'not for a worker that no longer exists')
})

test('workers hand each other work: files land in the colleague’s folder and the mail wakes it', async () => {
  const agent = fakeAgent('Plotted it — see plot.png.')
  const { engine } = start(agent.runAgent)
  const ada = engine.save(draft('Ada', { color: '#8E5CE6' }))
  const bea = engine.save(draft('Bea'))
  const tools = Object.fromEntries(
    workersToolSource(engine)
      .tools({ mode: 'work', cwd: ada.folder, depth: 0, readOnly: false, settings: store.getSettings(), request: { workerId: ada.id } as StreamRequest })
      .map((t) => [t.name, t])
  )
  const ctx = { request: { workerId: ada.id } } as unknown as ToolContext

  const listed = String(await tools.list_workers.run({}, ctx))
  assert.match(listed, /- Bea: Bea's job/)
  assert.doesNotMatch(listed, /- Ada/)

  writeFileSync(join(ada.folder, 'data.csv'), 'x,y\n1,2\n')
  const result = String(await tools.message_worker.run({ to: 'bea', message: 'Mind plotting this for me?', files: ['data.csv'] }, ctx))
  const delivered = join(bea.folder, 'from-Ada', 'data.csv')
  assert.match(result, /Sent to Bea/)
  assert.ok(result.includes(delivered))
  assert.equal(readFileSync(delivered, 'utf8'), 'x,y\n1,2\n')

  await until(() => agent.requests.length === 1)
  await engine.whenIdle()
  const asked = agent.requests[0].history[agent.requests[0].history.length - 1]
  assert.equal(agent.requests[0].workerId, bea.id)
  assert.equal(text(asked), `[From Ada, a fellow worker] Mind plotting this for me?\nFiles (copied into your folder): ${delivered}`)
  assert.equal(asked.mail![0].fromColor, '#8E5CE6')
  assert.equal(asked.attachments, undefined, 'a colleague’s files are in the folder, not attached')

  const checked = String(await tools.check_worker.run({ name: 'Bea' }, ctx))
  assert.match(checked, /Latest reply:\nPlotted it — see plot\.png\./)

  await assert.rejects(() => tools.message_worker.run({ to: 'Ada', message: 'hi me' }, ctx) as Promise<unknown>, /That is you/)
  await assert.rejects(() => tools.message_worker.run({ to: 'Zed', message: 'hi' }, ctx) as Promise<unknown>, /no worker called "Zed"/)
  await assert.rejects(() => tools.message_worker.run({ to: 'Bea', message: 'x', files: ['missing.txt'] }, ctx) as Promise<unknown>, /does not exist/)
})

test('set_status sets the card line and a mood; the turn keeps it rather than summarising', async () => {
  const agent = fakeAgent(async (request, emit) => {
    service!.engine.setStatus(request.workerId!, 'Epoch 3/10 — loss 0.42', 'serious')
    emit({ type: 'delta', messageId: request.messageId, text: 'All fine.' })
    return { text: 'All fine.', usage }
  })
  const { engine } = start(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  engine.send(nova.id, 'How is training going?')
  await until(() => agent.requests.length === 1)
  await engine.whenIdle()
  const now = engine.list()[0]
  assert.equal(now.activity, 'Epoch 3/10 — loss 0.42')
  assert.equal(now.moodHint?.mood, 'serious')
  assert.equal(workerMood(now), 'serious')
})

test('workers can create workers, but rarely', async () => {
  const agent = fakeAgent('On it.')
  const { engine } = start(agent.runAgent)
  const ada = engine.save(draft('Ada', { access: 'safe' }))
  const create = (name: string, reason = 'Nobody handles video.') =>
    engine.createByWorker(ada.id, { name, personality: 'Quiet', purpose: 'Edit videos', firstTask: 'Cut the intro.', reason })
  assert.throws(() => create('Vee', ''), /why/)
  const vee = create('Vee')
  assert.equal(vee.createdBy, ada.id)
  assert.deepEqual(vee.model, ada.model, 'runs on its creator’s model')
  assert.ok(existsSync(vee.folder))
  await until(() => agent.requests.length === 1)
  const asked = agent.requests[0].history[agent.requests[0].history.length - 1]
  assert.equal(text(asked), '[From Ada, a fellow worker] Cut the intro.')
  assert.match(agent.requests[0].persona!, /Ada, a fellow worker, created you/)
  create('Wes')
  assert.throws(() => create('Xan'), /already created 2 workers/)
  await engine.whenIdle()
})

/* --------------------------------------------------------- user controls */

test('pausing stops a running turn and holds mail until resumed', async () => {
  const agent = heldAgent()
  const { engine } = start(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  engine.send(nova.id, 'Long job')
  await until(() => agent.requests.length === 1)
  engine.setPaused(nova.id, true)
  await engine.whenIdle()
  assert.equal(engine.list()[0].status, 'paused')
  assert.equal(workerMood(engine.list()[0]), 'asleep')
  engine.send(nova.id, 'Another')
  await settle()
  assert.equal(agent.requests.length, 1, 'paused workers read nothing')
  assert.throws(() => engine.wake(nova.id), /paused/)
  engine.setPaused(nova.id, false)
  await until(() => agent.requests.length === 2)
  agent.release()
  await engine.whenIdle()
  assert.equal(engine.list()[0].status, 'asleep')
})

test('stop ends only the running turn; wake runs a check-in', async () => {
  const agent = heldAgent()
  const { engine } = start(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  engine.send(nova.id, 'Long job')
  await until(() => agent.requests.length === 1)
  engine.stopTurn(nova.id)
  await engine.whenIdle()
  assert.equal(engine.list()[0].activity, 'Stopped')
  assert.notEqual(engine.list()[0].status, 'failed')
  engine.wake(nova.id)
  await until(() => agent.requests.length === 2)
  const asked = agent.requests[1].history[agent.requests[1].history.length - 1]
  assert.equal(text(asked), '[Check-in] The user asked you to check in now.')
  agent.release()
  await engine.whenIdle()
})

test('clear empties the thread; remove forgets the worker and deletes its thread file', async () => {
  const agent = fakeAgent('Hi.')
  const { engine } = start(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  engine.send(nova.id, 'Hello')
  await until(() => agent.requests.length === 1)
  await engine.whenIdle()
  engine.markRead(nova.id)
  assert.equal(engine.list()[0].unread, 0)
  engine.clear(nova.id)
  assert.deepEqual(engine.getThread(nova.id).messages, [])
  await store.flushWrites()
  const file = join(app.getPath('userData'), 'store', `worker-${nova.id}.json`)
  assert.ok(existsSync(file))
  await engine.remove(nova.id)
  assert.equal(engine.list().length, 0)
  assert.ok(!existsSync(file))
  assert.ok(existsSync(nova.folder), 'its folder and work stay on disk')
  assert.throws(() => engine.getThread(nova.id), /no longer exists/)
})

/* -------------------------------------------------------------- recovery */

function createSeedWorker(extra: Partial<Worker> = {}): Worker {
  const folder = join(root, 'Workers', 'Seed')
  return {
    id: 'seed-1',
    name: 'Seed',
    color: '#3FAE6A',
    personality: '',
    purpose: 'Testing',
    createdAt: Date.parse('2026-09-01T00:00:00Z'),
    createdBy: null,
    model: MODEL,
    folder,
    paused: false,
    access: 'safe',
    heartbeat: { nextAt: null, everyMs: null, note: '' },
    status: 'asleep',
    activity: '',
    moodHint: null,
    lastRunAt: null,
    lastOutcome: null,
    lastError: null,
    inbox: [],
    unread: 0,
    runningMessageId: null,
    ...extra
  }
}

test('a turn cut off by a quit is sealed and recorded at the next launch', async () => {
  store.setJson(WORKERS, [createSeedWorker({ status: 'working', runningMessageId: 'm2' })])
  const tool: ChatToolPart = { type: 'tool', id: 't1', name: 'run_command', input: {}, output: null, status: 'running', progress: 'building…' }
  store.setJson('worker-seed-1.json', {
    workerId: 'seed-1',
    summary: null,
    messages: [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: '[From the user] build it' }], createdAt: 1 },
      { id: 'm2', role: 'assistant', parts: [tool], createdAt: 2 }
    ]
  })
  const { engine } = start(fakeAgent().runAgent)
  const seed = engine.list()[0]
  assert.equal(seed.status, 'idle')
  assert.equal(seed.runningMessageId, null)
  assert.equal(seed.lastError, 'Interrupted when Eaon quit')
  const part = engine.getThread('seed-1').messages[1].parts[0] as ChatToolPart
  assert.equal(part.status, 'error')
  assert.equal(part.progress, undefined)
})

test('quitting mid-turn records the interruption before the process goes', async () => {
  const agent = heldAgent()
  const { engine } = start(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  engine.send(nova.id, 'Long job')
  await until(() => agent.requests.length === 1)
  service!.stop()
  await engine.whenIdle()
  const saved = store.getJson<Worker[]>(WORKERS, [])[0]
  assert.equal(saved.status, 'idle')
  assert.equal(saved.runningMessageId, null)
  assert.equal(saved.lastError, 'Interrupted when Eaon quit')
  service = null
})

/* ------------------------------------------- the real agent loop, fake model */

test('real loop: a worker speaks as itself and schedules its own heartbeat', async () => {
  const { url, server, requests } = await sseServer((body) => {
    const toolTurns = (body.messages as { role: string }[]).filter((m) => m.role === 'tool').length
    if (toolTurns === 0) {
      const args = JSON.stringify({ every_minutes: 1, note: 'check the loss' })
      return [chunk({ tool_calls: [{ index: 0, id: 'h1', function: { name: 'set_heartbeat', arguments: args } }] }), chunk({}, 'tool_calls'), '[DONE]']
    }
    return [chunk({ content: 'Watching the run.' }), chunk({}, 'stop'), '[DONE]']
  })
  try {
    store.saveProviderConfig({
      fake: { name: 'Fake', kind: 'openai-compatible', baseUrl: url, enabled: true, models: [{ id: 'fake-1', label: 'Fake 1', providerId: 'fake' }] }
    })
    secrets.set('fake', 'test-key')
    const { ctx } = fakeContext()
    // No runAgent override: the real loop, tools and approval policy.
    service = createWorkersService(ctx, { startDelayMs: 60_000 })
    service.start()
    service.engine.start()
    const engine = service.engine
    const nova = engine.save(draft('Nova', { model: { providerId: 'fake', modelId: 'fake-1' } }))
    engine.send(nova.id, 'Keep an eye on the training run')
    await until(() => engine.list()[0]?.status !== 'working' && requests.length >= 2, 10_000)
    await engine.whenIdle()

    const offered = ((requests[0].tools as { function: { name: string } }[]) ?? []).map((t) => t.function.name)
    for (const name of ['set_heartbeat', 'message_worker', 'list_workers', 'write_file']) assert.ok(offered.includes(name), name)
    const system = JSON.stringify((requests[0].messages as unknown[])[0])
    assert.match(system, /You are Nova, one of the user's Eaon Workers/)
    assert.doesNotMatch(system, /You are Eaon, the user's assistant/)

    const after = engine.list()[0]
    assert.equal(after.heartbeat.everyMs, 60_000)
    assert.equal(after.heartbeat.note, 'check the loss')
    assert.equal(after.status, 'idle')
    const reply = engine.getThread(nova.id).messages[1]
    const call = reply.parts.find((p): p is ChatToolPart => p.type === 'tool')!
    assert.equal(call.name, 'set_heartbeat')
    assert.equal(call.status, 'done')
    assert.equal(text(reply), 'Watching the run.')
    assert.equal(after.activity, 'Watching the run.')
  } finally {
    server.close()
  }
})

/* ------------------------------------------------------------ autonomy */

test('a Careful worker has nobody to approve risky steps; a Look-only one only looks', async () => {
  const agent = fakeAgent()
  const { engine } = start(agent.runAgent)
  const careful = engine.save(draft('Careful', { access: 'safe' }))
  const looker = engine.save(draft('Looker', { access: 'read-only' }))
  engine.send(careful.id, 'go')
  engine.send(looker.id, 'go')
  await until(() => agent.requests.length === 2)
  await engine.whenIdle()
  const byWorker = new Map(agent.requests.map((r, i) => [r.workerId, agent.options[i]]))
  assert.equal(byWorker.get(careful.id)!.unattended, 'safe')
  assert.equal(await byWorker.get(careful.id)!.approver!('computer', {}), false)
  assert.equal(byWorker.get(looker.id)!.unattended, 'read-only')
})

test('heartbeats: in_minutes 0 means as soon as possible, and a clock time works', () => {
  const { engine } = start(fakeAgent().runAgent)
  const nova = engine.save(draft('Nova'))
  const soon = engine.setHeartbeat(nova.id, { inMinutes: 0, note: 'send the test message' })
  assert.match(soon, /Heartbeat set: next wake-up/)
  const beat = engine.list()[0].heartbeat
  assert.ok(beat.nextAt! - Date.now() <= 61_000 && beat.nextAt! - Date.now() >= 59_000, 'the soonest is one minute')
  const at = Date.now() + 90 * 60_000
  engine.setHeartbeat(nova.id, { at, note: 'later' })
  assert.ok(Math.abs(engine.list()[0].heartbeat.nextAt! - at) < 1000)
  assert.throws(() => engine.setHeartbeat(nova.id, { note: 'when?' }), /in_minutes \(0 = as soon as possible\)/)
})

test('parseWakeTime reads clock times (today, or tomorrow once passed) and ISO date-times', async () => {
  const { parseWakeTime } = await import('../src/main/features/workers/tools')
  const now = new Date(2026, 8, 30, 14, 0).getTime()
  assert.equal(new Date(parseWakeTime('15:30', now)!).getHours(), 15)
  assert.equal(new Date(parseWakeTime('2:05 PM', now)!).getMinutes(), 5)
  assert.equal(new Date(parseWakeTime('9am', now)!).getDate(), 1, '9am has passed: tomorrow')
  assert.equal(parseWakeTime('2026-10-02T08:00:00', now), new Date(2026, 9, 2, 8, 0).getTime())
  assert.equal(parseWakeTime('whenever', now), null)
  assert.equal(parseWakeTime('25:00', now), null)
})

test('routines: several named schedules; a due one wakes the worker with its task, then comes round again', async () => {
  const agent = fakeAgent('Checked.')
  const { engine } = start(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  assert.match(engine.addRoutine(nova.id, { name: 'Morning brief', task: 'Summarise overnight mail', daily: '08:30' }), /daily at 08:30/)
  assert.match(engine.addRoutine(nova.id, { name: 'Deploy watch', task: 'Check the deploy', everyMinutes: 30 }), /every 30 min/)
  assert.throws(() => engine.addRoutine(nova.id, { name: 'x', task: 'y' }), /how often/)
  assert.throws(() => engine.addRoutine(nova.id, { name: 'x', task: 'y', daily: '8.30' }), /24-hour/)
  assert.equal(engine.list()[0].routines.length, 2)
  assert.equal(engine.list()[0].status, 'idle', 'something scheduled: awake, not asleep')

  // Bring the deploy watch due now.
  const internal = (engine as unknown as { workers: Worker[] }).workers
  const routine = internal[0].routines.find((r) => r.name === 'Deploy watch')!
  routine.nextAt = Date.now() - 1
  engine.tick()
  await until(() => agent.requests.length === 1)
  await engine.whenIdle()
  assert.equal(text(agent.requests[0].history.at(-1)!), '[Routine "Deploy watch"] Check the deploy')
  assert.match(agent.requests[0].persona!, /Your routines:\n- Morning brief \(daily at 08:30\)/)
  const after = engine.list()[0].routines.find((r) => r.name === 'Deploy watch')!
  assert.equal(after.runs.length, 1)
  assert.ok(after.nextAt > Date.now() + 29 * 60_000, 'comes round again in 30 minutes')

  assert.match(engine.removeRoutine(nova.id, 'deploy watch'), /Removed/)
  assert.deepEqual(engine.list()[0].routines.map((r) => r.name), ['Morning brief'])
})

test('goal and notes are the worker\'s own memory: in its prompt every turn, capped, oldest notes first to go', async () => {
  const agent = fakeAgent()
  const { engine } = start(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  engine.setMemory(nova.id, { goal: 'Ship the landing page by Friday' })
  engine.setMemory(nova.id, { appendNote: 'User prefers short updates' })
  engine.setMemory(nova.id, { appendNote: 'Staging URL is staging.example.com' })
  engine.send(nova.id, 'Status?')
  await until(() => agent.requests.length === 1)
  await engine.whenIdle()
  const persona = agent.requests[0].persona!
  assert.match(persona, /Your goal: Ship the landing page by Friday/)
  assert.match(persona, /Your notes:\n- User prefers short updates\n- Staging URL is staging.example.com/)

  for (let i = 0; i < 200; i++) engine.setMemory(nova.id, { appendNote: `note number ${i} `.padEnd(60, '.') })
  const notes = engine.list()[0].notes
  assert.ok(notes.length <= 4000)
  assert.match(notes, /note number 199/, 'the newest note stays')
  assert.doesNotMatch(notes, /User prefers short updates/, 'the oldest went first')
})

test('ask_user does not block; approving lets exactly that call through once, and the answer arrives as mail', async () => {
  Notification.supported = true
  const agent = fakeAgent('Carrying on.')
  const { engine } = start(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  const buy = { action: 'click', ref: 12 }
  const ask = engine.ask(nova.id, { question: 'Buy the domain for $12?', options: ['Yes', 'No'], approve: { tool: 'browser', input: buy, summary: 'Buy eaon-demo.com' } })
  assert.equal(engine.list()[0].asks.length, 1)
  assert.equal(engine.list()[0].unread, 1)
  assert.match(describeText(engine.list()[0]), /question for you/)
  assert.ok(Notification.shown.some((n) => /Nova has a question/.test(n.options.title)), 'reached the user as a notification')

  assert.equal(engine.allowOnce(nova.id, 'browser', buy), false, 'not before the user answers')
  engine.answer(nova.id, ask.id, { approved: true })
  assert.equal(engine.list()[0].asks.length, 0)
  // Key order does not matter; the same call matches.
  assert.equal(engine.allowOnce(nova.id, 'browser', { ref: 12, action: 'click' }), true)
  assert.equal(engine.allowOnce(nova.id, 'browser', buy), false, 'spent after one use')
  assert.equal(engine.allowOnce(nova.id, 'browser', { action: 'click', ref: 13 }), false, 'only that exact call')

  await until(() => agent.requests.length === 1)
  await engine.whenIdle()
  assert.match(text(agent.requests[0].history.at(-1)!), /\[Answer to "Buy the domain for \$12\?"\] Approved: Buy eaon-demo.com/)
  assert.throws(() => engine.answer(nova.id, ask.id, { text: 'again' }), /already answered/)
})

test('an approval asked for by a namespaced tool name still lets the real call through', () => {
  // GPT-style models call tools "functions.<name>" in approve_tool (Oct 1 2026: "functions.email_send"
  // was approved, the real call email_send was then refused as unapproved). Gemini says "default_api.".
  const { engine } = start(fakeAgent().runAgent)
  const nova = engine.save(draft('Nova'))
  const email = { to: ['me@example.com'], subject: 'Bill reminder: Acme due today', text: 'Hi,\n\nThe Acme bill of $20 is due today.\n\n— nova' }
  for (const asked of ['functions.email_send', 'default_api.email_send', ' email_send ']) {
    const ask = engine.ask(nova.id, { question: 'Send the reminder?', approve: { tool: asked, input: email, summary: 'Send the bill reminder' } })
    engine.answer(nova.id, ask.id, { approved: true })
    assert.equal(engine.allowOnce(nova.id, 'email_send', email), true, asked)
    assert.equal(engine.allowOnce(nova.id, 'email_send', email), false, `${asked}: spent after one use`)
  }
  // And the other way round: a loop that reports the call with a prefix still finds the grant.
  const ask = engine.ask(nova.id, { question: 'Send it?', approve: { tool: 'email_send', input: email, summary: 'Send' } })
  engine.answer(nova.id, ask.id, { approved: true })
  assert.equal(engine.allowOnce(nova.id, 'functions.email_send', email), true)
  // A different tool is still a different tool.
  const other = engine.ask(nova.id, { question: 'Reply?', approve: { tool: 'functions.email_reply', input: email, summary: 'Reply' } })
  engine.answer(nova.id, other.id, { approved: true })
  assert.equal(engine.allowOnce(nova.id, 'email_send', email), false)
})

test('notify_user reaches out first: a notification and an unread mark', () => {
  Notification.supported = true
  const { engine } = start(fakeAgent().runAgent)
  const nova = engine.save(draft('Nova'))
  engine.reachOut(nova.id, 'Training finished', 'Final loss 0.21 — best run so far.')
  assert.equal(engine.list()[0].unread, 1)
  assert.ok(Notification.shown.some((n) => n.options.title === 'Training finished' && /0\.21/.test(n.options.body ?? '')))
})

test('workers get no scheduler tool (heartbeats and routines instead), and every autonomy tool', () => {
  const { engine } = start(fakeAgent().runAgent)
  const nova = engine.save(draft('Nova'))
  const settings = store.getSettings()
  const request = { chatId: `worker:${nova.id}`, workerId: nova.id, messageId: 'm', providerId: 'ollama', modelId: 'fake-model', effort: 'light', mode: 'work', history: [], summary: null, projectInstructions: '', cwd: nova.folder, work: { swarm: false, plan: false }, goal: null } as unknown as StreamRequest
  const names = toolsFor({ mode: 'work', cwd: nova.folder, depth: 0, readOnly: false, settings, request }).map((t) => t.name)
  assert.ok(!names.includes('schedule'), 'the app scheduler starts chats; workers schedule themselves')
  assert.ok(!names.includes('spawn_agents'), 'no swarm: colleagues are the swarm')
  for (const tool of ['set_heartbeat', 'add_routine', 'remove_routine', 'set_goal', 'update_notes', 'ask_user', 'notify_user', 'message_worker']) {
    assert.ok(names.includes(tool), `${tool} offered`)
  }
})

function describeText(worker: Worker): string {
  return describeWorker(worker)
}

/* ------------------------------------------------------------- trading */

test('a trading worker gets a Trading check that only runs while the market is open, kept in step with the editor', async () => {
  const agent = fakeAgent('Looked; nothing to do.')
  const { engine } = start(agent.runAgent)
  assert.throws(() => engine.save(draft('Quant', { trading: { via: '', strategy: 'x', everyMinutes: 15, autoPlace: false } })), /Pick where the worker trades/)
  const quant = engine.save(draft('Quant', { trading: { via: TRADING_DESK, strategy: 'Buy strength in mega caps.', everyMinutes: 15, autoPlace: true } }))
  let routine = quant.routines.find((r) => r.name === TRADING_ROUTINE_NAME)!
  assert.equal(routine.everyMs, 15 * 60_000)
  assert.equal(routine.marketHours, true)
  assert.ok(isOpen(routine.nextAt), 'scheduled inside market hours')

  // The editor changes the interval; the routine follows. Turning trading off removes it.
  routine = engine.save({ ...draft('Quant'), id: quant.id, trading: { via: TRADING_DESK, strategy: 'x', everyMinutes: 30, autoPlace: true } }).routines.find((r) => r.name === TRADING_ROUTINE_NAME)!
  assert.equal(routine.everyMs, 30 * 60_000)
  const off = engine.save({ ...draft('Quant'), id: quant.id, trading: null })
  assert.equal(off.trading, null)
  assert.equal(off.routines.length, 0)
  // Leaving trading out of a draft keeps it (a worker editing itself sends none).
  engine.save({ ...draft('Quant'), id: quant.id, trading: { via: TRADING_DESK, strategy: 'y', everyMinutes: 5, autoPlace: false } })
  assert.equal(engine.save({ ...draft('Quant'), id: quant.id }).trading!.strategy, 'y')
})

test('market-hours routines skip nights, weekends and holidays', () => {
  const every15 = { everyMs: 15 * 60_000, daily: null, marketHours: true }
  // Friday 3:50 PM ET (19:50 UTC in October): the next slot is past the close, so Monday's open.
  const friday = Date.parse('2026-10-02T19:50:00Z')
  assert.equal(new Date(routineNextAt(every15, friday)).toISOString(), '2026-10-05T13:31:00.000Z')
  // Mid-session, it is just 15 minutes on.
  const tuesday = Date.parse('2026-10-06T15:00:00Z')
  assert.equal(routineNextAt(every15, tuesday), tuesday + 15 * 60_000)
  // Without the flag nothing changes.
  assert.equal(routineNextAt({ ...every15, marketHours: false }, friday), friday + 15 * 60_000)
})

test('a trading worker’s prompt names its account, strategy, tools and whether it may place orders alone', async () => {
  const agent = fakeAgent('Checked.')
  const { engine } = start(agent.runAgent)
  const desk = engine.save(draft('Desk', { trading: { via: TRADING_DESK, strategy: 'Momentum in AAPL and NVDA.', everyMinutes: 15, autoPlace: false } }))
  engine.send(desk.id, 'hi')
  await until(() => agent.requests.length === 1)
  await engine.whenIdle()
  const persona = agent.requests[0].persona!
  assert.match(persona, /Trading — the user set you up to trade for them:/)
  assert.match(persona, /Account: the trading desk’s Simulator account \(practice money\)/)
  assert.match(persona, /Strategy: Momentum in AAPL and NVDA\./)
  assert.match(persona, /trading_order to buy or sell \(always with a stop_loss/)
  assert.match(persona, /Every order needs the user’s approval: ask_user with approve_tool/)
  assert.match(persona, /Trading check \(every 15 min, while the market is open\)/)

  // A broker plugin that isn't connected: it must not trade.
  store.saveMcpServers([{ id: 'plugin-robinhood', name: 'Robinhood', transport: 'http', command: '', args: [], env: {}, url: 'https://agent.robinhood.com/mcp/trading', enabled: true, official: false, pluginId: 'robinhood' }])
  const rh = engine.save(draft('Robin', { trading: { via: 'plugin-robinhood', strategy: '', everyMinutes: 30, autoPlace: true } }))
  engine.send(rh.id, 'hi')
  await until(() => agent.requests.length === 2)
  await engine.whenIdle()
  const second = agent.requests[1].persona!
  assert.match(second, /Account: Robinhood — REAL MONEY/)
  assert.match(second, /separate Robinhood agentic account/)
  assert.match(second, /Robinhood isn’t connected right now\. Don’t trade/)
  assert.match(second, /Strategy: none yet\. Ask the user for one/)
  assert.match(second, /You may place orders on your own/)
  store.saveMcpServers([])
})

test('broker plugins: orders wait for the user unless a worker was set up to place them, and the kill switch stops them', async () => {
  const agent = fakeAgent('Done.')
  const { engine } = start(agent.runAgent)
  store.saveMcpServers([
    { id: 'plugin-robinhood', name: 'Robinhood', transport: 'http', command: '', args: [], env: {}, url: 'https://agent.robinhood.com/mcp/trading', enabled: true, official: false, pluginId: 'robinhood' },
    { id: 'plugin-tradier-paper', name: 'Tradier paper', transport: 'http', command: '', args: [], env: {}, url: 'https://mcp.tradier.com/mcp', enabled: true, official: false, pluginId: 'tradier-paper' },
    { id: 'plugin-notion', name: 'Notion', transport: 'http', command: '', args: [], env: {}, url: 'https://mcp.notion.com/mcp', enabled: true, official: false, pluginId: 'notion' }
  ])
  try {
    const order = { name: 'place_equity_order', serverId: 'plugin-robinhood' }
    // Reads never wait, annotated or not.
    assert.equal(writesToBroker({ name: 'get_positions' }), false)
    assert.equal(writesToBroker({ name: 'account_balances' }), false)
    assert.equal(writesToBroker({ name: 'place_equity_order' }), true)
    assert.equal(writesToBroker({ name: 'place_equity_order', readOnly: true }), false)
    assert.equal(brokerOf('plugin-notion'), null)
    assert.deepEqual(brokerOf('plugin-tradier-paper'), { realMoney: false })

    // A chat: real money always asks; a practice account doesn't need to.
    assert.equal(brokerWriteNeedsUser(order, 'chat-1'), true)
    assert.equal(brokerWriteNeedsUser({ ...order, serverId: 'plugin-tradier-paper' }, 'chat-1'), false)
    assert.equal(brokerWriteNeedsUser({ name: 'create_page', serverId: 'plugin-notion' }, 'chat-1'), false, 'not a broker')

    // A worker set up to trade there: its own switch decides; any other worker asks.
    const free = engine.save(draft('Free', { trading: { via: 'plugin-robinhood', strategy: 's', everyMinutes: 15, autoPlace: true } }))
    const careful = engine.save(draft('Asker', { trading: { via: 'plugin-robinhood', strategy: 's', everyMinutes: 15, autoPlace: false } }))
    const other = engine.save(draft('Other'))
    assert.equal(brokerWriteNeedsUser(order, `worker:${free.id}`), false)
    assert.equal(brokerWriteNeedsUser(order, `worker:${careful.id}`), true)
    assert.equal(brokerWriteNeedsUser(order, `worker:${other.id}`), true)
    // A server the user added by hand counts as a broker once a worker trades through it.
    const custom = engine.save(draft('Custom', { trading: { via: 'my-kraken', strategy: 's', everyMinutes: 15, autoPlace: false } }))
    assert.deepEqual(brokerOf('my-kraken', `worker:${custom.id}`), { realMoney: true })

    setTradingHalted(() => true)
    assert.equal(tradingHalted(), true)
  } finally {
    setTradingHalted(() => false)
    store.saveMcpServers([])
  }
})


/* ------------------------------------------------------- mentions and goals */

test('@mentions: names match whole words, longest first, in the order written, never the worker itself', () => {
  const team = [
    { id: 'a', name: 'Nova' },
    { id: 'b', name: 'Nova Prime' },
    { id: 'c', name: 'Bea' },
    { id: 'd', name: 'Al' }
  ]
  const ids = (text: string, self: string | null = null): string[] => mentionedWorkers(text, team, self).map((w) => w.id)
  assert.deepEqual(ids('@bea and @Nova, look at this'), ['c', 'a'])
  assert.deepEqual(ids('ask @Nova Prime first'), ['b'], 'the longer name wins at the same spot')
  assert.deepEqual(ids('@Nova Prime then @nova'), ['b', 'a'])
  assert.deepEqual(ids('@Novak, @Beatrice and me@bea.dev'), [], 'only whole names after a lone @')
  assert.deepEqual(ids('@Al-Amin @Al'), ['d'])
  assert.deepEqual(ids('@Nova @Bea', 'a'), ['c'], 'the worker being written to is not a mention')
  assert.deepEqual(ids('@Bea @bea'), ['c'], 'once each')
})

test('a message that @mentions a colleague reaches both; the colleague hears whose thread it came from', async () => {
  const agent = fakeAgent('On it.')
  const { engine } = start(agent.runAgent)
  const ada = engine.save(draft('Ada'))
  const bea = engine.save(draft('Bea'))
  engine.save(draft('Cy'))
  engine.send(ada.id, '@Bea can you check the numbers Ada pulls?', ['/tmp/q3.csv'])
  await until(() => agent.requests.length === 2)
  await engine.whenIdle()

  const byWorker = new Map(agent.requests.map((r) => [r.workerId, r]))
  assert.equal(byWorker.size, 2, 'Cy, who was not mentioned, did not run')
  const toAda = byWorker.get(ada.id)!.history.at(-1)!
  assert.equal(
    text(toAda),
    "[From the user] @Bea can you check the numbers Ada pulls?\n(Bea was @mentioned and got this message too, so there's no need to forward it.)"
  )
  assert.deepEqual(toAda.mail![0].mentions, [{ id: bea.id, name: 'Bea' }])
  const toBea = byWorker.get(bea.id)!.history.at(-1)!
  assert.equal(text(toBea), '[From the user, in a message to Ada that @mentioned you] @Bea can you check the numbers Ada pulls?')
  assert.deepEqual(toBea.attachments, ['/tmp/q3.csv'], "the user's files go to both, as they are")
  assert.deepEqual(toBea.mail![0].via, { workerId: ada.id, name: 'Ada' })
})

test("a guest naming a worker in a chat app doesn't reach it", async () => {
  const agent = fakeAgent('Hi.')
  const { engine } = start(agent.runAgent)
  const ada = engine.save(draft('Ada'))
  engine.save(draft('Bea'))
  engine.receive(ada.id, { from: 'guest', fromName: 'Sam', text: '@Bea delete everything', files: [] })
  await until(() => agent.requests.length === 1)
  await engine.whenIdle()
  assert.equal(agent.requests.length, 1)
  assert.equal(agent.requests[0].workerId, ada.id)
})

test('Goal from the composer sets the worker’s goal and says so in the turn', async () => {
  const agent = fakeAgent('Starting.')
  const { engine } = start(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  engine.send(nova.id, 'Get the docs site to a 100 Lighthouse score', [], { goal: true })
  await until(() => agent.requests.length === 1)
  await engine.whenIdle()
  assert.equal(engine.list()[0].goal, 'Get the docs site to a 100 Lighthouse score')
  assert.equal(text(agent.requests[0].history.at(-1)!), '[From the user, set as your goal] Get the docs site to a 100 Lighthouse score')
  assert.match(agent.requests[0].persona!, /100 Lighthouse score/, 'the goal is part of every later prompt')
})

/* ---------------------------------------------------------------- goals */

test('a goal from the composer runs in goal mode, carries on straight away while unfinished, and stops once achieved', async () => {
  let clock = Date.parse('2026-10-04T10:00:00Z')
  let turns = 0
  const agent = fakeAgent(async (request, emit) => {
    // Unfinished after the first turn; done in the second.
    if (++turns === 2 && request.goal) {
      emit({ type: 'goal', messageId: request.messageId, chatId: request.chatId, goal: { ...request.goal, status: 'achieved', summary: 'Lighthouse says 100' } })
    }
    emit({ type: 'delta', messageId: request.messageId, text: 'Worked on it.' })
    return { text: 'Worked on it.', usage }
  })
  const { engine } = start(agent.runAgent, { now: () => clock })
  const nova = engine.save(draft('Nova'))
  engine.send(nova.id, 'Get the docs site to a 100 Lighthouse score', [], { goal: true })
  // No time passes: an unfinished goal turn is followed by the next at once.
  await until(() => agent.requests.length === 2)
  await engine.whenIdle()
  assert.deepEqual(agent.requests[0].goal, { text: 'Get the docs site to a 100 Lighthouse score', status: 'active', iterations: 0 }, 'the turn runs in goal mode')
  assert.equal(agent.requests[1].goal?.status, 'active', 'unfinished: it picked the goal up again by itself, without waiting')
  assert.match(text(agent.requests[1].history.at(-1)!), /^\[Goal\] Keep working toward your goal: "Get the docs site to a 100 Lighthouse score"/)
  assert.equal(engine.getThread(nova.id).messages[2].heartbeat, 'Continuing toward its goal')
  const now = engine.list()[0]
  assert.equal(now.goalRun?.status, 'achieved')
  assert.equal(now.goalRun?.summary, 'Lighthouse says 100')
  assert.equal(now.goalRun?.turns, 2)
  assert.equal(now.goalRun?.nextAt ?? null, null)

  clock += 10 * 60_000
  engine.tick()
  await engine.whenIdle()
  assert.equal(agent.requests.length, 2, 'nothing more once it is achieved')
})

test('a worker that sleeps during its goal wakes when it said, with its note, and carries on in goal mode', async () => {
  let clock = Date.parse('2026-10-04T10:00:00Z')
  let turns = 0
  const agent = fakeAgent(async (request, emit) => {
    turns++
    if (turns === 1) service!.engine.sleep(request.workerId!, 30, 'wait for the CI run')
    // Done on the turn after it wakes.
    if (turns === 3 && request.goal) emit({ type: 'goal', messageId: request.messageId, chatId: request.chatId, goal: { ...request.goal, status: 'achieved', summary: 'CI is green' } })
    emit({ type: 'delta', messageId: request.messageId, text: 'Waiting on CI.' })
    return { text: 'Waiting on CI.', usage }
  })
  const { engine } = start(agent.runAgent, { now: () => clock })
  const nova = engine.save(draft('Nova'))
  engine.send(nova.id, 'Get the release green', [], { goal: true })
  await until(() => agent.requests.length === 1)
  await engine.whenIdle()
  let now = engine.list()[0]
  assert.equal(now.heartbeat.nextAt, clock + 30 * 60_000)
  assert.equal(now.goalRun?.nextAt ?? null, null, 'its own wake-up picks the goal up, not a second one')
  assert.match(now.activity, /^Sleeping until .+ — wait for the CI run$/)

  clock += 60_000
  engine.tick()
  await engine.whenIdle()
  assert.equal(agent.requests.length, 1, 'still asleep a minute later')

  clock += 30 * 60_000
  engine.tick()
  await until(() => agent.requests.length === 2)
  await engine.whenIdle()
  assert.equal(agent.requests[1].goal?.status, 'active', 'it wakes in goal mode')
  const woke = text(agent.requests[1].history.at(-1)!)
  assert.match(woke, /\[Heartbeat\] You scheduled this wake-up: "wait for the CI run"\./)
  assert.match(woke, /\[Goal\] Keep working toward your goal: "Get the release green"/)
  await until(() => agent.requests.length === 3)
  await engine.whenIdle()
  assert.equal(agent.requests[2].goal?.status, 'active', 'still unfinished after waking: it carries on straight away')
  now = engine.list()[0]
  assert.equal(now.goalRun?.status, 'achieved')
})

test('the user can pause, resume and clear a goal, and Stop pauses it', async () => {
  let clock = Date.parse('2026-10-04T10:00:00Z')
  const agent = heldAgent()
  const { engine } = start(agent.runAgent, { now: () => clock })
  const nova = engine.save(draft('Nova'))
  engine.send(nova.id, 'Tidy the docs', [], { goal: true })
  await until(() => agent.requests.length === 1)
  engine.stopTurn(nova.id)
  await engine.whenIdle()
  let now = engine.list()[0]
  assert.equal(now.goalRun?.status, 'paused', 'Stop pauses the goal')
  assert.equal(now.goalRun?.pausedByUser, true)

  clock += 3 * 60_000
  engine.tick()
  await engine.whenIdle()
  assert.equal(agent.requests.length, 1, 'a paused goal waits for the user')

  engine.setGoal(nova.id, 'active')
  await until(() => agent.requests.length === 2)
  assert.equal(agent.requests[1].goal?.status, 'active', 'resuming starts it again straight away')
  now = engine.list()[0]
  assert.equal(now.goalRun?.pausedByUser, undefined)
  assert.equal(now.goalRun?.turns, 1, 'with a fresh turn budget')
  engine.setGoal(nova.id, 'paused')
  agent.release()
  await engine.whenIdle()
  now = engine.list()[0]
  assert.equal(now.goalRun?.status, 'paused')
  assert.equal(now.goalRun?.nextAt ?? null, null, 'paused while running: no continuation afterwards')

  engine.setGoal(nova.id, null)
  assert.equal(engine.list()[0].goalRun, null)
  assert.throws(() => engine.setGoal(nova.id, 'active'), /has no goal/)
})

test('a goal pauses to check in after its turn budget, and a blocked goal resumes when the user answers', async () => {
  let clock = Date.parse('2026-10-04T10:00:00Z')
  let block = false
  const agent = fakeAgent(async (request, emit) => {
    if (block && request.goal) emit({ type: 'goal', messageId: request.messageId, chatId: request.chatId, goal: { ...request.goal, status: 'blocked', summary: 'Need the staging password' } })
    emit({ type: 'delta', messageId: request.messageId, text: 'Kept going.' })
    return { text: 'Kept going.', usage }
  })
  const { engine, sent } = start(agent.runAgent, { now: () => clock })
  const nova = engine.save(draft('Nova'))
  engine.send(nova.id, 'Migrate the database', [], { goal: true })
  // Never finished: it goes turn after turn, with no wait, to the end of its budget.
  await until(() => agent.requests.length === GOAL_MAX_TURNS)
  await engine.whenIdle()
  assert.equal(agent.requests.length, GOAL_MAX_TURNS, 'and no further')
  let now = engine.list()[0]
  assert.equal(now.goalRun?.status, 'paused')
  assert.match(now.goalRun?.summary ?? '', new RegExp(`after ${GOAL_MAX_TURNS} turns`))
  assert.equal(now.goalRun?.pausedByUser, undefined, 'the budget paused it, not the user')
  assert.ok(sent.length >= 0)

  block = true
  engine.setGoal(nova.id, 'active')
  await until(() => agent.requests.length === GOAL_MAX_TURNS + 1)
  await engine.whenIdle()
  now = engine.list()[0]
  assert.equal(now.goalRun?.status, 'blocked')
  assert.equal(now.goalRun?.summary, 'Need the staging password')
  clock += 3 * 60_000
  engine.tick()
  await engine.whenIdle()
  assert.equal(agent.requests.length, GOAL_MAX_TURNS + 1, 'blocked: it waits for the user')

  block = false
  engine.send(nova.id, 'The password is in 1Password under Staging')
  await until(() => agent.requests.length === GOAL_MAX_TURNS + 2)
  assert.equal(agent.requests[GOAL_MAX_TURNS + 1].goal?.status, 'active', 'the answer puts the goal back to work')
  // Cleared mid-turn: nothing carries on after it.
  engine.setGoal(nova.id, null)
  await engine.whenIdle()
})

test('sleep ends the turn, clamps how long, and goes into the worker’s schedule', async () => {
  const clock = Date.parse('2026-10-04T10:00:00Z')
  const { engine } = start(fakeAgent().runAgent, { now: () => clock })
  const ada = engine.save(draft('Ada'))
  const sleep = workersToolSource(engine)
    .tools({ mode: 'work', cwd: ada.folder, depth: 0, readOnly: false, settings: store.getSettings(), request: { workerId: ada.id } as StreamRequest })
    .find((t) => t.name === 'sleep')!
  assert.ok(sleep, 'workers have a sleep tool')
  const turn: ToolContext['turn'] = { notes: [] }
  const result = await sleep.run({ minutes: 999_999, note: 'the market opens' }, { request: { workerId: ada.id }, turn } as unknown as ToolContext)
  assert.match(String(result), /^Sleeping until/)
  assert.equal(turn.yielded?.until, clock + MAX_SLEEP_MINUTES * 60_000, 'at most a day')
  assert.equal(engine.list()[0].heartbeat.nextAt, clock + MAX_SLEEP_MINUTES * 60_000)
  assert.equal(engine.list()[0].heartbeat.note, 'the market opens')
  await sleep.run({ minutes: 0 }, { request: { workerId: ada.id }, turn } as unknown as ToolContext)
  assert.equal(engine.list()[0].heartbeat.nextAt, clock + 60_000, 'and at least a minute')
})
