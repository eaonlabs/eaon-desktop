import { createPublicKey, randomUUID, verify, type JsonWebKey } from 'node:crypto'
import type { Provider } from '@shared/types'
import type { Credentials } from '../adapters/types'
import type { OAuthFlow } from './index'
import { jwtClaims, pkce, randomState, singleFlight, startLoopback, tokenStore } from './shared'
import { providerFetch } from '../safeFetch'
import { redactSecrets } from '../redact'

/**
 * "Sign in with ChatGPT" — OpenAI's official way for open-source and locally
 * run apps to use a person's ChatGPT plan (developers.openai.com/siwc,
 * launched 2026-09-29). Unlike the Codex sign-in (`codex.ts`), which borrows
 * the Codex CLI's client id, this registers Eaon as its own client:
 *
 * - The first sign-in sends `client_id=dynamic_agent_client` with an app name
 *   and a stable per-install host id; OpenAI answers with an issued
 *   `oaiapp_…` client id, which is kept and used from then on.
 * - PKCE, loopback redirect on 127.0.0.1 (any port, path exactly /callback),
 *   `resource=https://api.openai.com/v1`, and the `chatgpt.tokens.use.direct`
 *   scope that lets the token draw on the plan.
 * - The ID token is verified (signature against OpenAI's JWKS, issuer,
 *   audience, expiry, nonce) before anything is stored.
 * - Access tokens last an hour; refresh tokens rotate on every use, so
 *   refreshes are serialised (`singleFlight`).
 *
 * Requests then go to the ordinary `api.openai.com/v1/responses` with
 * `store:false`, `stream:true`, no `max_output_tokens`/`temperature` and the
 * system prompt in `instructions` (the Responses adapter's `chatgpt-plan`
 * vendor).
 */

const ISSUER = 'https://auth.openai.com'
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`
const RESOURCE = 'https://api.openai.com/v1'
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
const PLAN_SCOPE = 'chatgpt.tokens.use.direct'
const DYNAMIC_CLIENT = 'dynamic_agent_client'
const APP_NAME = 'Eaon'
const TIMEOUT_MS = 5 * 60_000
/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 5 * 60_000

interface Tokens {
  access: string
  refresh: string
  idToken: string
  /** Epoch ms when `access` expires. */
  expires: number
  email?: string
  subject?: string
}

/** Kept across sign-outs: the install's host id and the client id OpenAI issued for it. */
interface Registration {
  hostId: string
  clientId: string | null
}

const tokens = tokenStore<Tokens>('openai-siwc')
const registration = tokenStore<Registration>('openai-siwc-registration')

function currentRegistration(): Registration {
  let reg = registration.get()
  if (!reg) {
    // Chosen once, before the first sign-in, and kept for the life of the
    // install — the spec requires the same host id every time.
    reg = { hostId: `urn:uuid:${randomUUID()}`, clientId: null }
    registration.set(reg)
  }
  return reg
}

let manualInput: ((input: string) => void) | null = null

/* ------------------------------------------------------------ id token */

let jwksCache: { at: number; keys: (JsonWebKey & { kid?: string })[] } | null = null

async function openIdConfig(): Promise<{ jwks_uri?: string; revocation_endpoint?: string }> {
  const response = await providerFetch(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`OpenAI's sign-in configuration is unavailable (${response.status}).`)
  return (await response.json()) as { jwks_uri?: string; revocation_endpoint?: string }
}

async function signingKeys(): Promise<(JsonWebKey & { kid?: string })[]> {
  if (jwksCache && Date.now() - jwksCache.at < 60 * 60_000) return jwksCache.keys
  const { jwks_uri } = await openIdConfig()
  if (!jwks_uri) throw new Error('OpenAI did not publish its signing keys.')
  const response = await providerFetch(jwks_uri, { signal: AbortSignal.timeout(15_000) })
  const body = (await response.json()) as { keys?: (JsonWebKey & { kid?: string })[] }
  jwksCache = { at: Date.now(), keys: body.keys ?? [] }
  return jwksCache.keys
}

/**
 * Checks an ID token as the spec asks: RS256 signature against OpenAI's JWKS,
 * then issuer, audience, expiry and the nonce this attempt sent. Returns the
 * claims, or throws with a reason.
 */
export async function verifyIdToken(idToken: string, clientId: string, nonce: string, now = Date.now()): Promise<Record<string, unknown>> {
  const [headerPart, payloadPart, signaturePart] = idToken.split('.')
  if (!headerPart || !payloadPart || !signaturePart) throw new Error('The ID token is malformed.')
  const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as { alg?: string; kid?: string }
  if (header.alg !== 'RS256') throw new Error(`Unexpected ID token algorithm ${header.alg ?? 'none'}.`)
  const keys = await signingKeys()
  const jwk = keys.find((key) => key.kid === header.kid) ?? (keys.length === 1 ? keys[0] : undefined)
  if (!jwk) throw new Error('The ID token was signed with a key OpenAI does not publish.')
  const valid = verify('RSA-SHA256', Buffer.from(`${headerPart}.${payloadPart}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(signaturePart, 'base64url'))
  if (!valid) throw new Error('The ID token signature did not verify.')
  const claims = jwtClaims(idToken) ?? {}
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (claims.iss !== ISSUER) throw new Error('The ID token came from an unexpected issuer.')
  if (!audience.includes(clientId)) throw new Error('The ID token was not issued to Eaon.')
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < now - 60_000) throw new Error('The ID token has expired.')
  if (claims.nonce !== nonce) throw new Error('The ID token does not belong to this sign-in attempt.')
  return claims
}

/* ------------------------------------------------------------ tokens */

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
  scope?: string
  error?: string
  error_description?: string
}

async function tokenRequest(body: Record<string, string>, signal?: AbortSignal): Promise<TokenResponse> {
  const response = await providerFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
  })
  const json = (await response.json().catch(() => ({}))) as TokenResponse
  if (!response.ok || !json.access_token) {
    throw Object.assign(new Error(redactSecrets(`ChatGPT sign-in failed (${response.status})${json.error_description ? `: ${json.error_description}` : json.error ? `: ${json.error}` : ''}.`)), {
      status: response.status
    })
  }
  return json
}

const refresh = singleFlight(async (): Promise<Tokens> => {
  const current = tokens.get()
  const clientId = registration.get()?.clientId
  if (!current?.refresh || !clientId) throw new Error('Sign in with ChatGPT again, in Settings → Model providers.')
  let lastError: unknown
  // Network failures and 5xx are retried while the refresh token is still good.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const json = await tokenRequest({ grant_type: 'refresh_token', client_id: clientId, refresh_token: current.refresh, resource: RESOURCE })
      const next: Tokens = {
        ...current,
        access: json.access_token!,
        // Refresh tokens rotate: always keep the replacement.
        refresh: json.refresh_token ?? current.refresh,
        idToken: json.id_token ?? current.idToken,
        expires: Date.now() + (json.expires_in ?? 3600) * 1000
      }
      tokens.set(next)
      return next
    } catch (error) {
      lastError = error
      const status = (error as { status?: number }).status
      if (status && status < 500) {
        // Rejected outright: the session is over.
        tokens.set(null)
        throw new Error('Your ChatGPT sign-in has ended. Sign in again in Settings → Model providers.')
      }
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)))
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
})

/* ------------------------------------------------------------ the flow */

export const siwcFlow: OAuthFlow = {
  id: 'openai-siwc',

  async signIn(onPrompt, signal) {
    const reg = currentRegistration()
    const { verifier, challenge } = pkce()
    const state = randomState()
    const nonce = randomState()
    const server = await startLoopback({ port: 0, path: '/callback', redirectHost: '127.0.0.1', state, service: 'ChatGPT' })
    const onAbort = (): void => server.cancel()
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => server.cancel(), TIMEOUT_MS)
    let pasted: URLSearchParams | null = null
    manualInput = (input) => {
      try {
        const params = new URL(input.trim()).searchParams
        if (params.get('state') === state && params.get('code')) pasted = params
      } catch {
        /* not a redirect URL; ignored */
      }
      server.cancel()
    }

    try {
      const previous = tokens.get()
      const url = new URL(AUTHORIZE_URL)
      url.search = new URLSearchParams({
        client_id: reg.clientId ?? DYNAMIC_CLIENT,
        ...(reg.clientId ? {} : { agent_name_hint: APP_NAME }),
        ext_agent_host_id: reg.hostId,
        response_type: 'code',
        redirect_uri: server.redirectUri,
        scope: SCOPE,
        resource: RESOURCE,
        state,
        nonce,
        code_challenge_method: 'S256',
        code_challenge: challenge,
        ...(reg.clientId && previous?.idToken ? { id_token_hint: previous.idToken } : {}),
        ...(reg.clientId && previous?.email ? { login_hint: previous.email } : {})
      }).toString()
      onPrompt({ url: url.toString(), message: 'Approve Eaon in your browser. It will use your ChatGPT plan.' })

      const code = await server.code
      const params = pasted ?? server.params()
      if (signal.aborted) throw new Error('Sign-in cancelled')
      const authCode = code ?? params?.get('code') ?? null
      if (!authCode || !params) throw new Error('No authorization code came back from ChatGPT.')
      if (params.get('error')) throw new Error(params.get('error') === 'access_denied' ? 'Sign-in was declined.' : `Sign-in failed: ${params.get('error')}`)

      // The issued client id arrives with the code on the first sign-in, and is
      // what every later request must use — never the dynamic placeholder.
      const issued = params.get('client_id') || reg.clientId
      if (!issued || issued === DYNAMIC_CLIENT) throw new Error('OpenAI did not register Eaon as a client. Try again.')
      const granted = (params.get('scope') ?? '').split(/[\s+]+/)
      if (params.get('scope') && !granted.includes(PLAN_SCOPE)) {
        throw new Error('ChatGPT plan usage was not granted, so Eaon cannot use your plan. Sign in again and allow it.')
      }

      const json = await tokenRequest(
        { client_id: issued, code: authCode, code_verifier: verifier, redirect_uri: server.redirectUri, resource: RESOURCE, grant_type: 'authorization_code' },
        signal
      )
      if (!json.id_token) throw new Error('ChatGPT sign-in returned no ID token.')
      const claims = await verifyIdToken(json.id_token, issued, nonce)
      // A different ChatGPT account than the one this install signed in with
      // before must not silently replace it.
      if (previous?.subject && claims.sub && previous.subject !== claims.sub && tokens.get()) {
        throw new Error('That is a different ChatGPT account. Sign out first to switch accounts.')
      }
      if (json.scope && !json.scope.split(' ').includes(PLAN_SCOPE)) {
        throw new Error('ChatGPT plan usage was not granted, so Eaon cannot use your plan.')
      }
      registration.set({ ...reg, clientId: issued })
      tokens.set({
        access: json.access_token!,
        refresh: json.refresh_token ?? '',
        idToken: json.id_token,
        expires: Date.now() + (json.expires_in ?? 3600) * 1000,
        email: typeof claims.email === 'string' ? claims.email : undefined,
        subject: typeof claims.sub === 'string' ? claims.sub : undefined
      })
    } finally {
      manualInput = null
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      server.close()
    }
  },

  async signOut() {
    const current = tokens.get()
    const clientId = registration.get()?.clientId
    tokens.set(null)
    if (!current?.refresh || !clientId) return
    // Revoke the session server-side too; an empty 200 means done, even for a
    // token that was already invalid.
    try {
      const { revocation_endpoint } = await openIdConfig()
      if (revocation_endpoint) {
        await providerFetch(revocation_endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: current.refresh, token_type_hint: 'refresh_token', client_id: clientId }).toString(),
          signal: AbortSignal.timeout(15_000)
        })
      }
    } catch {
      /* signed out locally regardless */
    }
  },

  isSignedIn() {
    return Boolean(tokens.get()?.access)
  },

  account() {
    return tokens.get()?.email
  },

  submitCode(input) {
    manualInput?.(input)
  },

  expire() {
    const current = tokens.get()
    if (current) tokens.set({ ...current, expires: 0 })
  },

  async credentials(provider: Provider): Promise<Credentials> {
    let current = tokens.get()
    if (!current) throw new Error('Sign in with ChatGPT first, in Settings → Model providers.')
    if (current.expires - Date.now() < REFRESH_MARGIN_MS) current = await refresh()
    return { apiKey: current.access, baseUrl: provider.baseUrl }
  }
}

/** Exposed for tests. */
export const __test = { tokens, registration }
