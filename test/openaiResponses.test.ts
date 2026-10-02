import { test } from 'node:test'
import assert from 'node:assert/strict'
import { codexUrl, openaiResponsesAdapter, __test } from '../src/main/providers/adapters/openaiResponses'
import { ProviderHttpError, type TurnRequest } from '../src/main/providers/adapters/types'
import type { ModelInfo, Provider } from '@shared/types'
import { provider, rawServer, sse } from './helpers'

function request(p: Provider, overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    provider: p,
    modelId: 'gpt-5.5',
    model: { id: 'gpt-5.5', label: 'GPT-5.5', providerId: p.id, reasoning: true, efforts: ['light', 'medium', 'high', 'extra-high'], maxOutput: 128_000, contextWindow: 272_000 } as ModelInfo,
    credentials: { apiKey: 'k' },
    system: 'be brief',
    messages: [{ role: 'user', text: 'hi' }],
    tools: [{ name: 'read_file', description: 'read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
    effort: 'ultra',
    signal: new AbortController().signal,
    cacheKey: 'chat-abc',
    agentic: true,
    onText: () => {},
    onReasoning: () => {},
    ...overrides
  }
}

const reasoningItem = { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'Plan.' }], encrypted_content: 'ENC' }
const callItem = { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}', status: 'completed' }

/** A full streamed turn: reasoning summary, a function call with argument deltas, usage with cache hits. */
const toolTurn = sse([
  { type: 'response.created', response: { id: 'resp_1' } },
  { type: 'response.output_item.added', output_index: 0, item: { id: 'rs_1', type: 'reasoning', summary: [] } },
  { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'Pla' },
  { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'n.' },
  { type: 'response.reasoning_summary_part.done', output_index: 0 },
  { type: 'response.output_item.done', output_index: 0, item: reasoningItem },
  { type: 'response.output_item.added', output_index: 1, item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '' } },
  { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":' },
  { type: 'response.function_call_arguments.delta', output_index: 1, delta: '"a.txt"}' },
  { type: 'response.function_call_arguments.done', output_index: 1, arguments: '{"path":"a.txt"}' },
  { type: 'response.output_item.done', output_index: 1, item: callItem },
  {
    type: 'response.completed',
    response: { id: 'resp_1', status: 'completed', output: [reasoningItem, callItem], usage: { input_tokens: 1000, output_tokens: 40, input_tokens_details: { cached_tokens: 600 } } }
  }
])

test('streams reasoning summaries, function calls and cached-token usage', async () => {
  let reasoning = ''
  const { url, server, requests } = await rawServer(() => ({ body: toolTurn }))
  const result = await openaiResponsesAdapter.turn(request(provider({ id: 'openai', kind: 'openai-responses', baseUrl: `${url}/v1` }), { onReasoning: (d) => (reasoning += d) }))
  server.close()

  assert.equal(requests[0].url, '/v1/responses')
  const body = requests[0].body
  assert.equal(body.store, false)
  assert.deepEqual(body.reasoning, { effort: 'xhigh', summary: 'auto' })
  assert.deepEqual(body.include, ['reasoning.encrypted_content'])
  assert.equal(body.prompt_cache_key, 'chat-abc')
  assert.equal((body.tools as { strict: boolean }[])[0].strict, false)
  assert.deepEqual((body.input as { role?: string }[])[0], { role: 'developer', content: 'be brief' })

  assert.equal(reasoning, 'Plan.\n\n')
  assert.equal(result.stop, 'tool_use')
  assert.deepEqual(result.calls, [{ id: 'call_1', name: 'read_file', input: { path: 'a.txt' } }])
  assert.deepEqual(result.usage, { input: 400, output: 40, cacheRead: 600, cacheWrite: 0 })
  assert.equal(result.replay?.adapter, 'openai-responses')
})

test('encrypted reasoning is replayed verbatim within the turn; otherwise calls go without item ids', () => {
  const replayed = __test.toInput(
    request(provider({ id: 'openai' }), {
      messages: [
        { role: 'user', text: 'go' },
        { role: 'assistant', text: '', calls: [{ id: 'call_1', name: 'read_file', input: { path: 'a.txt' } }], replay: { adapter: 'openai-responses', modelId: 'gpt-5.5', data: { items: [reasoningItem, callItem] } } },
        { role: 'tool', results: [{ id: 'call_1', name: 'read_file', output: 'contents', images: [{ mime: 'image/png', data: 'AAAA' }] }] }
      ]
    }),
    false
  ).input
  assert.deepEqual(replayed[2], reasoningItem)
  assert.deepEqual(replayed[3], callItem)
  assert.deepEqual(replayed[4], { type: 'function_call_output', call_id: 'call_1', output: 'contents' })
  // The screenshot follows as a user message.
  assert.equal((replayed[5] as { role: string }).role, 'user')

  const rebuilt = __test.toInput(
    request(provider({ id: 'openai' }), {
      modelId: 'gpt-5.4',
      messages: [
        { role: 'user', text: 'go' },
        { role: 'assistant', text: 'ok', calls: [{ id: 'toolu_01/x', name: 'read_file', input: {} }], replay: { adapter: 'openai-responses', modelId: 'gpt-5.5', data: { items: [reasoningItem] } } }
      ]
    }),
    false
  ).input
  assert.deepEqual(rebuilt[2], { role: 'assistant', content: 'ok' })
  assert.deepEqual(rebuilt[3], { type: 'function_call', call_id: 'toolu_01_x', name: 'read_file', arguments: '{}' })
})

test('Codex backend: URL, instructions, account and session headers, no output cap', async () => {
  const { url, server, requests } = await rawServer(() => ({
    body: sse([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } },
      { type: 'response.output_text.delta', output_index: 0, delta: 'Hi' },
      { type: 'response.done', response: { status: 'completed', usage: { input_tokens: 5, output_tokens: 1 } } }
    ])
  }))
  const codex = provider({ id: 'openai-codex', kind: 'openai-responses', baseUrl: `${url}/backend-api` })
  const result = await openaiResponsesAdapter.turn(request(codex, { credentials: { apiKey: 'tok', extra: { accountId: 'acct_9' } } }))
  server.close()

  const sent = requests[0]
  assert.equal(sent.url, '/backend-api/codex/responses')
  assert.equal(sent.headers['chatgpt-account-id'], 'acct_9')
  assert.equal(sent.headers.authorization, 'Bearer tok')
  assert.equal(sent.headers.originator, 'pi')
  assert.equal(sent.headers['openai-beta'], 'responses=experimental')
  assert.equal(sent.headers['session-id'], 'chat-abc')
  assert.equal(sent.body.instructions, 'be brief')
  assert.equal(sent.body.max_output_tokens, undefined)
  assert.equal(sent.body.tool_choice, 'auto')
  assert.equal(sent.body.parallel_tool_calls, true)
  assert.equal((sent.body.tools as { strict: null }[])[0].strict, null)
  assert.equal(result.text, 'Hi')
  assert.equal(result.stop, 'end')

  assert.equal(codexUrl('https://chatgpt.com/backend-api/'), 'https://chatgpt.com/backend-api/codex/responses')
  assert.equal(codexUrl('https://chatgpt.com/backend-api/codex'), 'https://chatgpt.com/backend-api/codex/responses')
})

test('an output-limit stop maps to max_tokens', async () => {
  const { url, server } = await rawServer(() => ({
    body: sse([
      { type: 'response.output_text.delta', output_index: 0, delta: 'partial' },
      { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: {} } }
    ])
  }))
  const result = await openaiResponsesAdapter.turn(request(provider({ id: 'openai', baseUrl: url })))
  server.close()
  assert.equal(result.stop, 'max_tokens')
})

test('HTTP errors keep their status and retry-after; a spent ChatGPT plan is not retried', async () => {
  const busy = await rawServer(() => ({ status: 429, type: 'application/json', headers: { 'retry-after-ms': '1500' }, body: JSON.stringify({ error: { message: 'slow down' } }) }))
  await assert.rejects(openaiResponsesAdapter.turn(request(provider({ id: 'openai', baseUrl: busy.url }))), (error: unknown) => {
    assert.ok(error instanceof ProviderHttpError)
    assert.equal(error.status, 429)
    assert.equal(error.retryAfterMs, 1500)
    return true
  })
  busy.server.close()

  const spent = await rawServer(() => ({
    status: 429,
    type: 'application/json',
    body: JSON.stringify({ error: { code: 'usage_limit_reached', plan_type: 'plus', resets_at: Math.floor(Date.now() / 1000) + 600 } })
  }))
  await assert.rejects(
    openaiResponsesAdapter.turn(request(provider({ id: 'openai-codex', baseUrl: spent.url }), { credentials: { apiKey: 't', extra: { accountId: 'a' } } })),
    (error: unknown) => {
      assert.ok(!(error instanceof ProviderHttpError))
      assert.match((error as Error).message, /ChatGPT usage limit \(plus plan\)\. Try again in ~10 min/)
      return true
    }
  )
  spent.server.close()
})

test('a rejected reasoning parameter is dropped and the request retried (older models)', async () => {
  let calls = 0
  const { url, server, requests } = await rawServer((body) => {
    calls++
    if (body.reasoning) return { status: 400, type: 'application/json', body: JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning.effort'" } }) }
    return { body: sse([{ type: 'response.completed', response: { status: 'completed', usage: {} } }]) }
  })
  await openaiResponsesAdapter.turn(request(provider({ id: 'xai', baseUrl: url })))
  server.close()
  assert.equal(calls, 2)
  assert.equal(requests[1].body.reasoning, undefined)
})

test('a failed response and a stream that never finishes both surface as errors', async () => {
  const failed = await rawServer(() => ({ body: sse([{ type: 'response.failed', response: { error: { code: 'server_error', message: 'boom' } } }]) }))
  await assert.rejects(openaiResponsesAdapter.turn(request(provider({ id: 'openai', baseUrl: failed.url }))), /server_error: boom/)
  failed.server.close()

  const cut = await rawServer(() => ({ body: sse([{ type: 'response.output_text.delta', output_index: 0, delta: 'x' }]) }))
  await assert.rejects(openaiResponsesAdapter.turn(request(provider({ id: 'openai', baseUrl: cut.url }))), /ended before it finished/)
  cut.server.close()
})

test('Responses tool arguments are always an object', async () => {
  const { url, server } = await rawServer(() => ({
    body: sse([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '' } },
      { type: 'response.function_call_arguments.done', output_index: 0, arguments: 'null' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'c1', name: 'read_file', arguments: 'null' } },
      { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } } }
    ])
  }))
  const result = await openaiResponsesAdapter
    .turn(request(provider({ id: 'openai', kind: 'openai-responses', baseUrl: `${url}/v1` })))
    .finally(() => server.close())
  assert.deepEqual(result.calls, [{ id: 'c1', name: 'read_file', input: {} }])
})

test('Sign in with ChatGPT: plain Responses API, system prompt in instructions, no output cap', async () => {
  const done = sse([{ type: 'response.completed', response: { id: 'r', status: 'completed', output: [], usage: { input_tokens: 5, output_tokens: 1 } } }])
  const { url, server, requests } = await rawServer(() => ({ body: done }))
  await openaiResponsesAdapter.turn(request(provider({ id: 'chatgpt', kind: 'openai-responses', baseUrl: `${url}/v1` }), { credentials: { apiKey: 'plan-token' } }))
  server.close()
  assert.equal(requests[0].url, '/v1/responses')
  const body = requests[0].body
  assert.equal(body.instructions, 'be brief')
  assert.ok(!(body.input as { role?: string }[]).some((item) => item.role === 'system' || item.role === 'developer'), 'no system message items')
  assert.equal(body.max_output_tokens, undefined)
  assert.equal(body.temperature, undefined)
  assert.equal(body.store, false)
  assert.equal(body.stream, true)
  assert.equal(requests[0].headers.authorization, 'Bearer plan-token')
  assert.equal(requests[0].headers['chatgpt-account-id'], undefined)
})
