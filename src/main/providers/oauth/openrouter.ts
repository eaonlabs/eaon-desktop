import { randomUUID } from 'node:crypto'
import type { Provider } from '@shared/types'
import { secrets } from '../../secrets'
import type { Credentials } from '../adapters/types'
import type { OAuthFlow } from './index'
import { parseAuthorizationInput, pkce, startLoopback } from './shared'

/**
 * "Sign in with OpenRouter": OpenRouter's PKCE flow mints an ordinary,
 * user-controlled API key billed from the account's credits (Eaon Code's
 * `openrouter` OAuth). Nothing expires and nothing refreshes, so the result
 * is simply stored as the provider's API key and every other code path —
 * fallback keys, Remove key — keeps working unchanged.
 */

const AUTHORIZE_URL = 'https://openrouter.ai/auth'
const KEY_URL = 'https://openrouter.ai/api/v1/auth/keys'
const PROVIDER_ID = 'openrouter'
const TIMEOUT_MS = 5 * 60_000

let manualInput: ((input: string) => void) | null = null

export const openRouterFlow: OAuthFlow = {
  id: 'openrouter',

  async signIn(onPrompt, signal) {
    const { verifier, challenge } = pkce()
    // A fresh path per attempt, so a stale tab from an earlier try cannot complete this one.
    const server = await startLoopback({ port: 0, path: `/oauth/callback/${randomUUID()}`, redirectHost: '127.0.0.1', service: 'OpenRouter' })
    const onAbort = (): void => server.cancel()
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => server.cancel(), TIMEOUT_MS)
    let pasted: string | null = null
    manualInput = (input) => {
      pasted = input
      server.cancel()
    }

    try {
      const url = new URL(AUTHORIZE_URL)
      url.search = new URLSearchParams({ callback_url: server.redirectUri, code_challenge: challenge, code_challenge_method: 'S256' }).toString()
      onPrompt({ url: url.toString(), message: 'Approve Eaon in your browser. OpenRouter creates a key billed from your credits.' })

      const code = (await server.code) ?? (pasted ? (parseAuthorizationInput(pasted).code ?? null) : null)
      if (signal.aborted) throw new Error('Sign-in cancelled')
      if (!code) throw new Error('No authorization code came back from OpenRouter.')

      const response = await fetch(KEY_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      })
      const body = (await response.json().catch(() => ({}))) as { key?: string; error?: { message?: string } | string; message?: string }
      if (!response.ok || typeof body.key !== 'string' || !body.key) {
        const detail = typeof body.error === 'string' ? body.error : (body.error?.message ?? body.message)
        throw new Error(`OpenRouter did not issue a key (${response.status})${detail ? `: ${detail}` : ''}.`)
      }
      secrets.set(PROVIDER_ID, body.key)
    } finally {
      manualInput = null
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      server.close()
    }
  },

  // The minted key is a normal key: removing it is "Remove key" on the provider.
  async signOut() {},

  isSignedIn() {
    return secrets.has(PROVIDER_ID)
  },

  submitCode(input) {
    manualInput?.(input)
  },

  async credentials(_provider: Provider): Promise<Credentials> {
    const key = secrets.get(PROVIDER_ID)
    if (!key) throw new Error('Sign in to OpenRouter or add a key first, in Settings → Model providers.')
    return { apiKey: key }
  }
}
