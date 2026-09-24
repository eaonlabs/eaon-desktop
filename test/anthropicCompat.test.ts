import { test } from 'node:test'
import assert from 'node:assert/strict'
import { anthropicAdapter } from '../src/main/providers/adapters/anthropic'
import { copilotHeaders, routerAdapter } from '../src/main/providers/adapters/router'
import type { TurnRequest } from '../src/main/providers/adapters/types'
import type { ModelInfo, Provider } from '@shared/types'
import { provider, rawServer, sse } from './helpers'

/** A minimal but complete Messages stream. */
const reply = sse([
  {
    type: 'message_start',
    message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } }
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: 'message_stop' }
])

function request(p: Provider, overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    provider: p,
    modelId: 'MiniMax-M2.7',
    model: { id: 'MiniMax-M2.7', label: 'M2.7', providerId: p.id, reasoning: true, efforts: ['light', 'medium', 'high'], maxOutput: 131_072, contextWindow: 204_800 } as ModelInfo,
    credentials: { apiKey: 'k' },
    system: 'sys',
    messages: [{ role: 'user', text: 'hi' }],
    tools: [{ name: 'read_file', description: 'read', inputSchema: { type: 'object', properties: {} } }],
    effort: 'high',
    signal: new AbortController().signal,
    cacheKey: 'c1',
    agentic: true,
    onText: () => {},
    onReasoning: () => {},
    ...overrides
  }
}

test('MiniMax: budget thinking, no betas, no top-level cache_control, a breakpoint on the last block', async () => {
  const { url, server, requests } = await rawServer(() => ({ body: reply }))
  const result = await anthropicAdapter.turn(request(provider({ id: 'minimax', kind: 'anthropic', baseUrl: `${url}/anthropic` })))
  server.close()
  const sent = requests[0]
  assert.equal(sent.url.startsWith('/anthropic/v1/messages'), true)
  assert.equal(sent.headers['anthropic-beta'], undefined)
  assert.equal(sent.headers['x-api-key'], 'k')
  assert.equal(sent.body.cache_control, undefined)
  assert.equal(sent.body.context_management, undefined)
  assert.deepEqual(sent.body.thinking, { type: 'enabled', budget_tokens: 12_000 })
  assert.equal(sent.body.output_config, undefined)
  const last = (sent.body.messages as { content: { cache_control?: unknown }[] }[]).at(-1)!
  assert.deepEqual(last.content.at(-1)!.cache_control, { type: 'ephemeral' })
  assert.equal(result.text, 'ok')
})

test('Kimi For Coding: adaptive thinking with an effort', async () => {
  const { url, server, requests } = await rawServer(() => ({ body: reply }))
  await anthropicAdapter.turn(
    request(provider({ id: 'kimi-coding', kind: 'anthropic', baseUrl: `${url}/coding` }), {
      modelId: 'k3',
      model: { id: 'k3', label: 'K3', providerId: 'kimi-coding', reasoning: true, efforts: ['light', 'high', 'ultra'] } as ModelInfo,
      effort: 'medium'
    })
  )
  server.close()
  assert.deepEqual(requests[0].body.thinking, { type: 'adaptive', display: 'summarized' })
  // "medium" is not a level K3 takes; the nearest one below is.
  assert.deepEqual(requests[0].body.output_config, { effort: 'low' })
})

test('Claude on a host that is not api.anthropic.com: Claude thinking, but no betas or automatic caching', async () => {
  const { url, server, requests } = await rawServer(() => ({ body: reply }))
  // First-party-ness is decided by host, so a proxy of Anthropic counts as a third party.
  await anthropicAdapter.turn(request(provider({ id: 'my-proxy', kind: 'anthropic', baseUrl: url }), { modelId: 'claude-opus-5', model: undefined }))
  server.close()
  assert.equal(requests[0].body.cache_control, undefined)
  assert.equal(requests[0].headers['anthropic-beta'], undefined)
  assert.deepEqual(requests[0].body.thinking, { type: 'adaptive', display: 'summarized' })
  assert.deepEqual(requests[0].body.output_config, { effort: 'high' })
})

test('Copilot routes Claude to Messages with a bearer token and the editor headers', async () => {
  const { url, server, requests } = await rawServer(() => ({ body: reply }))
  const copilot = provider({
    id: 'github-copilot',
    kind: 'openai-compatible',
    auth: 'oauth',
    baseUrl: url,
    headers: { 'Editor-Version': 'vscode/1.107.0', 'Copilot-Integration-Id': 'vscode-chat' }
  })
  await routerAdapter.turn(
    request(copilot, {
      modelId: 'claude-opus-4.8',
      model: undefined,
      credentials: { apiKey: 'copilot-token', baseUrl: url },
      messages: [
        { role: 'user', text: 'go' },
        { role: 'assistant', text: '', calls: [{ id: 't1', name: 'read_file', input: {} }] },
        { role: 'tool', results: [{ id: 't1', name: 'read_file', output: 'x' }] }
      ]
    })
  )
  server.close()
  const sent = requests[0]
  assert.equal(sent.headers.authorization, 'Bearer copilot-token')
  assert.equal(sent.headers['x-api-key'], undefined)
  assert.equal(sent.headers['x-initiator'], 'agent')
  assert.equal(sent.headers['openai-intent'], 'conversation-edits')
  assert.equal(sent.headers['copilot-integration-id'], 'vscode-chat')
  // Opus 4.8 written with a dot still gets adaptive thinking, not budget_tokens.
  assert.deepEqual(sent.body.thinking, { type: 'adaptive', display: 'summarized' })
})

test('Copilot marks user-initiated turns and image requests', () => {
  assert.equal(copilotHeaders([{ role: 'user', text: 'hi' }])['X-Initiator'], 'user')
  assert.equal(copilotHeaders([{ role: 'user', text: 'hi', images: [{ mime: 'image/png', data: 'A' }] }])['Copilot-Vision-Request'], 'true')
})
