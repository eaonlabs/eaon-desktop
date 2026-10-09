import { test } from 'node:test'
import assert from 'node:assert/strict'
import { catchUp, chatEngineApproval, engineChatError, runEngineChat, type EngineChatDeps } from '../src/main/agent/engineChat'
import type { EngineAdapter, EngineApprovalRequest, EngineTurnInput, EngineTurnResult } from '../src/main/engines/types'
import type { ChatMessage, Settings, StreamEvent, StreamRequest, TokenUsage } from '@shared/types'

/**
 * Chat on an agent engine (Codex): the turn goes to the engine with Chat's
 * own approval rules, its conversation is remembered per chat, an engine
 * joining a chat late hears what was said, and failures read as what to do.
 */

const msg = (role: ChatMessage['role'], text: string, extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: `${role}-${text.slice(0, 8)}`, role, parts: [{ type: 'text', text }], createdAt: 0, ...extra }) as ChatMessage

const settings = (approvalMode: 'ask' | 'full'): Settings => ({ approvalMode }) as unknown as Settings

function request(history: ChatMessage[], extra: Partial<StreamRequest> = {}): StreamRequest {
  return {
    chatId: 'chat-1',
    messageId: 'reply-1',
    providerId: 'codex',
    modelId: 'gpt-6-luna',
    effort: 'medium',
    mode: 'work',
    history,
    summary: null,
    projectInstructions: '',
    cwd: null,
    work: { swarm: false, plan: false },
    goal: null,
    engine: 'codex',
    ...extra
  } as StreamRequest
}

const usage: TokenUsage = { input: 120, output: 30, cacheRead: 0, cacheWrite: 0 }

/** A Codex stand-in that records its input and plays back a scripted turn. */
function fakeAdapter(script: (input: EngineTurnInput) => Promise<Partial<EngineTurnResult>>): { adapter: EngineAdapter; inputs: EngineTurnInput[] } {
  const inputs: EngineTurnInput[] = []
  const adapter = {
    id: 'codex',
    runTurn: async (input: EngineTurnInput) => {
      inputs.push(input)
      const out = await script(input)
      return { sessionId: 'thread-9', text: '', usage, cancelled: false, sideEffects: false, ...out } as EngineTurnResult
    }
  } as unknown as EngineAdapter
  return { adapter, inputs }
}

function deps(adapter: EngineAdapter, sessions: Map<string, string>, asked: EngineApprovalRequest[] = [], answer = true): EngineChatDeps & { recorded: string[] } {
  const recorded: string[] = []
  return {
    recorded,
    adapter: () => adapter,
    session: (chatId, engine) => sessions.get(`${chatId}:${engine}`) ?? null,
    saveSession: (chatId, engine, id) => {
      if (id) sessions.set(`${chatId}:${engine}`, id)
      else sessions.delete(`${chatId}:${engine}`)
    },
    ask: async (tool, input, summary) => {
      asked.push({ tool, input, summary, mutating: true })
      return answer
    },
    record: (account, model, used) => recorded.push(`${account}|${model}|${used.input + used.output}`)
  }
}

test('a chat moving to Codex part-way gives it what was said; the next message continues Codex’s own conversation', async () => {
  const sessions = new Map<string, string>()
  const { adapter, inputs } = fakeAdapter(async (input) => {
    input.emit({ type: 'delta', messageId: input.messageId, text: 'Hello there.' })
    return { text: 'Hello there.' }
  })
  const d = deps(adapter, sessions)
  const events: StreamEvent[] = []
  const history = [msg('user', 'What is in the repo?'), msg('assistant', 'A desktop app.'), msg('user', 'Now ask Codex')]
  const first = await runEngineChat({ request: request(history), engine: 'codex', cwd: '/tmp/work', settings: settings('ask'), signal: new AbortController().signal, emit: (e) => events.push(e) }, d)
  assert.equal(first.text, 'Hello there.')
  assert.equal(inputs[0].sessionId, null)
  assert.match(inputs[0].text, /Earlier in this conversation[\s\S]*User: What is in the repo\?[\s\S]*Assistant: A desktop app\.[\s\S]*---\nNow ask Codex$/)
  assert.equal(inputs[0].model, 'gpt-6-luna')
  assert.equal(inputs[0].cwd, '/tmp/work')
  assert.equal(inputs[0].access, 'safe')
  assert.deepEqual(
    events.map((e) => e.type),
    ['delta', 'done']
  )
  assert.equal(sessions.get('chat-1:codex'), 'thread-9', 'its conversation is remembered for the chat')
  assert.deepEqual(d.recorded, ['codex|gpt-6-luna|150'], 'counted as Codex on the plan, from Chat')

  // The next message: Codex already has the conversation; nothing is resent.
  await runEngineChat({ request: request([...history, msg('assistant', 'Hello there.'), msg('user', 'history please')], { messageId: 'reply-2' }), engine: 'codex', cwd: '/tmp/work', settings: settings('ask'), signal: new AbortController().signal, emit: () => {} }, d)
  assert.equal(inputs[1].sessionId, 'thread-9')
  assert.equal(inputs[1].text, 'history please')
})

test('Chat’s own approval rules decide what Codex may do without asking', () => {
  const read: EngineApprovalRequest = { tool: 'run_command', input: { command: 'ls' }, summary: 'ls', mutating: false }
  const write: EngineApprovalRequest = { tool: 'run_command', input: { command: 'npm test' }, summary: 'npm test', mutating: true }
  const wreck: EngineApprovalRequest = { tool: 'run_command', input: { command: 'rm -rf ~' }, summary: 'rm -rf ~', mutating: true }
  assert.equal(chatEngineApproval(settings('ask'), false, read), true, 'reading never asks')
  assert.equal(chatEngineApproval(settings('ask'), false, write), null, 'Ask first: the dialog decides')
  assert.equal(chatEngineApproval(settings('full'), false, write), true, 'Full access: it runs')
  assert.equal(chatEngineApproval(settings('full'), false, wreck), false, 'never anything that could wreck the computer')
  assert.equal(chatEngineApproval(settings('full'), true, write), false, 'Plan mode changes nothing')
})

test('a call Codex wants approved reaches the approval dialog, and the answer goes back', async () => {
  const asked: EngineApprovalRequest[] = []
  let allowed: boolean | null = null
  const { adapter } = fakeAdapter(async (input) => {
    allowed = await input.approve({ tool: 'apply_patch', input: { files: ['notes.txt'] }, summary: 'notes.txt', mutating: true })
    return { text: 'ok' }
  })
  await runEngineChat({ request: request([msg('user', 'patch it')]), engine: 'codex', cwd: '/w', settings: settings('ask'), signal: new AbortController().signal, emit: () => {} }, deps(adapter, new Map(), asked, false))
  assert.equal(asked.length, 1)
  assert.equal(asked[0].tool, 'apply_patch')
  assert.equal(allowed, false, 'the user said no')
})

test('a failed turn ends the reply with what fixes it; a stopped one just ends', async () => {
  const events: StreamEvent[] = []
  const { adapter } = fakeAdapter(async () => ({ error: 'unexpected status 401', errorKind: 'auth-expired' as const }))
  const out = await runEngineChat({ request: request([msg('user', 'hi')]), engine: 'codex', cwd: '/w', settings: settings('ask'), signal: new AbortController().signal, emit: (e) => events.push(e) }, deps(adapter, new Map()))
  assert.match(out.error ?? '', /Codex’s sign-in expired\. Sign in again/)
  assert.equal(events.at(-1)?.type, 'error')

  const stopped: StreamEvent[] = []
  const { adapter: stopper } = fakeAdapter(async () => ({ cancelled: true }))
  const outcome = await runEngineChat({ request: request([msg('user', 'hi')]), engine: 'codex', cwd: '/w', settings: settings('ask'), signal: new AbortController().signal, emit: (e) => stopped.push(e) }, deps(stopper, new Map()))
  assert.equal(outcome.error, undefined)
  assert.deepEqual(
    stopped.map((e) => e.type),
    ['done']
  )
  assert.match(engineChatError('codex', { errorKind: 'model-unavailable' } as EngineTurnResult, 'nope'), /doesn’t offer nope on your account/)
})

test('the catch-up keeps the newest of a long conversation and the summary of what came before', () => {
  const long = Array.from({ length: 200 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `message ${i} ${'x'.repeat(200)}`))
  const text = catchUp(long, 'they planned a release')
  assert.ok(text.length <= 12_000 + 200, String(text.length))
  assert.match(text, /^Summary of the conversation before that: they planned a release/)
  assert.match(text, /message 199/)
  assert.doesNotMatch(text, /message 0 /)
})
