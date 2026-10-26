import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StreamEvent } from '@shared/types'
import { AcpEngine, accountMethod } from '../src/main/engines/acp'
import { ACP_AGENTS, modelLabel, parseCopilotModels, type AcpAgentSpec } from '../src/main/engines/acp/agents'
import { toolOf } from '../src/main/engines/acp/turn'
import { engineOptions } from '../src/shared/modelSelection'
import type { EngineApprovalRequest, EngineTurnInput } from '../src/main/engines/types'

/**
 * GitHub Copilot CLI and Gemini CLI as engines, over the Agent Client
 * Protocol, against a fake agent (test/fixtures/fake-acp.mjs). The fake logs
 * every request with its argv, so the tests can see exactly what Eaon sent.
 */

const FIXTURE = join(process.cwd(), 'test/fixtures/fake-acp.mjs')

interface Harness {
  engine: AcpEngine
  work: string
  log: () => { pid: number; argv: string[]; method?: string; params?: Record<string, unknown>; permissionAnswer?: unknown }[]
  opened: string[]
  done: () => Promise<void>
}

function harness(scenario: Record<string, string> = {}, spec: Partial<AcpAgentSpec> = {}, clock?: { now: number }): Harness {
  const root = mkdtempSync(join(tmpdir(), 'eaon-acp-'))
  const bin = join(root, 'fake-agent')
  const logFile = join(root, 'log.jsonl')
  const vars = Object.entries({ ...scenario, FAKE_ACP_LOG: logFile })
    .map(([k, v]) => `${k}='${v}'`)
    .join(' ')
  writeFileSync(bin, `#!/bin/sh\n${vars} exec "${process.execPath}" "${FIXTURE}" "$@"\n`)
  chmodSync(bin, 0o755)
  const work = join(root, 'work')
  mkdirSync(work)
  const opened: string[] = []
  const engine = new AcpEngine(
    { ...ACP_AGENTS.gemini, bins: ['fake-agent'], modelsCommand: undefined, ...spec },
    {
      which: (name) => (name === 'fake-agent' ? bin : null),
      env: () => process.env,
      probeDir: () => join(root, 'probe'),
      clientVersion: '1.2.3',
      openTerminal: async (command) => void opened.push(command),
      ...(clock ? { now: () => clock.now } : {})
    }
  )
  return {
    engine,
    work,
    opened,
    log: () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    done: async () => {
      await engine.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

function turnInput(h: Harness, overrides: Partial<EngineTurnInput> = {}): EngineTurnInput & { events: StreamEvent[]; asked: EngineApprovalRequest[] } {
  const events: StreamEvent[] = []
  const asked: EngineApprovalRequest[] = []
  return {
    sessionId: null,
    messageId: 'm1',
    cwd: h.work,
    model: null,
    effort: null,
    instructions: '',
    text: 'hello there',
    images: [],
    access: 'safe',
    signal: new AbortController().signal,
    emit: (event) => void events.push(event),
    approve: async (request) => {
      asked.push(request)
      return true
    },
    ...overrides,
    events,
    asked
  }
}

test('a signed-in agent: found, its version from the handshake, signed in, and the check’s session closed', async () => {
  const h = harness({ FAKE_ACP_VERSION: '0.65.0' })
  try {
    const status = await h.engine.detect({ force: true })
    assert.equal(status.installed, true)
    assert.equal(status.version, '0.65.0')
    assert.equal(status.auth.state, 'signed-in')
    assert.equal(status.error, null)
    const methods = h.log().map((e) => e.method)
    assert.deepEqual(methods.slice(0, 3), ['initialize', 'session/new', 'session/close'])
    const init = h.log()[0].params as { clientCapabilities: { fs: Record<string, boolean>; terminal: boolean }; clientInfo: { name: string } }
    assert.deepEqual(init.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, 'Eaon offers no file system or terminal of its own')
    assert.equal(init.clientInfo.name, 'eaon', 'it says it is Eaon, not some other client')
  } finally {
    await h.done()
  }
})

test('a check opens a session only when sign-in may have changed: routine checks just shake hands', async () => {
  const clock = { now: 1_000_000 }
  const h = harness({}, {}, clock)
  try {
    assert.equal((await h.engine.detect({ force: true })).auth.state, 'signed-in')
    // Past the five-minute cache, as the half-hourly checks are.
    clock.now += 31 * 60_000
    assert.equal((await h.engine.detect()).auth.state, 'signed-in')
    clock.now += 31 * 60_000
    await h.engine.detect()
    const sessions = (): number => h.log().filter((e) => e.method === 'session/new').length
    assert.equal(sessions(), 1, 'the routine checks after it opened none')
    assert.equal(h.log().filter((e) => e.method === 'initialize').length, 3, 'but each still asked for the version')
    await h.engine.detect({ force: true })
    assert.equal(sessions(), 2, 'a check the user asks for opens one')
  } finally {
    await h.done()
  }
})

test('“authentication required” on session/new reads as signed out, not as an error', async () => {
  const h = harness({ FAKE_ACP_SIGNED_OUT: '1' })
  try {
    const status = await h.engine.detect({ force: true })
    assert.equal(status.auth.state, 'signed-out')
    assert.equal(status.error, null)
  } finally {
    await h.done()
  }
})

test('not on PATH: not installed, with how to install it', async () => {
  const h = harness({}, { bins: ['no-such-agent'] })
  try {
    const status = await h.engine.detect({ force: true })
    assert.equal(status.installed, false)
    assert.equal(status.updateHint, ACP_AGENTS.gemini.install)
  } finally {
    await h.done()
  }
})

test('models come from the session’s model option, after the CLI’s own default', async () => {
  const h = harness({ FAKE_ACP_MODELS: 'pro,flash' })
  try {
    await h.engine.detect({ force: true })
    const { models } = await h.engine.listModels({ force: true })
    assert.deepEqual(
      models.map((m) => [m.id, m.label, m.isDefault]),
      [
        ['', 'Default', true],
        ['pro', 'Model pro', false],
        ['flash', 'Model flash', false]
      ]
    )
    assert.equal(models[1].source.kind, 'engine-live')
  } finally {
    await h.done()
  }
})

const PLAN_SPEC: Partial<AcpAgentSpec> = { name: 'Fake Copilot', planCheck: ACP_AGENTS.copilot.planCheck }
const prompts = (h: Harness): string[] =>
  h.log().filter((e) => e.method === 'session/prompt').map((e) => ((e.params?.prompt as { text?: string }[])[0]?.text ?? ''))

test('a plan that offers Auto only: one /model answer, and the list is just Auto, with why', async () => {
  const h = harness({ FAKE_ACP_MODELS: 'pro,flash', FAKE_ACP_PLAN: 'auto-only' }, PLAN_SPEC)
  try {
    await h.engine.detect({ force: true })
    // Copilot answers `/model` itself: nothing else was sent, so nothing reached a model.
    assert.deepEqual(prompts(h), ['/model pro'])
    const list = await h.engine.listModels({ force: true })
    assert.deepEqual(list.models.map((m) => [m.id, m.label, m.isDefault]), [['', 'Auto', true]])
    assert.match(list.note ?? '', /Fake Copilot plan offers Auto only/)
  } finally {
    await h.done()
  }
})

test('a plan without some models: those stay listed, marked as not on the plan; the rest are offered', async () => {
  const h = harness({ FAKE_ACP_MODELS: 'pro,flash', FAKE_ACP_PLAN: 'refuse:pro' }, PLAN_SPEC)
  try {
    await h.engine.detect({ force: true })
    assert.deepEqual(prompts(h), ['/model pro', '/model flash'])
    const list = await h.engine.listModels({ force: true })
    assert.deepEqual(list.models.map((m) => [m.id, m.unavailable ?? null]), [
      ['', null],
      ['pro', 'Your Fake Copilot plan doesn’t include Model pro.'],
      ['flash', null]
    ])
    assert.equal(list.note, undefined)
    const rows = engineOptions('copilot', list, { ...(await h.engine.detect()), id: 'copilot' })
    assert.deepEqual(rows.map((r) => [r.modelId, r.availability, r.planNote]), [
      ['', 'ready', null],
      ['pro', 'unavailable', 'Not on your plan'],
      ['flash', 'ready', null]
    ])
  } finally {
    await h.done()
  }
})

test('no plan check when the session doesn’t list the command: a slash command could reach the model', async () => {
  const h = harness({ FAKE_ACP_MODELS: 'pro,flash', FAKE_ACP_PLAN: 'auto-only', FAKE_ACP_NO_COMMANDS: '1' }, PLAN_SPEC)
  try {
    await h.engine.detect({ force: true })
    assert.deepEqual(prompts(h), [])
    const list = await h.engine.listModels({ force: true })
    assert.deepEqual(list.models.map((m) => m.id), ['', 'pro', 'flash'])
  } finally {
    await h.done()
  }
})

test('a turn on a model the plan doesn’t include runs, and says the CLI picked the model', async () => {
  const h = harness({ FAKE_ACP_MODELS: 'pro,flash', FAKE_ACP_PLAN: 'refuse:pro' }, PLAN_SPEC)
  try {
    await h.engine.detect({ force: true })
    const result = await h.engine.runTurn(turnInput(h, { model: 'pro' }))
    assert.equal(result.error, undefined)
    assert.match(result.text, /hello there/)
    assert.equal(result.notice, 'Your Fake Copilot plan doesn’t include Pro, so Fake Copilot picked the model.')
    const offered = await h.engine.runTurn(turnInput(h, { model: 'flash' }))
    assert.equal(offered.notice, undefined)
  } finally {
    await h.done()
  }
})

test('on a plan that offers Auto only, a model chosen earlier is left out of the turn, as the picker shows', async () => {
  const h = harness({ FAKE_ACP_MODELS: 'pro,flash', FAKE_ACP_PLAN: 'auto-only' }, PLAN_SPEC)
  try {
    await h.engine.detect({ force: true })
    const result = await h.engine.runTurn(turnInput(h, { model: 'pro' }))
    assert.equal(result.error, undefined)
    assert.equal(result.notice, undefined)
    const turn = h.log().find((e) => e.method === 'session/prompt' && !String((e.params?.prompt as { text?: string }[])[0]?.text).startsWith('/'))
    assert.ok(turn && !turn.argv.includes('--model'), 'no model on the command line')
    assert.ok(!h.log().some((e) => e.method === 'session/set_config_option'))
  } finally {
    await h.done()
  }
})

test('a turn: thinking, a command approved through Eaon, an edit with its diff, the plan, and the answer', async () => {
  const h = harness()
  try {
    const input = turnInput(h, { model: 'flash', instructions: 'You review pull requests.' })
    const result = await h.engine.runTurn(input)
    assert.equal(result.error, undefined)
    assert.equal(result.text, 'You said: You review pull requests.\n\n---\n\nhello there')
    assert.equal(result.cancelled, false)
    assert.equal(result.sideEffects, true)
    assert.equal(result.billing, 'plan')
    assert.ok(result.sessionId)

    const types = input.events.map((e) => e.type)
    assert.deepEqual(types, ['reasoning', 'tool-call', 'tool-result', 'tool-call', 'tool-result', 'todos', 'delta', 'delta'])
    assert.deepEqual(input.events[1], { type: 'tool-call', messageId: 'm1', toolId: 't1', name: 'run_command', input: { command: 'npm test' } })
    assert.deepEqual(input.events[2], { type: 'tool-result', messageId: 'm1', toolId: 't1', output: '3 passing', status: 'done' })
    assert.deepEqual(input.events[3], { type: 'tool-call', messageId: 'm1', toolId: 't2', name: 'edit_file', input: { path: '/w/a.txt', old_text: 'old', new_text: 'new' } })
    assert.deepEqual(input.events[5], { type: 'todos', messageId: 'm1', todos: [{ text: 'Run tests', status: 'done' }, { text: 'Fix', status: 'in_progress' }] })
    assert.deepEqual(input.asked, [{ tool: 'run_command', input: { command: 'npm test' }, summary: 'Run the tests', mutating: true }])

    const log = h.log()
    const prompt = log.find((e) => e.method === 'session/prompt')!
    assert.deepEqual(prompt.argv, ['--acp', '--model', 'flash'], 'the model goes on the command line')
    assert.deepEqual(log.find((e) => e.permissionAnswer)?.permissionAnswer, { outcome: { outcome: 'selected', optionId: 'yes' } })
  } finally {
    await h.done()
  }
})

test('a refusal from Eaon’s approval policy is the reject option, and the call ends failed', async () => {
  const h = harness()
  try {
    const input = turnInput(h, { approve: async () => false })
    const result = await h.engine.runTurn(input)
    assert.deepEqual(h.log().find((e) => e.permissionAnswer)?.permissionAnswer, { outcome: { outcome: 'selected', optionId: 'no' } })
    const ran = input.events.find((e) => e.type === 'tool-result' && e.toolId === 't1')
    assert.equal(ran && ran.type === 'tool-result' && ran.status, 'error')
    assert.equal(result.cancelled, false)
  } finally {
    await h.done()
  }
})

test('the next turn on the same session reuses its process; one after the process is gone resumes with session/load and shows none of the replay', async () => {
  const h = harness()
  try {
    const first = await h.engine.runTurn(turnInput(h))
    const second = await h.engine.runTurn(turnInput(h, { sessionId: first.sessionId, messageId: 'm2', instructions: 'ignored on a resumed session' }))
    assert.equal(second.sessionId, first.sessionId)
    const pids = new Set(h.log().filter((e) => e.method === 'session/prompt').map((e) => e.pid))
    assert.equal(pids.size, 1, 'one process for both turns')
    assert.equal(second.text, 'You said: hello there', 'project instructions go only at the start of a session')

    await h.engine.dispose()
    const input = turnInput(h, { sessionId: first.sessionId, messageId: 'm3' })
    const third = await h.engine.runTurn(input)
    assert.equal(third.sessionId, first.sessionId)
    assert.equal(third.sessionReplaced, undefined)
    assert.ok(h.log().some((e) => e.method === 'session/load' && (e.params as { sessionId: string }).sessionId === first.sessionId))
    assert.ok(!input.events.some((e) => e.type === 'delta' && e.text.includes('EARLIER ANSWER')), 'the replayed history stays out of the transcript')
  } finally {
    await h.done()
  }
})

test('an agent that can’t load sessions starts a new one and says so', async () => {
  const h = harness({ FAKE_ACP_NO_LOAD: '1' })
  try {
    const result = await h.engine.runTurn(turnInput(h, { sessionId: 'gone-session' }))
    assert.equal(result.sessionReplaced, true)
    assert.match(result.notice ?? '', /started a new one/)
    assert.notEqual(result.sessionId, 'gone-session')
  } finally {
    await h.done()
  }
})

test('stopping a turn sends session/cancel and the turn ends cancelled', async () => {
  const h = harness({ FAKE_ACP_SLOW: '1' })
  try {
    const controller = new AbortController()
    const input = turnInput(h, { signal: controller.signal })
    const running = h.engine.runTurn(input)
    await new Promise((resolve) => setTimeout(resolve, 800))
    controller.abort()
    const result = await running
    assert.equal(result.cancelled, true)
    assert.ok(h.log().some((e) => e.method === 'session/cancel'))
  } finally {
    await h.done()
  }
})

test('stopping while an approval waits answers it “cancelled”, as ACP requires', async () => {
  const h = harness()
  try {
    const controller = new AbortController()
    const input = turnInput(h, {
      signal: controller.signal,
      approve: () => {
        setTimeout(() => controller.abort(), 50)
        return new Promise<boolean>(() => {})
      }
    })
    const result = await h.engine.runTurn(input)
    assert.equal(result.cancelled, true)
    assert.deepEqual(h.log().find((e) => e.permissionAnswer)?.permissionAnswer, { outcome: { outcome: 'cancelled' } })
  } finally {
    await h.done()
  }
})

test('a sign-in that ran out during a turn: signed-out error, and the status everyone reads says so too', async () => {
  const h = harness({ FAKE_ACP_EXPIRE_ON_PROMPT: '1' })
  try {
    await h.engine.detect({ force: true })
    const heard: string[] = []
    const off = h.engine.subscribe((status) => heard.push(status.auth.state))
    const result = await h.engine.runTurn(turnInput(h))
    off()
    assert.equal(result.errorKind, 'signed-out')
    assert.match(result.error ?? '', /isn’t signed in/)
    assert.deepEqual(heard, ['signed-out'])
  } finally {
    await h.done()
  }
})

test('signing in: an agent that signs in itself is asked to; a terminal-only one opens its own command in a terminal', async () => {
  const google = harness()
  try {
    await google.engine.login()
    const auth = google.log().find((e) => e.method === 'authenticate')
    assert.deepEqual(auth?.params, { methodId: 'oauth-personal' }, 'the account sign-in, never the API-key one')
    assert.deepEqual(google.opened, [])
  } finally {
    await google.done()
  }
  const terminal = harness({ FAKE_ACP_TERMINAL_AUTH: '1' })
  try {
    const signingIn = terminal.engine.login()
    await new Promise((resolve) => setTimeout(resolve, 1500))
    // Already signed in, so the first check after opening the terminal ends the wait.
    await signingIn
    assert.deepEqual(terminal.opened, ['/opt/fake login'])
    assert.ok(!terminal.log().some((e) => e.method === 'authenticate'), 'a terminal method is never passed to authenticate')
  } finally {
    await terminal.done()
  }
})

test('accountMethod skips key, Vertex and gateway methods and terminal ones', () => {
  assert.equal(accountMethod([{ id: 'gemini-api-key', name: 'Gemini API key' }, { id: 'oauth-personal', name: 'Log in with Google' }])?.id, 'oauth-personal')
  assert.equal(accountMethod([{ id: 'vertex-ai', name: 'Vertex AI' }, { id: 'gateway', name: 'AI API Gateway' }]), null)
  assert.equal(accountMethod([{ id: 'copilot-login', name: 'Log in', type: 'terminal' }]), null)
  // Copilot's own, as it sends it: no type, the command under _meta.
  assert.equal(accountMethod([{ id: 'copilot-login', name: 'Log in with Copilot CLI', _meta: { 'terminal-auth': { command: 'copilot', args: ['login'] } } }]), null)
})

test('Copilot’s models come from its own `help config`, labelled readably', () => {
  const help = [
    '  `mcpServers`: …',
    '  `model`: AI model to use for Copilot CLI; can be changed with /model command or --model flag option.',
    '    - "claude-sonnet-5.5"',
    '    - "gpt-5.4-mini"',
    '    - "gemini-3.8-flash"',
    '',
    '  `contextTier`: context window tier'
  ].join('\n')
  assert.deepEqual(parseCopilotModels(help), ['claude-sonnet-5.5', 'gpt-5.4-mini', 'gemini-3.8-flash'])
  assert.deepEqual(parseCopilotModels('nothing here'), [])
  assert.equal(modelLabel('claude-sonnet-5.5'), 'Claude Sonnet 5.5')
  assert.equal(modelLabel('gpt-5.4-mini'), 'GPT-5.4 Mini')
  assert.equal(modelLabel('gemini-3.8-flash'), 'Gemini 3.8 Flash')
})

test('ACP tool kinds become Eaon’s own tool names', () => {
  assert.deepEqual(toolOf({ toolCallId: 'a', kind: 'read', locations: [{ path: '/x.ts' }] }), { name: 'read_file', input: { path: '/x.ts' }, mutating: false })
  assert.deepEqual(toolOf({ toolCallId: 'b', kind: 'edit', content: [{ type: 'diff', path: '/n.ts', oldText: null, newText: 'hi' }] }), {
    name: 'write_file',
    input: { path: '/n.ts', content: 'hi' },
    mutating: true
  })
  assert.deepEqual(toolOf({ toolCallId: 'c', kind: 'search', rawInput: { pattern: 'TODO' } }), { name: 'grep', input: { pattern: 'TODO' }, mutating: false })
  assert.deepEqual(toolOf({ toolCallId: 'd', kind: 'other', title: 'Searching the web' }), { name: 'Searching the web', input: {}, mutating: false })
})

test('quitting stops a check still under way, not only the chats', async () => {
  const h = harness()
  try {
    // The check starts its CLI straight away; Eaon quits before it's done.
    const checking = h.engine.detect({ force: true })
    const running = (h.engine as unknown as { running: Set<{ child: { pid: number } }> }).running
    const pids = [...running].map((server) => server.child.pid)
    assert.equal(pids.length, 1, 'the check’s CLI is running')
    await h.engine.dispose()
    await checking
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), /ESRCH/, `process ${pid} outlived Eaon`)
    assert.equal(running.size, 0)
  } finally {
    await h.done()
  }
})
