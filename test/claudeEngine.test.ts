import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { StreamEvent } from '@shared/types'
import { authOf, ClaudeEngine, modelsOf, type ClaudeEngineDeps } from '../src/main/engines/claude'
import type { EngineApprovalRequest, EngineTurnInput } from '../src/main/engines/types'
import { withCliDays } from '../src/main/features/usage/rows'

/**
 * Claude as an engine: the user's own Claude Code through the Agent SDK. A
 * stand-in for the SDK's `query` plays Claude Code's side, so these check
 * what Eaon does with what it hears, and what it sends.
 */

type Script = (options: Options, said: SDKUserMessage) => AsyncGenerator<SDKMessage>

const init = (session = 's-1', apiKeySource = 'none'): SDKMessage => ({ type: 'system', subtype: 'init', session_id: session, apiKeySource }) as unknown as SDKMessage
const delta = (text: string, parent: string | null = null): SDKMessage =>
  ({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } }) as unknown as SDKMessage
const started = (id: string): SDKMessage => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id } } }) as unknown as SDKMessage
const assistant = (id: string, content: unknown[], parent: string | null = null, error?: string): SDKMessage =>
  ({ type: 'assistant', parent_tool_use_id: parent, message: { id, content }, ...(error ? { error } : {}) }) as unknown as SDKMessage
const toolResult = (id: string, content: string, isError = false): SDKMessage =>
  ({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } }) as unknown as SDKMessage
const result = (text: string, session = 's-1', extra: Record<string, unknown> = {}): SDKMessage =>
  ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    session_id: session,
    usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 400, cache_creation_input_tokens: 10 },
    ...extra
  }) as unknown as SDKMessage

function engine(script: Script, overrides: Partial<ClaudeEngineDeps> = {}) {
  const calls: { options: Options; said: SDKUserMessage }[] = []
  const deps: ClaudeEngineDeps = {
    which: (bin) => (bin === 'claude' ? '/usr/local/bin/claude' : null),
    env: () => ({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/Users/me/.claude-work' }),
    run: async (_command, args) =>
      args[0] === '--version'
        ? { ok: true, stdout: '2.1.304 (Claude Code)\n', stderr: '' }
        : { ok: true, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'me@example.com', orgName: 'Me' }), stderr: '' },
    probeDir: () => mkdtempSync(join(tmpdir(), 'eaon-claude-')),
    clientVersion: '2026.7.4',
    openTerminal: async () => {},
    query: ({ prompt, options }) => {
      const run = (async function* () {
        const iterator = prompt[Symbol.asyncIterator]()
        const first = await iterator.next()
        calls.push({ options: options!, said: first.value })
        yield* script(options!, first.value)
        await iterator.return?.()
      })()
      return Object.assign(run, {
        supportedModels: async () => [
          { value: 'default', displayName: 'Default (recommended)', description: 'Opus 5.5 for your plan', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
          { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 5.5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
          { value: 'haiku', displayName: 'Haiku', description: 'Haiku 5.5' }
        ],
        close: () => {}
      }) as never
    },
    ...overrides
  }
  return { engine: new ClaudeEngine(deps), calls }
}

function turnInput(overrides: Partial<EngineTurnInput> = {}): { input: EngineTurnInput; events: StreamEvent[]; asked: EngineApprovalRequest[] } {
  const events: StreamEvent[] = []
  const asked: EngineApprovalRequest[] = []
  return {
    events,
    asked,
    input: {
      sessionId: null,
      messageId: 'm1',
      cwd: '/tmp/project',
      model: null,
      effort: null,
      instructions: '',
      text: 'Fix the failing test',
      images: [],
      access: 'safe',
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
      approve: async (request) => {
        asked.push(request)
        return true
      },
      ...overrides
    }
  }
}

test('sign-in is read from `claude auth status`, never anything that names the person', async () => {
  assert.deepEqual(authOf(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'me@example.com', orgId: 'o' })), { state: 'signed-in', method: 'Claude account', plan: 'Max' })
  assert.deepEqual(authOf(JSON.stringify({ loggedIn: true, authMethod: 'console' })), { state: 'signed-in', method: 'API key', plan: null })
  assert.deepEqual(authOf(JSON.stringify({ loggedIn: false })), { state: 'signed-out', method: null, plan: null })
  assert.equal(authOf('Not JSON').state, 'unknown')

  const { engine: claude } = engine(async function* () {})
  const status = await claude.detect()
  assert.equal(status.version, '2.1.304')
  assert.deepEqual(status.auth, { state: 'signed-in', method: 'Claude account', plan: 'Max' })
  assert.doesNotMatch(JSON.stringify(status), /example\.com|orgName/, 'no email or organization anywhere in the status')
  const missing = await new ClaudeEngine({ ...({} as ClaudeEngineDeps), which: () => null, now: Date.now, clientVersion: '1', probeDir: tmpdir, env: () => ({}), run: async () => ({ ok: false, stdout: '', stderr: '' }), openTerminal: async () => {} }).detect()
  assert.equal(missing.installed, false)
  assert.match(missing.updateHint ?? '', /@anthropic-ai\/claude-code/)
})

test('the model list is Claude Code’s own for this account, its default first, with each model’s efforts', async () => {
  const { engine: claude, calls } = engine(async function* () {})
  const list = await claude.listModels()
  assert.equal(list.staleBecause, null)
  assert.deepEqual(list.models.map((m) => [m.id, m.label]), [['', 'Default'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']])
  assert.deepEqual(list.models[1].efforts, ['light', 'medium', 'high'])
  assert.deepEqual(list.models[2].efforts, [], 'no effort levels where the model takes none')
  assert.equal(calls.length, 0, 'asking for models sends Claude no message')
  assert.equal(modelsOf([], 1)[0].isDefault, true)
})

test('a turn: Claude Code started as published, its stream drawn once, tools as Eaon’s, usage and plan billing', async () => {
  const { engine: claude, calls } = engine(async function* () {
    yield init('s-9')
    yield started('msg-1')
    yield delta('Looking at the test. ')
    yield assistant('msg-1', [
      { type: 'text', text: 'Looking at the test. ' },
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/project/a.test.ts' } },
      { type: 'tool_use', id: 't2', name: 'TodoWrite', input: { todos: [{ content: 'Fix it', status: 'in_progress' }] } }
    ])
    yield toolResult('t1', 'test body')
    yield assistant('msg-2', [{ type: 'text', text: 'Fixed.' }])
    yield result('Looking at the test. Fixed.', 's-9')
  })
  const { input, events } = turnInput({ instructions: 'You are the release worker.', model: 'sonnet', effort: 'high' })
  await claude.listModels()
  const out = await claude.runTurn(input)

  const { options, said } = calls[0]
  assert.equal(options.pathToClaudeCodeExecutable, '/usr/local/bin/claude', 'the user’s own Claude Code, not a copy of Eaon’s')
  assert.equal(options.systemPrompt, undefined, 'Claude Code’s own system prompt, untouched')
  assert.equal(options.env?.CLAUDE_CONFIG_DIR, '/Users/me/.claude-work', 'the Claude account chosen in Settings → Accounts')
  assert.equal(options.env?.CLAUDE_AGENT_SDK_CLIENT_APP, 'eaon/2026.7.4', 'it says it is Eaon')
  assert.equal(options.permissionMode, 'default', 'Claude Code asks, and Eaon’s approval policy answers')
  assert.equal(options.model, 'sonnet')
  assert.equal(options.effort, 'high')
  assert.equal(options.resume, undefined)
  const content = (said.message as { content: { text: string }[] }).content
  assert.match(content[0].text, /^You are the release worker\.\n\n---\n\nFix the failing test$/, 'the worker’s role opens the session, as the user’s words')
  assert.deepEqual((said as { origin?: unknown }).origin, { kind: 'human' })

  assert.equal(events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join(''), 'Looking at the test. Fixed.', 'streamed text isn’t drawn a second time')
  assert.deepEqual(
    events.filter((e) => e.type === 'tool-call').map((e) => [(e as { name: string }).name, (e as { input: unknown }).input]),
    [['read_file', { path: '/tmp/project/a.test.ts' }]]
  )
  assert.deepEqual((events.find((e) => e.type === 'todos') as { todos: unknown }).todos, [{ text: 'Fix it', status: 'in_progress' }])
  assert.equal((events.find((e) => e.type === 'tool-result') as { output: string }).output, 'test body')
  assert.equal(out.sessionId, 's-9')
  assert.equal(out.text, 'Looking at the test. Fixed.')
  assert.deepEqual(out.usage, { input: 120, output: 30, cacheRead: 400, cacheWrite: 10 })
  assert.equal(out.billing, 'plan')
  assert.equal(out.sideEffects, false, 'reading changes nothing')
  assert.equal(out.error, undefined)
})

test('each call Claude Code would ask about goes to Eaon’s approval policy; a no is a denial Claude hears', async () => {
  let decisions: unknown[] = []
  const { engine: claude } = engine(async function* (options) {
    yield init()
    yield assistant('a', [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'rm -rf build', description: 'Clean' } }])
    decisions.push(await options.canUseTool!('Bash', { command: 'rm -rf build' }, { signal: new AbortController().signal, toolUseID: 'b1', title: 'Run rm -rf build' } as never))
    yield toolResult('b1', 'Permission denied by the user', true)
    decisions.push(await options.canUseTool!('Edit', { file_path: '/p/a.ts', old_string: 'a', new_string: 'b' }, { signal: new AbortController().signal, toolUseID: 'e1' } as never))
    yield toolResult('e1', 'ok')
    decisions.push(await options.canUseTool!('AskUserQuestion', { questions: [] }, { signal: new AbortController().signal, toolUseID: 'q1' } as never))
    yield result('Done')
  })
  const { input, events, asked } = turnInput({ approve: async (request) => (asked.push(request), request.tool !== 'run_command') })
  const out = await claude.runTurn(input)
  assert.deepEqual(asked.map((a) => [a.tool, a.summary, a.mutating]), [['run_command', 'Run rm -rf build', true], ['edit_file', '/p/a.ts', true]])
  assert.equal((decisions[0] as { behavior: string }).behavior, 'deny')
  assert.equal((decisions[1] as { behavior: string }).behavior, 'allow')
  assert.equal((decisions[2] as { behavior: string }).behavior, 'deny', 'Claude’s question form has no place here: it asks in its reply')
  const statuses = events.filter((e) => e.type === 'tool-result').map((e) => (e as { status: string }).status)
  assert.deepEqual(statuses, ['denied', 'done'])
  assert.equal(out.sideEffects, true, 'the edit it was allowed changed a file')
  decisions = []
})

test('a plan is Claude Code’s own read-only mode; a resumed chat carries its session; a vanished one starts again, saying so', async () => {
  const { engine: claude, calls } = engine(async function* (options) {
    if (options.resume === 'gone') throw new Error('Claude Code process exited with code 1: No conversation found with session ID: gone')
    yield init('s-new')
    yield result('Plan: …', 's-new')
  })
  await claude.runTurn(turnInput({ access: 'read-only' }).input)
  assert.equal(calls[0].options.permissionMode, 'plan')
  await claude.runTurn(turnInput({ sessionId: 's-old' }).input)
  assert.equal(calls[1].options.resume, 's-old')
  const replaced = await claude.runTurn(turnInput({ sessionId: 'gone', instructions: 'Role' }).input)
  assert.equal(replaced.sessionReplaced, true)
  assert.equal(replaced.sessionId, 's-new')
  assert.match(replaced.notice ?? '', /no longer had this conversation/)
  assert.match((calls[3].said.message as { content: { text: string }[] }).content[0].text, /^Role/, 'the new session hears the role again')
})

test('limits, sign-in and keys: plain words and the right fix', async () => {
  const limited = engine(async function* () {
    yield init()
    yield { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: Math.round(Date.now() / 1000) + 3600 } } as unknown as SDKMessage
    yield assistant('x', [], null, 'rate_limit')
    yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['rate limited'], session_id: 's', usage: {} } as unknown as SDKMessage
  })
  const out = await limited.engine.runTurn(turnInput().input)
  assert.equal(out.errorKind, 'rate-limited')
  assert.match(out.error ?? '', /5-hour limit is used up\. It resets/)

  const signedOut = engine(async function* () {
    yield init()
    yield assistant('x', [], null, 'authentication_failed')
    yield { type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login', session_id: 's', usage: {} } as unknown as SDKMessage
  })
  await signedOut.engine.detect()
  const changes: string[] = []
  signedOut.engine.subscribe((status) => changes.push(status.auth.state))
  const denied = await signedOut.engine.runTurn(turnInput().input)
  assert.equal(denied.errorKind, 'signed-out')
  assert.match(denied.error ?? '', /Sign in in Settings → Agent engines/)
  assert.deepEqual(changes, ['signed-out'], 'Settings hears it at once')

})

test('never charged: no key reaches Claude Code, a key sign-in is refused, and extra usage stops the turn and the next', async () => {
  // A key in Eaon's environment would win over the sign-in: Claude Code never sees one.
  const { engine: plain, calls } = engine(async function* () {
    yield init()
    yield result('ok')
  }, { env: () => ({ PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_AUTH_TOKEN: 't' }) })
  await plain.runTurn(turnInput().input)
  assert.equal(calls[0].options.env?.ANTHROPIC_API_KEY, undefined)
  assert.equal(calls[0].options.env?.ANTHROPIC_AUTH_TOKEN, undefined)

  // Claude Code signed in with a Console key: refused before it starts.
  const consoleLogin = engine(async function* () {
    yield result('should not run')
  }, { run: async (_c, args) => ({ ok: true, stdout: args[0] === '--version' ? '2.1.304' : JSON.stringify({ loggedIn: true, authMethod: 'console' }), stderr: '' }) })
  const refused = await consoleLogin.engine.runTurn(turnInput().input)
  assert.equal(refused.errorKind, 'misconfigured')
  assert.match(refused.error ?? '', /charges per use.*claude auth login/)
  assert.equal(consoleLogin.calls.length, 0, 'Claude Code wasn’t started')

  // A key it found itself (an apiKeyHelper): stopped at its first word, before anything else.
  let after = 0
  const helper = engine(async function* () {
    yield init('s', 'apiKeyHelper')
    after++
    yield delta('costly')
    yield result('ok')
  })
  const halted = await helper.engine.runTurn(turnInput().input)
  assert.equal(halted.errorKind, 'misconfigured')
  assert.equal(after, 0, 'nothing after the session said it was on a key')
  assert.equal(halted.cancelled, false)

  // Past the plan's limit with extra usage on: stopped, and the next turn doesn't start until the reset.
  let turns = 0
  const resets = Math.round(Date.now() / 1000) + 2 * 3600
  const overage = engine(async function* () {
    turns++
    yield init()
    yield { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', isUsingOverage: true, resetsAt: resets } } as unknown as SDKMessage
    yield delta('more')
    yield result('ok')
  })
  const first = await overage.engine.runTurn(turnInput().input)
  assert.equal(first.errorKind, 'rate-limited')
  assert.match(first.error ?? '', /extra usage, which Anthropic charges for\. Eaon stopped/)
  const second = await overage.engine.runTurn(turnInput().input)
  assert.match(second.error ?? '', /Try again after/)
  assert.equal(turns, 1, 'the second turn never started Claude Code')
})

test('Stop: the waiting approval is answered at once and the turn ends as cancelled', async () => {
  const controller = new AbortController()
  const { engine: claude } = engine(async function* (options) {
    yield init()
    const decision = options.canUseTool!('Bash', { command: 'sleep 100' }, { signal: options.abortController!.signal, toolUseID: 'b' } as never)
    controller.abort()
    assert.equal(((await decision) as { behavior: string }).behavior, 'deny')
  })
  const { input } = turnInput({ signal: controller.signal, approve: () => new Promise(() => {}) })
  const out = await claude.runTurn(input)
  assert.equal(out.cancelled, true)
  assert.equal(out.error, undefined)
})

test('Usage: a Claude engine turn counts once, left to Claude Code’s own logs when they were read', () => {
  const eaon = { '2026-10-30': { claude: { 'claude-sonnet-5-5': { input: 1, output: 1 } }, anthropic: { 'claude-haiku-5-5': { input: 2, output: 2 } } } } as never
  const cli = { '2026-10-30': { 'cli:claude-code': { 'claude-sonnet-5-5': { input: 1, output: 1 } } } } as never
  const merged = withCliDays(eaon, cli, false, true)
  assert.equal(merged['2026-10-30'].claude, undefined)
  assert.ok(merged['2026-10-30'].anthropic, 'Eaon’s own Anthropic turns stay')
  assert.ok(withCliDays(eaon, cli, false)['2026-10-30'].claude, 'kept when Claude Code’s logs weren’t read')
})
