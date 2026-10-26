import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Notification, powerSaveBlocker } from 'electron'
import '../src/main/agent/sources'
import type { ToolContext } from '../src/main/agent/tools'
import type { RunOptions, RunOutcome } from '../src/main/agent/loop'
import { store } from '../src/main/store'
import { createWorkersService, type WorkersOverrides, type WorkersService } from '../src/main/features/workers/service'
import { workersToolSource } from '../src/main/features/workers/tools'
import { workerPersona } from '../src/main/features/workers/prompt'
import { fingerprint, judge, look, newLines, type WatchReading } from '../src/main/features/workers/watch'
import { readTail } from '../src/main/features/workers/jobs'
import { addressUrl, describeTaught } from '../src/main/features/workers/browser'
import type { RunAgent } from '../src/main/features/workers/runner'
import type { FeatureContext } from '../src/main/features/types'
import { describeWorker, GOAL_MAX_TURNS, MAX_GOAL_HOURS, type Worker, type WorkerDraft, type WorkerWatch } from '@shared/workers'
import type { StreamEvent, StreamRequest } from '@shared/types'

/**
 * What lets a worker run on its own for hours: goals with an end time (no
 * turn budget, the computer kept awake, a report at the end), retrying after
 * a failed turn, background jobs that wake it when they end, watches that
 * look for it without the model, and playbooks — including ones the user
 * teaches it by doing the task once.
 */

const WORKERS = 'workers.json'
const MODEL = { providerId: 'ollama', modelId: 'fake-model' }
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }
const HOUR = 60 * 60_000

let service: WorkersService | null = null
let root = ''

beforeEach(() => {
  store.setJson(WORKERS, [])
  root = mkdtempSync(join(tmpdir(), 'eaon-autonomy-'))
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

async function until(check: () => boolean, timeout = 8000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function fakeContext() {
  const window = {
    isFocused: () => false,
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => false,
    show() {},
    focus() {},
    restore() {},
    webContents: { isLoading: () => false, once() {} }
  }
  return {
    ipcMain: { handle: () => {} },
    getWindow: () => window,
    send: () => {},
    emitStream: () => {}
  } as unknown as FeatureContext
}

type Behaviour = (request: StreamRequest, emit: (event: StreamEvent) => void, options: RunOptions) => Promise<RunOutcome> | RunOutcome

function fakeAgent(behave: Behaviour | string = 'Done.') {
  const requests: StreamRequest[] = []
  const runAgent: RunAgent = async (request, emit, opts) => {
    requests.push(structuredClone(request))
    if (typeof behave === 'string') {
      emit({ type: 'delta', messageId: request.messageId, text: behave })
      return { text: behave, usage }
    }
    return behave(request, emit, opts)
  }
  return { runAgent, requests }
}

function start(runAgent: RunAgent, overrides: WorkersOverrides = {}) {
  service = createWorkersService(fakeContext(), { runAgent, startDelayMs: 60_000, ...overrides })
  service.start()
  service.engine.start()
  return service.engine
}

function draft(name: string, extra: Partial<WorkerDraft> = {}): WorkerDraft {
  return { name, color: '#3E86C6', personality: 'Calm.', purpose: `${name}'s job`, model: MODEL, ...extra }
}

const lastText = (request: StreamRequest): string =>
  request.history
    .at(-1)!
    .parts.filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join('')

function toolsOf(engine: WorkersService['engine'], worker: Worker) {
  const all = workersToolSource(engine).tools({
    mode: 'work',
    cwd: worker.folder,
    depth: 0,
    readOnly: false,
    settings: store.getSettings(),
    request: { workerId: worker.id } as StreamRequest
  })
  const ctx = { request: { workerId: worker.id }, turn: { notes: [] } } as unknown as ToolContext
  return {
    names: all.map((t) => t.name),
    tool: (name: string) => all.find((t) => t.name === name)!,
    run: async (name: string, input: Record<string, unknown>) => String(await all.find((t) => t.name === name)!.run(input, ctx)),
    ctx
  }
}

const blocker = powerSaveBlocker as unknown as { active: Set<number> }

/* --------------------------------------------------------- hours-long goals */

test('a goal with an end time has no turn budget, keeps the computer awake, and ends with a report', async () => {
  let clock = Date.parse('2026-10-13T09:00:00Z')
  const end = clock + 4 * HOUR
  const turns = GOAL_MAX_TURNS + 6
  const agent = fakeAgent((request, emit) => {
    // The clock moves a few minutes a turn; past the turn budget, the end time arrives.
    clock += 5 * 60_000
    if (agent.requests.length === turns) clock = end + 60_000
    emit({ type: 'delta', messageId: request.messageId, text: 'Kept going.' })
    return { text: request.goal ? 'Kept going.' : 'Report: shipped the migration; two tables left.', usage }
  })
  const engine = start(agent.runAgent, { now: () => clock, maxTurnsPerHour: 1000 })
  const nova = engine.save(draft('Nova'))
  const awakeBefore = blocker.active.size
  engine.send(nova.id, 'Migrate every table to the new schema', [], { goal: true, until: end })
  assert.equal(engine.list()[0].goalRun?.until, end)

  await until(() => agent.requests.length === turns + 1)
  await engine.whenIdle()
  assert.equal(agent.requests[0].goal?.until, end, 'the loop is told the end time')
  assert.ok(agent.requests.slice(0, turns).every((r) => r.goal?.status === 'active'), `well past ${GOAL_MAX_TURNS} turns, still in goal mode`)
  assert.match(lastText(agent.requests[1]), /\[Goal\] Keep working toward your goal: ".+"\. You have until .+ \(.+ left\)\./)

  const report = agent.requests[turns]
  assert.equal(report.goal, null, 'the last turn is the report, not more work')
  assert.match(lastText(report), /\[Time’s up on the goal\] Your time on the goal "Migrate every table to the new schema" is up/)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(agent.requests.length, turns + 1, 'and then it stops')
  const after = engine.list()[0]
  assert.equal(after.goalRun?.status, 'paused')
  assert.match(after.goalRun?.summary ?? '', /^Time’s up — worked on it for/)
  assert.equal(blocker.active.size, awakeBefore, 'the computer may sleep again')
})

test('the computer is kept awake while a timed goal is active, and resuming keeps an end time still to come', async () => {
  let clock = Date.parse('2026-10-13T09:00:00Z')
  const agent = fakeAgent((request, emit) => {
    emit({ type: 'delta', messageId: request.messageId, text: 'Waiting on CI.' })
    return { text: 'Waiting on CI.', usage }
  })
  const engine = start(agent.runAgent, { now: () => clock })
  const nova = engine.save(draft('Nova'))
  const before = blocker.active.size
  engine.send(nova.id, 'Keep CI green', [], { goal: true, until: clock + 2 * HOUR })
  assert.equal(blocker.active.size, before + 1)
  engine.setGoal(nova.id, 'paused')
  assert.equal(blocker.active.size, before, 'released once no run needs it')
  await engine.whenIdle()
  // A paused run whose time is still to come keeps its end time when resumed.
  engine.setGoal(nova.id, 'active')
  assert.equal(engine.list()[0].goalRun?.until, clock + 2 * HOUR)
  engine.setGoal(nova.id, 'paused')
  await engine.whenIdle()
  clock += 3 * HOUR
  // One whose time ran out carries on as an ordinary goal.
  engine.setGoal(nova.id, 'active')
  assert.equal(engine.list()[0].goalRun?.until, undefined)
  engine.setGoal(nova.id, null)
  await engine.whenIdle()
})

test('pausing or clearing a goal cancels the wake-up the worker set for it, and leaves a steady heartbeat alone', async () => {
  const clock = Date.parse('2026-10-13T09:00:00Z')
  let engine: ReturnType<typeof start> | null = null
  const agent = fakeAgent((request, emit) => {
    engine!.sleep(request.workerId!, 20, 'check the build')
    emit({ type: 'delta', messageId: request.messageId, text: 'Sleeping on it.' })
    return { text: 'Sleeping on it.', usage }
  })
  engine = start(agent.runAgent, { now: () => clock })
  const nova = engine.save(draft('Nova'))
  const pip = engine.save(draft('Pip'))

  for (const [worker, status] of [[nova, 'paused'], [pip, null]] as const) {
    engine.send(worker.id, 'Keep the build green', [], { goal: true })
    await until(() => agent.requests.some((r) => r.workerId === worker.id))
    await engine.whenIdle()
    const asleep = engine.list().find((w) => w.id === worker.id)!
    assert.equal(asleep.heartbeat.nextAt, clock + 20 * 60_000, 'the goal’s sleep is set')
    assert.equal(asleep.goalRun?.wakeAt, clock + 20 * 60_000)
    engine.setGoal(worker.id, status)
    const after = engine.list().find((w) => w.id === worker.id)!
    assert.equal(after.heartbeat.nextAt, null, `${status ?? 'cleared'}: no wake-up left to carry on the goal`)
    assert.equal(after.goalRun?.wakeAt, undefined)
  }

  // A steady heartbeat the worker keeps isn't the goal's to cancel.
  engine.setHeartbeat(nova.id, { everyMinutes: 60, note: 'check the inbox' })
  engine.setGoal(nova.id, 'active')
  await engine.whenIdle()
  engine.setHeartbeat(nova.id, { everyMinutes: 60, note: 'check the inbox' })
  engine.setGoal(nova.id, 'paused')
  assert.equal(engine.list().find((w) => w.id === nova.id)!.heartbeat.everyMs, 60 * 60_000)
})

test('an end time is clamped to the longest a run may be, and one in the past is ignored', () => {
  const clock = Date.parse('2026-10-13T09:00:00Z')
  const engine = start(fakeAgent().runAgent, { now: () => clock })
  const nova = engine.save(draft('Nova'))
  engine.setPaused(nova.id, true)
  engine.send(nova.id, 'Watch the launch', [], { goal: true, until: clock + 100 * HOUR })
  assert.equal(engine.list()[0].goalRun?.until, clock + MAX_GOAL_HOURS * HOUR)
  engine.send(nova.id, 'Something else', [], { goal: true, until: clock - 1 })
  assert.equal(engine.list()[0].goalRun?.until, undefined)
})

test('a failed goal turn tries again after a pause, longer each time, then pauses the goal', async () => {
  let clock = Date.parse('2026-10-13T09:00:00Z')
  let fail = true
  const agent = fakeAgent((request, emit) => {
    if (fail) return { text: '', usage, error: 'The model is overloaded' }
    emit({ type: 'goal', messageId: request.messageId, chatId: request.chatId, goal: { ...request.goal!, status: 'achieved', summary: 'Done' } })
    return { text: 'Done.', usage }
  })
  const engine = start(agent.runAgent, { now: () => clock })
  const nova = engine.save(draft('Nova'))
  engine.send(nova.id, 'Fix the flaky test', [], { goal: true })
  await until(() => agent.requests.length === 1)
  await engine.whenIdle()
  let now = engine.list()[0]
  assert.equal(now.goalRun?.status, 'active', 'still on it')
  assert.equal(now.goalRun?.failures, 1)
  assert.equal(now.goalRun?.nextAt, clock + 60_000, 'tries again in a minute')
  assert.equal(now.status, 'idle', 'not the dead face: it is trying again')
  assert.match(now.activity, /^Hit a problem; trying again in 1 min$/)

  clock += 60_000
  engine.tick()
  await until(() => agent.requests.length === 2)
  await engine.whenIdle()
  assert.equal(agent.requests[1].goal?.status, 'active', 'the retry is in goal mode')
  assert.equal(engine.list()[0].goalRun?.nextAt, clock + 5 * 60_000, 'then five minutes')

  clock += 5 * 60_000
  engine.tick()
  await until(() => agent.requests.length === 3)
  await engine.whenIdle()
  assert.equal(engine.list()[0].goalRun?.nextAt, clock + 15 * 60_000, 'then fifteen')

  clock += 15 * 60_000
  engine.tick()
  await until(() => agent.requests.length === 4)
  await engine.whenIdle()
  now = engine.list()[0]
  assert.equal(now.goalRun?.status, 'paused', 'the fourth failure in a row pauses it')
  assert.equal(now.goalRun?.summary, 'Paused after 4 failed turns in a row')
  assert.equal(now.status, 'failed')

  fail = false
  engine.setGoal(nova.id, 'active')
  await until(() => agent.requests.length === 5)
  await engine.whenIdle()
  now = engine.list()[0]
  assert.equal(now.goalRun?.status, 'achieved')
  assert.equal(now.goalRun?.failures, undefined, 'a good turn clears the count')
})

/* -------------------------------------------------------------------- jobs */

test('a background job runs outside the turn and wakes the worker with how it ended', async () => {
  const agent = fakeAgent('Saw the job end.')
  const engine = start(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  const tools = toolsOf(engine, nova)
  assert.ok(['start_job', 'check_job', 'watch', 'unwatch', 'save_playbook', 'read_playbook'].every((name) => tools.names.includes(name)))

  const started = await tools.run('start_job', { command: 'echo building && echo done && exit 3', name: 'Build' })
  assert.match(started, /^Started job \w{8} \("Build"\)/)
  await until(() => agent.requests.length === 1)
  await engine.whenIdle()
  const woke = lastText(agent.requests[0])
  assert.match(woke, /\[Job "Build" ended\] Your job \w{8} \("Build"\) ended: exit code 3 after/)
  assert.match(woke, /Last output:\nbuilding\ndone/)
  const job = engine.list()[0].jobs[0]
  assert.equal(job.ok, false)
  assert.equal(job.result, 'exit code 3')
  assert.ok(job.log.startsWith(join(nova.folder, '.jobs')), 'its log is in the worker’s folder, where it can read it')
  assert.match(readFileSync(job.log, 'utf8'), /building\ndone/)
  assert.match(await tools.run('check_job', { job: 'Build' }), /ended: exit code 3/)
})

test('a job the worker stops doesn’t wake it; one the user stops does', async () => {
  const agent = fakeAgent('Noted.')
  const engine = start(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  const tools = toolsOf(engine, nova)
  await tools.run('start_job', { command: 'sleep 30', name: 'Long' })
  assert.equal(describeWorker(engine.list()[0]), 'Waiting on Long')
  assert.match(await tools.run('check_job', {}), /\("Long"\) is running \(/)
  await tools.run('check_job', { stop: true })
  await until(() => engine.list()[0].jobs[0].endedAt !== null)
  assert.equal(engine.list()[0].jobs[0].result, 'stopped')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(agent.requests.length, 0, 'it knows: it stopped it')

  await tools.run('start_job', { command: 'sleep 30', name: 'Another' })
  const second = engine.list()[0].jobs[1]
  engine.stopJob(nova.id, second.id, 'user')
  await until(() => agent.requests.length === 1)
  assert.match(lastText(agent.requests[0]), /\[Job "Another" was stopped by the user\]/)
  await engine.whenIdle()
})

test('jobs still running when Eaon quit are recorded as lost', () => {
  store.setJson(WORKERS, [
    {
      id: 'w1',
      name: 'Nova',
      folder: root,
      jobs: [{ id: 'abc12345', name: 'Train', command: 'python train.py', cwd: root, log: join(root, 'x.log'), pid: 4242, startedAt: 1, endedAt: null, result: null, ok: null, timeoutMs: HOUR }]
    }
  ])
  const engine = start(fakeAgent().runAgent)
  const job = engine.list()[0].jobs[0]
  assert.equal(job.result, 'lost when Eaon quit')
  assert.equal(job.ok, false)
  assert.equal(job.pid, null)
})

test('readTail gives the last lines of a log, without a half line at the cut', async () => {
  const path = join(root, 'big.log')
  writeFileSync(path, Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join('\n') + '\n')
  assert.equal(await readTail(path, 3), 'line 19997\nline 19998\nline 19999')
  assert.equal(await readTail(join(root, 'none.log')), '')
})

/* ----------------------------------------------------------------- watches */

test('judging a look: change, contains, missing and fails, each on its edge', () => {
  const reading = (content: string, ok = true): WatchReading => ({ ok, content, summary: ok ? 'HTTP 200' : 'HTTP 503' })
  const watch = (when: WorkerWatch['when'], last: WorkerWatch['last'] = null, text = 'In stock') => ({ when, text, last })
  const last = (content: string, met: boolean) => ({ at: 0, fingerprint: fingerprint(content), met, summary: '' })

  assert.equal(judge(watch('change'), reading('a')).fire, false, 'the first look is the baseline')
  assert.equal(judge(watch('change', last('a', false)), reading('a  ')).fire, false, 'whitespace is not a change')
  assert.equal(judge(watch('change', last('a', false)), reading('b')).fire, true)
  assert.equal(judge(watch('change', last('a', false)), reading('', false)).fire, false, 'a failed look is not a change')

  assert.equal(judge(watch('contains'), reading('Now IN STOCK')).fire, true, 'already true on the first look counts')
  assert.equal(judge(watch('contains', last('x', true)), reading('In stock')).fire, false, 'only when it starts to hold')
  assert.equal(judge(watch('missing', last('In stock', false)), reading('Sold out')).fire, true)
  assert.equal(judge(watch('missing'), reading('', false)).fire, false, 'unknown is not missing')

  const down = judge(watch('fails'), reading('', false))
  assert.deepEqual([down.fire, down.what], [true, 'it is failing'])
  assert.equal(judge(watch('fails', last('', true)), reading('', false)).fire, false, 'once, not on every look')
  const back = judge(watch('fails', last('', true)), reading('ok'))
  assert.deepEqual([back.fire, back.what], [true, 'it recovered'])

  assert.deepEqual(newLines('a\nb', 'a\nb\nc\n\nd'), ['c', 'd'])
  assert.deepEqual(newLines(undefined, 'a'), [])
})

test('a watch is looked at without the model and wakes the worker only when it fires', async () => {
  let clock = Date.parse('2026-10-13T09:00:00Z')
  let page = 'Price: $40\nShipping: 2 days'
  let ok = true
  const looks: string[] = []
  const agent = fakeAgent('On it.')
  const engine = start(agent.runAgent, {
    now: () => clock,
    look: async (_worker, watch) => {
      looks.push(watch.name)
      return { ok, content: ok ? page : '', summary: ok ? 'HTTP 200' : 'HTTP 503' }
    }
  })
  const nova = engine.save(draft('Nova'))
  const tools = toolsOf(engine, nova)
  const reply = await tools.run('watch', { name: 'Price', kind: 'url', target: 'https://shop.example.com/item', every_minutes: 5, note: 'Tell the user if it drops' })
  assert.match(reply, /^Watching "Price": https:\/\/shop\.example\.com\/item changing, checked every 5 min/)
  await until(() => looks.length === 1)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(agent.requests.length, 0, 'the first look only sets the baseline')
  assert.equal(engine.list()[0].status, 'idle', 'watching is not asleep')
  assert.equal(describeWorker(engine.list()[0]), 'Watching Price')

  clock += 4 * 60_000
  engine.tick()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(looks.length, 1, 'not before its time')

  page = 'Price: $32\nShipping: 2 days'
  clock += 60_000
  engine.tick()
  await until(() => agent.requests.length === 1)
  await engine.whenIdle()
  const woke = lastText(agent.requests[0])
  assert.match(woke, /\[Price: it changed\] Your watch "Price" \(https:\/\/shop\.example\.com\/item changing\): it changed — HTTP 200\./)
  assert.match(woke, /New lines:\n> Price: \$32/)
  assert.match(woke, /What you meant to do: Tell the user if it drops/)
  assert.equal(engine.list()[0].watches[0].fires, 1)

  // Paused workers' watches wait.
  engine.setPaused(nova.id, true)
  clock += 10 * 60_000
  engine.tick()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(looks.length, 2)
  engine.setPaused(nova.id, false)

  assert.match(await tools.run('unwatch', { name: 'price' }), /Stopped watching "Price"/)
  assert.equal(engine.list()[0].watches.length, 0)
  assert.throws(() => engine.addWatch(nova.id, { name: 'x', kind: 'url', target: 'example.com' }), /full http\(s\) URL/)
  assert.throws(() => engine.addWatch(nova.id, { name: 'x', kind: 'file', target: 'a.txt', when: 'contains' }), /needs the text/)
  assert.throws(() => engine.addWatch(nova.id, { name: 'x', kind: 'disk', target: '/' }), /kind must be/)
  await engine.whenIdle()
})

test('a command watch is checked like run_command when it is set', () => {
  const engine = start(fakeAgent().runAgent)
  const nova = engine.save(draft('Nova'))
  const { tool, ctx } = toolsOf(engine, nova)
  const watch = tool('watch')
  const mutating = watch.mutating as (input: Record<string, unknown>, ctx: ToolContext) => boolean
  assert.equal(mutating({ kind: 'command', target: 'git status' }, ctx), false, 'looking is not changing')
  assert.equal(mutating({ kind: 'command', target: 'npm run deploy' }, ctx), true)
  assert.equal(mutating({ kind: 'url', target: 'https://example.com' }, ctx), false)
  assert.equal(watch.catastrophic!({ kind: 'command', target: 'sudo rm -rf /' }, ctx), true)
  assert.equal(tool('start_job').catastrophic!({ command: 'sudo reboot' }, ctx), true)
})

test('looking at files, folders and commands for real', async () => {
  const file = join(root, 'status.txt')
  assert.deepEqual(await look({ kind: 'file', target: 'status.txt' }, root), { ok: false, content: '', summary: 'missing' })
  writeFileSync(file, 'deploy: ok')
  const seen = await look({ kind: 'file', target: 'status.txt' }, root)
  assert.equal(seen.ok, true)
  assert.equal(seen.content, 'deploy: ok')
  const folder = await look({ kind: 'file', target: '.' }, root)
  assert.match(folder.content, /^status\.txt\t10\t\d+$/m)
  assert.match(folder.summary, /^folder · \d+ items?$/)
  const passing = await look({ kind: 'command', target: 'echo healthy' }, root)
  assert.deepEqual([passing.ok, passing.summary], [true, 'exit code 0 · healthy'])
  const failing = await look({ kind: 'command', target: 'echo broken >&2; exit 2' }, root)
  assert.deepEqual([failing.ok, failing.summary], [false, 'exit code 2 · broken'])
})

/* --------------------------------------------------------------- playbooks */

test('playbooks: saved, listed in the prompt by name, read when used, updated and removed', async () => {
  const engine = start(fakeAgent().runAgent)
  const nova = engine.save(draft('Nova'))
  const tools = toolsOf(engine, nova)
  assert.match(
    await tools.run('save_playbook', { name: 'Weekly report', summary: 'Every Monday, for the team', steps: '1. Open the dashboard\n2. Export CSV' }),
    /^Saved playbook "Weekly report"/
  )
  let worker = engine.list()[0]
  const persona = workerPersona(worker, null)
  assert.match(persona, /Your playbooks \(read_playbook for the steps\):\n- Weekly report: Every Monday, for the team/)
  assert.ok(!persona.includes('Export CSV'), 'only names and summaries sit in the prompt')

  assert.equal(await tools.run('read_playbook', { name: 'weekly' }), '# Weekly report\nUse it to: Every Monday, for the team\n\n1. Open the dashboard\n2. Export CSV')
  assert.equal(engine.list()[0].playbooks[0].uses, 1)
  await tools.run('save_playbook', { name: 'WEEKLY REPORT', steps: '1. Open the new dashboard' })
  worker = engine.list()[0]
  assert.equal(worker.playbooks.length, 1, 'same name, updated')
  assert.equal(worker.playbooks[0].steps, '1. Open the new dashboard')
  assert.equal(worker.playbooks[0].summary, 'Every Monday, for the team', 'the summary stays when not given')
  await assert.rejects(tools.run('read_playbook', { name: 'Payroll' }), /No playbook "Payroll"\. Yours: WEEKLY REPORT/)
  assert.match(await tools.run('save_playbook', { name: 'weekly report', remove: true }), /Removed/)
  assert.equal(engine.list()[0].playbooks.length, 0)
})

test('Teach: what the user did becomes their message, asking for a playbook', async () => {
  const agent = fakeAgent('Saved "File an expense".')
  const engine = start(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  assert.throws(() => engine.teach(nova.id, { task: 'x', steps: [] }), /Nothing was recorded/)
  engine.teach(nova.id, { task: 'file an expense report', steps: ['Opened https://expenses.example.com', 'Clicked the button "New expense"'] })
  await until(() => agent.requests.length === 1)
  await engine.whenIdle()
  const message = lastText(agent.requests[0])
  assert.match(message, /\[From the user\] I just showed you in your browser how to file an expense report\. What I did:\n1\. Opened https:\/\/expenses\.example\.com\n2\. Clicked the button "New expense"/)
  assert.match(message, /save_playbook/)
})

test('recorded actions read as steps; secrets never do', () => {
  assert.equal(describeTaught({ kind: 'click', role: 'button', label: 'Submit' }), 'Clicked the button "Submit"')
  assert.equal(describeTaught({ kind: 'click', role: 'link', label: 'Docs', href: 'https://x.dev/docs' }), 'Clicked the link "Docs" → https://x.dev/docs')
  assert.equal(describeTaught({ kind: 'click', role: 'div', label: '' }), null, 'a click on nothing in particular says nothing')
  assert.equal(describeTaught({ kind: 'type', label: 'Email', value: 'me@example.com' }), 'Typed "me@example.com" into "Email"')
  assert.equal(describeTaught({ kind: 'type', label: 'Password', value: 'hunter2', secret: true }), 'Typed a password or card detail into "Password" (not recorded; ask the user when you need it)')
  assert.equal(describeTaught({ kind: 'select', label: 'Country', value: 'Canada' }), 'Chose "Canada" in "Country"')
  assert.equal(describeTaught({ kind: 'check', role: 'checkbox', label: 'Remember me', checked: true }), 'Ticked "Remember me"')
  assert.equal(describeTaught({ kind: 'enter', label: 'Search' }), 'Pressed Enter in "Search"')
  assert.equal(describeTaught({ kind: 'mystery' }), null)
  assert.equal(describeTaught(null), null)
})

test('the persona tells a worker how to work for hours, and what it watches', () => {
  const engine = start(fakeAgent().runAgent)
  const nova = engine.save(draft('Nova'))
  engine.setPaused(nova.id, true)
  engine.addWatch(nova.id, { name: 'Site', kind: 'url', target: 'https://example.com', when: 'fails', note: 'restart the server' })
  const persona = workerPersona(engine.list()[0], null)
  assert.match(persona, /start_job/)
  assert.match(persona, /Maintain what you are responsible for with watch/)
  assert.match(persona, /You are watching:\n- Site: https:\/\/example\.com going down, every 10 min — restart the server/)
  assert.ok(existsSync(nova.folder))
})

test('the live view’s address bar takes a local dev server as typed', () => {
  assert.equal(addressUrl('localhost:5199'), 'http://localhost:5199')
  assert.equal(addressUrl('127.0.0.1:3000/app'), 'http://127.0.0.1:3000/app')
  assert.equal(addressUrl('localhost'), 'http://localhost')
  assert.equal(addressUrl('https://example.com/a'), 'https://example.com/a')
  assert.equal(addressUrl('example.com'), 'https://example.com')
  assert.equal(addressUrl('expense report'), 'https://duckduckgo.com/?q=expense%20report')
})
