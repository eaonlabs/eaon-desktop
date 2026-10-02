import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { anthropicAdapter } from '../src/main/providers/adapters/anthropic'
import { ProviderHttpError, type TurnRequest } from '../src/main/providers/adapters/types'
import { provider } from './helpers'

/**
 * The Anthropic adapter against a local server speaking the Messages
 * streaming protocol — checks the request shape that decides cost (cache
 * breakpoints, context editing) and correctness (thinking config per model).
 */

interface Captured {
  url: string
  headers: Record<string, string | string[] | undefined>
  body: Record<string, any>
}

async function anthropicServer(events: { event: string; data: Record<string, unknown> }[]) {
  const captured: Captured[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    captured.push({ url: req.url ?? '', headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) })
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const e of events) res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server, captured }
}

const toolUseStream = [
  {
    event: 'message_start',
    data: {
      type: 'message_start',
      message: {
        id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 3000, cache_creation_input_tokens: 400 }
      }
    }
  },
  { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Reading it.' } } },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' } } },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
  { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 42 } } },
  { event: 'message_stop', data: { type: 'message_stop' } }
]

function request(url: string, modelId: string, overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    provider: provider({ id: 'anthropic', kind: 'anthropic', baseUrl: url, builtIn: true }),
    modelId,
    model: undefined,
    credentials: { apiKey: 'sk-test' },
    system: 'You are Eaon.',
    messages: [{ role: 'user', text: 'read a.ts' }],
    tools: [
      { name: 'list_dir', description: 'list', inputSchema: { type: 'object', properties: {} } },
      { name: 'read_file', description: 'read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }
    ],
    effort: 'extra-high',
    signal: new AbortController().signal,
    cacheKey: 'chat',
    agentic: true,
    onText: () => {},
    onReasoning: () => {},
    ...overrides
  }
}

test('agentic Opus request: cache breakpoints, context editing, adaptive thinking, xhigh effort', async () => {
  const { url, server, captured } = await anthropicServer(toolUseStream)
  let text = ''
  const result = await anthropicAdapter.turn(request(url, 'claude-opus-5', { onText: (d) => (text += d) }))
  server.close()
  const { body, headers } = captured[0]
  assert.equal(text, 'Reading it.')
  assert.deepEqual(result.calls, [{ id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } }])
  assert.equal(result.stop, 'tool_use')
  assert.deepEqual(result.usage, { input: 120, output: 42, cacheRead: 3000, cacheWrite: 400 })
  // Cost: the tool list and system prompt are cached, and the tail moves.
  assert.deepEqual(body.tools[1].cache_control, { type: 'ephemeral' })
  assert.equal(body.tools[0].cache_control, undefined)
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' })
  assert.deepEqual(body.cache_control, { type: 'ephemeral' })
  assert.equal(body.context_management.edits[0].type, 'clear_tool_uses_20250919')
  assert.match(String(headers['anthropic-beta']), /context-management-2025-06-27/)
  // Correctness: adaptive thinking with a visible summary, xhigh effort.
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' })
  assert.deepEqual(body.output_config, { effort: 'xhigh' })
  // Replay keeps the raw blocks for the next round of the same turn.
  assert.equal(result.replay?.adapter, 'anthropic')
})

test('Haiku 4.5 gets budgeted thinking and no effort field', async () => {
  const { url, server, captured } = await anthropicServer(toolUseStream)
  await anthropicAdapter.turn(request(url, 'claude-haiku-4-5', { effort: 'medium' }))
  server.close()
  const { body } = captured[0]
  assert.equal(body.thinking.type, 'enabled')
  assert.ok(body.thinking.budget_tokens >= 1024 && body.thinking.budget_tokens < body.max_tokens)
  assert.equal(body.output_config, undefined)
})

test('Opus 4.6 has no xhigh: the effort falls back to one it accepts', async () => {
  const { url, server, captured } = await anthropicServer(toolUseStream)
  await anthropicAdapter.turn(request(url, 'claude-opus-4-6', { effort: 'extra-high' }))
  server.close()
  assert.notEqual(captured[0].body.output_config?.effort, 'xhigh')
})

test('plain chat turns skip context editing', async () => {
  const { url, server, captured } = await anthropicServer(toolUseStream)
  await anthropicAdapter.turn(request(url, 'claude-sonnet-5', { agentic: false }))
  server.close()
  assert.equal(captured[0].body.context_management, undefined)
})

test('tool results carry screenshots as image blocks', async () => {
  const { url, server, captured } = await anthropicServer(toolUseStream)
  await anthropicAdapter.turn(
    request(url, 'claude-sonnet-5', {
      messages: [
        { role: 'user', text: 'look' },
        { role: 'assistant', text: '', calls: [{ id: 't1', name: 'computer', input: { action: 'screenshot' } }] },
        { role: 'tool', results: [{ id: 't1', name: 'computer', output: '1280x800', images: [{ mime: 'image/jpeg', data: 'AAAA' }] }] }
      ]
    })
  )
  server.close()
  const toolResult = captured[0].body.messages[2].content[0]
  assert.equal(toolResult.type, 'tool_result')
  assert.equal(toolResult.content[1].type, 'image')
})

test('a stream cut off before message_stop is reported as a retryable truncation', async () => {
  const { url, server } = await anthropicServer(toolUseStream.slice(0, 6))
  try {
    await assert.rejects(anthropicAdapter.turn(request(url, 'claude-opus-4-7')), /stream ended before it finished/)
  } finally {
    server.close()
  }
})

test('message_stop without a stop_reason is not taken as a finished reply', async () => {
  // The last input_json_delta is half an object; the SDK's partial parser
  // turns it into { path: 'a' }, a call that looks whole.
  const cut = [
    ...toolUseStream.slice(0, 5),
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a' } } },
    { event: 'message_stop', data: { type: 'message_stop' } }
  ]
  const { url, server } = await anthropicServer(cut)
  try {
    await assert.rejects(anthropicAdapter.turn(request(url, 'claude-opus-4-7')), /stream ended before it finished/)
  } finally {
    server.close()
  }
})

test('an overload without retry-after leaves the wait to the loop, and reads as the API message', async () => {
  // Number(null) is 0: a missing header used to become "retry in 0s", so an
  // overloaded API was hit three more times back to back.
  const server = createServer((_req, res) => {
    res.writeHead(529, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    const error = (await anthropicAdapter.turn(request(url, 'claude-opus-5')).then(
      () => assert.fail('expected a rejection'),
      (e: unknown) => e
    )) as ProviderHttpError
    assert.ok(error instanceof ProviderHttpError)
    assert.equal(error.status, 529)
    assert.equal(error.retryAfterMs, undefined)
    assert.equal(error.message, '529: Overloaded')
  } finally {
    server.close()
  }
})

test('retry-after on a 429 is honoured', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '7' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Slow down' } }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    await assert.rejects(anthropicAdapter.turn(request(url, 'claude-opus-5')), (error: unknown) => {
      assert.ok(error instanceof ProviderHttpError)
      assert.equal(error.retryAfterMs, 7000)
      return true
    })
  } finally {
    server.close()
  }
})

test('a reply stopped by the context window is cut off, so its tool call is not run', async () => {
  // The SDK fills a half-streamed tool input in from partial JSON; a
  // write_file cut here would otherwise run with truncated content.
  const cut = [
    ...toolUseStream.slice(0, 5),
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'model_context_window_exceeded', stop_sequence: null }, usage: { output_tokens: 9 } } },
    { event: 'message_stop', data: { type: 'message_stop' } }
  ]
  const { url, server } = await anthropicServer(cut)
  try {
    const result = await anthropicAdapter.turn(request(url, 'claude-opus-5'))
    assert.equal(result.stop, 'max_tokens')
  } finally {
    server.close()
  }
})

test('screenshots in the transcript do not squeeze max_tokens to the floor', async () => {
  // Image base64 was counted as text: four 250 KB screenshots "used" ~280k
  // of a 200k window, so every reply was capped at 1024 tokens (thinking
  // included) and the loop kept reporting "hit the output limit".
  const shot = { mime: 'image/png', data: 'A'.repeat(250_000) }
  const messages: TurnRequest['messages'] = [{ role: 'user', text: 'click through the settings' }]
  for (let i = 0; i < 4; i++) {
    messages.push({ role: 'assistant', text: '', calls: [{ id: `t${i}`, name: 'computer', input: { action: 'screenshot' } }] })
    messages.push({ role: 'tool', results: [{ id: `t${i}`, name: 'computer', output: '1280x800', images: [shot] }] })
  }
  const { url, server, captured } = await anthropicServer(toolUseStream)
  try {
    await anthropicAdapter.turn(request(url, 'claude-haiku-4-5', { messages }))
    assert.ok(captured[0].body.max_tokens > 32_000, `max_tokens was ${captured[0].body.max_tokens}`)
  } finally {
    server.close()
  }
})
