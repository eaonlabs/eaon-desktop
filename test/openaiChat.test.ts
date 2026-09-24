import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openaiChatAdapter, __test } from '../src/main/providers/adapters/openaiChat'
import type { TurnRequest } from '../src/main/providers/adapters/types'
import { chunk, provider, sseServer } from './helpers'

function request(base: string, overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    provider: provider({ baseUrl: base }),
    modelId: 'test-model',
    model: undefined,
    credentials: { apiKey: 'k' },
    system: 'sys',
    messages: [{ role: 'user', text: 'hi' }],
    tools: [{ name: 'read_file', description: 'read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
    effort: 'medium',
    signal: new AbortController().signal,
    cacheKey: 'chat1',
    agentic: true,
    onText: () => {},
    onReasoning: () => {},
    ...overrides
  }
}

test('tool calls are detected even when finish_reason says stop (Ollama)', async () => {
  const { url, server } = await sseServer(() => [
    chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"path":' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }),
    chunk({}, 'stop'),
    '[DONE]'
  ])
  const result = await openaiChatAdapter.turn(request(url))
  server.close()
  assert.equal(result.stop, 'tool_use')
  assert.deepEqual(result.calls, [{ id: 'c1', name: 'read_file', input: { path: 'a.txt' } }])
})

test('tool calls without index or id, and arguments sent as an object', async () => {
  const { url, server } = await sseServer(() => [
    chunk({ tool_calls: [{ function: { name: 'read_file', arguments: { path: 'b.txt' } } }] }),
    '[DONE]'
  ])
  const result = await openaiChatAdapter.turn(request(url))
  server.close()
  assert.equal(result.calls.length, 1)
  assert.equal(result.calls[0].name, 'read_file')
  assert.deepEqual(result.calls[0].input, { path: 'b.txt' })
  assert.match(result.calls[0].id, /^call_/)
})

test('invalid JSON arguments are surfaced for the loop to report, not thrown', async () => {
  const { url, server } = await sseServer(() => [
    chunk({ tool_calls: [{ index: 0, id: 'x', function: { name: 'read_file', arguments: '{"path": oops' } }] }, 'tool_calls')
  ])
  const result = await openaiChatAdapter.turn(request(url))
  server.close()
  assert.ok('__invalid_json' in result.calls[0].input)
})

test('text, reasoning and usage with cached tokens', async () => {
  let reasoning = ''
  let text = ''
  const { url, server } = await sseServer(() => [
    chunk({ reasoning_content: 'thinking…' }),
    chunk({ content: 'Hel' }),
    chunk({ content: 'lo' }, 'stop'),
    JSON.stringify({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 800 } } })
  ])
  const result = await openaiChatAdapter.turn(request(url, { onText: (d) => (text += d), onReasoning: (d) => (reasoning += d) }))
  server.close()
  assert.equal(text, 'Hello')
  assert.equal(reasoning, 'thinking…')
  assert.equal(result.stop, 'end')
  assert.deepEqual(result.usage, { input: 200, output: 20, cacheRead: 800, cacheWrite: 0 })
})

test('a model that cannot use tools is retried without them', async () => {
  let calls = 0
  const { url, server, requests } = await sseServer((body) => {
    calls++
    if (body.tools) return { status: 400, body: JSON.stringify({ error: { message: 'registry.ollama.ai/library/gemma does not support tools' } }) }
    return [chunk({ content: 'ok' }, 'stop')]
  })
  const result = await openaiChatAdapter.turn(request(url))
  server.close()
  assert.equal(calls, 2)
  assert.equal(requests[1].tools, undefined)
  assert.equal(result.text, 'ok')
})

test('reasoning_effort is only sent to models that take it', async () => {
  const { url, server, requests } = await sseServer(() => [chunk({ content: 'x' }, 'stop')])
  await openaiChatAdapter.turn(request(url, { modelId: 'llama-3.3-70b' }))
  await openaiChatAdapter.turn(request(url, { modelId: 'gpt-5-mini' }))
  server.close()
  assert.equal(requests[0].reasoning_effort, undefined)
  assert.equal(requests[1].reasoning_effort, 'medium')
})

test('Mistral gets nine-character alphanumeric tool ids, consistently', () => {
  const wire = __test.toWire(
    request('https://api.mistral.ai/v1', {
      provider: provider({ id: 'mistral', baseUrl: 'https://api.mistral.ai/v1' }),
      messages: [
        { role: 'user', text: 'hi' },
        { role: 'assistant', text: '', calls: [{ id: 'toolu_01ABCdef', name: 'read_file', input: { path: 'a' } }] },
        { role: 'tool', results: [{ id: 'toolu_01ABCdef', name: 'read_file', output: 'contents' }] }
      ]
    })
  )
  const assistant = wire.find((m) => m.role === 'assistant')!
  const tool = wire.find((m) => m.role === 'tool')!
  assert.match(assistant.tool_calls![0].id, /^[a-zA-Z0-9]{9}$/)
  assert.equal(assistant.tool_calls![0].id, tool.tool_call_id)
})

test('tool screenshots follow the tool message as a user image', () => {
  const wire = __test.toWire(
    request('http://x', {
      messages: [
        { role: 'user', text: 'look' },
        { role: 'assistant', text: '', calls: [{ id: 'c', name: 'computer', input: {} }] },
        { role: 'tool', results: [{ id: 'c', name: 'computer', output: 'shot', images: [{ mime: 'image/jpeg', data: 'AAAA' }] }] }
      ]
    })
  )
  const last = wire[wire.length - 1]
  assert.equal(last.role, 'user')
  assert.ok(Array.isArray(last.content))
})

test('Gemini schema sanitising drops unsupported keywords', () => {
  const clean = __test.sanitizeForGemini({
    $schema: 'x',
    type: 'object',
    additionalProperties: false,
    properties: { a: { type: ['string', 'null'], format: 'uri', default: 'q' } }
  }) as Record<string, any>
  assert.equal(clean.$schema, undefined)
  assert.equal(clean.additionalProperties, undefined)
  assert.equal(clean.properties.a.type, 'string')
  assert.equal(clean.properties.a.format, undefined)
})
