import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { anthropicAdapter } from '../src/main/providers/adapters/anthropic'
import { ollamaAdapter } from '../src/main/providers/adapters/ollama'
import { openaiChatAdapter } from '../src/main/providers/adapters/openaiChat'
import { openaiResponsesAdapter } from '../src/main/providers/adapters/openaiResponses'
import type { Adapter, TurnRequest } from '../src/main/providers/adapters/types'
import type { Provider } from '@shared/types'
import { chunk, provider } from './helpers'

/** A server that sends `first` and then holds the connection open, like a model thinking. */
async function stalling(first: string): Promise<{ base: string; server: Server; closed: () => boolean }> {
  let closed = false
  const server = createServer((req, res) => {
    req.resume()
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(first)
    res.on('close', () => (closed = true))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server, closed: () => closed }
}

const cases: [string, Adapter, (base: string) => Provider, string][] = [
  ['openai-chat', openaiChatAdapter, (base) => provider({ baseUrl: `${base}/v1` }), `data: ${chunk({ content: 'Hel' })}\n\n`],
  ['openai-responses', openaiResponsesAdapter, (base) => provider({ kind: 'openai-responses', baseUrl: `${base}/v1` }), `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Hel' })}\n\n`],
  ['ollama', ollamaAdapter, (base) => provider({ id: 'ollama', kind: 'ollama', local: true, baseUrl: `${base}/v1` }), `${JSON.stringify({ message: { content: 'Hel' }, done: false })}\n`],
  ['anthropic', anthropicAdapter, (base) => provider({ id: 'anthropic', kind: 'anthropic', baseUrl: base, builtIn: true }), `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })}\n\nevent: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\nevent: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } })}\n\n`]
]

for (const [name, adapter, make, first] of cases) {
  test(`${name}: Stop mid-stream settles at once and closes the connection`, async () => {
    const { base, server, closed } = await stalling(first)
    const controller = new AbortController()
    let text = ''
    const request: TurnRequest = {
      provider: make(base),
      modelId: 'claude-sonnet-5',
      model: undefined,
      credentials: { apiKey: 'k' },
      system: 'sys',
      messages: [{ role: 'user', text: 'hi' }],
      tools: [],
      effort: 'medium',
      signal: controller.signal,
      cacheKey: 'c',
      agentic: false,
      onText: (delta) => {
        text += delta
        controller.abort()
      },
      onReasoning: () => {}
    }
    try {
      const started = Date.now()
      await assert.rejects(adapter.turn(request))
      assert.ok(Date.now() - started < 2000)
      assert.equal(text, 'Hel')
      const deadline = Date.now() + 2000
      while (!closed() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
      assert.equal(closed(), true, 'the provider connection is closed')
    } finally {
      server.closeAllConnections()
      server.close()
    }
  })
}
