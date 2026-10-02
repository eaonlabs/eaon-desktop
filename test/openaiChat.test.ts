import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openaiChatAdapter, __test } from '../src/main/providers/adapters/openaiChat'
import type { TurnRequest } from '../src/main/providers/adapters/types'
import { chunk, provider, rawServer, sseServer } from './helpers'

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

test('a stream that closes before finish_reason or [DONE] is an error, not an answer', async () => {
  const { url, server } = await sseServer(() => [
    chunk({ content: 'Writing it now.' }),
    chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"path":"a' } }] })
  ])
  try {
    await assert.rejects(openaiChatAdapter.turn(request(url)), /stream ended before it finished/)
  } finally {
    server.close()
  }
})

test('either finish_reason or [DONE] marks a stream as finished', async () => {
  const onlyFinish = await sseServer(() => [chunk({ content: 'Hi.' }, 'stop')])
  const finished = await openaiChatAdapter.turn(request(onlyFinish.url)).finally(() => onlyFinish.server.close())
  assert.equal(finished.text, 'Hi.')
  const onlyDone = await sseServer(() => [chunk({ content: 'Hi.' }), '[DONE]'])
  const done = await openaiChatAdapter.turn(request(onlyDone.url)).finally(() => onlyDone.server.close())
  assert.equal(done.stop, 'end')
})

test('a final event without a trailing newline is still read', async () => {
  const { url, server } = await rawServer(() => ({
    body: `data: ${chunk({ content: 'Hello' })}\n\ndata: ${chunk({ content: ' there' }, 'stop')}`
  }))
  const result = await openaiChatAdapter.turn(request(url + '/v1')).finally(() => server.close())
  assert.equal(result.text, 'Hello there')
  assert.equal(result.stop, 'end')
})

test('a reply the provider interrupted for lack of capacity is an error, not an answer', async () => {
  // DeepSeek ends a reply it could not finish with this finish_reason; the
  // text (or tool call) before it is cut off mid-way.
  const { url, server } = await sseServer(() => [
    chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"path":"a' } }] }),
    chunk({}, 'insufficient_system_resource'),
    '[DONE]'
  ])
  try {
    await assert.rejects(openaiChatAdapter.turn(request(url)), /overloaded/)
  } finally {
    server.close()
  }
})

test('tool arguments are always an object: null is none, double-encoded JSON is unwrapped', async () => {
  // JSON.parse gave the loop `null` or a string here, and the loop's
  // `'__invalid_json' in input` check threw a TypeError that ended the turn.
  const { url, server } = await sseServer(() => [
    chunk({
      tool_calls: [
        { index: 0, id: 'a', function: { name: 'read_file', arguments: 'null' } },
        { index: 1, id: 'b', function: { name: 'read_file', arguments: JSON.stringify(JSON.stringify({ path: 'a.txt' })) } },
        { index: 2, id: 'c', function: { name: 'read_file', arguments: '[1,2]' } }
      ]
    }),
    chunk({}, 'tool_calls')
  ])
  const result = await openaiChatAdapter.turn(request(url)).finally(() => server.close())
  assert.deepEqual(result.calls[0].input, {})
  assert.deepEqual(result.calls[1].input, { path: 'a.txt' })
  assert.deepEqual(result.calls[2].input, { __invalid_json: '[1,2]' })
})

test('parallel calls with a null index are kept apart by their ids', async () => {
  // Servers that serialise unset fields send `index: null`; keyed as "inull",
  // both calls merged into one with `{"path":"a"}{"path":"b"}` as arguments.
  const { url, server } = await sseServer(() => [
    chunk({ tool_calls: [{ index: null, id: 'a', function: { name: 'read_file', arguments: '{"path":"a"}' } }] }),
    chunk({ tool_calls: [{ index: null, id: 'b', function: { name: 'read_file', arguments: '{"path":"b"}' } }] }),
    chunk({}, 'tool_calls')
  ])
  const result = await openaiChatAdapter.turn(request(url)).finally(() => server.close())
  assert.deepEqual(result.calls, [
    { id: 'a', name: 'read_file', input: { path: 'a' } },
    { id: 'b', name: 'read_file', input: { path: 'b' } }
  ])
})

test('images are not counted as text when fitting the output cap into the window', async () => {
  const { url, server, requests } = await sseServer(() => [chunk({ content: 'ok' }, 'stop')])
  const shot = { mime: 'image/png', data: 'A'.repeat(300_000) }
  await openaiChatAdapter
    .turn(
      request(url, {
        model: { id: 'test-model', label: 'm', providerId: 'test', contextWindow: 128_000, maxOutput: 32_000 },
        messages: [{ role: 'user', text: 'what is on screen?', images: [shot, shot] }]
      })
    )
    .finally(() => server.close())
  assert.equal(requests[0].max_tokens, 32_000)
})
