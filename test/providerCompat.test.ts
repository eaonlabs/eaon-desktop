import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openaiChatAdapter, __test } from '../src/main/providers/adapters/openaiChat'
import type { TurnRequest } from '../src/main/providers/adapters/types'
import { clampEffort, normalizeAzureUrl, vendorOf, wireApiFor } from '../src/main/providers/compat'
import { anthropicThinking, inferEfforts, maxOutputFor } from '../src/main/providers/models'
import type { ModelInfo, Provider } from '@shared/types'
import { chunk, provider, sseServer } from './helpers'

/**
 * One test per provider quirk the chat-completions adapter handles, each
 * checked against what the request actually put on the wire.
 */

function request(p: Provider, overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    provider: p,
    modelId: 'test-model',
    model: undefined,
    credentials: { apiKey: 'k' },
    system: 'sys',
    messages: [{ role: 'user', text: 'hi' }],
    tools: [{ name: 'read_file', description: 'read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
    effort: 'high',
    signal: new AbortController().signal,
    cacheKey: 'chat1',
    agentic: true,
    onText: () => {},
    onReasoning: () => {},
    ...overrides
  }
}

const model = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({ id, label: id, providerId: 'x', tools: true, ...extra })

async function capture(p: Omit<Partial<Provider>, 'baseUrl'>, overrides: Partial<TurnRequest> = {}, reply = [chunk({ content: 'ok' }, 'stop')]) {
  const headers: Record<string, string | string[] | undefined>[] = []
  const { url, server, requests } = await sseServer((_body, req) => {
    headers.push(req.headers)
    return reply
  })
  try {
    const result = await openaiChatAdapter.turn(request(provider({ ...p, baseUrl: url }), overrides))
    return { body: requests[0], headers: headers[0], result }
  } finally {
    // An open server keeps node --test alive after a failure.
    server.closeAllConnections()
    server.close()
  }
}

test('DeepSeek: thinking switched on, max_tokens field, reasoning_content on every assistant message', async () => {
  const { body } = await capture(
    { id: 'deepseek' },
    {
      modelId: 'deepseek-v4-pro',
      model: model('deepseek-v4-pro', { reasoning: true, efforts: ['high', 'ultra'], maxOutput: 384_000, contextWindow: 1_000_000 }),
      effort: 'ultra',
      messages: [
        { role: 'user', text: 'a' },
        { role: 'assistant', text: 'earlier answer', calls: [] },
        { role: 'user', text: 'b' }
      ]
    }
  )
  assert.deepEqual(body.thinking, { type: 'enabled' })
  assert.equal(body.reasoning_effort, 'max')
  assert.equal(typeof body.max_tokens, 'number')
  assert.equal(body.max_completion_tokens, undefined)
  const assistant = (body.messages as { role: string; reasoning_content?: string }[]).find((m) => m.role === 'assistant')!
  assert.equal(assistant.reasoning_content, '')
})

test('DeepSeek within a turn: the reasoning is sent back with the tool call it led to', () => {
  const p = provider({ id: 'deepseek', baseUrl: 'https://api.deepseek.com' })
  const wire = __test.toWire(
    request(p, {
      modelId: 'deepseek-v4-pro',
      model: model('deepseek-v4-pro', { reasoning: true }),
      messages: [
        { role: 'user', text: 'go' },
        {
          role: 'assistant',
          text: '',
          calls: [{ id: 'c1', name: 'read_file', input: {} }],
          replay: { adapter: 'openai-chat', modelId: 'deepseek-v4-pro', data: { field: 'reasoning_content', reasoning: 'I should read it' } }
        },
        { role: 'tool', results: [{ id: 'c1', name: 'read_file', output: 'x' }] }
      ]
    })
  )
  assert.equal(wire.find((m) => m.role === 'assistant')!.reasoning_content, 'I should read it')
})

test('Z.ai: thinking object with preserved reasoning, and streamed tool arguments', async () => {
  const { body } = await capture({ id: 'zai-coding' }, { modelId: 'glm-5.3', model: model('glm-5.3', { reasoning: true, efforts: ['light', 'high', 'ultra'] }) })
  assert.deepEqual(body.thinking, { type: 'enabled', clear_thinking: false })
  assert.equal(body.tool_stream, true)
  assert.equal(body.reasoning_effort, 'high')
})

test('Qwen (DashScope): enable_thinking, and no effort for models that do not take one', async () => {
  const { body } = await capture({ id: 'qwen' }, { modelId: 'qwen3.7-plus', model: model('qwen3.7-plus', { reasoning: true, efforts: [] }) })
  assert.equal(body.enable_thinking, true)
  assert.equal(body.reasoning_effort, undefined)
})

test('Kimi K2 toggles thinking DeepSeek-style; K3 takes reasoning_effort and needs reasoning_content', async () => {
  const k2 = await capture({ id: 'moonshot' }, { modelId: 'kimi-k2.6', model: model('kimi-k2.6', { reasoning: true, efforts: [] }) })
  assert.deepEqual(k2.body.thinking, { type: 'enabled' })
  const k3 = await capture(
    { id: 'moonshot' },
    {
      modelId: 'kimi-k3',
      model: model('kimi-k3', { reasoning: true, efforts: ['light', 'high', 'ultra'] }),
      messages: [
        { role: 'user', text: 'a' },
        { role: 'assistant', text: 'b', calls: [] },
        { role: 'user', text: 'c' }
      ]
    }
  )
  assert.equal(k3.body.thinking, undefined)
  assert.equal(k3.body.reasoning_effort, 'high')
  assert.equal((k3.body.messages as { role: string; reasoning_content?: string }[]).find((m) => m.role === 'assistant')!.reasoning_content, '')
})

test('Kimi: usage reported on the choice instead of the chunk is still counted', async () => {
  const { result } = await capture({ id: 'moonshot' }, {}, [
    JSON.stringify({ choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'stop', usage: { prompt_tokens: 50, completion_tokens: 5, cached_tokens: 20 } }] })
  ])
  assert.deepEqual(result.usage, { input: 30, output: 5, cacheRead: 20, cacheWrite: 0 })
})

test('Groq: Qwen reasoning is parsed out of the content, and its effort is "default"', async () => {
  const { body } = await capture({ id: 'groq' }, { modelId: 'qwen/qwen3.6-27b', model: model('qwen/qwen3.6-27b', { reasoning: true, efforts: ['high'] }) })
  assert.equal(body.reasoning_format, 'parsed')
  assert.equal(body.reasoning_effort, 'default')
})

test('xAI on chat-completions: no reasoning_effort (Grok 4 rejects it)', async () => {
  const { body } = await capture({ id: 'xai' }, { modelId: 'grok-4', model: model('grok-4', { reasoning: true }) })
  assert.equal(body.reasoning_effort, undefined)
})

test('Cerebras: gpt-oss effort goes through as reasoning_effort, capped output in max_tokens', async () => {
  const { body } = await capture(
    { id: 'cerebras' },
    { modelId: 'gpt-oss-120b', model: model('gpt-oss-120b', { reasoning: true, efforts: ['light', 'medium', 'high'], maxOutput: 40_960, contextWindow: 131_072 }) }
  )
  assert.equal(body.reasoning_effort, 'high')
  assert.equal(body.max_tokens, 40_960)
  assert.equal(body.store, undefined)
})

test('OpenRouter: nested reasoning effort, session header, and reasoning_details replayed', async () => {
  const { body, headers } = await capture(
    { id: 'openrouter' },
    {
      modelId: 'google/gemini-3.8-flash',
      model: model('google/gemini-3.8-flash', { reasoning: true, efforts: ['light', 'medium', 'high'] }),
      effort: 'ultra',
      messages: [
        { role: 'user', text: 'go' },
        {
          role: 'assistant',
          text: '',
          calls: [{ id: 'c1', name: 'read_file', input: {} }],
          replay: {
            adapter: 'openai-chat',
            modelId: 'google/gemini-3.8-flash',
            data: { field: 'reasoning', reasoning: 'r', details: [{ type: 'reasoning.encrypted', data: 'SIG' }] }
          }
        },
        { role: 'tool', results: [{ id: 'c1', name: 'read_file', output: 'x' }] }
      ]
    }
  )
  assert.deepEqual(body.reasoning, { effort: 'high' })
  assert.equal(body.reasoning_effort, undefined)
  assert.equal(headers['x-session-id'], 'chat1')
  const assistant = (body.messages as { role: string; reasoning_details?: unknown; reasoning?: string }[]).find((m) => m.role === 'assistant')!
  assert.deepEqual(assistant.reasoning_details, [{ type: 'reasoning.encrypted', data: 'SIG' }])
  assert.equal(assistant.reasoning, undefined)
})

test('OpenRouter: streamed reasoning_details are merged for replay', async () => {
  const { result } = await capture({ id: 'openrouter' }, {}, [
    chunk({ reasoning: 'a', reasoning_details: [{ type: 'reasoning.text', text: 'a', index: 0 }] }),
    chunk({ reasoning: 'b', reasoning_details: [{ type: 'reasoning.text', text: 'b', index: 0 }] }),
    chunk({ reasoning_details: [{ type: 'reasoning.encrypted', data: 'E', index: 1 }] }),
    chunk({ content: 'done' }, 'stop')
  ])
  const data = result.replay!.data as { details: { type: string; text?: string; data?: string }[] }
  assert.equal(data.details.length, 2)
  assert.equal(data.details[0].text, 'ab')
  assert.equal(data.details[1].data, 'E')
})

test('OpenRouter: an upstream error mid-stream carries the upstream message', async () => {
  await assert.rejects(
    capture({ id: 'openrouter' }, {}, [JSON.stringify({ error: { message: 'Provider returned error', metadata: { raw: 'context too long for Foo' } } })]),
    /Provider returned error — context too long for Foo/
  )
})

test('Azure: resource URLs of every shape normalise to /openai/v1, and the key goes in api-key', async () => {
  for (const raw of [
    'https://res.openai.azure.com',
    'https://res.openai.azure.com/openai',
    'https://res.openai.azure.com/openai/v1/chat/completions',
    'https://res.openai.azure.com/openai/deployments/gpt/chat/completions?api-version=2024-10-21',
    'res.openai.azure.com/'
  ]) {
    assert.equal(normalizeAzureUrl(raw), 'https://res.openai.azure.com/openai/v1', raw)
  }
  assert.equal(normalizeAzureUrl('https://hub.services.ai.azure.com/api/projects/p1'), 'https://hub.services.ai.azure.com/openai/v1')
  assert.equal(normalizeAzureUrl('https://example.com/v1'), 'https://example.com/v1')

  const { headers, body } = await capture({ id: 'azure' }, { model: model('gpt-5', { maxOutput: 1000, contextWindow: 400_000 }) })
  assert.equal(headers['api-key'], 'k')
  assert.equal(headers.authorization, undefined)
  assert.equal(body.max_completion_tokens, 1000)
  assert.equal(body.prompt_cache_key, 'chat1')
})

test('Cloudflare AI Gateway: the token goes in cf-aig-authorization, never Authorization', async () => {
  const { headers } = await capture({ id: 'cloudflare-ai-gateway' })
  assert.equal(headers['cf-aig-authorization'], 'Bearer k')
  assert.equal(headers.authorization, undefined)
})

test('Cloudflare Workers AI: an unfilled account id is a clear error, not a DNS failure', async () => {
  await assert.rejects(
    openaiChatAdapter.turn(
      request(provider({ id: 'cloudflare-workers-ai', name: 'Cloudflare Workers AI', baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1' }))
    ),
    /Fill in your account id for Cloudflare Workers AI/
  )
})

test('vLLM-served hosts: the output cap leaves room for the prompt', async () => {
  const { body } = await capture(
    { id: 'together' },
    { modelId: 'moonshotai/Kimi-K2.6', model: model('moonshotai/Kimi-K2.6', { maxOutput: 262_144, contextWindow: 262_144 }) }
  )
  assert.ok((body.max_tokens as number) < 262_144 - 4000)
})

test('Gemini 3: thought signatures are captured, replayed, and stubbed for calls without one', async () => {
  const { result } = await capture({ id: 'gemini' }, { modelId: 'gemini-3.8-flash' }, [
    chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{}' }, extra_content: { google: { thought_signature: 'SIG1' } } }] }, 'tool_calls')
  ])
  assert.deepEqual((result.replay!.data as { signatures: Record<string, string> }).signatures, { c1: 'SIG1' })

  const p = provider({ id: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' })
  const wire = __test.toWire(
    request(p, {
      modelId: 'gemini-3.8-flash',
      messages: [
        { role: 'user', text: 'a' },
        { role: 'assistant', text: '', calls: [{ id: 'old', name: 'read_file', input: {} }] },
        { role: 'tool', results: [{ id: 'old', name: 'read_file', output: 'x' }] },
        { role: 'assistant', text: '', calls: [{ id: 'c1', name: 'read_file', input: {} }], replay: result.replay },
        { role: 'tool', results: [{ id: 'c1', name: 'read_file', output: 'y' }] }
      ]
    })
  )
  const calls = wire.filter((m) => m.role === 'assistant').map((m) => m.tool_calls![0].extra_content?.google.thought_signature)
  assert.deepEqual(calls, ['skip_thought_signature_validator', 'SIG1'])
})

test('Perplexity: models marked tool-less are sent no tools', async () => {
  const { body } = await capture({ id: 'perplexity' }, { modelId: 'sonar-pro', model: model('sonar-pro', { tools: false }) })
  assert.equal(body.tools, undefined)
})

test('inline <think> content (MiniMax, raw vLLM) is split into reasoning', async () => {
  let reasoning = ''
  const { result } = await capture({ id: 'custom-vllm' }, { onReasoning: (d) => (reasoning += d) }, [
    chunk({ content: '<thi' }),
    chunk({ content: 'nk>weigh options</th' }),
    chunk({ content: 'ink>\n\nFinal.' }, 'stop')
  ])
  assert.equal(result.text, 'Final.')
  assert.equal(reasoning, 'weigh options')
})

test('a rejected thinking parameter is dropped and the request retried', async () => {
  let calls = 0
  const { url, server, requests } = await sseServer((body) => {
    calls++
    if (body.enable_thinking) return { status: 400, body: JSON.stringify({ error: { message: 'enable_thinking is not supported by this model' } }) }
    return [chunk({ content: 'ok' }, 'stop')]
  })
  const result = await openaiChatAdapter.turn(request(provider({ id: 'qwen', baseUrl: url }), { modelId: 'qwen3-coder-plus', model: model('qwen3-coder-plus', { reasoning: true, efforts: [] }) }))
  server.close()
  assert.equal(calls, 2)
  assert.equal(requests[1].enable_thinking, undefined)
  assert.equal(result.text, 'ok')
})

test('vendor detection works by host for custom endpoints too', () => {
  const custom = (baseUrl: string): Pick<Provider, 'id' | 'kind' | 'baseUrl'> => ({ id: 'mine', kind: 'openai-compatible', baseUrl })
  assert.equal(vendorOf(custom('https://api.deepseek.com/v1')), 'deepseek')
  assert.equal(vendorOf(custom('https://open.bigmodel.cn/api/paas/v4')), 'zai')
  assert.equal(vendorOf(custom('https://dashscope-intl.aliyuncs.com/compatible-mode/v1')), 'qwen')
  assert.equal(vendorOf(custom('https://my.openai.azure.com/openai/v1')), 'azure')
  assert.equal(vendorOf(custom('http://localhost:8000/v1')), 'other')
})

test('effort clamps to the nearest level the model takes', () => {
  assert.equal(clampEffort('ultra', ['light', 'medium', 'high']), 'high')
  assert.equal(clampEffort('medium', ['high', 'ultra']), 'high')
  assert.equal(clampEffort('extra-high', ['light', 'high', 'ultra']), 'high')
  assert.equal(clampEffort('high', []), undefined)
})

test('dotted Claude ids (Copilot, OpenCode) get the right thinking family', () => {
  assert.deepEqual(anthropicThinking('claude-opus-4.8', 'high', 64_000), { type: 'adaptive', display: 'summarized' })
  assert.deepEqual(anthropicThinking('claude-opus-4-8', 'high', 64_000), { type: 'adaptive', display: 'summarized' })
  assert.equal(anthropicThinking('claude-haiku-4.5', 'high', 64_000)?.type, 'enabled')
  assert.deepEqual(inferEfforts('claude-sonnet-4.6'), ['light', 'medium', 'high', 'ultra'])
  assert.equal(maxOutputFor(provider(), 'claude-opus-4.8', undefined), 64_000)
})

test('mixed-API providers route each model family to its own wire format', () => {
  const copilot = provider({ id: 'github-copilot', baseUrl: 'https://api.individual.githubcopilot.com' })
  assert.equal(wireApiFor(copilot, 'claude-sonnet-5'), 'anthropic')
  assert.equal(wireApiFor(copilot, 'gpt-5.5'), 'openai-responses')
  assert.equal(wireApiFor(copilot, 'gemini-3.8-flash'), 'openai-chat')
  const zen = provider({ id: 'opencode', baseUrl: 'https://opencode.ai/zen/v1' })
  assert.equal(wireApiFor(zen, 'qwen3.6-plus'), 'anthropic')
  assert.equal(wireApiFor(zen, 'grok-4.6'), 'openai-responses')
  assert.equal(wireApiFor(zen, 'glm-5.3'), 'openai-chat')
})
