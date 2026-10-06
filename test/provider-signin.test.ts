import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import type { ProviderAuthStatus } from '@shared/providers'
import { providerAuthFeature } from '../src/main/features/providerAuth'
import type { FeatureContext } from '../src/main/features/types'
import { getProvider, listProviders, updateProvider } from '../src/main/providers'
import { credentialAttempts } from '../src/main/providers/credentials'
import { huggingFaceFlow, poeFlow } from '../src/main/providers/oauth/appClients'
import { siwcFlow, verifyIdToken, __test as siwc } from '../src/main/providers/oauth/siwc'
import { secrets } from '../src/main/secrets'

/**
 * Account sign-in for providers that officially allow it: OpenAI's "Sign in
 * with ChatGPT" (dynamic client registration, no app to register), and the
 * registered-app flows for Hugging Face and Poe. Each test plays the browser
 * against the flow's real loopback server and fakes only the provider's own
 * endpoints.
 */

const realFetch = globalThis.fetch
type Fake = (url: string, init: RequestInit | undefined) => Response | Promise<Response> | undefined

/** Routes the provider's endpoints to `fake`; everything else (the loopback redirect) is real. */
function withFetch(fake: Fake): () => void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const answer = await fake(url, init)
    return answer ?? realFetch(input, init)
  }) as typeof fetch
  return () => {
    globalThis.fetch = realFetch
  }
}

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const form = (init: RequestInit | undefined): URLSearchParams => new URLSearchParams(String(init?.body ?? ''))

/** Waits for the flow to hand over its authorization URL, then "approves" it by hitting the redirect. */
function browser(approve: (authorize: URL) => Record<string, string>): { onPrompt: (p: { url: string }) => void; seen: Promise<URL> } {
  let resolve: (url: URL) => void = () => {}
  const seen = new Promise<URL>((r) => (resolve = r))
  return {
    seen,
    onPrompt: ({ url }) => {
      const authorize = new URL(url)
      resolve(authorize)
      const redirect = new URL(authorize.searchParams.get('redirect_uri')!)
      for (const [key, value] of Object.entries(approve(authorize))) redirect.searchParams.set(key, value)
      setTimeout(() => void realFetch(redirect), 10)
    }
  }
}

/* ------------------------------------------------------------ ChatGPT */

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' }

function idToken(claims: Record<string, unknown>): string {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const signature = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')
  return `${head}.${body}.${signature}`
}

const SCOPE = 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke'

function openAiServer(options: { nonceFrom: () => string; wrongNonce?: boolean }): { restore: () => void; tokenBodies: URLSearchParams[] } {
  const tokenBodies: URLSearchParams[] = []
  const restore = withFetch((url, init) => {
    if (url === 'https://auth.openai.com/.well-known/openid-configuration') {
      return json({ jwks_uri: 'https://auth.openai.com/jwks', revocation_endpoint: 'https://auth.openai.com/revoke' })
    }
    if (url === 'https://auth.openai.com/jwks') return json({ keys: [jwk] })
    if (url === 'https://auth.openai.com/revoke') return new Response('', { status: 200 })
    if (url === 'https://auth.openai.com/api/accounts/oauth/token') {
      const body = form(init)
      tokenBodies.push(body)
      if (body.get('grant_type') === 'refresh_token') {
        return json({ access_token: `access-${tokenBodies.length}`, refresh_token: `refresh-${tokenBodies.length}`, expires_in: 3600 })
      }
      return json({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 3600,
        scope: SCOPE,
        id_token: idToken({
          iss: 'https://auth.openai.com',
          aud: 'oaiapp_eaon_test',
          sub: 'user-1',
          email: 'you@example.com',
          exp: Math.floor(Date.now() / 1000) + 3600,
          nonce: options.wrongNonce ? 'not-this-attempt' : options.nonceFrom()
        })
      })
    }
    return undefined
  })
  return { restore, tokenBodies }
}

test('Sign in with ChatGPT registers Eaon dynamically, verifies the ID token, and reuses the issued client', async () => {
  siwc.tokens.set(null)
  siwc.registration.set(null)
  let nonce = ''
  const server = openAiServer({ nonceFrom: () => nonce })
  try {
    const first = browser((authorize) => {
      nonce = authorize.searchParams.get('nonce')!
      return { code: 'code-1', state: authorize.searchParams.get('state')!, client_id: 'oaiapp_eaon_test', scope: SCOPE }
    })
    await siwcFlow.signIn(first.onPrompt, new AbortController().signal)
    const authorize = await first.seen

    // First sign-in: the dynamic placeholder, the app's name and a stable host id.
    assert.equal(authorize.origin + authorize.pathname, 'https://auth.openai.com/api/accounts/authorize')
    assert.equal(authorize.searchParams.get('client_id'), 'dynamic_agent_client')
    assert.equal(authorize.searchParams.get('agent_name_hint'), 'Eaon')
    assert.match(authorize.searchParams.get('ext_agent_host_id')!, /^urn:uuid:[0-9a-f-]{36}$/)
    assert.equal(authorize.searchParams.get('resource'), 'https://api.openai.com/v1')
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256')
    assert.ok(authorize.searchParams.get('scope')!.includes('chatgpt.tokens.use.direct'))
    assert.match(authorize.searchParams.get('redirect_uri')!, /^http:\/\/127\.0\.0\.1:\d+\/callback$/)

    // The code is exchanged with the issued id, never the placeholder.
    const exchange = server.tokenBodies[0]
    assert.equal(exchange.get('client_id'), 'oaiapp_eaon_test')
    assert.equal(exchange.get('grant_type'), 'authorization_code')
    assert.equal(exchange.get('resource'), 'https://api.openai.com/v1')
    assert.ok(exchange.get('code_verifier'))
    assert.equal(siwcFlow.isSignedIn(), true)
    assert.equal(siwcFlow.account?.(), 'you@example.com')
    const hostId = authorize.searchParams.get('ext_agent_host_id')

    // Signing in again goes straight to the issued client, from the same host.
    const again = browser((a) => {
      nonce = a.searchParams.get('nonce')!
      return { code: 'code-2', state: a.searchParams.get('state')!, client_id: 'oaiapp_eaon_test', scope: SCOPE }
    })
    await siwcFlow.signIn(again.onPrompt, new AbortController().signal)
    const second = await again.seen
    assert.equal(second.searchParams.get('client_id'), 'oaiapp_eaon_test')
    assert.equal(second.searchParams.get('agent_name_hint'), null)
    assert.equal(second.searchParams.get('ext_agent_host_id'), hostId)

    // An hour later the access token is refreshed, and the rotated refresh token kept.
    siwcFlow.expire?.()
    const credentials = await siwcFlow.credentials(getProvider('chatgpt')!)
    const refresh = server.tokenBodies.at(-1)!
    assert.equal(refresh.get('grant_type'), 'refresh_token')
    assert.equal(refresh.get('client_id'), 'oaiapp_eaon_test')
    assert.equal(refresh.get('resource'), 'https://api.openai.com/v1')
    assert.equal(credentials.apiKey, `access-${server.tokenBodies.length}`)
    assert.equal(siwc.tokens.get()?.refresh, `refresh-${server.tokenBodies.length}`)

    await siwcFlow.signOut()
    assert.equal(siwcFlow.isSignedIn(), false)
    assert.equal(siwc.registration.get()?.hostId, hostId, 'the host id outlives a sign-out')
  } finally {
    server.restore()
  }
})

test('an ID token from another attempt, issuer or audience is refused', async () => {
  const restore = withFetch((url) => {
    if (url.endsWith('/.well-known/openid-configuration')) return json({ jwks_uri: 'https://auth.openai.com/jwks' })
    if (url === 'https://auth.openai.com/jwks') return json({ keys: [jwk] })
    return undefined
  })
  try {
    const good = { iss: 'https://auth.openai.com', aud: 'oaiapp_x', sub: 's', exp: Math.floor(Date.now() / 1000) + 60, nonce: 'n1' }
    assert.equal((await verifyIdToken(idToken(good), 'oaiapp_x', 'n1')).sub, 's')
    await assert.rejects(verifyIdToken(idToken(good), 'oaiapp_x', 'n2'), /this sign-in attempt/)
    await assert.rejects(verifyIdToken(idToken({ ...good, iss: 'https://evil.example' }), 'oaiapp_x', 'n1'), /issuer/)
    await assert.rejects(verifyIdToken(idToken({ ...good, aud: 'someone-else' }), 'oaiapp_x', 'n1'), /not issued to Eaon/)
    const tampered = idToken(good).replace(/\.[^.]+\./, `.${Buffer.from(JSON.stringify({ ...good, sub: 'mallory' })).toString('base64url')}.`)
    await assert.rejects(verifyIdToken(tampered, 'oaiapp_x', 'n1'), /signature/)
  } finally {
    restore()
  }
})

test('a sign-in whose nonce does not match is not stored', async () => {
  siwc.tokens.set(null)
  const server = openAiServer({ nonceFrom: () => '', wrongNonce: true })
  try {
    const flow = browser((a) => ({ code: 'c', state: a.searchParams.get('state')!, client_id: 'oaiapp_eaon_test', scope: SCOPE }))
    await assert.rejects(siwcFlow.signIn(flow.onPrompt, new AbortController().signal), /this sign-in attempt/)
    assert.equal(siwcFlow.isSignedIn(), false)
  } finally {
    server.restore()
  }
})

/* ------------------------------------------------------------ Hugging Face and Poe */

function register(): Map<string, (...args: unknown[]) => unknown> {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  providerAuthFeature.register({
    ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) },
    getWindow: () => null,
    send: () => {},
    emitStream: () => {}
  } as unknown as FeatureContext)
  return handlers
}

test('Hugging Face asks for a registered client id, then signs in and serves inference with the account token', async () => {
  const handlers = register()
  huggingFaceFlow.setClientId?.(null)
  await huggingFaceFlow.signOut()
  secrets.set('huggingface', '')
  const statuses = (await handlers.get('provider-auth:status')!()) as ProviderAuthStatus[]
  const before = statuses.find((s) => s.providerId === 'huggingface')!
  assert.equal(before.needsClientId, true)
  assert.equal(before.clientSetup?.registerUrl, 'https://huggingface.co/settings/applications/new')
  await assert.rejects(huggingFaceFlow.signIn(() => {}, new AbortController().signal), /Client ID/)

  const after = (await handlers.get('provider-auth:set-client-id')!(null, 'huggingface', 'hf-client-123')) as ProviderAuthStatus
  assert.equal(after.needsClientId, false)
  assert.equal(after.clientId, 'hf-client-123')

  let exchange: URLSearchParams | null = null
  const restore = withFetch((url, init) => {
    if (url !== 'https://huggingface.co/oauth/token') return undefined
    exchange = form(init)
    return json({ access_token: 'hf_oauth_token', refresh_token: 'hf_refresh', expires_in: 28_800 })
  })
  try {
    const flow = browser((a) => ({ code: 'hf-code', state: a.searchParams.get('state')! }))
    await huggingFaceFlow.signIn(flow.onPrompt, new AbortController().signal)
    const authorize = await flow.seen
    assert.equal(authorize.origin + authorize.pathname, 'https://huggingface.co/oauth/authorize')
    assert.equal(authorize.searchParams.get('client_id'), 'hf-client-123')
    assert.equal(authorize.searchParams.get('scope'), 'openid profile inference-api')
    assert.match(authorize.searchParams.get('redirect_uri')!, /^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    assert.equal(exchange!.get('grant_type'), 'authorization_code')
    assert.equal(exchange!.get('client_id'), 'hf-client-123')
    assert.ok(exchange!.get('code_verifier'))
  } finally {
    restore()
  }

  // No API key, but the signed-in account makes the provider usable.
  const provider = listProviders().find((p) => p.id === 'huggingface')!
  assert.equal(provider.hasKey, true)
  assert.deepEqual(await credentialAttempts(provider), [{ apiKey: 'hf_oauth_token' }])
  await huggingFaceFlow.signOut()
  providerAuthFeature.dispose?.()
})

test('Poe sign-in mints an ordinary API key', async () => {
  secrets.set('poe', '')
  poeFlow.setClientId?.('poe-client-9')
  let exchange: URLSearchParams | null = null
  const restore = withFetch((url, init) => {
    if (url !== 'https://api.poe.com/token') return undefined
    exchange = form(init)
    return json({ api_key: 'poe-key-abc', api_key_expires_in: null })
  })
  try {
    const flow = browser((a) => ({ code: 'poe-code', state: a.searchParams.get('state')! }))
    await poeFlow.signIn(flow.onPrompt, new AbortController().signal)
    const authorize = await flow.seen
    assert.equal(authorize.searchParams.get('scope'), 'apikey:create')
    assert.match(authorize.searchParams.get('redirect_uri')!, /^http:\/\/localhost:\d+\/callback$/)
    assert.equal(exchange!.get('client_id'), 'poe-client-9')
    assert.equal(secrets.get('poe'), 'poe-key-abc')
  } finally {
    restore()
    secrets.set('poe', '')
    poeFlow.setClientId?.(null)
  }
})

test('signing in turns a provider back on that was switched off, so its models show up', async () => {
  // OpenRouter switched off in Model providers earlier: the sign-in minted a
  // key and listed the models, but the provider stayed off, so the picker and
  // Link accounts showed nothing and it looked as if the sign-in had failed.
  updateProvider('openrouter', { enabled: false })
  secrets.set('openrouter', '')
  const handlers = register()
  const restore = withFetch((url) => {
    if (url === 'https://openrouter.ai/api/v1/auth/keys') return json({ key: 'sk-or-v1-minted' })
    if (url.startsWith('https://openrouter.ai/api/v1/models')) return json({ data: [{ id: 'openai/gpt-6.1-sol', name: 'OpenAI: GPT-6.1 Sol', context_length: 1_050_000 }] })
    return undefined
  })
  const hooks = globalThis as { __eaonOpenExternal?: (url: string) => void }
  hooks.__eaonOpenExternal = (url) => {
    const callback = new URL(new URL(url).searchParams.get('callback_url')!)
    callback.searchParams.set('code', 'or-code')
    setTimeout(() => void realFetch(callback), 10)
  }
  try {
    const status = (await handlers.get('provider-auth:sign-in')!(null, 'openrouter')) as ProviderAuthStatus
    assert.equal(status.state, 'idle', status.error)
    assert.equal(status.signedIn, true)
    const provider = getProvider('openrouter')!
    assert.equal(provider.enabled, true)
    assert.ok(provider.models.some((m) => m.id === 'openai/gpt-6.1-sol'))
  } finally {
    restore()
    delete hooks.__eaonOpenExternal
    secrets.set('openrouter', '')
    providerAuthFeature.dispose?.()
  }
})
