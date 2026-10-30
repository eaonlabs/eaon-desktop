import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createClaudeAgentAdapter, type ClaudeAgentDeps } from '../src/main/providers/claudeAgent/adapter'
import { fingerprint, withCheckpoint } from '../src/main/providers/claudeAgent/history'
import { shortName } from '../src/main/providers/claudeAgent/tools'
import type { NeutralMessage, ToolSpec, TurnRequest } from '../src/main/providers/adapters/types'

/**
 * Claude Agent as a provider: Claude running Eaon's own agent through the
 * user's Claude Code. A stand-in for Claude Code reads the session's
 * messages and calls Eaon's tools over the real MCP server the adapter
 * offers, so these check the hand-off both ways: a held call becomes the
 * loop's step, and the loop's result goes back into the waiting session.
 */

/** What the stand-in Claude Code does with each message it is sent. */
type Reply = (
  said: string,
  claude: { say: (text: string) => void; call: (name: string, input: Record<string, unknown>) => Promise<string>; raw: (message: unknown) => void }
) => Promise<void>

interface Started {
  options: Options
  said: string[]
}

function fakeClaude(reply: Reply) {
  const started: Started[] = []
  let sessionCount = 0
  const query = ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => {
    const run: Started = { options: options!, said: [] }
    started.push(run)
    const session = options?.resume ?? `claude-session-${++sessionCount}`
    const out: SDKMessage[] = []
    let wake: (() => void) | null = null
    const emit = (message: unknown): void => {
      out.push(message as SDKMessage)
      wake?.()
    }
    let finished = false
    void (async () => {
      let client: Client | null = null
      const server = (options?.mcpServers?.eaon as { instance?: McpServer } | undefined)?.instance
      if (server) {
        const [a, b] = InMemoryTransport.createLinkedPair()
        await server.connect(a)
        client = new Client({ name: 'fake-claude', version: '1' })
        await client.connect(b)
      }
      emit({ type: 'system', subtype: 'init', session_id: session, apiKeySource: 'none' })
      let n = 0
      for await (const message of prompt) {
        const content = (message.message as { content: { type: string; text?: string }[] }).content
        const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('')
        run.said.push(text)
        const id = `msg-${++n}`
        emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id, usage: { input_tokens: 100, cache_read_input_tokens: 50 } } } })
        await reply(text, {
          say: (t) => emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } } }),
          raw: emit,
          call: async (name, input) => {
            const listed = await client!.listTools()
            assert.ok(listed.tools.some((t) => t.name === name), `${name} is offered`)
            const result = await client!.callTool({ name, arguments: input })
            return (result.content as { text: string }[]).map((c) => c.text).join('')
          }
        })
        emit({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_delta', usage: { output_tokens: 20 } } })
        emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: session, usage: {} })
      }
      finished = true
      wake?.()
    })()
    const iterator = (async function* () {
      while (true) {
        const next = out.shift()
        if (next) {
          yield next
          continue
        }
        if (finished) return
        await new Promise<void>((resolve) => (wake = resolve))
        wake = null
      }
    })()
    return Object.assign(iterator, { interrupt: async () => undefined, close: () => (finished = true) }) as never
  }
  return { query, started }
}

function adapterWith(reply: Reply, overrides: Partial<ClaudeAgentDeps> = {}) {
  const fake = fakeClaude(reply)
  const adapter = createClaudeAgentAdapter({
    executable: () => '/usr/local/bin/claude',
    env: () => ({ PATH: '/usr/bin' }),
    auth: async () => ({ auth: { state: 'signed-in', method: 'Claude account', plan: 'Max' }, checkedAt: Date.now() }),
    defaultCwd: () => '/tmp/eaon-claude-agent',
    query: async () => fake.query as never,
    ...overrides
  })
  return { adapter, started: fake.started }
}

const TOOLS: ToolSpec[] = [
  { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'web_browser', description: 'Use the browser', inputSchema: { type: 'object', properties: {} } }
]

function request(messages: NeutralMessage[], extra: Partial<TurnRequest> = {}): TurnRequest & { streamed: string[] } {
  const streamed: string[] = []
  return {
    provider: { id: 'claude-agent' } as never,
    modelId: 'sonnet',
    model: { id: 'sonnet', label: 'Sonnet', providerId: 'claude-agent', efforts: ['light', 'medium', 'high'] },
    credentials: {},
    system: 'You are Eaon.',
    messages,
    tools: TOOLS,
    effort: 'high',
    signal: new AbortController().signal,
    cacheKey: 'chat-1',
    agentic: true,
    onText: (t) => streamed.push(t),
    onReasoning: () => {},
    cwd: '/Users/me/project',
    streamed,
    ...extra
  }
}

test('Claude Code starts as Eaon’s model: its own tools and settings off, Eaon’s tools in, Eaon’s prompt after its own', async () => {
  const { adapter, started } = adapterWith(async (_said, claude) => claude.say('Hi.'))
  const result = await adapter.turn(request([{ role: 'user', text: 'hello' }]))
  assert.equal(result.text, 'Hi.')
  assert.equal(result.stop, 'end')
  const { options } = started[0]
  assert.equal(options.pathToClaudeCodeExecutable, '/usr/local/bin/claude')
  assert.deepEqual(options.tools, [], 'no Claude Code tools')
  assert.deepEqual(options.allowedTools, ['mcp__eaon__*'])
  assert.equal(options.permissionMode, 'dontAsk', 'Eaon asks itself, before it runs a call')
  assert.deepEqual(options.settingSources, [], 'none of the user’s Claude Code settings')
  assert.equal(options.strictMcpConfig, true)
  assert.equal(options.model, 'sonnet')
  assert.equal(options.effort, 'high')
  assert.equal(options.cwd, '/Users/me/project')
  assert.equal(options.verbatimPrompts, true)
  const prompt = options.systemPrompt as { type: string; preset: string; append: string; snapshot: boolean }
  assert.equal(prompt.preset, 'claude_code')
  assert.equal(prompt.snapshot, false)
  assert.match(prompt.append, /running in Eaon[\s\S]*You are Eaon\./)
  assert.equal(options.env?.ENABLE_TOOL_SEARCH, 'false', 'tool search would hide every Eaon tool')
  assert.equal(options.env?.CLAUDE_CODE_DISABLE_CLAUDE_MDS, '1')
  assert.deepEqual(result.usage, { input: 100, output: 20, cacheRead: 50, cacheWrite: 0 })
})

test('a tool call ends the step; the loop runs it; its result goes back into the waiting session, which goes on', async () => {
  let seen = ''
  const { adapter, started } = adapterWith(async (said, claude) => {
    if (said.startsWith('Read')) {
      claude.say('Reading. ')
      seen = await claude.call('read_file', { path: 'a.txt' })
      claude.say(`It says ${seen}.`)
    } else claude.say('Sure.')
  })
  const messages: NeutralMessage[] = [{ role: 'user', text: 'Read a.txt' }]
  const first = await adapter.turn(request(messages))
  assert.equal(first.stop, 'tool_use')
  assert.equal(first.text, 'Reading. ')
  assert.equal(first.calls.length, 1)
  assert.deepEqual([first.calls[0].name, first.calls[0].input], ['read_file', { path: 'a.txt' }])

  // The loop's way: its reply, then the results, in the same array.
  messages.push({ role: 'assistant', text: first.text, calls: first.calls })
  messages.push({ role: 'tool', results: [{ id: first.calls[0].id, name: 'read_file', output: 'hello world' }] })
  const second = await adapter.turn(request(messages))
  assert.equal(seen, 'hello world', 'Claude got Eaon’s result')
  assert.equal(second.stop, 'end')
  assert.equal(second.text, 'It says hello world.')
  assert.equal(started.length, 1, 'one process for the whole turn')

  // The next turn: Eaon rebuilds the history from the saved chat; the same session goes on with just the new message.
  const rebuilt: NeutralMessage[] = [
    { role: 'user', text: 'Read a.txt' },
    { role: 'assistant', text: 'Reading. ', calls: first.calls },
    { role: 'tool', results: [{ id: first.calls[0].id, name: 'read_file', output: '[output shortened]' }] },
    { role: 'assistant', text: 'It says hello world.', calls: [] },
    { role: 'user', text: 'Thanks' }
  ]
  const third = await adapter.turn(request(rebuilt))
  assert.equal(third.text, 'Sure.')
  assert.equal(started.length, 1, 'still the same process')
  assert.deepEqual(started[0].said, ['Read a.txt', 'Thanks'], 'only the new message was sent')
})

test('a changed prompt resumes the same Claude session in a new process; a changed history starts again, caught up', async () => {
  const { adapter, started } = adapterWith(async (_said, claude) => claude.say('ok'))
  await adapter.turn(request([{ role: 'user', text: 'one' }]))
  const history: NeutralMessage[] = [
    { role: 'user', text: 'one' },
    { role: 'assistant', text: 'ok', calls: [] },
    { role: 'user', text: 'two' }
  ]
  await adapter.turn(request(history, { system: 'You are Eaon. Today is Friday.' }))
  assert.equal(started.length, 2)
  assert.equal(started[1].options.resume, 'claude-session-1', 'a new process, the same session')
  assert.deepEqual(started[1].said, ['two'])

  // An edit: the earlier message is different now.
  const edited: NeutralMessage[] = [
    { role: 'user', text: 'one, edited' },
    { role: 'assistant', text: 'ok', calls: [] },
    { role: 'user', text: 'three' }
  ]
  await adapter.turn(request(edited, { system: 'You are Eaon. Today is Friday.' }))
  assert.equal(started.length, 3)
  assert.equal(started[2].options.resume, undefined, 'a new session')
  assert.match(started[2].said[0], /<conversation-checkpoint>[\s\S]*one, edited[\s\S]*<\/conversation-checkpoint>\n\nthree$/)
})

test('a subagent while its parent waits on it gets a session of its own, and the parent’s goes on after', async () => {
  const { adapter, started } = adapterWith(async (said, claude) => {
    if (said === 'Plan the trip') {
      const answer = await claude.call('web_browser', { task: 'find flights' })
      claude.say(`Found: ${answer}`)
    } else claude.say('Two flights.')
  })
  const parent: NeutralMessage[] = [{ role: 'user', text: 'Plan the trip' }]
  const step = await adapter.turn(request(parent))
  assert.equal(step.stop, 'tool_use')
  // The subagent: its own loop, its own messages, the same chat.
  const sub = await adapter.turn(request([{ role: 'user', text: 'find flights' }], { system: 'You are a subagent.' }))
  assert.equal(sub.text, 'Two flights.')
  assert.equal(started.length, 2)
  assert.equal(started[1].options.persistSession, false, 'kept out of the user’s Claude history')
  parent.push({ role: 'assistant', text: '', calls: step.calls }, { role: 'tool', results: [{ id: step.calls[0].id, name: 'web_browser', output: 'Two flights.' }] })
  const done = await adapter.turn(request(parent))
  assert.equal(done.text, 'Found: Two flights.')
})

test('a title is a one-off with Eaon’s prompt alone; the loop’s own nudges go into the session without joining the record', async () => {
  const { adapter, started } = adapterWith(async (said, claude) => claude.say(said === 'Name this chat' ? 'Trip planning' : said.includes('Go ahead') ? 'Doing it.' : ''))
  const title = await adapter.turn(request([{ role: 'user', text: 'Name this chat' }], { tools: [], system: 'Write a title.', cacheKey: 'eaon-chat-title' }))
  assert.equal(title.text, 'Trip planning')
  assert.equal(started[0].options.systemPrompt, 'Write a title.')
  assert.equal(started[0].options.persistSession, false)

  // An empty reply, then the loop's nudge (it doesn't record the empty reply).
  const messages: NeutralMessage[] = [{ role: 'user', text: 'Book it' }]
  const empty = await adapter.turn(request(messages))
  assert.equal(empty.text, '')
  messages.push({ role: 'user', text: 'Go ahead and do it now with your tools, then report back.' })
  const nudged = await adapter.turn(request(messages))
  assert.equal(nudged.text, 'Doing it.')
  assert.equal(started.length, 2, 'the same session')
  // The rebuilt history has no nudge, and still matches.
  await adapter.turn(request([{ role: 'user', text: 'Book it' }, { role: 'assistant', text: 'Doing it.', calls: [] }, { role: 'user', text: 'Thanks' }]))
  assert.equal(started.length, 2)
})

test('never charged: a key sign-in is refused before Claude Code starts, and extra usage stops the turn', async () => {
  const keyed = adapterWith(async (_s, claude) => claude.say('x'), {
    auth: async () => ({ auth: { state: 'signed-in', method: 'API key', plan: null }, checkedAt: Date.now() })
  })
  await assert.rejects(() => keyed.adapter.turn(request([{ role: 'user', text: 'hi' }])), /charges per use/)
  assert.equal(keyed.started.length, 0)
  const out = adapterWith(async (_s, claude) => claude.say('x'), {
    auth: async () => ({ auth: { state: 'signed-out', method: null, plan: null }, checkedAt: Date.now() })
  })
  await assert.rejects(() => out.adapter.turn(request([{ role: 'user', text: 'hi' }])), /isn’t signed in/)

  // Past the plan's limit with extra usage on: this turn stops, and the next doesn't start until the reset.
  const resets = Math.round(Date.now() / 1000) + 3600
  const over = adapterWith(async (_s, claude) => {
    claude.raw({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', isUsingOverage: true, resetsAt: resets } })
    claude.say('more')
  })
  await assert.rejects(() => over.adapter.turn(request([{ role: 'user', text: 'hi' }])), /extra usage, which Anthropic charges for\. Eaon stopped/)
  await assert.rejects(() => over.adapter.turn(request([{ role: 'user', text: 'again' }], { cacheKey: 'chat-2' })), /Try again after/)
  assert.equal(over.started.length, 1, 'the second turn never started Claude Code')
})

test('history keys: what survives Eaon’s rebuild of a chat, and a checkpoint for a session that joins late', () => {
  const live: NeutralMessage[] = [
    { role: 'user', text: 'Look at this\n\nAttached file /a.txt:\n```\nfull text\n```' },
    { role: 'assistant', text: 'Reading', calls: [{ id: 'toolu_1', name: 'read_file', input: { path: '/a.txt' } }] },
    { role: 'tool', results: [{ id: 'toolu_1', name: 'read_file', output: 'a long output' }] }
  ]
  const rebuilt: NeutralMessage[] = [
    { role: 'user', text: '(continuing the conversation)' },
    { role: 'user', text: 'Look at this\n\n[Attached: /a.txt]' },
    { role: 'assistant', text: 'Reading…', calls: [{ id: 'toolu_1', name: 'read_file', input: {} }] },
    { role: 'tool', results: [{ id: 'toolu_1', name: 'read_file', output: '[shortened]' }] }
  ]
  assert.deepEqual(fingerprint(live), fingerprint(rebuilt))
  assert.equal(withCheckpoint([], 'hi'), 'hi')
  assert.match(withCheckpoint(live, 'next'), /^<conversation-checkpoint>[\s\S]*USER: Look at this[\s\S]*\n\nnext$/)
  assert.equal(shortName('read_file'), 'read_file')
  assert.ok(shortName('mcp:server/very-long-tool-name-'.repeat(4)).length <= 64 - 'mcp__eaon__'.length)
})
