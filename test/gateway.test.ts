import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { startLocalServer, stopLocalServer } from '../src/main/localServer'
import { gatewayInfo, setGatewayDefaults } from '../src/main/gateway'
import { resolveGatewayModel } from '../src/main/gateway/models'
import { store } from '../src/main/store'
import { secrets } from '../src/main/secrets'
import { chunk, sseServer } from './helpers'

/**
 * The gateway: other apps (Claude Code, Codex, OpenCode…) using Eaon's
 * models through the Local API Server in three wire formats, with the app's
 * own tools passed through. The upstream is a fake OpenAI-compatible
 * provider; nothing reaches a real API.
 */

type Reply = string[] | { status: number; body: string }
let reply: (body: Record<string, unknown>) => Reply = () => [chunk({ content: 'ok' }, 'stop')]
let upstream: Awaited<ReturnType<typeof sseServer>>
let base = ''

const quietLocals = { ollama: { enabled: false }, 'lm-studio': { enabled: false }, 'llama-cpp': { enabled: false }, mlx: { enabled: false }, vllm: { enabled: false }, jan: { enabled: false } }

before(async () => {
  upstream = await sseServer((body) => reply(body))
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
  store.patchSettings({ localServer: { ...store.getSettings().localServer, port: 47331, defaultModelId: null, smallModelId: null } })
  const status = await startLocalServer()
  assert.equal(status.running, true, status.error)
  base = status.url!
})

after(async () => {
  await stopLocalServer()
  upstream.server.close()
})

const last = (): Record<string, unknown> => upstream.requests[upstream.requests.length - 1]

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; text: string; json: () => Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  const text = await res.text()
  return { status: res.status, text, json: () => JSON.parse(text) as Record<string, unknown> }
}

/** `data:` lines of an OpenAI stream, parsed (without [DONE]). */
const dataLines = (text: string): Record<string, unknown>[] =>
  text
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>)

/** `event:` + `data:` pairs of an Anthropic or Responses stream. */
const events = (text: string): { event: string; data: Record<string, unknown> }[] =>
  text
    .split('\n\n')
    .filter((block) => block.startsWith('event: '))
    .map((block) => {
      const [eventLine, dataLine] = block.split('\n')
      return { event: eventLine.slice(7), data: JSON.parse(dataLine.slice(6)) as Record<string, unknown> }
    })

const toolCall = (index: number, id: string, name: string, args: string): string =>
  chunk({ tool_calls: [{ index, id, type: 'function', function: { name, arguments: args } }] })

const READ_TOOL = { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }

/* ------------------------------------------------------------- chat completions */

test('chat completions: the app’s tools reach the model and its tool call comes back', async () => {
  reply = () => [chunk({ content: 'Let me look.' }), toolCall(0, 'call_1', 'read_file', '{"path":"a.ts"}'), chunk({}, 'tool_calls')]
  const res = await post('/v1/chat/completions', { model: 'fake/big-model', messages: [{ role: 'user', content: 'read a.ts' }], tools: [READ_TOOL] })
  assert.equal(res.status, 200)
  const body = res.json() as { choices: { message: { content: string; tool_calls: { id: string; function: { name: string; arguments: string } }[] }; finish_reason: string }[] }
  assert.equal(body.choices[0].finish_reason, 'tool_calls')
  assert.equal(body.choices[0].message.content, 'Let me look.')
  assert.equal(body.choices[0].message.tool_calls[0].function.name, 'read_file')
  assert.deepEqual(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments), { path: 'a.ts' })
  const sent = last() as { model: string; tools: { function: { name: string } }[] }
  assert.equal(sent.model, 'big-model', 'the provider gets its own model id')
  assert.equal(sent.tools[0].function.name, 'read_file')
})

test('chat completions, streamed: text, two parallel tool calls, finish reason, usage and [DONE]', async () => {
  reply = () => [chunk({ content: 'Reading both.' }), toolCall(0, 'call_a', 'read_file', '{"path":"a"}'), toolCall(1, 'call_b', 'read_file', '{"path":"b"}'), chunk({}, 'tool_calls')]
  const res = await post('/v1/chat/completions', {
    model: 'big-model',
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: 'user', content: 'read a and b' }],
    tools: [READ_TOOL]
  })
  assert.equal(res.status, 200)
  assert.match(res.text, /data: \[DONE\]\n\n$/)
  const chunks = dataLines(res.text) as { choices: { delta: { content?: string; tool_calls?: { index: number; id: string; function: { arguments: string } }[] }; finish_reason: string | null }[]; usage?: unknown }[]
  const text = chunks.map((c) => c.choices[0]?.delta.content ?? '').join('')
  assert.equal(text, 'Reading both.')
  const calls = chunks.flatMap((c) => c.choices[0]?.delta.tool_calls ?? [])
  assert.deepEqual(calls.map((c) => [c.index, c.id]), [[0, 'call_a'], [1, 'call_b']])
  assert.equal(chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0].finish_reason, 'tool_calls')
  assert.ok(chunks.some((c) => c.usage), 'a usage chunk when asked for')
})

test('chat completions: the round trip sends the call and its result back to the model', async () => {
  reply = () => [chunk({ content: 'a.ts exports one function.' }, 'stop')]
  const res = await post('/v1/chat/completions', {
    model: 'big-model',
    messages: [
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: 'read a.ts' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'export const a = 1' }
    ],
    tools: [READ_TOOL]
  })
  assert.equal(res.status, 200)
  assert.equal((res.json() as { choices: { finish_reason: string }[] }).choices[0].finish_reason, 'stop')
  const sent = last() as { messages: { role: string; content: unknown; tool_calls?: { id: string }[]; tool_call_id?: string }[] }
  assert.deepEqual(sent.messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool'])
  assert.equal(sent.messages[2].tool_calls?.[0].id, 'call_1')
  assert.equal(sent.messages[3].tool_call_id, 'call_1')
  assert.equal(sent.messages[3].content, 'export const a = 1')
})

test('chat completions: max_tokens lowers the output cap sent upstream', async () => {
  reply = () => [chunk({ content: 'ok' }, 'stop')]
  await post('/v1/chat/completions', { model: 'big-model', max_tokens: 321, messages: [{ role: 'user', content: 'hi' }] })
  const sent = last() as { max_tokens?: number; max_completion_tokens?: number }
  assert.equal(sent.max_tokens ?? sent.max_completion_tokens, 321)
})

test('a base URL without /v1 still works', async () => {
  reply = () => [chunk({ content: 'ok' }, 'stop')]
  const res = await post('/chat/completions', { model: 'big-model', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(res.status, 200)
})

/* ------------------------------------------------------------- anthropic messages */

const ANTHROPIC_HEADERS = { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14' }
const READ_TOOL_ANTHROPIC = { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } }, cache_control: { type: 'ephemeral' } }

test('anthropic messages: Claude Code’s request shape, a tool_use block and stop_reason tool_use', async () => {
  reply = () => [chunk({ content: 'Reading.' }), toolCall(0, 'call_x', 'Read', '{"file_path":"/tmp/a.ts"}'), chunk({}, 'tool_calls')]
  const res = await post(
    '/v1/messages?beta=true',
    {
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 32000,
      system: [{ type: 'text', text: 'You are Claude Code.', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'read a.ts', cache_control: { type: 'ephemeral' } }] }],
      tools: [READ_TOOL_ANTHROPIC, { type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
      metadata: { user_id: 'someone' }
    },
    ANTHROPIC_HEADERS
  )
  assert.equal(res.status, 200, res.text)
  const body = res.json() as { type: string; role: string; content: { type: string; text?: string; id?: string; name?: string; input?: unknown }[]; stop_reason: string; usage: { input_tokens: number } }
  assert.equal(body.type, 'message')
  assert.equal(body.stop_reason, 'tool_use')
  assert.deepEqual(body.content.map((b) => b.type), ['text', 'tool_use'])
  assert.equal(body.content[1].name, 'Read')
  assert.deepEqual(body.content[1].input, { file_path: '/tmp/a.ts' })
  assert.equal(typeof body.usage.input_tokens, 'number')
  const sent = last() as { model: string; messages: { role: string; content: unknown }[]; tools: { function: { name: string } }[] }
  assert.equal(sent.model, 'big-model', 'Claude Code’s own model name maps to the default (the first model when none is set)')
  assert.equal(sent.messages[0].role, 'system')
  assert.equal(sent.messages[0].content, 'You are Claude Code.')
  assert.deepEqual(sent.tools.map((t) => t.function.name), ['Read'], 'server tools are left out')
})

test('anthropic messages, streamed: the event sequence Claude Code reads', async () => {
  reply = () => [chunk({ content: 'Rea' }), chunk({ content: 'ding.' }), toolCall(0, 'call_y', 'Read', '{"file_path":"b"}'), chunk({}, 'tool_calls')]
  const res = await post('/v1/messages', { model: 'fake/big-model', max_tokens: 1000, stream: true, messages: [{ role: 'user', content: 'read b' }], tools: [READ_TOOL_ANTHROPIC] }, ANTHROPIC_HEADERS)
  assert.equal(res.status, 200)
  const seq = events(res.text)
  assert.deepEqual(
    seq.map((e) => e.event),
    ['message_start', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']
  )
  assert.equal((seq[0].data.message as { role: string }).role, 'assistant')
  assert.deepEqual(seq[1].data.content_block, { type: 'text', text: '' })
  assert.equal((seq[2].data.delta as { text: string }).text, 'Rea')
  const toolStart = seq[5].data as { index: number; content_block: { type: string; name: string; id: string } }
  assert.equal(toolStart.index, 1)
  assert.equal(toolStart.content_block.type, 'tool_use')
  assert.match(toolStart.content_block.id, /^[A-Za-z0-9_-]+$/)
  assert.deepEqual(JSON.parse((seq[6].data.delta as { partial_json: string }).partial_json), { file_path: 'b' })
  assert.equal((seq[8].data.delta as { stop_reason: string }).stop_reason, 'tool_use')
})

test('anthropic messages: tool results, and thinking blocks from the app’s history, go back the right way', async () => {
  reply = () => [chunk({ content: 'Done.' }, 'stop')]
  const res = await post(
    '/v1/messages',
    {
      model: 'big-model',
      max_tokens: 1000,
      messages: [
        { role: 'user', content: 'read b' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'I should read it.', signature: 'abc' },
            { type: 'text', text: 'Reading.' },
            { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: 'b' } }
          ]
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: [{ type: 'text', text: 'contents of b' }] }, { type: 'text', text: 'thanks' }] }
      ],
      tools: [READ_TOOL_ANTHROPIC]
    },
    ANTHROPIC_HEADERS
  )
  assert.equal(res.status, 200, res.text)
  const sent = last() as { messages: { role: string; content: unknown; tool_calls?: { id: string; function: { name: string } }[]; tool_call_id?: string }[] }
  assert.deepEqual(sent.messages.map((m) => m.role), ['user', 'assistant', 'tool', 'user'])
  assert.equal(sent.messages[1].content, 'Reading.', 'thinking is not sent to another provider')
  assert.equal(sent.messages[1].tool_calls?.[0].function.name, 'Read')
  assert.equal(sent.messages[2].tool_call_id, sent.messages[1].tool_calls?.[0].id)
  assert.equal(sent.messages[2].content, 'contents of b')
})

test('anthropic messages: an app that asks for thinking gets a thinking block before the text', async () => {
  reply = () => [chunk({ reasoning_content: 'Hmm.' }), chunk({ content: 'Answer.' }, 'stop')]
  const res = await post(
    '/v1/messages',
    { model: 'big-model', max_tokens: 20000, stream: true, thinking: { type: 'enabled', budget_tokens: 16000 }, messages: [{ role: 'user', content: 'think' }] },
    ANTHROPIC_HEADERS
  )
  const seq = events(res.text)
  const starts = seq.filter((e) => e.event === 'content_block_start').map((e) => (e.data.content_block as { type: string }).type)
  assert.deepEqual(starts, ['thinking', 'text'])
  assert.ok(seq.some((e) => (e.data.delta as { type?: string } | undefined)?.type === 'signature_delta'), 'a thinking block closes with a signature')
  // Without asking, no thinking block.
  reply = () => [chunk({ reasoning_content: 'Hmm.' }), chunk({ content: 'Answer.' }, 'stop')]
  const plain = await post('/v1/messages', { model: 'big-model', max_tokens: 1000, stream: true, messages: [{ role: 'user', content: 'think' }] }, ANTHROPIC_HEADERS)
  assert.deepEqual(events(plain.text).filter((e) => e.event === 'content_block_start').map((e) => (e.data.content_block as { type: string }).type), ['text'])
})

test('anthropic count_tokens gives an estimate', async () => {
  const res = await post('/v1/messages/count_tokens?beta=true', { model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hello there, how are you today?' }] }, ANTHROPIC_HEADERS)
  assert.equal(res.status, 200)
  const body = res.json() as { input_tokens: number }
  assert.ok(body.input_tokens > 0)
})

/* ------------------------------------------------------------- responses (codex) */

const SHELL_TOOL = { type: 'function', name: 'shell', description: 'Run a command', strict: false, parameters: { type: 'object', properties: { command: { type: 'array', items: { type: 'string' } } }, required: ['command'] } }
const PATCH_TOOL = { type: 'custom', name: 'apply_patch', description: 'Apply a patch', format: { type: 'grammar', syntax: 'lark', definition: 'start: begin_patch' } }

test('responses, streamed: Codex’s request shape and the events it reads, ending in response.completed', async () => {
  reply = () => [chunk({ content: 'Listing.' }), toolCall(0, 'call_s', 'shell', '{"command":["ls"]}'), chunk({}, 'tool_calls')]
  const res = await post('/v1/responses', {
    model: 'gpt-5-codex',
    instructions: 'You are Codex.',
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Sandbox: workspace-write' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] }
    ],
    tools: [SHELL_TOOL, PATCH_TOOL, { type: 'web_search' }],
    tool_choice: 'auto',
    parallel_tool_calls: true,
    reasoning: { effort: 'medium', summary: 'auto' },
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: 'abc'
  })
  assert.equal(res.status, 200, res.text)
  const seq = events(res.text)
  assert.equal(seq[0].event, 'response.created')
  assert.equal(seq[seq.length - 1].event, 'response.completed')
  const done = seq.filter((e) => e.event === 'response.output_item.done').map((e) => e.data.item as { type: string; name?: string; call_id?: string; arguments?: string; content?: { text: string }[] })
  assert.deepEqual(done.map((i) => i.type), ['message', 'function_call'])
  assert.equal(done[0].content?.[0].text, 'Listing.')
  assert.equal(done[1].name, 'shell')
  assert.deepEqual(JSON.parse(done[1].arguments ?? ''), { command: ['ls'] })
  assert.ok(seq.some((e) => e.event === 'response.output_text.delta'))
  const completed = seq[seq.length - 1].data.response as { usage: { input_tokens: number; output_tokens: number }; output: unknown[] }
  assert.equal(typeof completed.usage.input_tokens, 'number')
  assert.equal(completed.output.length, 2)
  const sent = last() as { messages: { role: string; content: unknown }[]; tools: { function: { name: string; parameters: { properties: Record<string, unknown> } } }[] }
  assert.equal(sent.messages[0].role, 'system')
  assert.match(String(sent.messages[0].content), /You are Codex\.[\s\S]*Sandbox: workspace-write/)
  assert.deepEqual(sent.tools.map((t) => t.function.name), ['shell', 'apply_patch'], 'hosted tools are left out')
  assert.ok(sent.tools[1].function.parameters.properties.input, 'a freeform tool is offered with one string input')
})

test('responses: a freeform tool call comes back as custom_tool_call, and its output round-trips', async () => {
  reply = () => [toolCall(0, 'call_p', 'apply_patch', JSON.stringify({ input: '*** Begin Patch\n*** End Patch' })), chunk({}, 'tool_calls')]
  const res = await post('/v1/responses', { model: 'fake/big-model', input: 'patch it', tools: [PATCH_TOOL] })
  assert.equal(res.status, 200, res.text)
  const body = res.json() as { status: string; output: { type: string; call_id: string; input: string }[] }
  assert.equal(body.status, 'completed')
  assert.equal(body.output[0].type, 'custom_tool_call')
  assert.equal(body.output[0].input, '*** Begin Patch\n*** End Patch')

  reply = () => [chunk({ content: 'Patched.' }, 'stop')]
  await post('/v1/responses', {
    model: 'fake/big-model',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'patch it' }] },
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'xyz' },
      { type: 'custom_tool_call', call_id: body.output[0].call_id, name: 'apply_patch', input: '*** Begin Patch\n*** End Patch' },
      { type: 'custom_tool_call_output', call_id: body.output[0].call_id, output: 'Done!' },
      { type: 'function_call', call_id: 'call_2', name: 'shell', arguments: '{"command":["ls"]}' },
      { type: 'function_call_output', call_id: 'call_2', output: 'a.ts\nb.ts' }
    ],
    tools: [PATCH_TOOL, SHELL_TOOL]
  })
  const sent = last() as { messages: { role: string; content: unknown; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string }[] }
  // Two rounds: each call, then its output.
  assert.deepEqual(sent.messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant', 'tool'])
  assert.deepEqual(sent.messages[1].tool_calls?.map((c) => c.function.name), ['apply_patch'])
  assert.deepEqual(JSON.parse(sent.messages[1].tool_calls?.[0].function.arguments ?? ''), { input: '*** Begin Patch\n*** End Patch' })
  assert.deepEqual(sent.messages[3].tool_calls?.map((c) => c.function.name), ['shell'])
  assert.deepEqual([sent.messages[2].content, sent.messages[4].content], ['Done!', 'a.ts\nb.ts'])
  assert.equal(sent.messages[2].tool_call_id, sent.messages[1].tool_calls?.[0].id)
})

/* ------------------------------------------------------------- models, defaults, auth, errors */

test('model names: provider/model, a bare id, and an app’s own names mapped to the defaults', () => {
  setGatewayDefaults({ defaultModel: null, smallModel: null })
  assert.equal(resolveGatewayModel('fake/tiny-model')?.id, 'fake/tiny-model')
  assert.equal(resolveGatewayModel('tiny-model')?.id, 'fake/tiny-model')
  assert.deepEqual(resolveGatewayModel('claude-sonnet-4-5') && { id: resolveGatewayModel('claude-sonnet-4-5')!.id, mapped: resolveGatewayModel('claude-sonnet-4-5')!.mapped }, { id: 'fake/big-model', mapped: true }, 'no default yet: the first model')
  setGatewayDefaults({ defaultModel: 'fake/big-model', smallModel: 'fake/tiny-model' })
  assert.equal(resolveGatewayModel('claude-opus-4-1')?.id, 'fake/big-model')
  assert.equal(resolveGatewayModel('claude-3-5-haiku-20241022')?.id, 'fake/tiny-model', 'a haiku goes to the small slot')
  assert.equal(resolveGatewayModel('gpt-5-mini')?.id, 'fake/tiny-model')
  assert.equal(resolveGatewayModel('gpt-5')?.id, 'fake/big-model')
  setGatewayDefaults({ smallModel: null })
  assert.equal(resolveGatewayModel('claude-3-5-haiku-20241022')?.id, 'fake/big-model', 'no small model: the default')
})

test('/v1/models lists provider/model ids, in Anthropic’s shape when asked', async () => {
  const openai = (await (await fetch(`${base}/v1/models`)).json()) as { object: string; data: { id: string }[] }
  assert.equal(openai.object, 'list')
  assert.deepEqual(openai.data.map((m) => m.id), ['fake/big-model', 'fake/tiny-model'])
  const anthropic = (await (await fetch(`${base}/v1/models`, { headers: ANTHROPIC_HEADERS })).json()) as { data: { type: string; id: string }[]; has_more: boolean }
  assert.equal(anthropic.data[0].type, 'model')
  assert.equal(anthropic.has_more, false)
})

test('the key: none still works, this install’s works, any other is refused in the API’s own error shape', async () => {
  reply = () => [chunk({ content: 'ok' }, 'stop')]
  const { token } = gatewayInfo()
  assert.match(token, /^eaon-/)
  assert.equal(gatewayInfo().token, token, 'made once')
  const body = { model: 'big-model', messages: [{ role: 'user', content: 'hi' }] }
  assert.equal((await post('/v1/chat/completions', body)).status, 200)
  assert.equal((await post('/v1/chat/completions', body, { Authorization: `Bearer ${token}` })).status, 200)
  assert.equal((await post('/v1/messages', { ...body, max_tokens: 10 }, { 'x-api-key': token, ...ANTHROPIC_HEADERS })).status, 200)
  const wrong = await post('/v1/chat/completions', body, { Authorization: 'Bearer sk-not-this-one' })
  assert.equal(wrong.status, 401)
  assert.equal((wrong.json() as { error: { type: string } }).error.type, 'invalid_api_key')
  const wrongAnthropic = await post('/v1/messages', { ...body, max_tokens: 10 }, { 'x-api-key': 'nope', ...ANTHROPIC_HEADERS })
  assert.equal(wrongAnthropic.status, 401)
  assert.deepEqual((wrongAnthropic.json() as { type: string; error: { type: string } }).error.type, 'authentication_error')
})

test('provider errors come back in each API’s error shape; a refused provider key is not reported as the app’s', async () => {
  reply = () => ({ status: 400, body: JSON.stringify({ error: { message: 'context too long' } }) })
  const chat = await post('/v1/chat/completions', { model: 'big-model', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(chat.status, 400)
  assert.match((chat.json() as { error: { message: string } }).error.message, /context too long/)

  const messages = await post('/v1/messages', { model: 'big-model', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, ANTHROPIC_HEADERS)
  assert.equal(messages.status, 400)
  const anthropic = messages.json() as { type: string; error: { type: string; message: string } }
  assert.equal(anthropic.type, 'error')
  assert.equal(anthropic.error.type, 'invalid_request_error')

  reply = () => ({ status: 401, body: JSON.stringify({ error: { message: 'Incorrect API key provided' } }) })
  const refused = await post('/v1/messages', { model: 'big-model', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }, ANTHROPIC_HEADERS)
  assert.equal(refused.status, 502, 'a 401 would make Claude Code ask to log in again')

  reply = () => ({ status: 400, body: JSON.stringify({ error: { message: 'bad request' } }) })
  const responses = await post('/v1/responses', { model: 'big-model', input: 'hi' })
  assert.equal(responses.status, 400)
  assert.match((responses.json() as { error: { message: string } }).error.message, /bad request/)
})

test('malformed requests are refused with 400', async () => {
  assert.equal((await post('/v1/chat/completions', { model: 'big-model' })).status, 400)
  assert.equal((await post('/v1/messages', { model: 'big-model', max_tokens: 10 }, ANTHROPIC_HEADERS)).status, 400)
  assert.equal((await post('/v1/responses', { model: 'big-model' })).status, 400)
  const notJson = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...ANTHROPIC_HEADERS }, body: '{nope' })
  assert.equal(notJson.status, 400)
  assert.equal(((await notJson.json()) as { type: string }).type, 'error')
})

test('gatewayInfo gives connectors the URLs, key and models', () => {
  const info = gatewayInfo()
  assert.equal(info.running, true)
  assert.equal(info.openaiBaseUrl, 'http://127.0.0.1:47331/v1')
  assert.equal(info.anthropicBaseUrl, 'http://127.0.0.1:47331')
  assert.deepEqual(info.models.map((m) => m.id), ['fake/big-model', 'fake/tiny-model'])
  assert.equal(info.models[0].providerName, 'Fake')
})

test('health checks answer: Claude Code sends HEAD /api/hello first', async () => {
  assert.equal((await fetch(`${base}/api/hello`, { method: 'HEAD' })).status, 200)
  assert.equal((await fetch(`${base}/`)).status, 200)
})
