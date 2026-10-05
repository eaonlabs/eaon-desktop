import type { Provider } from '@shared/types'
import type { Credentials } from '../adapters/types'
import type { OAuthFlow } from './index'
import { jwtClaims, parseAuthorizationInput, pkce, randomState, singleFlight, startLoopback, tokenStore } from './shared'

/**
 * ChatGPT Plus/Pro sign-in, for the Codex backend.
 *
 * Mirrors Eaon Code's `openai-codex` login exactly: the Codex CLI's public
 * client id, PKCE (S256), a loopback callback on `localhost:1455/auth/callback`
 * (the only redirect that client id is registered for), a form-encoded token
 * exchange at auth.openai.com, and refresh with the rotating refresh token.
 * The ChatGPT account id — sent as `chatgpt-account-id` on every Codex
 * request — is read from the access token's `https://api.openai.com/auth`
 * claim, falling back to the id token's.
 */

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const SCOPE = 'openid profile email offline_access'
const CALLBACK_PORT = 1455
const CALLBACK_PATH = '/auth/callback'
const AUTH_CLAIM = 'https://api.openai.com/auth'
const PROFILE_CLAIM = 'https://api.openai.com/profile'
/** Refresh this long before expiry, so a long agent turn never starts on a token about to lapse. */
const REFRESH_MARGIN_MS = 5 * 60_000

interface CodexTokens {
  access: string
  refresh: string
  /** Epoch ms. */
  expires: number
  accountId: string
  email?: string
  plan?: string
}

const store = tokenStore<CodexTokens>('openai-codex')

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
}

function tokensFrom(body: TokenResponse, previous?: CodexTokens): CodexTokens {
  if (!body.access_token || !body.refresh_token || typeof body.expires_in !== 'number') {
    throw new Error('ChatGPT sign-in returned an incomplete token response.')
  }
  const access = jwtClaims(body.access_token)
  const id = jwtClaims(body.id_token)
  const auth = ((access?.[AUTH_CLAIM] ?? id?.[AUTH_CLAIM]) ?? {}) as { chatgpt_account_id?: string; chatgpt_plan_type?: string }
  const accountId = auth.chatgpt_account_id ?? previous?.accountId
  if (!accountId) throw new Error('ChatGPT sign-in did not include an account id. Sign in with a ChatGPT Plus or Pro account.')
  const profile = (access?.[PROFILE_CLAIM] ?? {}) as { email?: string }
  return {
    access: body.access_token,
    refresh: body.refresh_token,
    expires: Date.now() + body.expires_in * 1000,
    accountId,
    email: (id?.email as string | undefined) ?? profile.email ?? previous?.email,
    plan: auth.chatgpt_plan_type ?? previous?.plan
  }
}

async function tokenRequest(params: Record<string, string>, operation: string, signal?: AbortSignal): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    // A token endpoint that never answers must not hold every request (and the refresh lock) forever.
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const error = new Error(`ChatGPT token ${operation} failed (${response.status}): ${text.slice(0, 300) || response.statusText}`)
    ;(error as Error & { status?: number }).status = response.status
    throw error
  }
  return (await response.json()) as TokenResponse
}

let manualInput: ((input: string) => void) | null = null

const refresh = singleFlight(async (): Promise<CodexTokens> => {
  const current = store.get()
  if (!current) throw new Error('Sign in with ChatGPT first, in Settings → Model providers.')
  try {
    const next = tokensFrom(
      await tokenRequest({ grant_type: 'refresh_token', refresh_token: current.refresh, client_id: CLIENT_ID }, 'refresh'),
      current
    )
    store.set(next)
    return next
  } catch (error) {
    // A refresh token that was revoked or already spent never recovers.
    const status = (error as { status?: number }).status
    if (status === 400 || status === 401) {
      store.set(null)
      throw new Error('Your ChatGPT sign-in has expired. Sign in again in Settings → Model providers.')
    }
    throw error
  }
})

export const codexFlow: OAuthFlow = {
  id: 'openai-codex',

  async signIn(onPrompt, signal) {
    const { verifier, challenge } = pkce()
    const state = randomState()
    const server = await startLoopback({
      port: CALLBACK_PORT,
      path: CALLBACK_PATH,
      redirectHost: 'localhost',
      state,
      service: 'ChatGPT'
    })
    const onAbort = (): void => server.cancel()
    signal.addEventListener('abort', onAbort, { once: true })

    let pasted: string | null = null
    manualInput = (input) => {
      pasted = input
      server.cancel()
    }

    try {
      const url = new URL(AUTHORIZE_URL)
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('client_id', CLIENT_ID)
      url.searchParams.set('redirect_uri', server.redirectUri)
      url.searchParams.set('scope', SCOPE)
      url.searchParams.set('code_challenge', challenge)
      url.searchParams.set('code_challenge_method', 'S256')
      url.searchParams.set('state', state)
      url.searchParams.set('id_token_add_organizations', 'true')
      url.searchParams.set('codex_cli_simplified_flow', 'true')
      url.searchParams.set('originator', 'pi')
      onPrompt({ url: url.toString(), message: 'Finish signing in with ChatGPT in your browser.' })

      let code = await server.code
      if (!code && pasted) {
        const parsed = parseAuthorizationInput(pasted)
        if (parsed.state && parsed.state !== state) throw new Error('That redirect URL is from a different sign-in attempt.')
        code = parsed.code ?? null
      }
      if (signal.aborted) throw new Error('Sign-in cancelled')
      if (!code) throw new Error('No authorization code came back from ChatGPT.')

      const body = await tokenRequest(
        { grant_type: 'authorization_code', client_id: CLIENT_ID, code, code_verifier: verifier, redirect_uri: server.redirectUri },
        'exchange',
        signal
      )
      store.set(tokensFrom(body))
    } finally {
      manualInput = null
      signal.removeEventListener('abort', onAbort)
      server.close()
    }
  },

  async signOut() {
    store.set(null)
  },

  isSignedIn() {
    return Boolean(store.get())
  },

  account() {
    const tokens = store.get()
    if (!tokens) return undefined
    const plan = tokens.plan ? tokens.plan.charAt(0).toUpperCase() + tokens.plan.slice(1) : undefined
    return [tokens.email, plan].filter(Boolean).join(' · ') || undefined
  },

  submitCode(input) {
    manualInput?.(input)
  },

  expire() {
    const tokens = store.get()
    if (tokens) store.set({ ...tokens, expires: 0 })
  },

  async credentials(provider: Provider): Promise<Credentials> {
    let tokens = store.get()
    if (!tokens) throw new Error('Sign in with ChatGPT first, in Settings → Model providers.')
    if (tokens.expires - Date.now() < REFRESH_MARGIN_MS) tokens = await refresh()
    return { apiKey: tokens.access, baseUrl: provider.baseUrl, extra: { accountId: tokens.accountId } }
  }
}

/** Exposed for the OAuth tests. */
export const __test = { tokensFrom, store }
