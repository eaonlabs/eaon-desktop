import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BUILT_IN, PROVIDER_META } from '../src/main/providers/catalog'
import { parseCopilotListing, parseListing } from '../src/main/providers/listing'
import { missingUrlFields } from '../src/main/providers/compat'
import { isChatModelId } from '../src/main/providers/models'
import { copilotBaseUrl } from '../src/main/providers/oauth/copilot'
import { __test as codex } from '../src/main/providers/oauth/codex'
import { parseAuthorizationInput, pkce, singleFlight } from '../src/main/providers/oauth/shared'
import { createHash } from 'node:crypto'

test('catalog: unique ids, a category and description everywhere, a key link for every key provider', () => {
  const ids = new Set<string>()
  for (const p of BUILT_IN) {
    assert.ok(!ids.has(p.id), `duplicate ${p.id}`)
    ids.add(p.id)
    assert.ok(p.category, `${p.id} has no category`)
    assert.ok(p.description, `${p.id} has no description`)
    if (p.auth === 'key') assert.ok(p.keyUrl, `${p.id} has no keyUrl`)
    if (p.auth === 'oauth') {
      assert.equal(p.category, 'subscription')
      assert.ok(p.oauthFlow)
    }
    const modelIds = new Set<string>()
    for (const model of p.models) {
      assert.equal(model.providerId, p.id, `${model.id} is filed under ${model.providerId}`)
      assert.ok(!modelIds.has(model.id), `${p.id} lists ${model.id} twice`)
      modelIds.add(model.id)
      if (model.maxOutput && model.contextWindow) assert.ok(model.maxOutput <= model.contextWindow * 1.01, `${p.id}/${model.id} output cap exceeds window`)
    }
  }
  assert.ok(ids.size >= 50, `only ${ids.size} providers`)
})

test('catalog: templated URLs have a field per placeholder; everything else is fully specified', () => {
  for (const p of BUILT_IN) {
    const missing = missingUrlFields(p.baseUrl)
    if (missing.length === 0) continue
    const meta = PROVIDER_META[p.id]
    assert.ok(meta?.baseUrlTemplate, `${p.id} has placeholders but no template`)
    assert.deepEqual(missing.sort(), (meta.fields ?? []).map((f) => f.key).sort())
  }
})

test('listing: OpenRouter context_length, output cap, tools and reasoning are kept', () => {
  const models = parseListing(
    {
      data: [
        {
          id: 'anthropic/claude-opus-5.5',
          name: 'Anthropic: Claude Opus 5.5',
          context_length: 1_000_000,
          architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
          top_provider: { max_completion_tokens: 128_000 },
          supported_parameters: ['tools', 'reasoning']
        },
        { id: 'meta/llama-guard-4', supported_parameters: [] },
        { id: 'x/image-maker', architecture: { output_modalities: ['image'] } },
        { id: 'plain/model', context_length: 32_000, supported_parameters: ['temperature'] }
      ]
    },
    'openrouter',
    'openrouter'
  )
  assert.deepEqual(models[0], {
    id: 'anthropic/claude-opus-5.5',
    label: 'Claude Opus 5.5',
    providerId: 'openrouter',
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    vision: true,
    tools: true,
    reasoning: true,
    efforts: ['light', 'medium', 'high']
  })
  assert.deepEqual(
    models.map((m) => m.id),
    ['anthropic/claude-opus-5.5', 'plain/model']
  )
  assert.equal(models[1].tools, false)
})

test('listing: Vercel types, DeepInfra tags and Novita context_size', () => {
  const vercel = parseListing(
    {
      data: [
        { id: 'openai/gpt-5.5', name: 'GPT 5.5', type: 'language', context_window: 1_000_000, max_tokens: 128_000, tags: ['reasoning', 'tool-use', 'vision'] },
        { id: 'openai/text-embedding-3-small', type: 'embedding' },
        { id: 'google/veo-3.1', type: 'video' }
      ]
    },
    'vercel',
    'vercel'
  )
  assert.deepEqual(
    vercel.map((m) => [m.id, m.contextWindow, m.maxOutput, m.tools, m.vision]),
    [['openai/gpt-5.5', 1_000_000, 128_000, true, true]]
  )
  const deepinfra = parseListing(
    {
      data: [
        { id: 'Qwen/Qwen3.8-27B', metadata: { context_length: 262_144, max_tokens: 262_144, tags: ['chat', 'vision', 'reasoning_effort', 'reasoning'] } },
        { id: 'XiaomiMiMo/MiMo-V2.5-tts', metadata: { tags: ['tts'] } }
      ]
    },
    'deepinfra',
    'other'
  )
  assert.equal(deepinfra.length, 1)
  assert.deepEqual(deepinfra[0].efforts, ['light', 'medium', 'high'])
  const novita = parseListing({ data: [{ id: 'zai-org/glm-5.3', context_size: 1_048_576, max_output_tokens: 131_072, model_type: 'chat', features: ['function-calling'] }] }, 'novita', 'other')
  assert.equal(novita[0].contextWindow, 1_048_576)
  assert.equal(novita[0].tools, true)
})

test('listing: Copilot keeps only picker-enabled tool models, with their limits', () => {
  const models = parseCopilotListing({
    data: [
      { id: 'gpt-5.5', name: 'GPT-5.5', model_picker_enabled: true, policy: { state: 'enabled' }, capabilities: { type: 'chat', supports: { tool_calls: true, vision: true }, limits: { max_context_window_tokens: 400_000, max_output_tokens: 128_000 } } },
      { id: 'text-embedding-3', model_picker_enabled: false, capabilities: { type: 'embeddings' } },
      { id: 'o-old', model_picker_enabled: true, policy: { state: 'disabled' }, capabilities: { type: 'chat' } }
    ]
  })
  assert.deepEqual(models, [{ id: 'gpt-5.5', label: 'GPT-5.5', providerId: 'github-copilot', tools: true, contextWindow: 400_000, maxOutput: 128_000, vision: true }])
})

test('non-chat ids are filtered out of refreshed lists', () => {
  for (const id of ['text-embedding-3-large', 'gpt-image-1', 'whisper-1', 'tts-1', 'mistral-ocr-latest', 'meta-llama/Llama-Guard-4-12B', 'black-forest-labs/flux-1.1-pro', 'BAAI/bge-m3']) {
    assert.equal(isChatModelId(id), false, id)
  }
  for (const id of ['gpt-5.5', 'claude-opus-5', 'openai/gpt-oss-safeguard-20b', 'qwen3.8-max', 'deepseek-v4-pro']) {
    assert.equal(isChatModelId(id), true, id)
  }
})

test('OAuth: PKCE challenge is the S256 of the verifier', () => {
  const { verifier, challenge } = pkce()
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'))
})

test('OAuth: a pasted redirect URL, query string or bare code all yield the code', () => {
  assert.deepEqual(parseAuthorizationInput('http://localhost:1455/auth/callback?code=abc&state=s1'), { code: 'abc', state: 's1' })
  assert.deepEqual(parseAuthorizationInput('code=abc&state=s1'), { code: 'abc', state: 's1' })
  assert.deepEqual(parseAuthorizationInput('  abc  '), { code: 'abc' })
})

test('OAuth: Codex tokens carry the ChatGPT account id, from the access token or the id token', () => {
  const jwt = (claims: Record<string, unknown>): string => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`
  const tokens = codex.tokensFrom({
    access_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_1', chatgpt_plan_type: 'pro' } }),
    refresh_token: 'r',
    id_token: jwt({ email: 'me@example.com' }),
    expires_in: 3600
  })
  assert.equal(tokens.accountId, 'acct_1')
  assert.equal(tokens.email, 'me@example.com')
  assert.equal(tokens.plan, 'pro')
  assert.ok(tokens.expires > Date.now() + 3500_000)
  const fromId = codex.tokensFrom({
    access_token: jwt({}),
    refresh_token: 'r',
    id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_2' } }),
    expires_in: 60
  })
  assert.equal(fromId.accountId, 'acct_2')
  assert.throws(() => codex.tokensFrom({ access_token: jwt({}), refresh_token: 'r', expires_in: 60 }), /account id/)
})

test('OAuth: Copilot base URL comes from the token’s proxy endpoint', () => {
  assert.equal(copilotBaseUrl('tid=1;exp=2;proxy-ep=proxy.individual.githubcopilot.com;st=x'), 'https://api.individual.githubcopilot.com')
  assert.equal(copilotBaseUrl('tid=1;proxy-ep=proxy.business.githubcopilot.com'), 'https://api.business.githubcopilot.com')
  assert.equal(copilotBaseUrl('no-endpoint'), 'https://api.individual.githubcopilot.com')
})

test('OAuth: concurrent refreshes share one request (refresh tokens are single-use)', async () => {
  let calls = 0
  const refresh = singleFlight(async () => {
    calls++
    await new Promise((r) => setTimeout(r, 20))
    return calls
  })
  const results = await Promise.all([refresh(), refresh(), refresh()])
  assert.deepEqual(results, [1, 1, 1])
  assert.equal(calls, 1)
  assert.equal(await refresh(), 2)
})
