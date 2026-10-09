import { after, afterEach, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { spawn as Spawn } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../src/main/agent/sources'
import type { RunOptions, RunOutcome } from '../src/main/agent/loop'
import { store } from '../src/main/store'
import { secrets } from '../src/main/secrets'
import { createWorkersService, type WorkersOverrides, type WorkersService } from '../src/main/features/workers/service'
import type { RunAgent } from '../src/main/features/workers/runner'
import type { WorkersEngine } from '../src/main/features/workers/engine'
import type { FeatureContext } from '../src/main/features/types'
import { gatewayToken, tokenAllowed } from '../src/main/gateway/models'
import { Bonjour, instanceName } from '../src/main/remote/bonjour'
import { createRemote, defaultModelId, remoteModels } from '../src/main/remote'
import { RemoteServer, type RemoteServerOptions } from '../src/main/remote/server'
import { MAX_WORKERS, WORKER_COLORS, type WorkerDraft } from '@shared/workers'
import type { StreamEvent, StreamRequest } from '@shared/types'
import { chunk, sseServer } from './helpers'

/**
 * The remote API end to end: the real server over a real workers engine with a
 * fake model, called over HTTP the way the phone does. Nothing reaches a real
 * API; the Mac's models (`/v1/*`) go to a fake upstream.
 *
 * Every test starts its own server (on a free port, with a fresh failure
 * count), and every response body is kept so a test can scan them all for
 * what must never be sent: the worker's folder, a colleague's file, the home
 * directory.
 */

const TOKEN = 'eaonr-test-key-0123456789abcdefghij'
// A provider the fake upstream below stands behind: a worker pinned to one that is disabled would never run.
const MODEL = { providerId: 'fake', modelId: 'big-model' }
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }
const CHECK_IN = 'The user asked you to check in now'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

let service: WorkersService | null = null
let server: RemoteServer | null = null
let port = 0
let root = ''
let home = ''
/** Every response body of the running test. */
let seen: string[] = []

/* ------------------------------------------------------------ upstream model */

let upstream: Awaited<ReturnType<typeof sseServer>>
let upstreamReply: (body: Record<string, unknown>) => string[] = () => [chunk({ content: 'ok' }, 'stop')]
const quietLocals = { ollama: { enabled: false }, 'lm-studio': { enabled: false }, 'llama-cpp': { enabled: false }, mlx: { enabled: false }, vllm: { enabled: false }, jan: { enabled: false } }

before(async () => {
  upstream = await sseServer((body) => upstreamReply(body))
  store.saveProviderConfig({
    ...quietLocals,
    fake: {
      name: 'Fake',
      kind: 'openai-compatible',
      baseUrl: upstream.url,
      models: [
        { id: 'big-model', label: 'Big', providerId: 'fake' },
        { id: 'tiny-model', label: 'Tiny', providerId: 'fake' }
      ]
    }
  })
  secrets.set('fake', 'key')
})

after(() => {
  upstream.server.close()
})

/* -------------------------------------------------------------------- setup */

beforeEach(() => {
  store.setJson('workers.json', [])
  root = mkdtempSync(join(tmpdir(), 'eaon-remote-'))
  home = join(root, 'home')
  store.patchSettings({ work: { ...store.getSettings().work, defaultFolder: root } })
  store.patchSettings({ remote: { enabled: false, port: 0, token: null } })
  seen = []
})

afterEach(async () => {
  await server?.stop()
  server = null
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

type Behaviour = (request: StreamRequest, emit: (event: StreamEvent) => void, options: RunOptions) => Promise<RunOutcome> | RunOutcome

/** A fake runAgent that records what it was asked; `behave` decides each reply. */
function fakeAgent(behave: Behaviour | string = 'Done.') {
  const requests: StreamRequest[] = []
  const runAgent: RunAgent = async (request, emit, opts) => {
    requests.push(structuredClone(request))
    if (typeof behave === 'string') {
      emit({ type: 'delta', messageId: request.messageId, text: behave })
      emit({ type: 'done', messageId: request.messageId })
      return { text: behave, usage }
    }
    return behave(request, emit, opts)
  }
  return { runAgent, requests }
}

/**
 * A goal turn that ends the way a real one between steps does: the worker
 * sleeps until a set time, or (`done`) finishes the goal. A goal turn that
 * just ended carries on at once (workers/engine.ts), so an agent that only
 * says "Done." would go through its whole turn budget in a moment.
 */
function goalAgent(engine: () => WorkersEngine, done = false) {
  return fakeAgent((request, emit) => {
    if (request.goal && done) {
      emit({ type: 'goal', messageId: request.messageId, chatId: request.chatId, goal: { ...request.goal, status: 'achieved', summary: 'Shipped' } })
    } else if (request.goal) {
      engine().sleep(request.workerId!, 30, 'waiting on the build')
    }
    emit({ type: 'delta', messageId: request.messageId, text: 'On it.' })
    emit({ type: 'done', messageId: request.messageId })
    return Promise.resolve({ text: 'On it.', usage })
  })
}

/** Replies only once released, or when its signal aborts — like the real loop. */
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

/**
 * A turn that reasons, speaks, runs two tools (one reading a file in the
 * worker's folder, one with a long command) and speaks again. Its text names
 * the worker's folder and the home directory, which must not reach the phone.
 */
function scriptedAgent() {
  return fakeAgent(async (request, emit) => {
    const id = request.messageId
    const folder = request.cwd!
    emit({ type: 'reasoning', messageId: id, text: 'secret thoughts about the plan' })
    emit({ type: 'delta', messageId: id, text: `Saved it to ${folder}/notes.md. ` })
    emit({ type: 'tool-call', messageId: id, toolId: 't1', name: 'read_file', input: { path: join(folder, 'notes.md') } })
    emit({ type: 'tool-result', messageId: id, toolId: 't1', output: 'x'.repeat(2000), status: 'done' })
    emit({ type: 'tool-call', messageId: id, toolId: 't2', name: 'run_command', input: { command: `cat ${join(home, 'Documents', 'a.txt')} ${'y'.repeat(300)}` } })
    emit({ type: 'tool-result', messageId: id, toolId: 't2', output: 'denied by policy', status: 'denied' })
    emit({ type: 'delta', messageId: id, text: 'All done.' })
    emit({ type: 'done', messageId: id })
    return { text: 'All done.', usage }
  })
}

function fakeContext(): FeatureContext {
  const window = { isFocused: () => false, isDestroyed: () => false, isMinimized: () => false, show() {}, focus() {}, restore() {}, webContents: { isLoading: () => false, once() {} } }
  return { ipcMain: { handle: () => {} }, getWindow: () => window, send: () => {}, emitStream: () => {} } as unknown as FeatureContext
}

function startService(runAgent: RunAgent, overrides: WorkersOverrides = {}): WorkersService {
  service = createWorkersService(fakeContext(), { runAgent, startDelayMs: 60_000, ...overrides })
  service.start()
  service.engine.start()
  return service
}

/** The workers service, with the remote server in front of it. */
async function boot(runAgent: RunAgent, options: Partial<RemoteServerOptions> = {}, overrides: WorkersOverrides = {}) {
  const svc = startService(runAgent, overrides)
  server = new RemoteServer({
    token: () => TOKEN,
    hub: svc.hub,
    api: {
      engine: svc.engine,
      remove: svc.remove,
      info: () => ({ name: 'Test Mac', appVersion: '1.2.3' }),
      models: remoteModels,
      defaultModel: defaultModelId,
      modelLabel: (m) => (m.modelId === 'big-model' ? 'Fake Model' : undefined),
      home
    },
    pingMs: 80,
    ...options
  })
  const status = await server.start(0)
  assert.equal(status.running, true, status.error)
  port = status.port
  return svc.engine
}

const draft = (name: string, extra: Partial<WorkerDraft> = {}): WorkerDraft => ({
  name,
  color: '#3E86C6',
  personality: 'Calm and plain-spoken.',
  purpose: `${name}'s job`,
  model: MODEL,
  ...extra
})

interface Reply {
  status: number
  headers: IncomingHttpHeaders
  text: string
  json: Json
}

/** One request, over a plain socket: the test decides every header, and the key defaults to the right one. */
function call(
  method: string,
  path: string,
  opts: { key?: string | null; body?: unknown; raw?: string | Buffer; headers?: Record<string, string>; port?: number } = {}
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const key = opts.key === undefined ? TOKEN : opts.key
    const payload = opts.raw !== undefined ? opts.raw : opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: opts.port ?? port,
        method,
        path,
        // A fresh connection each time, so a stopped server is seen as stopped.
        agent: false,
        headers: {
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
          ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
          ...opts.headers
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('error', reject)
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          seen.push(text)
          let json: Json = null
          try {
            json = JSON.parse(text)
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json })
        })
      }
    )
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

const get = (path: string): Promise<Reply> => call('GET', path)
const post = (path: string, body?: unknown): Promise<Reply> => call('POST', path, body === undefined ? {} : { body })

interface Feed {
  events: { event: string; data: Json }[]
  comments: number
  ended: boolean
  status: number
  contentType: string | undefined
  close: () => void
}

/** An open event stream, parsed as it arrives. */
function openEvents(key: string | null = TOKEN, at?: number): Promise<Feed> {
  return new Promise((resolve, reject) => {
    const feed: Feed = { events: [], comments: 0, ended: false, status: 0, contentType: undefined, close: () => req.destroy() }
    let buffer = ''
    const req = httpRequest({ host: '127.0.0.1', port: at ?? port, path: '/remote/v1/events', agent: false, headers: key ? { Authorization: `Bearer ${key}` } : {} }, (res) => {
      feed.status = res.statusCode ?? 0
      feed.contentType = res.headers['content-type']
      res.setEncoding('utf8')
      res.on('data', (text: string) => {
        buffer += text
        for (let end = buffer.indexOf('\n\n'); end !== -1; end = buffer.indexOf('\n\n')) {
          const block = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          if (block.startsWith(':')) {
            feed.comments++
            continue
          }
          const event = /^event: (.*)$/m.exec(block)?.[1]
          const data = /^data: (.*)$/m.exec(block)?.[1]
          if (event && data) feed.events.push({ event, data: JSON.parse(data) as Json })
        }
      })
      const over = (): void => {
        feed.ended = true
      }
      res.on('end', over)
      res.on('close', over)
      res.on('error', over)
      resolve(feed)
    })
    req.on('error', (error) => {
      feed.ended = true
      reject(error)
    })
    req.end()
  })
}

const WORKER_KEYS = [
  'access',
  'activity',
  'asks',
  'color',
  'createdAt',
  'goal',
  'goalRun',
  'id',
  'lastError',
  'lastOutcome',
  'lastRunAt',
  'model',
  'mood',
  'name',
  'nextWakeAt',
  'paused',
  'personality',
  'purpose',
  'routines',
  'runningMessageId',
  'status',
  'unread'
]

/* --------------------------------------------------------------------- auth */

test('every route needs the remote key: none, a wrong one and the Local API Server’s are all refused', async () => {
  await boot(fakeAgent().runAgent, { maxFailures: 1000 })
  const local = gatewayToken()
  assert.match(local, /^eaon-/)
  assert.equal(tokenAllowed({ authorization: `Bearer ${TOKEN}` }), 'wrong', 'and the remote key never works on the Local API Server')

  for (const path of ['/remote/v1/hello', '/remote/v1/workers', '/remote/v1/events', '/v1/models', '/nowhere']) {
    for (const key of [null, 'eaonr-wrong', local, '']) {
      const reply = await call('GET', path, { key })
      assert.equal(reply.status, 401, `${path} with ${key === null ? 'no key' : key || 'an empty key'}`)
      assert.equal(reply.json.error.code, 'unauthorized')
      assert.equal(typeof reply.json.error.message, 'string')
    }
  }
  assert.equal((await call('GET', '/remote/v1/hello', { key: null, headers: { Authorization: 'Basic abc' } })).status, 401, 'only a Bearer key counts')
  assert.equal((await call('GET', '/remote/v1/hello', { key: null, headers: { 'x-api-key': TOKEN } })).status, 401, 'and only in the Authorization header')
  assert.equal((await call('GET', '/remote/v1/hello', { key: null, headers: { Authorization: `Bearer ${TOKEN}x` } })).status, 401, 'a key with something added is wrong')
  assert.equal((await call('GET', '/remote/v1/hello', { key: null, headers: { Authorization: `bearer ${TOKEN}` } })).status, 200, 'the scheme is case-insensitive')
  assert.equal((await get('/remote/v1/hello')).status, 200)
  assert.equal(seen.filter((body) => body.includes(TOKEN)).length, 0, 'the key is never echoed')
})

test('a request from a web page is refused, key or not, and no CORS headers are ever sent', async () => {
  await boot(fakeAgent().runAgent)
  for (const key of [TOKEN, null]) {
    const reply = await call('GET', '/remote/v1/hello', { key, headers: { Origin: 'http://evil.example' } })
    assert.equal(reply.status, 403)
    assert.equal(reply.json.error.code, 'forbidden')
  }
  assert.equal((await call('GET', '/remote/v1/hello', { headers: { Origin: 'null' } })).status, 403, 'even "null"')
  assert.equal((await call('POST', '/v1/chat/completions', { body: { messages: [] }, headers: { Origin: 'http://localhost:3000' } })).status, 403, 'loopback pages too, and on /v1')
  const ok = await get('/remote/v1/hello')
  const refused = await call('OPTIONS', '/remote/v1/hello', { headers: { 'Access-Control-Request-Method': 'GET' } })
  for (const reply of [ok, refused]) {
    assert.deepEqual(Object.keys(reply.headers).filter((h) => h.startsWith('access-control-')), [])
  }
})

test('ten wrong keys from one address, and it is turned away for the next minute — even with the right key', async () => {
  let clock = 1_000_000
  await boot(fakeAgent().runAgent, { now: () => clock })
  for (let i = 0; i < 10; i++) assert.equal((await call('GET', '/remote/v1/hello', { key: `eaonr-guess-${i}` })).status, 401)
  const limited = await call('GET', '/remote/v1/hello', { key: 'eaonr-guess-11' })
  assert.equal(limited.status, 429)
  assert.equal(limited.json.error.code, 'rate_limited')
  const wait = Number(limited.headers['retry-after'])
  assert.ok(wait >= 1 && wait <= 60, `Retry-After ${wait}`)
  assert.equal((await get('/remote/v1/hello')).status, 429, 'the right key does not get a guesser back in')

  clock += 30_000
  assert.equal((await get('/remote/v1/hello')).status, 429)
  clock += 31_000
  assert.equal((await get('/remote/v1/hello')).status, 200, 'a minute later it may try again')
})

test('the key is read on every request, so replacing it locks the old one out at once', async () => {
  let key = TOKEN
  await boot(fakeAgent().runAgent, { token: () => key })
  assert.equal((await get('/remote/v1/hello')).status, 200)
  key = 'eaonr-the-new-key'
  assert.equal((await get('/remote/v1/hello')).status, 401)
  assert.equal((await call('GET', '/remote/v1/hello', { key })).status, 200)
})

test('an empty key is never a match', async () => {
  await boot(fakeAgent().runAgent, { token: () => '' })
  assert.equal((await call('GET', '/remote/v1/hello', { key: '' })).status, 401)
  assert.equal((await call('GET', '/remote/v1/hello', { headers: { Authorization: 'Bearer ' } })).status, 401)
})

/* ------------------------------------------------------------------ reading */

test('hello reports the app, the API version, the computer and how many workers are running', async () => {
  const agent = heldAgent()
  const engine = await boot(agent.runAgent)
  assert.deepEqual((await get('/remote/v1/hello')).json, { app: 'Eaon', apiVersion: 1, appVersion: '1.2.3', name: 'Test Mac', workers: 0, running: 0 })
  const nova = engine.save(draft('Nova'))
  engine.save(draft('Atlas'))
  engine.send(nova.id, 'go')
  await until(() => agent.requests.length === 1)
  const hello = (await get('/remote/v1/hello')).json
  assert.deepEqual([hello.workers, hello.running], [2, 1])
  assert.equal((await get('/remote/v1/hello')).headers['content-type'], 'application/json; charset=utf-8')
  agent.release()
})

test('a worker is listed and read as the contract has it, with nothing that is the Mac’s', async () => {
  const engine = await boot(fakeAgent().runAgent)
  const nova = engine.save(draft('Nova', { access: 'safe', color: '#E4574B' }))
  engine.setHeartbeat(nova.id, { inMinutes: 30, note: 'check the build' })
  engine.addRoutine(nova.id, { name: 'Morning', task: 'Summarise the news', daily: '08:30' })
  engine.setMemory(nova.id, { goal: 'Ship it', notes: 'a private note' })
  engine.setStatus(nova.id, 'Reading the docs')
  const atlas = engine.save(draft('Atlas', { model: null }))
  const state = engine.list().find((w) => w.id === nova.id)!

  const list = (await get('/remote/v1/workers')).json
  assert.deepEqual(list.workers.map((w: Json) => w.name), ['Nova', 'Atlas'])
  const w = list.workers[0]
  assert.deepEqual(Object.keys(w).sort(), WORKER_KEYS, 'exactly the contract’s fields')
  assert.deepEqual(
    { id: w.id, color: w.color, purpose: w.purpose, personality: w.personality, status: w.status, mood: w.mood, activity: w.activity, paused: w.paused, access: w.access },
    { id: nova.id, color: '#E4574B', purpose: "Nova's job", personality: 'Calm and plain-spoken.', status: 'idle', mood: 'neutral', activity: 'Reading the docs', paused: false, access: 'safe' }
  )
  assert.deepEqual(w.model, { ...MODEL, label: 'Fake Model' })
  assert.equal(w.goal, 'Ship it')
  assert.equal(w.goalRun, null)
  assert.deepEqual([w.asks, w.unread, w.lastRunAt, w.lastOutcome, w.lastError, w.runningMessageId], [[], 0, null, null, null, null])
  assert.equal(w.createdAt, nova.createdAt)
  assert.equal(w.nextWakeAt, Math.min(state.heartbeat.nextAt!, state.routines[0].nextAt), 'the soonest of the heartbeat and the routines')
  assert.deepEqual(w.routines, [{ id: state.routines[0].id, name: 'Morning', task: 'Summarise the news', everyMs: null, daily: '08:30', nextAt: state.routines[0].nextAt }])
  assert.equal(list.workers[1].model, null, 'null follows the app’s model')
  assert.equal(list.workers[1].nextWakeAt, null)

  const one = await get(`/remote/v1/workers/${atlas.id}`)
  assert.equal(one.status, 200)
  assert.equal(one.json.worker.name, 'Atlas')
  const missing = await get('/remote/v1/workers/nobody')
  assert.equal(missing.status, 404)
  assert.equal(missing.json.error.code, 'not_found')

  const everything = seen.join('\n')
  for (const secret of [nova.folder, atlas.folder, 'a private note']) assert.ok(!everything.includes(secret), `${secret} must not be sent`)
  assert.ok(!/"(folder|notes|inbox|trading|handoffs)"/.test(everything))
})

test('a paused worker has no next wake-up, and a goal run’s continuation counts', async () => {
  let engine!: WorkersEngine
  const agent = goalAgent(() => engine)
  engine = await boot(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  engine.send(nova.id, 'Get this done', [], { goal: true })
  await engine.whenIdle()
  const wake = engine.list()[0].heartbeat.nextAt
  assert.equal(typeof wake, 'number')
  let w = (await get(`/remote/v1/workers/${nova.id}`)).json.worker
  assert.equal(w.nextWakeAt, wake, 'the goal carries on when it wakes')
  assert.deepEqual(w.goalRun, { text: 'Get this done', status: 'active', turns: 1 })
  assert.equal(w.goal, 'Get this done')
  engine.setPaused(nova.id, true)
  w = (await get(`/remote/v1/workers/${nova.id}`)).json.worker
  assert.equal(w.nextWakeAt, null)
  assert.equal(w.mood, 'asleep')
})

/* ----------------------------------------------------------------- commands */

test('creating a worker: 201, defaults the way the desktop has them, a folder the phone never sees', async () => {
  const engine = await boot(fakeAgent().runAgent)
  const reply = await post('/remote/v1/workers', { name: '  Pixel ', purpose: 'Watch the build', personality: 'Dry.' })
  assert.equal(reply.status, 201)
  const w = reply.json.worker
  assert.deepEqual(Object.keys(w).sort(), WORKER_KEYS)
  assert.equal(w.name, 'Pixel')
  assert.equal(w.access, 'autonomous')
  assert.equal(w.model, null)
  assert.ok(WORKER_COLORS.includes(w.color), 'a colour from the palette when none is given')
  assert.deepEqual([w.status, w.paused, w.purpose, w.personality], ['idle', false, 'Watch the build', 'Dry.'])
  const made = engine.list()[0]
  assert.equal(made.id, w.id)
  assert.ok(existsSync(made.folder))
  assert.ok(!reply.text.includes(made.folder))

  const full = await post('/remote/v1/workers', { name: 'Atlas', purpose: 'Research', color: '#8E5CE6', access: 'read-only', model: MODEL })
  assert.equal(full.status, 201)
  assert.deepEqual([full.json.worker.color, full.json.worker.access, full.json.worker.model], ['#8E5CE6', 'read-only', { ...MODEL, label: 'Fake Model' }])
})

test('creating a worker: bad drafts are 400 with a message, and the 16th is a 409', async () => {
  const engine = await boot(fakeAgent().runAgent)
  const ok = { name: 'A', purpose: 'x' }
  const cases: [unknown, RegExp][] = [
    [{}, /name/],
    [{ name: 'A' }, /purpose/],
    [{ name: '   ', purpose: 'x' }, /name/],
    [{ name: 7, purpose: 'x' }, /name/],
    [{ name: 'x'.repeat(41), purpose: 'x' }, /40/],
    [{ ...ok, purpose: '' }, /purpose/],
    [{ ...ok, purpose: 'x'.repeat(2001) }, /2000/],
    [{ ...ok, personality: 'x'.repeat(601) }, /600/],
    [{ ...ok, color: 'red' }, /color/],
    [{ ...ok, color: '#12345' }, /color/],
    [{ ...ok, access: 'root' }, /access/],
    [{ ...ok, model: { providerId: 'p' } }, /model/],
    [{ ...ok, model: 'gpt' }, /model/]
  ]
  for (const [body, message] of cases) {
    const reply = await post('/remote/v1/workers', body)
    assert.equal(reply.status, 400, JSON.stringify(body))
    assert.equal(reply.json.error.code, 'invalid_request')
    assert.match(reply.json.error.message, message)
  }
  assert.equal((await call('POST', '/remote/v1/workers', { raw: 'not json' })).status, 400)
  assert.equal((await call('POST', '/remote/v1/workers', { raw: '[]' })).status, 400, 'a list is not a draft')
  assert.equal(engine.list().length, 0, 'nothing was made')

  assert.equal((await post('/remote/v1/workers', ok)).status, 201)
  const again = await post('/remote/v1/workers', ok)
  assert.equal(again.status, 400)
  assert.match(again.json.error.message, /already a worker called A/, 'the engine’s own words')

  for (let i = engine.list().length; i < MAX_WORKERS; i++) engine.save(draft(`W${i}`))
  const full = await post('/remote/v1/workers', { name: 'One too many', purpose: 'x' })
  assert.equal(full.status, 409)
  assert.equal(full.json.error.code, 'conflict')
  assert.match(full.json.error.message, new RegExp(`up to ${MAX_WORKERS}`))
})

test('editing a worker changes only what was sent', async () => {
  const engine = await boot(fakeAgent().runAgent)
  const nova = engine.save(draft('Nova', { color: '#E4574B', access: 'read-only' }))
  const patch = (body: unknown): Promise<Reply> => call('PATCH', `/remote/v1/workers/${nova.id}`, { body })

  let reply = await patch({ purpose: 'Research papers' })
  assert.equal(reply.status, 200)
  assert.deepEqual(
    { name: reply.json.worker.name, purpose: reply.json.worker.purpose, personality: reply.json.worker.personality, color: reply.json.worker.color, access: reply.json.worker.access, model: reply.json.worker.model },
    { name: 'Nova', purpose: 'Research papers', personality: 'Calm and plain-spoken.', color: '#E4574B', access: 'read-only', model: { ...MODEL, label: 'Fake Model' } }
  )
  reply = await patch({ name: 'Nova 2', access: 'safe', color: '#3E86C6', model: null, personality: '' })
  assert.deepEqual(
    [reply.json.worker.name, reply.json.worker.access, reply.json.worker.color, reply.json.worker.model, reply.json.worker.personality, reply.json.worker.purpose],
    ['Nova 2', 'safe', '#3E86C6', null, '', 'Research papers']
  )
  assert.equal(engine.list()[0].folder, nova.folder, 'editing never moves the folder')
  assert.equal((await patch({})).status, 200)
  assert.equal(engine.list()[0].name, 'Nova 2')

  for (const body of [{ name: '' }, { color: 'blue' }, { access: 'all' }, { purpose: '' }, [], { model: 3 }]) assert.equal((await patch(body)).status, 400, JSON.stringify(body))
  engine.save(draft('Taken'))
  const clash = await patch({ name: 'taken' })
  assert.equal(clash.status, 400)
  assert.match(clash.json.error.message, /already a worker/)
  assert.equal((await call('PATCH', '/remote/v1/workers/nobody', { body: { name: 'X' } })).status, 404)
})

test('removing a worker forgets it and leaves its folder on disk', async () => {
  const engine = await boot(fakeAgent().runAgent)
  const nova = engine.save(draft('Nova'))
  const reply = await call('DELETE', `/remote/v1/workers/${nova.id}`)
  assert.deepEqual([reply.status, reply.json], [200, { ok: true }])
  assert.equal(engine.list().length, 0)
  assert.ok(existsSync(nova.folder), 'the folder stays')
  assert.equal((await get(`/remote/v1/workers/${nova.id}`)).status, 404)
  assert.equal((await call('DELETE', `/remote/v1/workers/${nova.id}`)).status, 404)
})

test('sending reaches the worker as mail from the user, and a goal send sets its goal', async () => {
  let engine!: WorkersEngine
  const agent = goalAgent(() => engine, true)
  engine = await boot(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  const sent = await post(`/remote/v1/workers/${nova.id}/send`, { text: '  Find sources on tidal power ' })
  assert.deepEqual([sent.status, sent.json], [200, { ok: true }])
  await until(() => agent.requests.length === 1)
  await engine.whenIdle()
  const asked = agent.requests[0].history.at(-1)!
  assert.match(asked.parts[0].type === 'text' ? asked.parts[0].text : '', /\[From the user\] Find sources on tidal power$/)
  assert.deepEqual(asked.mail!.map((m) => [m.from, m.fromName, m.text, m.files, m.goal]), [['user', 'You', 'Find sources on tidal power', [], undefined]])
  assert.equal(engine.list()[0].goalRun, null)

  assert.equal((await post(`/remote/v1/workers/${nova.id}/send`, { text: 'Ship the release', goal: true })).status, 200)
  await until(() => agent.requests.length === 2)
  await engine.whenIdle()
  const goalMail = engine.getThread(nova.id).messages.filter((m) => m.mail).at(-1)!.mail![0]
  assert.equal(goalMail.goal, true)
  const state = engine.list()[0]
  assert.equal(state.goal, 'Ship the release')
  assert.equal(state.goalRun?.text, 'Ship the release')
  assert.equal(state.goalRun?.status, 'achieved', 'it ran in goal mode and finished')
})

test('sending: what is not a message is a 400, a missing worker a 404, and a paused worker still takes mail', async () => {
  const agent = fakeAgent()
  const engine = await boot(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  const url = `/remote/v1/workers/${nova.id}/send`
  for (const body of [{}, { text: '' }, { text: '   ' }, { text: 5 }, { text: 'x'.repeat(8001) }, { text: 'hi', goal: 'yes' }, []]) {
    const reply = await post(url, body)
    assert.equal(reply.status, 400, JSON.stringify(body).slice(0, 40))
    assert.equal(reply.json.error.code, 'invalid_request')
  }
  assert.equal((await post('/remote/v1/workers/nobody/send', { text: 'hi' })).status, 404)
  await settle()
  assert.equal(agent.requests.length, 0, 'nothing reached the worker')

  engine.setPaused(nova.id, true)
  assert.equal((await post(url, { text: 'x'.repeat(8000) })).status, 200, 'the longest allowed')
  await settle()
  assert.equal(agent.requests.length, 0, 'held, as in the app')
  assert.equal(engine.list()[0].inbox.length, 1)
})

test('stop aborts only the running turn', async () => {
  const agent = heldAgent()
  const engine = await boot(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  assert.equal((await post(`/remote/v1/workers/${nova.id}/stop`)).status, 200, 'nothing running: still fine')
  engine.send(nova.id, 'go')
  await until(() => agent.requests.length === 1)
  let w = (await get(`/remote/v1/workers/${nova.id}`)).json.worker
  assert.equal(w.status, 'working')
  assert.equal(typeof w.runningMessageId, 'string')
  assert.deepEqual((await post(`/remote/v1/workers/${nova.id}/stop`)).json, { ok: true })
  await engine.whenIdle()
  w = (await get(`/remote/v1/workers/${nova.id}`)).json.worker
  assert.notEqual(w.status, 'working')
  assert.equal(w.runningMessageId, null)
  assert.equal(w.paused, false, 'the worker itself carries on')
  assert.equal(w.activity, 'Stopped')
})

test('wake runs a check-in turn, and a paused worker says so with a 409', async () => {
  const agent = fakeAgent()
  const engine = await boot(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  assert.deepEqual((await post(`/remote/v1/workers/${nova.id}/wake`)).json, { ok: true })
  await until(() => agent.requests.length === 1)
  await engine.whenIdle()
  assert.match(JSON.stringify(agent.requests[0].history.at(-1)), /check in now/)
  engine.setPaused(nova.id, true)
  const refused = await post(`/remote/v1/workers/${nova.id}/wake`)
  assert.equal(refused.status, 409)
  assert.equal(refused.json.error.code, 'conflict')
  assert.match(refused.json.error.message, /paused/)
  assert.equal((await post('/remote/v1/workers/nobody/wake')).status, 404)
})

test('pause and resume answer with the worker', async () => {
  const engine = await boot(fakeAgent().runAgent)
  const nova = engine.save(draft('Nova'))
  const url = `/remote/v1/workers/${nova.id}/pause`
  let reply = await post(url, { paused: true })
  assert.equal(reply.status, 200)
  assert.deepEqual([reply.json.worker.paused, reply.json.worker.status, reply.json.worker.mood], [true, 'paused', 'asleep'])
  assert.equal(engine.list()[0].paused, true)
  reply = await post(url, { paused: false })
  assert.deepEqual([reply.json.worker.paused, reply.json.worker.status], [false, 'asleep'], 'nothing scheduled: it sleeps until written to')
  for (const body of [{}, { paused: 'yes' }, { paused: 1 }, []]) assert.equal((await post(url, body)).status, 400)
})

test('the goal can be paused, resumed and cleared, and a worker with none says so', async () => {
  let engine!: WorkersEngine
  const agent = goalAgent(() => engine)
  engine = await boot(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  const url = `/remote/v1/workers/${nova.id}/goal`
  const none = await post(url, { status: 'paused' })
  assert.equal(none.status, 409)
  assert.match(none.json.error.message, /no goal/)

  engine.send(nova.id, 'Reach the summit', [], { goal: true })
  await engine.whenIdle()
  const goalStatus = async (): Promise<string | undefined> => (await get(`/remote/v1/workers/${nova.id}`)).json.worker.goalRun?.status
  assert.deepEqual((await post(url, { status: 'paused' })).json, { ok: true })
  assert.equal(await goalStatus(), 'paused')
  assert.equal(engine.list()[0].goalRun?.pausedByUser, true)
  assert.deepEqual((await post(url, { status: 'active' })).json, { ok: true })
  await engine.whenIdle()
  assert.equal(await goalStatus(), 'active')
  assert.deepEqual((await post(url, { status: null })).json, { ok: true })
  assert.equal((await get(`/remote/v1/workers/${nova.id}`)).json.worker.goalRun, null)
  for (const body of [{}, { status: 'done' }, { status: 3 }]) assert.equal((await post(url, body)).status, 400, JSON.stringify(body))
})

test('answering: approving once reaches the engine, declining does not, and the call’s arguments are never sent', async () => {
  const agent = fakeAgent()
  const engine = await boot(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  const email = { to: 'bill@example.com', body: 'Pay up' }
  const approve = engine.ask(nova.id, { question: 'Send the reminder?', options: ['Yes', 'No'], approve: { tool: 'email_send', input: email, summary: 'Email bill@example.com' } })
  const plain = engine.ask(nova.id, { question: 'Which colour?', options: ['Red', 'Blue'] })

  const w = (await get(`/remote/v1/workers/${nova.id}`)).json.worker
  assert.deepEqual(w.asks, [
    { id: approve.id, question: 'Send the reminder?', options: ['Yes', 'No'], approve: { tool: 'email_send', summary: 'Email bill@example.com' }, at: approve.at },
    { id: plain.id, question: 'Which colour?', options: ['Red', 'Blue'], approve: null, at: plain.at }
  ])
  assert.ok(!seen.join('').includes('Pay up'), 'what the call would send stays on the Mac')
  assert.equal(w.mood, 'curious')

  const url = `/remote/v1/workers/${nova.id}/answer`
  assert.equal((await post(url, { askId: approve.id })).status, 400, 'an action must be approved or declined')
  assert.equal((await post(url, { askId: approve.id, approved: 'yes' })).status, 400)
  assert.equal((await post(url, { askId: plain.id })).status, 400, 'a question wants an answer')
  assert.equal((await post(url, { text: 'Red' })).status, 400, 'and says which')
  assert.equal(engine.list()[0].asks.length, 2, 'nothing was answered yet')

  assert.deepEqual((await post(url, { askId: approve.id, approved: true })).json, { ok: true })
  assert.equal(engine.allowOnce(nova.id, 'email_send', email), true, 'approve once flowed to the engine')
  assert.equal(engine.allowOnce(nova.id, 'email_send', email), false, 'and only once')
  await until(() => agent.requests.length === 1)
  await engine.whenIdle()
  assert.match(JSON.stringify(agent.requests[0].history.at(-1)), /Approved: Email bill@example\.com/)

  assert.deepEqual((await post(url, { askId: plain.id, text: 'Blue' })).json, { ok: true })
  await until(() => agent.requests.length === 2)
  await engine.whenIdle()
  assert.match(JSON.stringify(agent.requests[1].history.at(-1)), /\[Answer to \\"Which colour\?\\"\] Blue/)
  assert.equal(engine.list()[0].asks.length, 0)
  const gone = await post(url, { askId: approve.id, approved: true })
  assert.equal(gone.status, 404, 'the question is gone')
  assert.equal(gone.json.error.code, 'not_found')

  const refused = engine.ask(nova.id, { question: 'Wipe the disk?', approve: { tool: 'run_command', input: { command: 'rm -rf x' }, summary: 'Wipe x' } })
  assert.deepEqual((await post(url, { askId: refused.id, approved: false, text: 'no way' })).json, { ok: true })
  assert.equal(engine.allowOnce(nova.id, 'run_command', { command: 'rm -rf x' }), false, 'declined: nothing is let through')
  await until(() => agent.requests.length === 3)
  await engine.whenIdle()
  assert.match(JSON.stringify(agent.requests[2].history.at(-1)), /Declined: Wipe x — no way/)
})

test('clear empties the thread and read marks it read', async () => {
  const agent = fakeAgent()
  const engine = await boot(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  engine.send(nova.id, 'hello')
  await engine.whenIdle()
  assert.equal((await get(`/remote/v1/workers/${nova.id}`)).json.worker.unread, 1)
  assert.deepEqual((await post(`/remote/v1/workers/${nova.id}/read`)).json, { ok: true })
  assert.equal((await get(`/remote/v1/workers/${nova.id}`)).json.worker.unread, 0)
  assert.equal((await get(`/remote/v1/workers/${nova.id}/thread`)).json.messages.length, 2)
  assert.deepEqual((await post(`/remote/v1/workers/${nova.id}/clear`)).json, { ok: true })
  assert.deepEqual((await get(`/remote/v1/workers/${nova.id}/thread`)).json, { messages: [], hasMore: false })
  assert.equal(engine.list()[0].name, 'Nova', 'the worker stays')
  assert.equal((await post('/remote/v1/workers/nobody/clear')).status, 404)
})

/* ------------------------------------------------------------------- thread */

test('the thread: pages, tool steps in order, no reasoning, notes on scheduled turns, and no paths', async () => {
  const agent = scriptedAgent()
  const engine = await boot(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  const atlasFile = '/etc/secret-file.txt'
  for (let i = 1; i <= 4; i++) {
    engine.send(nova.id, `Question ${i}`)
    await engine.whenIdle()
  }
  engine.wake(nova.id)
  await engine.whenIdle()
  engine.receive(nova.id, { from: 'atlas-id', fromName: 'Atlas', fromColor: '#8E5CE6', text: 'FYI the build is green', files: [atlasFile] })
  await engine.whenIdle()
  engine.receive(nova.id, { from: 'atlas-id', fromName: 'Atlas', fromColor: '#8E5CE6', text: '  ', files: [atlasFile] })
  await engine.whenIdle()
  assert.equal(engine.getThread(nova.id).messages.length, 14, 'seven turns, two messages each')

  const url = `/remote/v1/workers/${nova.id}/thread`
  const all = (await get(url)).json
  assert.equal(all.hasMore, false)
  const roles = all.messages.map((m: Json) => m.role)
  assert.equal(all.messages.length, 13, 'the wake-up’s opening message is not shown')
  assert.equal(roles.filter((r: string) => r === 'user').length, 6)
  assert.deepEqual(all.messages.map((m: Json) => m.at), [...all.messages.map((m: Json) => m.at)].sort((a, b) => a - b), 'oldest first')
  assert.ok(all.messages.every((m: Json) => m.streaming === false))

  const [first, reply] = all.messages
  assert.deepEqual(first, { id: first.id, role: 'user', at: first.at, parts: [{ kind: 'text', text: 'Question 1' }], streaming: false })
  assert.equal(reply.role, 'assistant')
  assert.deepEqual(reply.parts.map((p: Json) => p.kind), ['text', 'tool', 'tool', 'text'], 'text and tool steps in the order they happened')
  assert.equal(reply.parts[0].text, 'Saved it to ./notes.md. ', 'the worker’s folder is "."')
  assert.deepEqual(reply.parts[1], {
    kind: 'tool',
    id: 't1',
    name: 'read_file',
    title: 'Read a file',
    detail: './notes.md',
    status: 'done',
    output: `${'x'.repeat(799)}…`
  })
  assert.equal(reply.parts[2].status, 'denied')
  assert.equal(reply.parts[2].title, 'Ran a command')
  assert.ok(reply.parts[2].detail.length <= 120 && reply.parts[2].detail.endsWith('…'), 'one line, 120 characters at most')
  assert.ok(reply.parts[2].detail.startsWith('cat ~/Documents/a.txt yyy'), 'the home directory is "~"')
  assert.equal(reply.parts[2].output, 'denied by policy')
  assert.equal(reply.parts[3].text, 'All done.')
  assert.equal(JSON.stringify(all).includes('secret thoughts'), false, 'reasoning is never sent')
  assert.equal(JSON.stringify(all).includes('reasoning'), false)

  const wake = all.messages.find((m: Json) => m.heartbeat !== undefined)
  assert.equal(wake.role, 'assistant')
  assert.equal(wake.heartbeat, CHECK_IN)
  assert.equal(all.messages.filter((m: Json) => m.heartbeat !== undefined).length, 1)

  const atlas = all.messages.filter((m: Json) => m.from)
  assert.deepEqual(atlas.map((m: Json) => [m.from, m.parts]), [
    [{ name: 'Atlas', color: '#8E5CE6' }, [{ kind: 'text', text: 'Atlas: FYI the build is green' }]],
    [{ name: 'Atlas', color: '#8E5CE6' }, [{ kind: 'text', text: 'Atlas: [1 file attached]' }]]
  ])
  assert.ok(all.messages.filter((m: Json) => m.role === 'user' && !m.from).every((m: Json) => m.parts.length === 1 && !m.parts[0].text.startsWith('[')), 'the user’s own turns are just their words')

  // Paged: the last four, then the four before, then the rest, with no overlap.
  const p1 = (await get(`${url}?limit=4`)).json
  assert.deepEqual(p1.messages.map((m: Json) => m.id), all.messages.slice(-4).map((m: Json) => m.id))
  assert.equal(p1.hasMore, true)
  const p2 = (await get(`${url}?limit=4&before=${p1.messages[0].id}`)).json
  assert.deepEqual(p2.messages.map((m: Json) => m.id), all.messages.slice(-8, -4).map((m: Json) => m.id))
  assert.equal(p2.hasMore, true)
  const p3 = (await get(`${url}?limit=4&before=${p2.messages[0].id}`)).json
  assert.deepEqual(p3.messages.map((m: Json) => m.id), all.messages.slice(1, 5).map((m: Json) => m.id))
  assert.equal(p3.hasMore, true)
  const p4 = (await get(`${url}?limit=4&before=${p3.messages[0].id}`)).json
  assert.deepEqual(p4.messages.map((m: Json) => m.id), all.messages.slice(0, 1).map((m: Json) => m.id))
  assert.equal(p4.hasMore, false)
  assert.equal((await get(`${url}?limit=13`)).json.hasMore, false, 'exactly all of it')
  assert.equal((await get(`${url}?limit=12`)).json.hasMore, true)
  assert.deepEqual((await get(`${url}?before=${all.messages[0].id}`)).json, { messages: [], hasMore: false })
  const [a, b] = [(await get(`${url}?limit=1`)).json, (await get(`${url}?limit=100`)).json]
  assert.equal(a.messages.length, 1)
  assert.equal(b.messages.length, 13)

  for (const query of ['limit=0', 'limit=101', 'limit=abc', 'limit=2.5', 'limit=-1']) {
    const reply = await get(`${url}?${query}`)
    assert.equal(reply.status, 400, query)
    assert.equal(reply.json.error.code, 'invalid_request')
  }
  const gone = await get(`${url}?before=no-such-message`)
  assert.equal(gone.status, 404)
  assert.equal(gone.json.error.code, 'not_found')
  assert.equal((await get('/remote/v1/workers/nobody/thread')).status, 404)

  // Nowhere, in anything the server said, is a path.
  const everything = seen.join('\n')
  for (const path of [nova.folder, atlasFile, home, root]) assert.ok(!everything.includes(path), `${path} must not be sent`)
  assert.ok(!/"(files|attachments|mail)"/.test(everything))
})

/* ------------------------------------------------------------- event stream */

test('the event stream: a snapshot first, then the turn’s messages, text, tool steps and worker changes', async () => {
  const agent = scriptedAgent()
  const engine = await boot(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  const feed = await openEvents()
  assert.equal(feed.status, 200)
  assert.match(feed.contentType ?? '', /^text\/event-stream/)
  await until(() => feed.events.length >= 1)
  assert.equal(feed.events[0].event, 'workers', 'the full list on connect')
  assert.deepEqual(feed.events[0].data.workers.map((w: Json) => w.id), [nova.id])
  assert.equal(server!.streamCount, 1)

  await post(`/remote/v1/workers/${nova.id}/send`, { text: 'Look at the notes' })
  await until(() => feed.events.some((e) => e.event === 'message' && e.data.message.role === 'assistant' && e.data.message.streaming === false))
  const ofKind = (name: string): Json[] => feed.events.filter((e) => e.event === name).map((e) => e.data)

  const messages = ofKind('message')
  assert.deepEqual(messages.map((m) => [m.workerId, m.message.role, m.message.streaming]), [
    [nova.id, 'user', false],
    [nova.id, 'assistant', true],
    [nova.id, 'assistant', false]
  ])
  assert.deepEqual(messages[0].message.parts, [{ kind: 'text', text: 'Look at the notes' }])
  assert.deepEqual(messages[1].message.parts, [], 'the reply starts empty')
  assert.equal(messages[1].message.id, messages[2].message.id, 'and is then replaced whole')
  assert.deepEqual(messages[2].message.parts.map((p: Json) => p.kind), ['text', 'tool', 'tool', 'text'])

  const messageId = messages[1].message.id
  const deltas = ofKind('delta')
  assert.ok(deltas.every((d) => d.workerId === nova.id && d.messageId === messageId))
  assert.equal(deltas.map((d) => d.text).join(''), 'Saved it to ./notes.md. All done.', 'text only, scrubbed, reasoning left out')

  const tools = ofKind('tool')
  assert.deepEqual(tools.map((t) => [t.part.id, t.part.status]), [['t1', 'running'], ['t1', 'done'], ['t2', 'running'], ['t2', 'denied']])
  assert.ok(tools.every((t) => t.messageId === messageId))
  assert.equal(tools[0].part.title, 'Read a file')
  assert.equal(tools[0].part.detail, './notes.md')
  assert.equal(tools[0].part.output, undefined, 'a step that has not finished has no output')
  assert.equal(tools[1].part.title, 'Read a file', 'the result carries its call’s title and detail')
  assert.equal(tools[1].part.detail, './notes.md')
  assert.equal(tools[1].part.output.length, 800)

  // The text before a tool step arrives before it.
  const order = feed.events.filter((e) => ['delta', 'tool'].includes(e.event)).map((e) => (e.event === 'tool' ? `tool:${e.data.part.id}:${e.data.part.status}` : 'delta'))
  assert.deepEqual(order, ['delta', 'tool:t1:running', 'tool:t1:done', 'tool:t2:running', 'tool:t2:denied', 'delta'])

  const lists = ofKind('workers')
  assert.ok(lists.some((l) => l.workers[0].status === 'working' && typeof l.workers[0].runningMessageId === 'string'))
  await until(() => ofKind('workers').at(-1).workers[0].status !== 'working')
  assert.equal(ofKind('workers').at(-1).workers[0].runningMessageId, null)
  assert.equal(ofKind('workers').at(-1).workers[0].unread, 1)

  const text = JSON.stringify(feed.events)
  for (const path of [nova.folder, home, 'secret thoughts']) assert.ok(!text.includes(path), `${path} must not be streamed`)

  // The stream goes away cleanly when the phone does.
  feed.close()
  await until(() => server!.streamCount === 0)
})

test('the event stream: a scheduled turn’s note rides on its reply, and a path split across deltas is still scrubbed', async () => {
  let folder = ''
  const agent = fakeAgent(async (request, emit) => {
    folder = request.cwd!
    const id = request.messageId
    emit({ type: 'delta', messageId: id, text: `Wrote ${folder.slice(0, 14)}` })
    await settle(40)
    emit({ type: 'delta', messageId: id, text: `${folder.slice(14, 30)}` })
    await settle(40)
    emit({ type: 'delta', messageId: id, text: `${folder.slice(30)}/out.md and ${folder.slice(0, 9)}` })
    await settle(40)
    emit({ type: 'done', messageId: id })
    return { text: 'Wrote it', usage }
  })
  const engine = await boot(agent.runAgent)
  const nova = engine.save(draft('Nova'))
  const feed = await openEvents()
  await post(`/remote/v1/workers/${nova.id}/wake`)
  await until(() => feed.events.some((e) => e.event === 'message' && e.data.message.role === 'assistant' && e.data.message.streaming === false))
  const messages = feed.events.filter((e) => e.event === 'message').map((e) => e.data.message)
  assert.deepEqual(messages.map((m: Json) => m.role), ['assistant', 'assistant'], 'a wake-up has no user message to show')
  assert.deepEqual(messages.map((m: Json) => m.heartbeat), [CHECK_IN, CHECK_IN], 'the note is on the reply, at the start and at the end')

  const deltas = feed.events.filter((e) => e.event === 'delta').map((e) => e.data.text as string)
  assert.ok(deltas.length >= 2, 'it did arrive in pieces')
  const streamed = deltas.join('')
  assert.ok(!streamed.includes(folder), 'the folder never gets through in one piece')
  assert.ok(!streamed.includes(folder.slice(0, 20)), 'nor half of it')
  assert.equal(streamed, `Wrote ./out.md and ${folder.slice(0, 9)}`, 'a tail that merely looked like a path is let out when the turn ends')
  assert.equal(messages[1].parts[0].text, `Wrote ./out.md and ${folder.slice(0, 9)}`)
  feed.close()
})

test('the event stream pings while it is quiet, and a stream with the wrong key or from a web page is refused', async () => {
  await boot(fakeAgent().runAgent, { pingMs: 50 })
  const feed = await openEvents()
  await until(() => feed.comments >= 2)
  assert.equal(feed.ended, false)
  feed.close()
  assert.equal((await openEvents(null).catch(() => ({ status: 0 }))).status, 401)
  assert.equal((await openEvents('eaonr-wrong')).status, 401)
  const page = await call('GET', '/remote/v1/events', { headers: { Origin: 'https://evil.example' } })
  assert.equal(page.status, 403)
})

test('disconnecting hangs up on every open stream; a stopped server is gone', async () => {
  await boot(fakeAgent().runAgent)
  const feeds = [await openEvents(), await openEvents()]
  await until(() => server!.streamCount === 2)
  server!.disconnect()
  await until(() => feeds.every((f) => f.ended))
  assert.equal(server!.streamCount, 0)
  assert.equal((await get('/remote/v1/hello')).status, 200, 'the server itself carries on, for a phone with the right key')

  const again = await openEvents()
  await until(() => server!.streamCount === 1)
  await server!.stop()
  await until(() => again.ended)
  assert.equal(server!.status().running, false)
  await assert.rejects(get('/remote/v1/hello'), /ECONNREFUSED/)
})

test('a worker that changes nothing a phone sees sends no new list', async () => {
  const engine = await boot(fakeAgent().runAgent)
  const nova = engine.save(draft('Nova'))
  const feed = await openEvents()
  await until(() => feed.events.length === 1)
  engine.markRead(nova.id)
  engine.setStatus(nova.id, 'Reading')
  engine.setStatus(nova.id, 'Reading')
  await settle(50)
  assert.equal(feed.events.filter((e) => e.event === 'workers').length, 2, 'the snapshot, and the one change')
  assert.equal(feed.events.at(-1)!.data.workers[0].activity, 'Reading')
  feed.close()
})

/* ------------------------------------------------------------------- limits */

test('a body over 256 KB is a 413, declared or not, and the limit is not the app’s on every route', async () => {
  const engine = await boot(fakeAgent().runAgent)
  const nova = engine.save(draft('Nova'))
  const big = JSON.stringify({ text: 'x'.repeat(300 * 1024) })
  const declared = await call('POST', `/remote/v1/workers/${nova.id}/send`, { raw: big })
  assert.equal(declared.status, 413)
  assert.equal(declared.json.error.code, 'too_large')

  // No Content-Length: counted as it arrives.
  const chunked = await new Promise<Reply>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: `/remote/v1/workers/${nova.id}/send`, agent: false, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: JSON.parse(text) as Json })
      })
    })
    req.on('error', reject)
    for (let i = 0; i < 3; i++) req.write('x'.repeat(100 * 1024))
    req.end()
  })
  assert.equal(chunked.status, 413)
  assert.equal(engine.list()[0].inbox.length, 0, 'nothing was delivered')

  assert.equal((await post(`/remote/v1/workers/${nova.id}/pause`, { paused: false })).status, 200, 'the same connection pool still works after')
  assert.equal((await call('POST', '/remote/v1/workers', { raw: JSON.stringify({ name: 'A', purpose: 'x'.repeat(200 * 1024) }) })).status, 400, 'under the limit it is validated, not refused')
})

test('an unknown route is a 404 once the key is right, a wrong method too', async () => {
  await boot(fakeAgent().runAgent)
  for (const [method, path] of [
    ['GET', '/'],
    ['GET', '/remote'],
    ['GET', '/remote/v1'],
    ['GET', '/remote/v1/nope'],
    ['GET', '/remote/v2/hello'],
    ['POST', '/remote/v1/hello'],
    ['DELETE', '/remote/v1/workers'],
    ['GET', '/remote/v1/workers/x/stop'],
    ['POST', '/remote/v1/workers/x/frobnicate'],
    ['GET', '/remote/v1/workers/x/thread/extra'],
    ['GET', '/models'],
    ['POST', '/chat/completions'],
    ['POST', '/v1/responses'],
    ['POST', '/v1/messages'],
    ['GET', '/docs']
  ]) {
    const reply = await call(method, path)
    assert.equal(reply.status, 404, `${method} ${path}`)
    assert.equal(reply.json.error.code, 'not_found')
  }
})

test('an error from inside never shows its insides', async () => {
  const engine = await boot(fakeAgent().runAgent)
  const nova = engine.save(draft('Nova'))
  const original = engine.setPaused.bind(engine)
  engine.setPaused = () => {
    throw new Error(`boom at ${nova.folder}`)
  }
  const reply = await post(`/remote/v1/workers/${nova.id}/pause`, { paused: true })
  engine.setPaused = original
  assert.equal(reply.status, 500)
  assert.deepEqual(reply.json, { error: { code: 'server_error', message: 'Something went wrong in Eaon.' } })
})

/* ---------------------------------------------------------------- the models */

test('the Mac’s models: listed for pinning a worker, with the app’s own pick as the default', async () => {
  await boot(fakeAgent().runAgent)
  store.patchSettings({ selectedModelId: null, selectedProviderId: null })
  let reply = await get('/remote/v1/models')
  assert.equal(reply.status, 200)
  assert.deepEqual(reply.json.models.filter((m: Json) => m.provider === 'Fake'), [
    { id: 'fake/big-model', name: 'Big', provider: 'Fake' },
    { id: 'fake/tiny-model', name: 'Tiny', provider: 'Fake' }
  ])
  assert.equal(reply.json.default, null)
  store.patchSettings({ selectedModelId: 'tiny-model', selectedProviderId: 'fake' })
  reply = await get('/remote/v1/models')
  assert.equal(reply.json.default, 'fake/tiny-model')
  store.patchSettings({ selectedModelId: 'not-a-model', selectedProviderId: 'fake' })
  assert.equal((await get('/remote/v1/models')).json.default, null)
  store.patchSettings({ selectedModelId: null, selectedProviderId: null })
  assert.equal((await call('GET', '/remote/v1/models', { key: null })).status, 401)
})

test('/v1/models and /v1/chat/completions are the gateway’s, behind the remote key and nothing else', async () => {
  await boot(fakeAgent().runAgent, { maxFailures: 1000, maxChatBody: 1024 * 1024 })
  const body = { model: 'fake/big-model', messages: [{ role: 'user', content: 'hi' }] }
  const local = gatewayToken()
  for (const key of [null, 'eaonr-wrong', local]) {
    assert.equal((await call('GET', '/v1/models', { key })).status, 401, 'models, key: ' + String(key))
    assert.equal((await call('POST', '/v1/chat/completions', { key, body })).status, 401, 'chat, key: ' + String(key))
  }
  assert.equal(upstream.requests.length, 0, 'nothing was spent')

  const models = await get('/v1/models')
  assert.equal(models.status, 200)
  assert.equal(models.json.object, 'list')
  assert.ok(models.json.data.some((m: Json) => m.id === 'fake/big-model' && m.object === 'model' && m.owned_by === 'fake'))

  upstreamReply = () => [chunk({ content: 'Hello from the Mac' }, 'stop')]
  const done = await call('POST', '/v1/chat/completions', { body })
  assert.equal(done.status, 200)
  assert.equal(done.json.choices[0].message.content, 'Hello from the Mac')
  assert.equal(done.json.choices[0].finish_reason, 'stop')
  assert.equal((upstream.requests.at(-1) as { model: string }).model, 'big-model', 'the provider gets its own model id')

  const streamed = await call('POST', '/v1/chat/completions', { body: { ...body, stream: true } })
  assert.equal(streamed.status, 200)
  assert.match(streamed.headers['content-type'] ?? '', /text\/event-stream/)
  assert.match(streamed.text, /Hello from the Mac/)
  assert.match(streamed.text, /data: \[DONE\]\n\n$/)

  assert.equal((await call('POST', '/v1/chat/completions', { raw: '[]' })).status, 400)
  assert.equal((await call('POST', '/v1/chat/completions', { raw: '{nope' })).status, 400)
  assert.equal((await call('POST', '/v1/chat/completions', { body: { messages: [] } })).status, 400)
  assert.equal((await call('POST', '/v1/chat/completions', { body, headers: { Origin: 'http://localhost' } })).status, 403)

  const images = { ...body, messages: [{ role: 'user', content: 'x'.repeat(400 * 1024) }] }
  assert.equal((await call('POST', '/v1/chat/completions', { body: images })).status, 200, 'a chat may carry more than a command (images)')
  assert.equal((await call('POST', '/v1/chat/completions', { raw: 'x'.repeat(1200 * 1024) })).status, 413, 'but not without end')
  upstreamReply = () => [chunk({ content: 'ok' }, 'stop')]
})

test('/v1 chat stops when the keys are reset: its stream is hung up on', async () => {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => (release = resolve))
  const chats: string[] = []
  await boot(fakeAgent().runAgent, {
    gateway: {
      models: () => [],
      chat: async (res) => {
        chats.push('open')
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('data: {"hello":1}\n\n')
        res.on('close', () => chats.push('closed'))
        await gate
        res.end()
      }
    }
  })
  const pending = call('POST', '/v1/chat/completions', { body: { messages: [{ role: 'user', content: 'x' }] } }).catch((error: Error) => error)
  await until(() => chats.includes('open'))
  server!.disconnect()
  await until(() => chats.includes('closed'))
  release()
  assert.ok(await pending)
})

/* ------------------------------------------------------------ wiring (Settings) */

/** A fake `dns-sd`: records how it was started and whether it was killed. */
function fakeSpawn() {
  const children: { cmd: string; args: string[]; killed: boolean }[] = []
  const spawn = ((cmd: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      killed: false,
      kill() {
        record.killed = true
        child.emit('exit')
        return true
      }
    })
    const record = { cmd, args, killed: false }
    children.push(record)
    return child
  }) as unknown as typeof Spawn
  return { spawn, children }
}

test('off by default; turning it on makes the key, starts the server and the announcement, and off closes both', async () => {
  const svc = startService(fakeAgent().runAgent)
  const dns = fakeSpawn()
  const statuses: boolean[] = []
  const remote = createRemote({
    hub: svc.hub,
    engine: svc.engine,
    remove: svc.remove,
    onStatus: (s) => statuses.push(s.running),
    bonjour: new Bonjour({ platform: 'darwin', spawn: dns.spawn }),
    server: { pingMs: 50 }
  })
  assert.deepEqual(store.getSettings().remote, { enabled: false, port: 0, token: null })

  await remote.launch()
  assert.equal(remote.server.status().running, false, 'nothing listens until it is turned on')
  assert.equal(dns.children.length, 0)
  let info = await remote.info()
  assert.deepEqual([info.enabled, info.status.running, info.token, info.link], [false, false, null, null])
  assert.ok(info.computerName.length > 0 && info.hostName.endsWith('.local'))

  info = await remote.setEnabled(true)
  assert.deepEqual([info.enabled, info.status.running], [true, true])
  assert.match(info.token!, /^eaonr-[A-Za-z0-9_-]{32}$/, 'eaonr- and 24 random bytes, base64url')
  assert.equal(store.getSettings().remote.token, info.token)
  assert.equal(store.getSettings().remote.enabled, true)
  const at = info.status.port
  assert.ok(at > 0)
  const link = new URL(info.link!)
  assert.equal(link.protocol, 'eaon:')
  assert.equal(link.host, 'pair')
  assert.deepEqual(
    [link.searchParams.get('v'), link.searchParams.get('port'), link.searchParams.get('key'), link.searchParams.get('name')],
    ['1', String(at), info.token, info.computerName]
  )
  assert.ok([...info.addresses, info.hostName].includes(link.searchParams.get('host')!))
  assert.equal((await call('GET', '/remote/v1/hello', { key: info.token, port: at })).status, 200)
  assert.equal((await call('GET', '/remote/v1/hello', { key: gatewayToken(), port: at })).status, 401)

  assert.equal(dns.children.length, 1, 'announced over Bonjour')
  const [advert] = dns.children
  assert.equal(advert.cmd, 'dns-sd')
  assert.deepEqual(advert.args.slice(0, 2), ['-R', instanceName(info.computerName)])
  assert.deepEqual(advert.args.slice(2, 6), ['_eaon._tcp', 'local', String(at), 'v=1'])
  assert.deepEqual(advert.args.slice(6), [`host=${info.hostName}`, `port=${at}`])
  assert.ok(!advert.args.join(' ').includes(info.token!), 'the key is never advertised')

  info = await remote.setEnabled(false)
  assert.deepEqual([info.enabled, info.status.running], [false, false])
  assert.equal(info.token, store.getSettings().remote.token, 'the key is kept for next time')
  assert.equal(advert.killed, true, 'the announcement ends with it')
  await assert.rejects(call('GET', '/remote/v1/hello', { key: info.token, port: at }), /ECONNREFUSED/)
  assert.ok(statuses.includes(true) && statuses.at(-1) === false)

  info = await remote.setEnabled(true)
  assert.equal(info.token, store.getSettings().remote.token)
  assert.equal(dns.children.length, 2)
  remote.dispose()
  assert.equal(dns.children[1].killed, true, 'quitting ends the announcement too')
  await settle(20)
  assert.equal(remote.server.status().running, false)
})

test('at launch the server starts when settings say so, and not otherwise', async () => {
  const svc = startService(fakeAgent().runAgent)
  store.patchSettings({ remote: { enabled: true, port: 0, token: 'eaonr-saved-key' } })
  const dns = fakeSpawn()
  const remote = createRemote({ hub: svc.hub, engine: svc.engine, remove: svc.remove, bonjour: new Bonjour({ platform: 'darwin', spawn: dns.spawn }) })
  await remote.launch()
  assert.equal(remote.server.status().running, true)
  const at = remote.server.status().port
  assert.equal((await call('GET', '/remote/v1/hello', { key: 'eaonr-saved-key', port: at })).status, 200, 'the saved key is the key')
  assert.equal(dns.children.length, 1)
  await remote.stop()
  assert.equal(dns.children[0].killed, true)
  assert.equal(remote.server.status().running, false)
})

test('a key that is missing is made when the server starts, never sooner', async () => {
  const svc = startService(fakeAgent().runAgent)
  store.patchSettings({ remote: { enabled: true, port: 0, token: null } })
  const remote = createRemote({ hub: svc.hub, engine: svc.engine, remove: svc.remove, bonjour: new Bonjour({ platform: 'linux' }) })
  assert.equal(store.getSettings().remote.token, null)
  await remote.launch()
  const token = store.getSettings().remote.token!
  assert.match(token, /^eaonr-/)
  assert.equal((await call('GET', '/remote/v1/hello', { key: token, port: remote.server.status().port })).status, 200)
  await remote.stop()
})

test('Reset key: a new key, every open stream closed, the old key refused, the link follows', async () => {
  const svc = startService(fakeAgent().runAgent)
  const dns = fakeSpawn()
  const remote = createRemote({
    hub: svc.hub,
    engine: svc.engine,
    remove: svc.remove,
    bonjour: new Bonjour({ platform: 'darwin', spawn: dns.spawn }),
    server: { pingMs: 50 }
  })
  const before = await remote.setEnabled(true)
  const at = before.status.port
  const feed = await openEvents(before.token, at)
  await until(() => remote.server.streamCount === 1)

  const after = await remote.resetToken()
  assert.notEqual(after.token, before.token)
  assert.match(after.token!, /^eaonr-/)
  assert.equal(store.getSettings().remote.token, after.token)
  assert.equal(new URL(after.link!).searchParams.get('key'), after.token)
  await until(() => feed.ended)
  assert.equal(remote.server.streamCount, 0)
  assert.equal((await call('GET', '/remote/v1/hello', { key: before.token, port: at })).status, 401, 'the old key is dead')
  assert.equal((await call('GET', '/remote/v1/hello', { key: after.token, port: at })).status, 200)
  assert.equal((await remote.info()).status.running, true, 'the server keeps running')
  assert.equal(dns.children.length, 1, 'and the announcement, which never held a key, is left alone')
  assert.equal(dns.children[0].killed, false)
  await remote.stop()
})

test('moving the port moves the server, the announcement and the link; a bad port is refused', async () => {
  const svc = startService(fakeAgent().runAgent)
  const dns = fakeSpawn()
  const remote = createRemote({ hub: svc.hub, engine: svc.engine, remove: svc.remove, bonjour: new Bonjour({ platform: 'darwin', spawn: dns.spawn }) })
  const before = await remote.setEnabled(true)
  for (const bad of [80, 1023, 65536, 3.5, Number.NaN]) await assert.rejects(remote.setPort(bad), /between 1024 and 65535/)

  const free = await new Promise<number>((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const p = (probe.address() as { port: number }).port
      probe.close(() => resolve(p))
    })
  })
  const moved = await remote.setPort(free)
  assert.equal(moved.status.running, true)
  assert.equal(moved.status.port, free)
  assert.equal(store.getSettings().remote.port, free)
  assert.equal(new URL(moved.link!).searchParams.get('port'), String(free))
  assert.equal(dns.children.length, 2)
  assert.equal(dns.children[0].killed, true)
  assert.ok(dns.children[1].args.includes(`port=${free}`))
  assert.equal((await call('GET', '/remote/v1/hello', { key: moved.token, port: free })).status, 200)
  await assert.rejects(call('GET', '/remote/v1/hello', { key: before.token, port: before.status.port }), /ECONNREFUSED/)
  await remote.stop()
})

test('a port that is taken is a status for the page, not a crash', async () => {
  const svc = startService(fakeAgent().runAgent)
  const first = new RemoteServer({ token: () => TOKEN, hub: svc.hub, api: { engine: svc.engine, remove: svc.remove, info: () => ({ name: 'x', appVersion: 'y' }), models: () => [], defaultModel: () => null } })
  const taken = (await first.start(0)).port
  const statuses: { running: boolean; error?: string }[] = []
  server = new RemoteServer({
    token: () => TOKEN,
    hub: svc.hub,
    api: { engine: svc.engine, remove: svc.remove, info: () => ({ name: 'x', appVersion: 'y' }), models: () => [], defaultModel: () => null },
    onStatus: (s) => statuses.push(s)
  })
  const status = await server.start(taken)
  assert.equal(status.running, false)
  assert.match(status.error!, new RegExp(`Port ${taken} is already in use`))
  assert.equal(statuses.at(-1)?.running, false)
  assert.equal((await server.start(70000)).running, false, 'an out-of-range port is reported too')
  assert.match(server.status().error!, /not a valid port/)
  await first.stop()
})

test('the hub gives the remote server what the window gets, and a listener that throws harms nobody', async () => {
  const agent = scriptedAgent()
  const sent: string[] = []
  const ctx = { ...fakeContext(), send: (channel: string) => sent.push(channel) } as FeatureContext
  service = createWorkersService(ctx, { runAgent: agent.runAgent, startDelayMs: 60_000 })
  service.start()
  service.engine.start()
  const heard: string[] = []
  service.hub.subscribe({
    changed: () => {
      throw new Error('a broken listener')
    }
  })
  service.hub.subscribe({
    changed: () => heard.push('changed'),
    message: (_id, m) => heard.push(`message:${m.role}`),
    event: (_id, e) => heard.push(`event:${e.type}`)
  })
  const nova = service.engine.save(draft('Nova'))
  service.engine.send(nova.id, 'hi')
  await service.engine.whenIdle()
  assert.ok(heard.includes('changed'))
  assert.deepEqual(heard.filter((h) => h.startsWith('message:')), ['message:user', 'message:assistant', 'message:assistant'])
  const events = heard.filter((h) => h.startsWith('event:'))
  assert.ok(events.includes('event:tool-call') && events.includes('event:tool-result') && events.includes('event:delta') && events.includes('event:done'))
  assert.equal(events.filter((e) => e === 'event:delta').length, 2, 'consecutive text is merged per frame, as for the window; a tool call splits it')
  assert.deepEqual([...new Set(sent)].filter((c) => c.startsWith('workers:')).sort(), ['workers:changed', 'workers:delegations', 'workers:event', 'workers:execution', 'workers:message'], 'the IPC sends are as they were')
})

test('settings: old files without remote load with the defaults, and a nested patch keeps the rest', () => {
  writeFileSync(join(process.env.EAON_TEST_USERDATA!, 'store', 'settings.json'), JSON.stringify({ general: { language: 'French' }, localServer: { port: 4242 } }))
  const settings = store.getSettings()
  assert.deepEqual(settings.remote, { enabled: false, port: 3266, token: null }, 'defaults: off, 3266, no key')
  assert.equal(settings.general.language, 'French')
  assert.equal(settings.localServer.port, 4242)
  assert.equal(settings.notifications.taskComplete, true, 'and everything else is still filled in')
  store.patchSettings({ remote: { enabled: true, port: 4100, token: null } })
  store.patchSettings({ remote: { ...store.getSettings().remote, token: 'eaonr-abc' } })
  assert.deepEqual(store.getSettings().remote, { enabled: true, port: 4100, token: 'eaonr-abc' })
  store.patchSettings({ remote: { ...store.getSettings().remote, token: null } })
  assert.equal(store.getSettings().remote.token, null, 'a null clears it')
  assert.equal(store.getSettings().localServer.port, settings.localServer.port, 'the other servers’ settings are untouched')
})
