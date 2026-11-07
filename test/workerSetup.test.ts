import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Notification } from 'electron'
import '../src/main/agent/sources'
import { store } from '../src/main/store'
import { createWorkersService, type WorkersService } from '../src/main/features/workers/service'
import type { RunAgent } from '../src/main/features/workers/runner'
import type { FeatureContext } from '../src/main/features/types'
import { MAX_ROUTINES, type WorkerDraft } from '@shared/workers'
import {
  changedSettings,
  importAccess,
  listText,
  matchPlugins,
  parseWorkerSetup,
  pluginIdsFor,
  routineWhen,
  setupFile,
  setupFileName,
  setupOf,
  settingsOf,
  uniqueName
} from '@shared/workerSetup'

/**
 * Duplicate, export and import. A setup is what the Edit dialog sets plus the
 * routines and playbooks, read through a whitelist; sign-ins, keys, notes and
 * messages are never in a file, and a file can't bring them in.
 */

const WORKERS = 'workers.json'
const MODEL = { providerId: 'ollama', modelId: 'fake-model' }

let service: WorkersService | null = null
const handlers = new Map<string, (...args: unknown[]) => unknown>()

beforeEach(() => {
  store.setJson(WORKERS, [])
  const root = mkdtempSync(join(tmpdir(), 'eaon-workers-setup-'))
  const settings = store.getSettings()
  store.patchSettings({ work: { ...settings.work, defaultFolder: root } })
  Notification.supported = false
  handlers.clear()
})

afterEach(async () => {
  service?.stop()
  await service?.engine.whenIdle()
  service = null
  await store.flushWrites()
})

function start() {
  const window = { isFocused: () => false, isDestroyed: () => false, isMinimized: () => false, show() {}, focus() {}, restore() {}, webContents: { isLoading: () => false, once() {} } }
  const ctx = {
    ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn) },
    getWindow: () => window,
    send: () => {},
    emitStream: () => {}
  } as unknown as FeatureContext
  const runAgent: RunAgent = async (request) => ({ text: '', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cancelled: request.messageId === '' })
  service = createWorkersService(ctx, { runAgent, startDelayMs: 60_000 })
  service.start()
  service.registerIpc()
  service.engine.start()
  return service.engine
}

const draft = (name: string, extra: Partial<WorkerDraft> = {}): WorkerDraft => ({ name, color: '#E4574B', personality: 'Calm and plain-spoken.', purpose: `${name} watches the build.`, model: MODEL, ...extra })
const call = async <T>(channel: string, ...args: unknown[]): Promise<T> => (await handlers.get(channel)!({}, ...args)) as T

/** A worker with a bit of everything, including what must never leave it. */
function richWorker(engine: ReturnType<typeof start>) {
  const nova = engine.save(
    draft('Nova', {
      access: 'autonomous',
      effort: 'high',
      budget: { tokens: 50_000, usd: 2, period: 'day' },
      retry: { attempts: 2, minutes: 5 },
      sites: { allow: ['github.com'], deny: ['ads.example.com'] },
      toolRules: { run_command: 'ask' },
      plugins: ['server-1']
    })
  )
  engine.addRoutine(nova.id, { name: 'Morning check', task: 'Look at the build and report.', daily: '08:30' })
  engine.addRoutine(nova.id, { name: 'Poll', task: 'Check the queue.', everyMinutes: 30 })
  engine.savePlaybook(nova.id, { name: 'Restart the runner', summary: 'When the runner hangs', steps: '1. Open the panel\n2. Press restart' })
  engine.setMemory(nova.id, { goal: 'Keep CI green', notes: 'The deploy key is sk-live-SECRET-123.' })
  engine.updateApp(nova.id, 'calendar', { signedIn: true, account: 'me@example.com' })
  return engine.list().find((w) => w.id === nova.id)!
}

test('the setup file carries instructions, model, tools, schedule and limits, and nothing it was signed in to', () => {
  const engine = start()
  const nova = richWorker(engine)
  // A purchase schedule is a spending plan, not a setup.
  nova.routines.push({ id: 'p1', name: 'Buy coffee', task: 'Buy it.', everyMs: 86_400_000, daily: null, nextAt: 1, runs: [], purchase: { item: 'coffee', site: 'amazon.com', merchant: 'Amazon', maxAmount: 20, currency: 'USD', notes: '', orders: null, track: false } })
  const text = setupFile(setupOf(nova, [{ id: 'server-1', name: 'GitHub', pluginId: 'github' }]), new Date('2026-11-07T10:00:00Z'))
  const file = JSON.parse(text) as { kind: string; version: number; exportedAt: string; worker: Record<string, unknown> }
  assert.equal(file.kind, 'eaon-worker')
  assert.equal(file.version, 1)
  assert.equal(file.exportedAt, '2026-11-07T10:00:00.000Z')
  assert.deepEqual(Object.keys(file.worker).sort(), ['access', 'budget', 'color', 'effort', 'engine', 'model', 'name', 'personality', 'playbooks', 'plugins', 'purpose', 'retry', 'routines', 'shape', 'sites', 'toolRules'])
  assert.deepEqual(file.worker.plugins, [{ id: 'server-1', name: 'GitHub', pluginId: 'github' }])
  assert.deepEqual((file.worker.routines as { name: string }[]).map((r) => r.name), ['Morning check', 'Poll'])
  for (const secret of ['sk-live-SECRET', 'me@example.com', 'Keep CI green', 'calendar', 'Buy coffee', 'amazon.com']) {
    assert.ok(!text.includes(secret), `${secret} is not in the file`)
  }
  assert.equal(setupFileName('Data Wrangler'), 'Data-Wrangler.eaonworker.json')
  assert.equal(setupFileName('../../etc/passwd'), 'etc-passwd.eaonworker.json')
  assert.equal(setupFileName('   '), 'worker.eaonworker.json')
})

test('a setup survives the file, and reading it again gives the same worker', () => {
  const engine = start()
  const nova = richWorker(engine)
  const parsed = parseWorkerSetup(setupFile(setupOf(nova, [])))
  assert.ok(parsed.ok)
  const setup = parsed.ok ? parsed.setup : null!
  assert.equal(setup.name, 'Nova')
  assert.equal(setup.purpose, 'Nova watches the build.')
  assert.deepEqual(setup.model, MODEL)
  assert.equal(setup.access, 'autonomous')
  assert.equal(setup.effort, 'high')
  assert.deepEqual(setup.budget, { tokens: 50_000, usd: 2, period: 'day' })
  assert.deepEqual(setup.retry, { attempts: 2, minutes: 5 })
  assert.deepEqual(setup.sites, { allow: ['github.com'], deny: ['ads.example.com'] })
  assert.deepEqual(setup.toolRules, { run_command: 'ask' })
  assert.deepEqual(setup.routines.map((r) => [r.name, r.daily, r.everyMs]), [['Morning check', '08:30', null], ['Poll', null, 30 * 60_000]])
  assert.deepEqual(setup.playbooks, [{ name: 'Restart the runner', summary: 'When the runner hangs', steps: '1. Open the panel\n2. Press restart' }])
  assert.deepEqual(parsed.ok && parsed.ignored, [])
})

test('a file is read through a whitelist: credentials and everything else it carries are dropped and named', () => {
  const hostile = JSON.stringify({
    kind: 'eaon-worker',
    version: 1,
    worker: {
      name: 'Helper',
      purpose: 'Does a job.',
      access: 'god-mode',
      color: 'url(javascript:alert(1))',
      shape: 'triangle',
      engine: 'rm -rf',
      apps: [{ id: 'bank', signedIn: true, account: 'me@bank.example' }],
      token: 'sk-ant-secret',
      apiKey: 'sk-secret',
      env: { AWS_SECRET_ACCESS_KEY: 'x' },
      vault: { logins: [{ password: 'hunter2' }] },
      trading: { via: 'desk', autoPlace: true },
      notes: 'private',
      messages: [{ text: 'hello' }],
      routines: [
        { name: 'ok', task: 'Do it.', daily: '9:05' },
        { name: 'no schedule', task: 'Never.' },
        { name: '', task: 'nameless', everyMs: 60_000 },
        { name: 'bad time', task: 'x', daily: '25:99' }
      ],
      budget: { tokens: -4 },
      retry: { attempts: 99, minutes: 1 }
    }
  })
  const parsed = parseWorkerSetup(hostile)
  assert.ok(parsed.ok)
  if (!parsed.ok) return
  assert.deepEqual(parsed.ignored.sort(), ['apiKey', 'apps', 'env', 'messages', 'notes', 'token', 'trading', 'vault'])
  const out = JSON.stringify(parsed.setup)
  for (const leak of ['sk-ant-secret', 'sk-secret', 'AWS_SECRET', 'hunter2', 'me@bank.example', 'private', 'hello', 'autoPlace']) assert.ok(!out.includes(leak), `${leak} did not get through`)
  assert.equal(parsed.setup.access, 'safe', 'an access it doesn’t know is the careful one')
  assert.equal(parsed.setup.color, '#3E86C6')
  assert.equal(parsed.setup.shape, 'pebble')
  assert.equal(parsed.setup.engine, 'native')
  assert.deepEqual(parsed.setup.routines.map((r) => [r.name, r.daily]), [['ok', '09:05']], 'a routine needs a name, a task and a time to run at')
  assert.equal(parsed.setup.budget, null)
  assert.deepEqual(parsed.setup.retry, { attempts: 5, minutes: 1 })
})

test('a file that is not a worker setup is refused in words', () => {
  const bad = (raw: string): string => {
    const parsed = parseWorkerSetup(raw)
    assert.equal(parsed.ok, false)
    return parsed.ok ? '' : parsed.error
  }
  assert.match(bad('not json'), /isn’t valid JSON/)
  assert.match(bad('[]'), /isn’t a worker setup file/)
  assert.match(bad(JSON.stringify({ kind: 'other', version: 1, worker: {} })), /isn’t a worker setup file/)
  assert.match(bad(JSON.stringify({ kind: 'eaon-worker', version: 9, worker: {} })), /newer Eaon/)
  assert.match(bad(JSON.stringify({ kind: 'eaon-worker', version: 1 })), /no worker/)
  assert.match(bad(JSON.stringify({ kind: 'eaon-worker', version: 1, worker: { purpose: 'x' } })), /no name/)
  assert.match(bad(JSON.stringify({ kind: 'eaon-worker', version: 1, worker: { name: 'A' } })), /no purpose/)
  assert.match(bad(`${' '.repeat(1024 * 1024 + 1)}{}`), /too big/)
})

test('the counts and lengths a file may set are bounded', () => {
  const many = Array.from({ length: MAX_ROUTINES + 15 }, (_, i) => ({ name: `r${i}`, task: 'x'.repeat(5000), everyMs: 60_000 }))
  const parsed = parseWorkerSetup(JSON.stringify({ kind: 'eaon-worker', version: 1, worker: { name: 'N'.repeat(200), purpose: 'p'.repeat(9000), routines: many } }))
  assert.ok(parsed.ok)
  if (!parsed.ok) return
  assert.equal(parsed.setup.name.length, 40)
  assert.equal(parsed.setup.purpose.length, 2000)
  assert.equal(parsed.setup.routines.length, MAX_ROUTINES)
  assert.equal(parsed.setup.routines[0].task.length, 600)
})

test('an imported setup starts no freer than Careful, and names get a free copy name', () => {
  assert.equal(importAccess('autonomous'), 'safe')
  assert.equal(importAccess('safe'), 'safe')
  assert.equal(importAccess('read-only'), 'read-only')
  assert.equal(uniqueName('Nova', []), 'Nova')
  assert.equal(uniqueName('Nova', ['nova']), 'Nova copy')
  assert.equal(uniqueName('Nova', ['Nova', 'Nova copy']), 'Nova copy 2')
  assert.equal(uniqueName('N'.repeat(40), ['N'.repeat(40)]).length, 40, 'a long name is cut to fit its suffix')
  assert.equal(listText(['purpose']), 'purpose')
  assert.equal(listText(['purpose', 'model', 'freedom']), 'purpose, model and freedom')
  assert.equal(routineWhen({ everyMs: 1_800_000, daily: null, marketHours: false }), 'every 30 min')
  assert.equal(routineWhen({ everyMs: 7_200_000, daily: null, marketHours: true }), 'every 2 h while the market is open')
  assert.equal(routineWhen({ everyMs: null, daily: '08:30', marketHours: false }), 'daily at 08:30')
})

test('plugins in a file are matched to what is connected here, by catalog id and then by name', () => {
  const wanted = [
    { id: 'abc', name: 'GitHub', pluginId: 'github' },
    { id: 'def', name: 'My Notes' },
    { id: 'ghi', name: 'Gone' }
  ]
  const local = [
    { id: 'L1', name: 'GitHub (work)', pluginId: 'github' },
    { id: 'L2', name: 'my notes' }
  ]
  const matches = matchPlugins(wanted, local)
  assert.deepEqual(matches.map((m) => m.here?.id ?? null), ['L1', 'L2', null])
  const setup = { plugins: wanted } as Parameters<typeof pluginIdsFor>[0]
  assert.deepEqual(pluginIdsFor(setup, local), ['L1', 'L2'], 'only what is here')
  assert.equal(pluginIdsFor({ plugins: null } as Parameters<typeof pluginIdsFor>[0], local), null, 'every plugin stays every plugin')
})

test('duplicating a worker copies its setup under a new name and its own look, and nothing it was signed in to', () => {
  const engine = start()
  const nova = richWorker(engine)
  engine.send(nova.id, 'Remember this message')
  const copy = engine.duplicate(nova.id)
  assert.equal(copy.name, 'Nova copy')
  assert.notEqual(copy.id, nova.id)
  assert.notEqual(copy.folder, nova.folder, 'it has a folder of its own')
  assert.notEqual(copy.color, nova.color, 'a free colour, so the two are told apart')
  assert.equal(copy.purpose, nova.purpose)
  assert.deepEqual(copy.model, nova.model)
  assert.equal(copy.access, 'autonomous', 'a copy of your own worker keeps its freedom')
  assert.deepEqual(copy.budget, nova.budget)
  assert.deepEqual(copy.sites, nova.sites)
  assert.deepEqual(copy.toolRules, nova.toolRules)
  assert.deepEqual(copy.plugins, ['server-1'])
  assert.deepEqual(copy.routines.map((r) => r.name), ['Morning check', 'Poll'])
  assert.notEqual(copy.routines[0].id, nova.routines[0].id)
  assert.deepEqual(copy.playbooks.map((p) => p.name), ['Restart the runner'])
  assert.equal(copy.playbooks[0].uses, 0)
  assert.deepEqual([copy.apps, copy.notes, copy.goal, copy.goalRun, copy.inbox], [[], '', '', null, []])
  assert.equal(engine.getThread(copy.id).messages.length, 0, 'no message history')
  assert.equal(engine.list().find((w) => w.id === nova.id)!.notes.includes('sk-live'), true, 'the original keeps its own')
  assert.equal(engine.duplicate(nova.id).name, 'Nova copy 2')
})

test('importing creates the worker from the setup, careful by default, with plugins matched and the rest left out', async () => {
  const engine = start()
  store.saveMcpServers([
    { id: 'local-gh', name: 'GitHub', transport: 'http', command: '', args: [], env: {}, url: 'https://x.test', enabled: true, official: false, pluginId: 'github' }
  ])
  const nova = richWorker(engine)
  const exported = await call<{ fileName: string; text: string; routines: number; playbooks: number }>('workers:export-setup', nova.id)
  assert.equal(exported.fileName, 'Nova.eaonworker.json')
  assert.equal(exported.routines, 2)
  assert.equal(exported.playbooks, 1)
  // Another computer: server-1 is not here, the GitHub plugin is under another id.
  const file = JSON.parse(exported.text)
  file.worker.plugins = [{ id: 'server-9', name: 'GitHub', pluginId: 'github' }, { id: 'server-10', name: 'Gone' }]
  const text = JSON.stringify(file)

  const made = await call<ReturnType<typeof engine.list>[number]>('workers:import-setup', text, { name: 'Nova on this computer' })
  assert.equal(made.name, 'Nova on this computer')
  assert.equal(made.access, 'safe', 'the file asked for Autonomous; it starts at Careful')
  assert.deepEqual(made.plugins, ['local-gh'])
  assert.deepEqual(made.budget, { tokens: 50_000, usd: 2, period: 'day' })
  assert.equal(made.routines.length, 2)
  assert.equal(made.playbooks.length, 1)
  assert.deepEqual(made.apps, [])
  assert.equal(made.notes, '')

  const chosen = await call<typeof made>('workers:import-setup', text, { name: 'Nova two', access: 'autonomous', model: null })
  assert.equal(chosen.access, 'autonomous', 'the user can raise it after reading the setup')
  assert.equal(chosen.model, null, 'a model that isn’t connected here is dropped, so the worker follows Chat’s')

  await assert.rejects(() => call('workers:import-setup', 'nonsense', {}), /isn’t valid JSON/)
  await assert.rejects(() => call('workers:import-setup', text, { name: 'Nova' }), /already a worker called Nova/)
})

test('what a version or a copy changes is told in words', () => {
  const engine = start()
  const nova = engine.save(draft('Nova'))
  const before = settingsOf(nova)
  const after = { ...before, purpose: 'Something else.', access: 'safe' as const, budget: { tokens: 10, usd: null, period: 'day' as const } }
  assert.deepEqual(changedSettings(before, after), ['purpose', 'freedom', 'spend cap'])
  assert.deepEqual(changedSettings(before, { ...before }), [])
})
