import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StreamEvent } from '@shared/types'
import { createCodexEngine, type CodexEngineOptions } from '../src/main/engines/codex'
import { classify, compareVersions, findCodexCandidates, inspectCopies, latestVersion, updateHint, type LatestVersionCache } from '../src/main/engines/codex/locate'
import { providerTarget, selfRouteReason } from '../src/main/engines/codex/guard'
import { displayCommand } from '../src/main/engines/codex/turn'
import { toRecord } from '../src/main/engines/codex/models'
import type { EngineApprovalRequest, EngineTurnInput } from '../src/main/engines/types'

/**
 * The Codex engine against a fake `codex` (test/fixtures/fake-codex.mjs) that
 * speaks Codex's app-server protocol. Every engine is disposed in `finally`
 * and every test checks that no fake process outlives it.
 */

const FIXTURE = join(process.cwd(), 'test/fixtures/fake-codex.mjs')

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `eaon-codex-${prefix}-`))
}

/** A `codex` executable that runs the fake with a fixed version. */
function fakeCodex(dir: string, version = '0.160.0', name = 'codex'): string {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\nFAKE_CODEX_VERSION="\${FAKE_CODEX_VERSION:-${version}}" exec "${process.execPath}" "${FIXTURE}" "$@"\n`)
  chmodSync(path, 0o755)
  return path
}

function memoryStore(): NonNullable<CodexEngineOptions['store']> & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    getJson: <T>(name: string, fallback: T): T => (data.has(name) ? (JSON.parse(JSON.stringify(data.get(name))) as T) : fallback),
    setJson: (name: string, value: unknown) => void data.set(name, JSON.parse(JSON.stringify(value)))
  }
}

interface Harness {
  engine: ReturnType<typeof createCodexEngine>
  state: string
  work: string
  scenario: Record<string, string>
  store: ReturnType<typeof memoryStore>
  opened: string[]
  requests: () => { pid: number; method: string; params: Record<string, unknown> }[]
  done: () => Promise<void>
}

function harness(overrides: Partial<CodexEngineOptions> & { version?: string; scenario?: Record<string, string>; state?: string; store?: ReturnType<typeof memoryStore> } = {}): Harness {
  const root = tempDir('h')
  const bin = join(root, 'bin')
  fakeCodex(bin, overrides.version ?? '0.160.0')
  const state = overrides.state ?? join(root, 'state')
  mkdirSync(state, { recursive: true })
  const work = join(root, 'work')
  mkdirSync(work)
  const scenario: Record<string, string> = { ...(overrides.scenario ?? {}) }
  const store = overrides.store ?? memoryStore()
  const opened: string[] = []
  const engine = createCodexEngine({
    discovery: { env: { PATH: bin }, home: root, platform: 'darwin', appDirs: [], npmPrefix: async () => null, systemDirs: [] },
    env: () => ({ ...process.env, EAON_CODEX_BIN: '', EAON_OFFLINE: '1', FAKE_CODEX_STATE: state, ...scenario }),
    store,
    openExternal: (url) => void opened.push(url),
    ownPorts: () => [1337],
    isOwnServerUrl: () => false,
    clientVersion: '0.0.0-test',
    controlIdleMs: 200,
    sessionIdleMs: 60_000,
    interruptGraceMs: 3000,
    ...overrides
  })
  const requests = (): { pid: number; method: string; params: Record<string, unknown> }[] => {
    const file = join(state, 'requests.jsonl')
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  }
  return {
    engine,
    state,
    work,
    scenario,
    store,
    opened,
    requests,
    done: async () => {
      await engine.dispose()
      assertNoFakeLeft(state)
      rmSync(root, { recursive: true, force: true })
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Every fake app-server this test started has exited (its pid file is gone, and the pid is dead). */
function assertNoFakeLeft(state: string): void {
  if (!existsSync(state)) return
  const left = readdirSync(state)
    .filter((f) => f.startsWith('pid-'))
    .map((f) => Number(f.slice(4)))
    .filter(alive)
  for (const pid of left) process.kill(pid, 'SIGKILL')
  assert.deepEqual(left, [], 'a fake Codex process outlived the test')
}

function turnInput(h: Harness, text: string, extra: Partial<EngineTurnInput> = {}): EngineTurnInput & { events: StreamEvent[]; asked: EngineApprovalRequest[] } {
  const events: StreamEvent[] = []
  const asked: EngineApprovalRequest[] = []
  return {
    sessionId: null,
    messageId: 'msg-1',
    cwd: h.work,
    model: null,
    effort: null,
    instructions: 'You are Ada, a careful test worker.',
    text,
    images: [],
    access: 'autonomous',
    signal: new AbortController().signal,
    emit: (event) => void events.push(event),
    approve: async (request) => {
      asked.push(request)
      return true
    },
    events,
    asked,
    ...extra
  }
}

/* -------------------------------------------------------------- detection */

test('discovery finds every copy, uses the newest, and says where it came from', async () => {
  const root = tempDir('find')
  try {
    const onPath = fakeCodex(join(root, 'path-bin'), '0.150.0')
    const npm = fakeCodex(join(root, 'npm', 'bin'), '0.160.0')
    const bundled = fakeCodex(join(root, 'Apps', 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin'), '0.161.0')
    fakeCodex(join(root, 'home', '.local', 'bin'), '0.155.0')
    const candidates = await findCodexCandidates({
      env: { PATH: join(root, 'path-bin') },
      home: join(root, 'home'),
      platform: 'darwin',
      appDirs: [join(root, 'Apps')],
      npmPrefix: async () => join(root, 'npm'),
      systemDirs: []
    })
    assert.deepEqual(
      candidates.map((c) => [c.path, c.source]),
      [
        [onPath, 'path'],
        [npm, 'npm'],
        [join(root, 'home', '.local', 'bin', 'codex'), 'path'],
        [bundled, 'chatgpt-app']
      ]
    )
    const copies = await inspectCopies(candidates)
    assert.deepEqual(
      copies.map((c) => c.version),
      ['0.161.0', '0.160.0', '0.155.0', '0.150.0']
    )
    assert.equal(copies[0].source, 'chatgpt-app')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a symlinked copy is classified by where it really lives, and seen once', async () => {
  const root = tempDir('link')
  try {
    const real = fakeCodex(join(root, 'lib', 'node_modules', '@openai', 'codex', 'bin'), '0.160.0', 'codex.js')
    mkdirSync(join(root, 'bin'))
    symlinkSync(real, join(root, 'bin', 'codex'))
    const candidates = await findCodexCandidates({
      env: { PATH: join(root, 'bin') },
      home: root,
      platform: 'darwin',
      appDirs: [],
      npmPrefix: async () => root,
      systemDirs: []
    })
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0].source, 'npm')
    assert.equal(classify('/opt/homebrew/Caskroom/codex/0.160.0/codex', root), 'homebrew')
    assert.equal(updateHint('npm'), 'npm i -g @openai/codex@latest')
    assert.equal(updateHint('homebrew', '/opt/homebrew/Caskroom/codex/0.160.0/codex'), 'brew upgrade --cask codex')
    assert.match(updateHint('chatgpt-app'), /Update the ChatGPT app/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('EAON_CODEX_BIN replaces the search; "none" means not installed', async () => {
  const root = tempDir('override')
  try {
    const custom = fakeCodex(join(root, 'custom'), '0.160.0')
    fakeCodex(join(root, 'path-bin'), '0.170.0')
    const base = { home: root, platform: 'darwin' as const, appDirs: [], npmPrefix: async () => null, systemDirs: [] }
    const chosen = await findCodexCandidates({ ...base, env: { PATH: join(root, 'path-bin'), EAON_CODEX_BIN: custom } })
    assert.deepEqual(chosen, [{ path: custom, source: 'override' }])
    assert.deepEqual(await findCodexCandidates({ ...base, env: { PATH: join(root, 'path-bin'), EAON_CODEX_BIN: 'none' } }), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('not installed: says so, with how to get it, and runTurn refuses with not-installed', async () => {
  const root = tempDir('none')
  const engine = createCodexEngine({
    discovery: { env: { PATH: join(root, 'empty') }, home: root, platform: 'darwin', appDirs: [], npmPrefix: async () => null, systemDirs: [] },
    env: () => ({ ...process.env, EAON_OFFLINE: '1' }),
    store: memoryStore()
  })
  try {
    const status = await engine.detect()
    assert.equal(status.installed, false)
    assert.equal(status.path, null)
    assert.match(status.updateHint ?? '', /ChatGPT desktop app|npm i -g @openai\/codex/)
    const result = await engine.runTurn(turnInput({ work: root } as Harness, 'hi'))
    assert.equal(result.errorKind, 'not-installed')
    const models = await engine.listModels()
    assert.equal(models.models[0]?.source.kind, 'shipped')
    assert.ok(models.staleBecause)
  } finally {
    await engine.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------- versions, updates */

test('versions compare as semver, pre-releases below their release', () => {
  assert.equal(compareVersions('0.160.0', '0.99.0'), 1)
  assert.equal(compareVersions('0.99.0', '0.99.0'), 0)
  assert.equal(compareVersions('0.161.0-alpha.2', '0.161.0'), -1)
  assert.equal(compareVersions('1.0.0', '0.999.999'), 1)
})

test('an outdated Codex is reported as such and never started', { timeout: 20_000 }, async () => {
  const h = harness({ version: '0.98.0' })
  try {
    const status = await h.engine.detect()
    assert.equal(status.installed, true)
    assert.equal(status.version, '0.98.0')
    assert.equal(status.outdated, true)
    assert.equal(status.minVersion, '0.99.0')
    assert.equal(status.foundIn, 'PATH')
    assert.equal(h.requests().length, 0, 'an outdated app-server must not be asked anything')
    const result = await h.engine.runTurn(turnInput(h, 'hello'))
    assert.equal(result.errorKind, 'outdated')
    assert.match(result.error ?? '', /0\.99\.0/)
  } finally {
    await h.done()
  }
})

test('the latest version comes from npm at most every 6 hours and survives being offline', async () => {
  let fetched = 0
  let fail = false
  let cache: LatestVersionCache | null = null
  let clock = 1_000_000
  const deps = {
    read: () => cache,
    write: (value: LatestVersionCache) => void (cache = value),
    now: () => clock,
    fetch: (async () => {
      fetched++
      if (fail) throw new Error('offline')
      return new Response(JSON.stringify({ latest: '0.161.0', alpha: '0.162.0-alpha.1' }), { status: 200 })
    }) as typeof fetch
  }
  assert.equal(await latestVersion(deps), '0.161.0')
  assert.equal(fetched, 1)
  clock += 60 * 60_000
  assert.equal(await latestVersion(deps), '0.161.0')
  assert.equal(fetched, 1, 'a fresh answer is reused')
  clock += 6 * 60 * 60_000
  fail = true
  assert.equal(await latestVersion(deps), '0.161.0', 'offline keeps the last answer')
  assert.equal(fetched, 2)
  assert.equal(await latestVersion({ ...deps, offline: true }), '0.161.0')
})

test('an update is offered with the right hint for where Codex came from', { timeout: 20_000 }, async () => {
  const h = harness()
  // Online for this one: the engine reads EAON_OFFLINE from its env.
  const engine = createCodexEngine({
    discovery: { env: { PATH: join(h.state, '..', 'bin') }, home: h.state, platform: 'darwin', appDirs: [], npmPrefix: async () => null, systemDirs: [] },
    env: () => ({ ...process.env, EAON_OFFLINE: '', FAKE_CODEX_STATE: h.state }),
    store: memoryStore(),
    fetch: (async () => new Response(JSON.stringify({ latest: '0.161.0' }))) as typeof fetch,
    controlIdleMs: 100
  })
  try {
    const status = await engine.detect()
    assert.equal(status.version, '0.160.0')
    assert.equal(status.latestVersion, '0.161.0')
    assert.equal(status.updateAvailable, true)
    assert.equal(status.outdated, false)
    assert.ok(status.updateHint)
  } finally {
    await engine.dispose()
    await h.done()
  }
})

/* ------------------------------------------------------------------- auth */

for (const [scenario, expected] of [
  [{ FAKE_CODEX_ACCOUNT: 'chatgpt:pro' }, { state: 'signed-in', method: 'ChatGPT', plan: 'Pro' }],
  [{ FAKE_CODEX_ACCOUNT: 'chatgpt:free', FAKE_CODEX_SESSION: 'offline' }, { state: 'signed-in', method: 'ChatGPT', plan: 'Free' }],
  [{ FAKE_CODEX_ACCOUNT: 'chatgpt:plus', FAKE_CODEX_SESSION: 'expired' }, { state: 'expired', method: 'ChatGPT', plan: 'Plus' }],
  [{ FAKE_CODEX_ACCOUNT: 'none' }, { state: 'signed-out', method: null, plan: null }],
  [{ FAKE_CODEX_ACCOUNT: 'not-required' }, { state: 'not-required', method: null, plan: null }],
  [{ FAKE_CODEX_ACCOUNT: 'apikey' }, { state: 'signed-in', method: 'API key', plan: null }]
] as const) {
  test(`auth: ${JSON.stringify(scenario)} → ${expected.state}`, { timeout: 20_000 }, async () => {
    const h = harness({ scenario: { ...scenario } })
    try {
      const status = await h.engine.detect()
      assert.deepEqual(status.auth, expected)
      assert.equal(status.error, null)
      if (expected.state === 'signed-out' || expected.state === 'expired') {
        const result = await h.engine.runTurn(turnInput(h, 'hello'))
        assert.equal(result.errorKind, expected.state === 'expired' ? 'auth-expired' : 'signed-out')
        assert.equal(h.requests().filter((r) => r.method === 'turn/start').length, 0)
      }
    } finally {
      await h.done()
    }
  })
}

test('sign-in opens Codex’s page, resolves when Codex reports success, and can be cancelled or time out', { timeout: 30_000 }, async () => {
  const h = harness({ scenario: { FAKE_CODEX_ACCOUNT: 'none' } })
  try {
    await h.engine.login!()
    assert.equal(h.opened.length, 1)
    assert.match(h.opened[0], /^https:\/\/auth\.example\.invalid\/authorize/)

    h.scenario.FAKE_CODEX_LOGIN = 'never'
    // The control process is reused while it lives; let it go so the new scenario applies.
    await new Promise((r) => setTimeout(r, 400))
    const waiting = h.engine.login!()
    for (let i = 0; i < 200 && h.opened.length < 2; i++) await new Promise((r) => setTimeout(r, 20))
    assert.equal(h.opened.length, 2)
    await h.engine.cancelLogin!()
    await assert.rejects(waiting, /Sign-in cancelled/)

    h.scenario.FAKE_CODEX_LOGIN = 'fail'
    await new Promise((r) => setTimeout(r, 400))
    await assert.rejects(h.engine.login!(), /didn’t finish/)
  } finally {
    await h.done()
  }
  const t = harness({ scenario: { FAKE_CODEX_ACCOUNT: 'none', FAKE_CODEX_LOGIN: 'never' }, loginTimeoutMs: 300 })
  try {
    await assert.rejects(t.engine.login!(), /timed out/)
  } finally {
    await t.done()
  }
})

/* ----------------------------------------------------------------- models */

test('models: every page is read, efforts and vision come only from Codex, and a failure falls back to the cache', { timeout: 30_000 }, async () => {
  const store = memoryStore()
  const h = harness({ store, scenario: { FAKE_CODEX_MODELS: '5', FAKE_CODEX_PAGE: '2' } })
  try {
    const live = await h.engine.listModels()
    assert.equal(live.staleBecause, null)
    assert.deepEqual(
      live.models.map((m) => m.id),
      ['fake-model-1', 'fake-model-2', 'fake-model-3', 'fake-model-4', 'fake-model-5']
    )
    assert.ok(live.models.every((m) => m.source.kind === 'engine-live'))
    const pages = h.requests().filter((r) => r.method === 'model/list')
    assert.deepEqual(
      pages.map((r) => r.params.cursor),
      [null, '2', '4']
    )
    // fake-model-4 lists low..ultra: Codex's "ultra" has no Eaon level and is left out, never guessed.
    assert.deepEqual(live.models[3].efforts, ['light', 'medium', 'high', 'extra-high', 'ultra'])
    assert.deepEqual(live.models[0].efforts, ['light', 'medium', 'high'])
    assert.equal(live.models[0].defaultEffort, 'medium')
    assert.equal(live.models[0].vision, true)
    assert.equal(live.models[1].vision, false)
    assert.equal(live.models[0].isDefault, true)
    const retrievedAt = live.retrievedAt

    h.scenario.FAKE_CODEX_MODELS_FAIL = '1'
    await new Promise((r) => setTimeout(r, 400)) // let the control process go so the failing one starts
    const stale = await h.engine.listModels({ force: true })
    assert.equal(stale.models.length, 5, 'the last good list is still shown')
    assert.ok(stale.models.every((m) => m.source.kind === 'cache'))
    assert.equal(stale.retrievedAt, retrievedAt)
    assert.match(stale.staleBecause ?? '', /Couldn’t refresh Codex’s models/)
    assert.equal((store.data.get('engine-codex-models.json') as { retrievedAt: number }).retrievedAt, retrievedAt, 'a failure never replaces the cache')
  } finally {
    await h.done()
  }
  // No cache at all: the shipped list, marked as such.
  const fresh = harness({ scenario: { FAKE_CODEX_MODELS_FAIL: '1' } })
  try {
    const shipped = await fresh.engine.listModels()
    assert.ok(shipped.models.length > 0)
    assert.ok(shipped.models.every((m) => m.source.kind === 'shipped'))
    assert.equal(shipped.retrievedAt, null)
  } finally {
    await fresh.done()
  }
})

test('model records keep Codex’s own effort spelling and only claim vision when Codex lists images', () => {
  const record = toRecord({ id: 'm', displayName: 'M', supportedReasoningEfforts: [{ reasoningEffort: 'xhigh' }, { reasoningEffort: 'ultra' }, { reasoningEffort: 'low' }], defaultReasoningEffort: 'ultra', inputModalities: ['text'] })
  assert.deepEqual(record.efforts, [
    { level: 'light', wire: 'low' },
    { level: 'extra-high', wire: 'xhigh' }
  ])
  assert.deepEqual(record.unmapped, ['ultra'])
  assert.equal(record.defaultEffort, null)
  assert.equal(record.vision, false)
  assert.equal(toRecord({ id: 'n' }).vision, null)
})

/* ------------------------------------------------------------------ turns */

test('a full turn: text, reasoning, a command with live output, usage, and the thread settings Eaon chose', { timeout: 30_000 }, async () => {
  const h = harness()
  try {
    const input = turnInput(h, 'please run the tests', { model: 'fake-model-2', effort: 'extra-high' })
    const result = await h.engine.runTurn(input)
    assert.equal(result.error, undefined)
    assert.equal(result.cancelled, false)
    assert.equal(result.text, 'Hello there.')
    assert.ok(result.sessionId)
    assert.equal(result.sideEffects, true)
    assert.equal(result.billing, 'plan')
    // Two model requests (before and after the command), each 100 input of which 20 cached, and 30 output.
    assert.deepEqual(result.usage, { input: 160, output: 60, cacheRead: 40, cacheWrite: 0 })

    const types = input.events.map((e) => e.type)
    assert.ok(types.includes('reasoning'))
    const call = input.events.find((e) => e.type === 'tool-call')
    assert.deepEqual(call && call.type === 'tool-call' ? [call.name, call.input.command] : null, ['run_command', 'npm test'])
    const progress = input.events.find((e) => e.type === 'tool-progress')
    assert.ok(progress && progress.type === 'tool-progress' && progress.output.includes('running tests'))
    const toolResult = input.events.find((e) => e.type === 'tool-result')
    assert.ok(toolResult && toolResult.type === 'tool-result')
    assert.equal(toolResult.status, 'done')
    assert.equal(toolResult.output, 'exit code 0\nrunning tests\n3 passed')
    const text = input.events.filter((e) => e.type === 'delta').map((e) => (e.type === 'delta' ? e.text : '')).join('')
    assert.equal(text, 'Hello there.')
    assert.ok(input.events.some((e) => e.type === 'usage'))
    assert.equal(input.asked.length, 0, 'autonomous: Codex runs inside its sandbox without asking')

    const start = h.requests().find((r) => r.method === 'thread/start')!
    assert.equal(start.params.approvalPolicy, 'on-request')
    assert.equal(start.params.sandbox, 'workspace-write')
    assert.equal(start.params.approvalsReviewer, 'user')
    assert.equal(start.params.developerInstructions, 'You are Ada, a careful test worker.')
    const turn = h.requests().find((r) => r.method === 'turn/start')!
    assert.equal(turn.params.model, 'fake-model-2')
    assert.deepEqual(turn.params.sandboxPolicy, { type: 'workspaceWrite' })
    assert.equal(turn.params.cwd, h.work)
  } finally {
    await h.done()
  }
})

test('effort is sent in the model’s own spelling, clamped to what it takes', { timeout: 30_000 }, async () => {
  const h = harness()
  try {
    await h.engine.listModels()
    // fake-model-1 takes low/medium/high: Max clamps down to high.
    const result = await h.engine.runTurn(turnInput(h, 'hello', { model: 'fake-model-1', effort: 'ultra' }))
    assert.equal(result.error, undefined)
    const turn = h.requests().find((r) => r.method === 'turn/start')!
    assert.equal(turn.params.effort, 'high')
  } finally {
    await h.done()
  }
})

test('plans become todos, and read-only work runs in a read-only sandbox with nothing to ask', { timeout: 30_000 }, async () => {
  const h = harness()
  try {
    const input = turnInput(h, 'make a plan', { access: 'read-only' })
    const result = await h.engine.runTurn(input)
    assert.equal(result.error, undefined)
    assert.equal(result.sideEffects, false)
    const todos = input.events.find((e) => e.type === 'todos')
    assert.ok(todos && todos.type === 'todos')
    assert.deepEqual(todos.todos, [
      { text: 'Look around', status: 'done' },
      { text: 'Make the change', status: 'in_progress' },
      { text: 'Test it', status: 'pending' }
    ])
    const start = h.requests().find((r) => r.method === 'thread/start')!
    assert.equal(start.params.approvalPolicy, 'never')
    assert.equal(start.params.sandbox, 'read-only')
  } finally {
    await h.done()
  }
})

test('approvals go to input.approve: allowed runs, refused is declined, for commands, edits and MCP tools', { timeout: 30_000 }, async () => {
  const h = harness()
  try {
    const allow = turnInput(h, 'run the tests then patch', { access: 'safe' })
    const allowed = await h.engine.runTurn(allow)
    assert.equal(allowed.error, undefined)
    assert.deepEqual(
      allow.asked.map((a) => [a.tool, a.summary, a.mutating]),
      [
        ['run_command', 'npm test', true],
        ['apply_patch', 'Edit notes.txt', true]
      ]
    )
    const answers = h.requests().filter((r) => r.method === 'approval-answer')
    assert.deepEqual(
      answers.map((a) => a.params.decision),
      ['accept', 'accept']
    )
    assert.equal(allowed.sideEffects, true)

    const deny = turnInput(h, 'run the tests then patch and use mcp', { access: 'safe', sessionId: allowed.sessionId, approve: async (request) => (deny.asked.push(request), false) })
    const denied = await h.engine.runTurn(deny)
    assert.equal(denied.error, undefined)
    const results = deny.events.filter((e) => e.type === 'tool-result')
    assert.deepEqual(
      results.map((e) => (e.type === 'tool-result' ? e.status : '')),
      ['denied', 'denied', 'error']
    )
    assert.deepEqual(
      deny.asked.map((a) => a.tool),
      ['run_command', 'apply_patch', 'mcp_tool']
    )
    assert.deepEqual(deny.asked[2].input, { server: 'tickets', tool: 'close_ticket', arguments: { id: 'T-1' } })
    const later = h.requests().filter((r) => r.method === 'approval-answer').slice(2)
    assert.deepEqual(
      later.map((a) => (a.params as { decision?: string; answers?: Record<string, { answers: string[] }> }).decision ?? Object.values(a.params.answers as Record<string, { answers: string[] }>)[0].answers[0]),
      ['decline', 'decline', 'Cancel']
    )
    assert.equal(denied.sideEffects, false, 'nothing ran')
  } finally {
    await h.done()
  }
})

test('cancelling interrupts the turn through turn/interrupt, and the session keeps working', { timeout: 30_000 }, async () => {
  const h = harness()
  try {
    const controller = new AbortController()
    const input = turnInput(h, 'go slow', { signal: controller.signal })
    const running = h.engine.runTurn(input)
    // Wait until Codex has started streaming.
    for (let i = 0; i < 100 && !input.events.some((e) => e.type === 'delta'); i++) await new Promise((r) => setTimeout(r, 20))
    assert.equal(await h.engine.steer!(String(h.requests().find((r) => r.method === 'turn/start')?.params.threadId), 'focus on tests'), true)
    controller.abort()
    const result = await running
    assert.equal(result.cancelled, true)
    assert.equal(result.error, undefined)
    assert.ok(h.requests().some((r) => r.method === 'turn/interrupt'))
    assert.ok(h.requests().some((r) => r.method === 'interrupted'))

    const next = await h.engine.runTurn(turnInput(h, 'hello again', { sessionId: result.sessionId }))
    assert.equal(next.error, undefined)
    assert.equal(next.text, 'Hello there.')
    assert.equal(next.sessionId, result.sessionId)
    assert.equal(h.requests().filter((r) => r.method === 'thread/resume').length, 0, 'the warm process still had the thread')
  } finally {
    await h.done()
  }
})

test('a Codex that ignores the interrupt is stopped, and the turn still ends as cancelled', { timeout: 30_000 }, async () => {
  const h = harness({ interruptGraceMs: 500 })
  try {
    const controller = new AbortController()
    const input = turnInput(h, 'go slow and deaf', { signal: controller.signal })
    const running = h.engine.runTurn(input)
    for (let i = 0; i < 100 && !input.events.some((e) => e.type === 'delta'); i++) await new Promise((r) => setTimeout(r, 20))
    controller.abort()
    const result = await running
    assert.equal(result.cancelled, true)
    assert.deepEqual(h.engine.livePids().filter(alive).length, 0, 'the stuck process was stopped')
  } finally {
    await h.done()
  }
})

test('a crash fails only that turn (engine-crashed); the next turn restarts Codex and resumes the thread', { timeout: 30_000 }, async () => {
  const h = harness()
  try {
    const first = await h.engine.runTurn(turnInput(h, 'hello'))
    assert.equal(first.error, undefined)
    const crashedInput = turnInput(h, 'now crash', { sessionId: first.sessionId })
    const crashed = await h.engine.runTurn(crashedInput)
    assert.equal(crashed.errorKind, 'engine-crashed')
    assert.match(crashed.error ?? '', /stopped unexpectedly/)
    assert.equal(crashed.cancelled, false)
    const crashPid = h.requests().filter((r) => r.method === 'turn/start').at(-1)!.pid
    assert.ok(!alive(crashPid))
    assert.ok(!h.engine.livePids().includes(crashPid), 'the dead process is forgotten')

    const after = await h.engine.runTurn(turnInput(h, 'what do you remember from history', { sessionId: first.sessionId }))
    assert.equal(after.error, undefined)
    assert.equal(after.sessionId, first.sessionId)
    assert.equal(after.sessionReplaced, false)
    assert.equal(after.text, 'I remember 2 earlier message(s).')
    assert.equal(h.requests().filter((r) => r.method === 'thread/resume').length, 1)
  } finally {
    await h.done()
  }
})

test('two sessions run at once in separate processes without touching each other', { timeout: 30_000 }, async () => {
  const h = harness()
  try {
    const controller = new AbortController()
    const slow = turnInput(h, 'go slow', { messageId: 'slow', signal: controller.signal })
    const fast = turnInput(h, 'hello', { messageId: 'fast' })
    const slowRun = h.engine.runTurn(slow)
    for (let i = 0; i < 100 && !slow.events.some((e) => e.type === 'delta'); i++) await new Promise((r) => setTimeout(r, 20))
    const fastResult = await h.engine.runTurn(fast)
    assert.equal(fastResult.text, 'Hello there.')
    assert.ok(fast.events.every((e) => e.messageId === 'fast'))
    assert.ok(!slow.events.some((e) => e.type === 'delta' && e.text.includes('Hello')), 'no text crossed over')
    const starts = h.requests().filter((r) => r.method === 'thread/start')
    assert.equal(new Set(starts.map((s) => s.pid)).size, 2, 'each session has its own process')
    controller.abort()
    const slowResult = await slowRun
    assert.equal(slowResult.cancelled, true)
    assert.notEqual(slowResult.sessionId, fastResult.sessionId)
  } finally {
    await h.done()
  }
})

test('resume after a restart: a new engine continues the thread, counting only this turn’s usage', { timeout: 30_000 }, async () => {
  const root = tempDir('restart')
  const state = join(root, 'state')
  mkdirSync(state)
  const a = harness({ state })
  let sessionId: string | null = null
  try {
    const first = await a.engine.runTurn(turnInput(a, 'hello'))
    sessionId = first.sessionId
  } finally {
    await a.engine.dispose()
  }
  const b = harness({ state })
  try {
    const input = turnInput(b, 'what is in the history', { sessionId })
    const result = await b.engine.runTurn(input)
    assert.equal(result.error, undefined)
    assert.equal(result.sessionId, sessionId)
    assert.equal(result.text, 'I remember 1 earlier message(s).')
    // The resumed thread replays its stored usage first; it isn't this turn's.
    assert.deepEqual(result.usage, { input: 80, output: 30, cacheRead: 20, cacheWrite: 0 })
    const resume = b.requests().find((r) => r.method === 'thread/resume')!
    assert.equal(resume.params.threadId, sessionId)
    assert.equal(resume.params.developerInstructions, 'You are Ada, a careful test worker.')
  } finally {
    await b.done()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a session Codex no longer has starts a new one and says so', { timeout: 30_000 }, async () => {
  const h = harness()
  try {
    const result = await h.engine.runTurn(turnInput(h, 'hello', { sessionId: '0199a213-81c0-7800-8aa1-bbab2a035a53' }))
    assert.equal(result.error, undefined)
    assert.equal(result.sessionReplaced, true)
    assert.match(result.notice ?? '', /started a new one/)
    assert.ok(result.sessionId && result.sessionId !== '0199a213-81c0-7800-8aa1-bbab2a035a53')
  } finally {
    await h.done()
  }
})

test('failures are classified: expired session, unavailable model, usage limit', { timeout: 30_000 }, async () => {
  const h = harness()
  try {
    const seen: string[] = []
    const stop = h.engine.subscribe!((status) => seen.push(status.auth.state))
    await h.engine.detect()
    const limit = await h.engine.runTurn(turnInput(h, 'fail-limit'))
    assert.equal(limit.errorKind, 'rate-limited')
    const model = await h.engine.runTurn(turnInput(h, 'fail-model'))
    assert.equal(model.errorKind, 'model-unavailable')
    assert.match(model.errorDetail ?? '', /not supported/)
    const auth = await h.engine.runTurn(turnInput(h, 'fail-auth'))
    assert.equal(auth.errorKind, 'auth-expired')
    assert.match(auth.error ?? '', /expired/)
    assert.equal(seen.at(-1), 'expired', 'the status says so too')
    stop()
  } finally {
    await h.done()
  }
})

/* --------------------------------------------------------- self-routing */

test('a Codex pointed at Eaon’s own gateway is refused with a reason, before any turn starts', { timeout: 30_000 }, async () => {
  const h = harness({
    scenario: { FAKE_CODEX_CONFIG: JSON.stringify({ model_provider: 'eaon', model_providers: { eaon: { name: 'Eaon', base_url: 'http://127.0.0.1:1337/v1' } } }) }
  })
  try {
    const status = await h.engine.detect()
    assert.match(status.blockedReason ?? '', /Eaon’s own models/)
    const result = await h.engine.runTurn(turnInput(h, 'hello'))
    assert.equal(result.errorKind, 'misconfigured')
    assert.equal(h.requests().filter((r) => r.method === 'turn/start' || r.method === 'thread/start').length, 0)
  } finally {
    await h.done()
  }
})

test('self-routing check: Eaon’s port on loopback only, through any provider', () => {
  assert.match(selfRouteReason(providerTarget({ model_provider: 'eaon', model_providers: { eaon: { base_url: 'http://localhost:1337/v1' } } }), [1337]) ?? '', /Connect apps/)
  assert.ok(selfRouteReason(providerTarget({ openai_base_url: 'http://127.0.0.1:4242/v1' }), [4242]))
  assert.equal(selfRouteReason(providerTarget({ openai_base_url: 'http://127.0.0.1:11434/api/codex/v1' }), [1337]), null, 'Ollama is not Eaon')
  assert.equal(selfRouteReason(providerTarget({ model_provider: 'x', model_providers: { x: { base_url: 'https://example.com:1337/v1' } } }), [1337]), null)
  assert.equal(selfRouteReason(providerTarget({}), [1337]), null)
  assert.equal(providerTarget({}, { OPENAI_BASE_URL: 'http://127.0.0.1:1337/v1' }).baseUrl, 'http://127.0.0.1:1337/v1')
})

test('commands are shown as typed, not as Codex’s shell wrapper', () => {
  assert.equal(displayCommand("/bin/zsh -lc 'ls -la'"), 'ls -la')
  assert.equal(displayCommand("bash -lc 'echo '\\''hi'\\'''"), "echo 'hi'")
  assert.equal(displayCommand('/bin/zsh -lc x', [{ command: 'npm test' }]), 'npm test')
  assert.equal(displayCommand('git status'), 'git status')
})

test('dispose stops every Codex process it started', { timeout: 30_000 }, async () => {
  const h = harness()
  try {
    await h.engine.detect()
    await h.engine.runTurn(turnInput(h, 'hello'))
    await h.engine.runTurn(turnInput(h, 'hello'))
    const pids = h.engine.livePids()
    assert.ok(pids.length >= 2)
    await h.engine.dispose()
    assert.deepEqual(pids.filter(alive), [])
  } finally {
    await h.done()
  }
})
