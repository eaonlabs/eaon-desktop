import type { Provider } from '@shared/types'
import type { OAuthClientSetup } from '@shared/providers'
import { secrets } from '../../secrets'
import type { Credentials } from '../adapters/types'
import type { OAuthFlow } from './index'
import { jwtClaims, parseAuthorizationInput, pkce, randomState, singleFlight, startLoopback, tokenStore } from './shared'
import { providerFetch } from '../safeFetch'

/**
 * Sign-ins for providers that officially let third-party apps use a person's
 * account — but only apps that registered an OAuth client with them first
 * (checked against each provider's docs, Sept 2026):
 *
 * - Hugging Face: public PKCE client, no secret; the `inference-api` scope
 *   lets the token call Inference Providers on the user's behalf. The token is
 *   used directly (alongside or instead of an API key) and refreshed.
 * - Poe: PKCE with `apikey:create`; the exchange mints an ordinary API key,
 *   stored as the provider's key like OpenRouter's.
 *
 * A registered client id is not a secret for these public clients. Eaon ships
 * with the ones in BUILT_IN_CLIENT_IDS once they have been registered; until
 * then (or to use their own), a person pastes one in Settings → Model
 * providers, stored under `oauth-client::<flow>`.
 *
 * Deliberately absent: Anthropic (Claude Pro/Max) and Google's Gemini CLI /
 * Antigravity logins — their terms forbid other apps from using them.
 */

/** Client ids registered for Eaon itself. Empty until registered; see the setup text on each flow. */
export const BUILT_IN_CLIENT_IDS: Record<string, string> = {
  huggingface: '',
  poe: ''
}

const TIMEOUT_MS = 5 * 60_000
const REFRESH_MARGIN_MS = 5 * 60_000

function clientIdStore(flowId: string): { get(): string | null; set(id: string | null): void } {
  const key = `oauth-client::${flowId}`
  return {
    get: () => secrets.get(key)?.trim() || BUILT_IN_CLIENT_IDS[flowId] || null,
    set: (id) => secrets.set(key, id?.trim() ?? '')
  }
}

/** A loopback PKCE authorization that resolves with the code (from the redirect, or a pasted URL). */
async function authorize(options: {
  authorizeUrl: string
  params: Record<string, string>
  redirectHost: string
  service: string
  message: string
  onPrompt: Parameters<OAuthFlow['signIn']>[0]
  signal: AbortSignal
  setManual: (fn: ((input: string) => void) | null) => void
}): Promise<{ code: string; verifier: string; redirectUri: string }> {
  const { verifier, challenge } = pkce()
  const state = randomState()
  const server = await startLoopback({ port: 0, path: '/callback', redirectHost: options.redirectHost, state, service: options.service })
  const onAbort = (): void => server.cancel()
  options.signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => server.cancel(), TIMEOUT_MS)
  let pasted: string | null = null
  options.setManual((input) => {
    const parsed = parseAuthorizationInput(input)
    if (parsed.code && (!parsed.state || parsed.state === state)) pasted = parsed.code
    server.cancel()
  })
  try {
    const url = new URL(options.authorizeUrl)
    url.search = new URLSearchParams({
      ...options.params,
      redirect_uri: server.redirectUri,
      response_type: 'code',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    }).toString()
    options.onPrompt({ url: url.toString(), message: options.message })
    const code = (await server.code) ?? pasted
    if (options.signal.aborted) throw new Error('Sign-in cancelled')
    if (!code) throw new Error(`No authorization code came back from ${options.service}.`)
    return { code, verifier, redirectUri: server.redirectUri }
  } finally {
    options.setManual(null)
    clearTimeout(timer)
    options.signal.removeEventListener('abort', onAbort)
    server.close()
  }
}

async function postForm(url: string, body: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown> & { status: number }> {
  const response = await providerFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
  })
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>
  return { ...json, status: response.status }
}

const errorText = (json: Record<string, unknown>): string => {
  const detail = json.error_description ?? json.error ?? json.message
  return typeof detail === 'string' ? `: ${detail}` : ''
}

/* ------------------------------------------------------------ Hugging Face */

const HF_SETUP: OAuthClientSetup = {
  registerUrl: 'https://huggingface.co/settings/applications/new',
  redirectUris: ['http://127.0.0.1/callback'],
  scopes: 'openid, profile, inference-api',
  note: 'leave out the client secret (a public app)'
}

interface HfTokens {
  access: string
  refresh: string | null
  expires: number
  account?: string
}

const hfTokens = tokenStore<HfTokens>('huggingface')
const hfClient = clientIdStore('huggingface')
let hfManual: ((input: string) => void) | null = null

const hfRefresh = singleFlight(async (): Promise<HfTokens> => {
  const current = hfTokens.get()
  const clientId = hfClient.get()
  if (!current?.refresh || !clientId) {
    hfTokens.set(null)
    throw new Error('Your Hugging Face sign-in has ended. Sign in again in Settings → Model providers.')
  }
  const json = await postForm('https://huggingface.co/oauth/token', { grant_type: 'refresh_token', refresh_token: current.refresh, client_id: clientId })
  if (typeof json.access_token !== 'string') {
    if (json.status < 500) hfTokens.set(null)
    throw new Error(`Hugging Face could not refresh your sign-in (${json.status})${errorText(json)}.`)
  }
  const next: HfTokens = {
    ...current,
    access: json.access_token,
    refresh: typeof json.refresh_token === 'string' ? json.refresh_token : current.refresh,
    expires: Date.now() + (typeof json.expires_in === 'number' ? json.expires_in : 28_800) * 1000
  }
  hfTokens.set(next)
  return next
})

export const huggingFaceFlow: OAuthFlow = {
  id: 'huggingface',
  providesCredentials: true,
  clientSetup: HF_SETUP,
  clientId: () => hfClient.get(),
  setClientId: (id) => hfClient.set(id),

  async signIn(onPrompt, signal) {
    const clientId = hfClient.get()
    if (!clientId) throw new Error('Add the Client ID of a Hugging Face OAuth app first.')
    const { code, verifier, redirectUri } = await authorize({
      authorizeUrl: 'https://huggingface.co/oauth/authorize',
      params: { client_id: clientId, scope: 'openid profile inference-api' },
      redirectHost: '127.0.0.1',
      service: 'Hugging Face',
      message: 'Approve Eaon in your browser. Inference runs on your Hugging Face account.',
      onPrompt,
      signal,
      setManual: (fn) => (hfManual = fn)
    })
    const json = await postForm(
      'https://huggingface.co/oauth/token',
      { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier },
      signal
    )
    if (typeof json.access_token !== 'string') throw new Error(`Hugging Face did not sign you in (${json.status})${errorText(json)}.`)
    const claims = jwtClaims(typeof json.id_token === 'string' ? json.id_token : undefined)
    const account = [claims?.preferred_username, claims?.name].find((v): v is string => typeof v === 'string')
    hfTokens.set({
      access: json.access_token,
      refresh: typeof json.refresh_token === 'string' ? json.refresh_token : null,
      expires: Date.now() + (typeof json.expires_in === 'number' ? json.expires_in : 28_800) * 1000,
      ...(account ? { account } : {})
    })
  },

  async signOut() {
    hfTokens.set(null)
  },

  isSignedIn() {
    return Boolean(hfTokens.get()?.access)
  },

  account() {
    return hfTokens.get()?.account
  },

  submitCode(input) {
    hfManual?.(input)
  },

  expire() {
    const current = hfTokens.get()
    if (current) hfTokens.set({ ...current, expires: 0 })
  },

  async credentials(_provider: Provider): Promise<Credentials> {
    let current = hfTokens.get()
    if (!current) throw new Error('Sign in with Hugging Face first, in Settings → Model providers.')
    if (current.expires - Date.now() < REFRESH_MARGIN_MS) current = await hfRefresh()
    return { apiKey: current.access }
  }
}

/* ------------------------------------------------------------ Poe */

const POE_SETUP: OAuthClientSetup = {
  registerUrl: 'https://poe.com/api/clients',
  redirectUris: ['http://localhost/callback'],
  scopes: 'apikey:create',
  note: 'localhost redirects work without being registered.'
}

const poeClient = clientIdStore('poe')
let poeManual: ((input: string) => void) | null = null

export const poeFlow: OAuthFlow = {
  id: 'poe',
  clientSetup: POE_SETUP,
  clientId: () => poeClient.get(),
  setClientId: (id) => poeClient.set(id),

  async signIn(onPrompt, signal) {
    const clientId = poeClient.get()
    if (!clientId) throw new Error('Add the Client ID of a Poe API client first.')
    const { code, verifier, redirectUri } = await authorize({
      authorizeUrl: 'https://poe.com/oauth/authorize',
      params: { client_id: clientId, scope: 'apikey:create' },
      redirectHost: 'localhost',
      service: 'Poe',
      message: 'Approve Eaon in your browser. Poe creates a key that uses your points.',
      onPrompt,
      signal,
      setManual: (fn) => (poeManual = fn)
    })
    const json = await postForm(
      'https://api.poe.com/token',
      { grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: redirectUri, code_verifier: verifier },
      signal
    )
    if (typeof json.api_key !== 'string' || !json.api_key) throw new Error(`Poe did not issue a key (${json.status})${errorText(json)}.`)
    // An ordinary key from here on: Remove key, fallbacks and Test all apply.
    secrets.set('poe', json.api_key)
  },

  async signOut() {},

  isSignedIn() {
    return secrets.has('poe')
  },

  submitCode(input) {
    poeManual?.(input)
  },

  async credentials(_provider: Provider): Promise<Credentials> {
    const key = secrets.get('poe')
    if (!key) throw new Error('Sign in to Poe or add a key first, in Settings → Model providers.')
    return { apiKey: key }
  }
}
