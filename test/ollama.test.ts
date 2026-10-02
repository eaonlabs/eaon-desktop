import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ollamaAdapter, ollamaHost } from '../src/main/providers/adapters/ollama'
import type { TurnRequest } from '../src/main/providers/adapters/types'
import { contextWindowFor, LOCAL_CONTEXT } from '../src/main/providers/models'
import type { ModelInfo, Provider } from '@shared/types'
import { provider, rawServer } from './helpers'

const ndjson = (lines: Record<string, unknown>[]): string => lines.map((line) => JSON.stringify(line)).join('\n') + '\n'

function request(p: Provider, overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    provider: p,
    modelId: 'gpt-oss:20b',
    model: { id: 'gpt-oss:20b', label: 'gpt-oss', providerId: 'ollama', reasoning: true, tools: true, efforts: ['light', 'medium', 'high'] } as ModelInfo,
    credentials: {},
    system: 'sys',
    messages: [{ role: 'user', text: 'hi', images: [{ mime: 'image/png', data: 'IMG' }] }],
    tools: [{ name: 'read_file', description: 'read', inputSchema: { type: 'object', properties: {} } }],
    effort: 'ultra',
    signal: new AbortController().signal,
    cacheKey: 'c',
    agentic: true,
    onText: () => {},
    onReasoning: () => {},
    ...overrides
  }
}

const ollama = (url: string): Provider => provider({ id: 'ollama', kind: 'ollama', local: true, baseUrl: `${url}/v1` })

test('posts to the native /api/chat with num_ctx, think level, images and tools', async () => {
  let reasoning = ''
  const { url, server, requests } = await rawServer(() => ({
    type: 'application/x-ndjson',
    body: ndjson([
      { message: { role: 'assistant', content: '', thinking: 'thinking…' }, done: false },
      { message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_x', function: { name: 'read_file', arguments: { path: 'a' } } }] }, done: false },
      { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 300, eval_count: 20 }
    ])
  }))
  const result = await ollamaAdapter.turn(request(ollama(url), { onReasoning: (d) => (reasoning += d) }))
  server.close()

  const sent = requests[0]
  assert.equal(sent.url, '/api/chat')
  assert.deepEqual(sent.body.options, { num_ctx: LOCAL_CONTEXT })
  assert.equal(sent.body.think, 'high')
  assert.equal((sent.body.tools as unknown[]).length, 1)
  assert.deepEqual((sent.body.messages as { images?: string[] }[])[1].images, ['IMG'])
  assert.equal(reasoning, 'thinking…')
  assert.deepEqual(result.calls, [{ id: 'call_x', name: 'read_file', input: { path: 'a' } }])
  assert.equal(result.stop, 'tool_use')
  assert.deepEqual(result.usage, { input: 300, output: 20, cacheRead: 0, cacheWrite: 0 })
})

test('num_ctx matches the window the loop plans compaction against', async () => {
  const { url, server, requests } = await rawServer(() => ({ body: ndjson([{ message: { content: 'ok' }, done: true, done_reason: 'stop' }]) }))
  const model: ModelInfo = { id: 'small:1b', label: 'small', providerId: 'ollama', contextWindow: 8192 }
  const p = ollama(url)
  await ollamaAdapter.turn(request(p, { modelId: 'small:1b', model }))
  server.close()
  assert.equal((requests[0].body.options as { num_ctx: number }).num_ctx, contextWindowFor(p, 'small:1b', model))
  assert.equal(contextWindowFor(p, 'small:1b', model), 8192)
  assert.equal(contextWindowFor(p, 'unknown', undefined), LOCAL_CONTEXT)
})

test('cloud models get no num_ctx; tool calls and thinking replay as Ollama expects', async () => {
  const { url, server, requests } = await rawServer(() => ({ body: ndjson([{ message: { content: 'ok' }, done: true }]) }))
  await ollamaAdapter.turn(
    request(ollama(url), {
      modelId: 'glm-5.1:cloud',
      model: { id: 'glm-5.1:cloud', label: 'glm', providerId: 'ollama', reasoning: true } as ModelInfo,
      messages: [
        { role: 'user', text: 'go' },
        { role: 'assistant', text: '', calls: [{ id: 'c1', name: 'read_file', input: { path: 'a' } }], replay: { adapter: 'ollama', modelId: 'glm-5.1:cloud', data: { thinking: 'plan' } } },
        { role: 'tool', results: [{ id: 'c1', name: 'read_file', output: 'contents' }] }
      ]
    })
  )
  server.close()
  const body = requests[0].body
  assert.equal(body.options, undefined)
  assert.equal(body.think, true)
  const messages = body.messages as { role: string; thinking?: string; tool_calls?: unknown; tool_name?: string }[]
  assert.equal(messages[2].thinking, 'plan')
  assert.deepEqual(messages[2].tool_calls, [{ function: { name: 'read_file', arguments: { path: 'a' } } }])
  assert.equal(messages[3].tool_name, 'read_file')
})

test('a model that cannot think or use tools is retried without them', async () => {
  let calls = 0
  const { url, server, requests } = await rawServer((body) => {
    calls++
    if (body.think !== undefined) return { status: 400, type: 'application/json', body: JSON.stringify({ error: '"gemma3" does not support thinking' }) }
    if (body.tools) return { status: 400, type: 'application/json', body: JSON.stringify({ error: 'registry.ollama.ai/library/gemma3 does not support tools' }) }
    return { body: ndjson([{ message: { content: 'plain' }, done: true }]) }
  })
  const result = await ollamaAdapter.turn(request(ollama(url)))
  server.close()
  assert.equal(calls, 3)
  assert.equal(requests[2].body.tools, undefined)
  assert.equal(result.text, 'plain')
})

test('inline <think> in content is split out', async () => {
  const { url, server } = await rawServer(() => ({
    body: ndjson([{ message: { content: '<think>hmm' } }, { message: { content: '</think>Answer' } }, { message: { content: '' }, done: true, done_reason: 'stop' }])
  }))
  const result = await ollamaAdapter.turn(request(ollama(url), { model: undefined, modelId: 'deepseek-r1:7b' }))
  server.close()
  assert.equal(result.text, 'Answer')
  assert.equal((result.replay?.data as { thinking: string }).thinking, 'hmm')
})

test('the native host is derived from the OpenAI-style base URL', () => {
  assert.equal(ollamaHost('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434')
  assert.equal(ollamaHost('http://gpu-box:11434/v1/'), 'http://gpu-box:11434')
  assert.equal(ollamaHost('http://gpu-box:11434'), 'http://gpu-box:11434')
})

test('a stream that closes before the done chunk is an error, not an answer', async () => {
  const { url, server } = await rawServer(() => ({
    body: ndjson([{ message: { content: 'Half an ans' } }, { message: { tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a' } } }] } }])
  }))
  try {
    await assert.rejects(ollamaAdapter.turn(request(ollama(url))), /stream ended before it finished/)
  } finally {
    server.close()
  }
})

test('a stream cut in the middle of a line is a retryable truncation, not a JSON error', async () => {
  // The connection dropped part-way through a chunk: the last line is half a
  // JSON object. That used to surface as "Unterminated string in JSON", which
  // the loop does not retry.
  const { url, server } = await rawServer(() => ({
    body: `${JSON.stringify({ message: { content: 'Hel' }, done: false })}\n{"message":{"content":"lo wor`
  }))
  try {
    await assert.rejects(ollamaAdapter.turn(request(ollama(url))), /stream ended before it finished/)
  } finally {
    server.close()
  }
})

test('Ollama tool arguments are always an object', async () => {
  const { url, server } = await rawServer(() => ({
    body: ndjson([
      { message: { content: '', tool_calls: [{ function: { name: 'read_file', arguments: null } }, { function: { name: 'read_file', arguments: '"{\\"path\\":\\"b\\"}"' } }] }, done: false },
      { message: { content: '' }, done: true, done_reason: 'stop' }
    ])
  }))
  const result = await ollamaAdapter.turn(request(ollama(url))).finally(() => server.close())
  assert.deepEqual(result.calls.map((call) => call.input), [{}, { path: 'b' }])
})

test('a model too slow to start answering is not reported as Ollama being down', async () => {
  const realFetch = globalThis.fetch
  // What Node's fetch throws when no response starts within its 5-minute headers timeout.
  globalThis.fetch = (async () => {
    throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) })
  }) as typeof fetch
  try {
    await assert.rejects(ollamaAdapter.turn(request(ollama('http://127.0.0.1:1'))), (error: Error) => {
      assert.match(error.message, /more than 5 minutes to start answering/)
      assert.doesNotMatch(error.message, /installed and running/)
      return true
    })
  } finally {
    globalThis.fetch = realFetch
  }
})
