import type { Provider } from '@shared/types'
import type { Credentials } from '../adapters/types'
import type { OAuthFlow } from './index'
import { abortableSleep, singleFlight, tokenStore } from './shared'

/**
 * GitHub Copilot sign-in, following Eaon Code's `github-copilot` flow.
 *
 * Two tokens: a long-lived GitHub OAuth token from the device flow (the user
 * types a code on github.com), and a short-lived Copilot token (~30 min)
 * exchanged from it at `copilot_internal/v2/token` and refreshed from it
 * whenever it nears expiry. The Copilot token says which API host serves the
 * account (`proxy-ep=proxy.individual.githubcopilot.com` →
 * `api.individual.githubcopilot.com`), so the base URL comes from the token,
 * not the catalog. Copilot only answers requests that identify as a
 * supported editor, hence the VS Code headers.
 */

// The public VS Code Copilot Chat client id, base64 as in Eaon Code.
const CLIENT_ID = Buffer.from('SXYxLmI1MDdhMDhjODdlY2ZlOTg=', 'base64').toString('utf8')
const DOMAIN = 'github.com'
const DEVICE_CODE_URL = `https://${DOMAIN}/login/device/code`
const ACCESS_TOKEN_URL = `https://${DOMAIN}/login/oauth/access_token`
const COPILOT_TOKEN_URL = `https://api.${DOMAIN}/copilot_internal/v2/token`
const USER_URL = `https://api.${DOMAIN}/user`
const DEFAULT_BASE = 'https://api.individual.githubcopilot.com'
const REFRESH_MARGIN_MS = 60_000

/** Headers Copilot requires on every call; also sent as the provider's own headers. */
export const COPILOT_HEADERS: Record<string, string> = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat'
}
export const COPILOT_API_VERSION = '2026-06-01'

interface CopilotTokens {
  /** GitHub OAuth token from the device flow; never expires on its own. */
  github: string
  /** Copilot API token. */
  copilot: string
  /** Epoch ms, already pulled forward by five minutes. */
  expires: number
  login?: string
}

const store = tokenStore<CopilotTokens>('github-copilot')

/** `…;proxy-ep=proxy.individual.githubcopilot.com;…` → `https://api.individual.githubcopilot.com`. */
export function copilotBaseUrl(token: string | undefined): string {
  const match = token?.match(/proxy-ep=([^;]+)/)
  return match ? `https://${match[1].replace(/^proxy\./, 'api.')}` : DEFAULT_BASE
}

async function exchangeCopilotToken(github: string, signal?: AbortSignal): Promise<{ copilot: string; expires: number }> {
  const response = await fetch(COPILOT_TOKEN_URL, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${github}`, ...COPILOT_HEADERS },
    signal
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const error = new Error(
      response.status === 401 || response.status === 403 || response.status === 404
        ? 'This GitHub account does not have access to Copilot.'
        : `Copilot token exchange failed (${response.status}): ${text.slice(0, 200)}`
    )
    ;(error as Error & { status?: number }).status = response.status
    throw error
  }
  const body = (await response.json()) as { token?: string; expires_at?: number }
  if (typeof body.token !== 'string' || typeof body.expires_at !== 'number') throw new Error('Copilot returned an unexpected token response.')
  return { copilot: body.token, expires: body.expires_at * 1000 - 5 * 60_000 }
}

/**
 * Some models (Claude, Grok) have to be switched on per account before first
 * use; Eaon Code does it at sign-in for models whose policy is still
 * "unconfigured". Best effort — a failure only means the user enables them
 * in VS Code instead.
 */
async function enableUnconfiguredModels(copilot: string, signal: AbortSignal): Promise<void> {
  const base = copilotBaseUrl(copilot)
  const headers = { Accept: 'application/json', Authorization: `Bearer ${copilot}`, ...COPILOT_HEADERS, 'X-GitHub-Api-Version': COPILOT_API_VERSION }
  const response = await fetch(`${base}/models`, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) })
  if (!response.ok) return
  const body = (await response.json()) as { data?: { id?: string; model_picker_enabled?: boolean; policy?: { state?: string } }[] }
  for (const model of body.data ?? []) {
    if (!model.id || model.policy?.state !== 'unconfigured' || !model.model_picker_enabled) continue
    const policy = await fetch(`${base}/models/${encodeURIComponent(model.id)}/policy`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'openai-intent': 'chat-policy', 'x-interaction-type': 'chat-policy' },
      body: JSON.stringify({ state: 'enabled' }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)])
    }).catch(() => null)
    if (policy?.status === 429) return
  }
}

const refresh = singleFlight(async (): Promise<CopilotTokens> => {
  const current = store.get()
  if (!current) throw new Error('Sign in with GitHub first, in Settings → Model providers.')
  try {
    const next = { ...current, ...(await exchangeCopilotToken(current.github)) }
    store.set(next)
    return next
  } catch (error) {
    // The GitHub token was revoked, or the Copilot subscription ended.
    const status = (error as { status?: number }).status
    if (status === 401) store.set(null)
    throw error
  }
})

export const copilotFlow: OAuthFlow = {
  id: 'github-copilot',

  async signIn(onPrompt, signal) {
    const deviceResponse = await fetch(DEVICE_CODE_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': COPILOT_HEADERS['User-Agent'] },
      body: new URLSearchParams({ client_id: CLIENT_ID, scope: 'read:user' }),
      signal
    })
    if (!deviceResponse.ok) throw new Error(`GitHub did not start the sign-in (${deviceResponse.status}).`)
    const device = (await deviceResponse.json()) as {
      device_code?: string
      user_code?: string
      verification_uri?: string
      interval?: number
      expires_in?: number
    }
    if (!device.device_code || !device.user_code || !device.verification_uri) throw new Error('GitHub returned an unexpected device-code response.')
    // Only ever send the user to an http(s) page.
    const verification = new URL(device.verification_uri)
    if (verification.protocol !== 'https:' && verification.protocol !== 'http:') throw new Error('GitHub returned an unexpected verification page.')

    onPrompt({ url: verification.href, code: device.user_code, message: 'Enter this code on GitHub to connect Copilot.' })

    // RFC 8628: poll no faster than `interval` (default 5s); `slow_down` adds 5s.
    let interval = Math.max(1, device.interval ?? 5) * 1000
    const deadline = Date.now() + (device.expires_in ?? 900) * 1000
    let github: string | null = null
    while (!github) {
      if (Date.now() > deadline) throw new Error('The GitHub code expired before it was entered. Try again.')
      await abortableSleep(interval, signal)
      const response = await fetch(ACCESS_TOKEN_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': COPILOT_HEADERS['User-Agent'] },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          device_code: device.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
        }),
        signal
      })
      const body = (await response.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string; interval?: number }
      if (body.access_token) github = body.access_token
      else if (body.error === 'authorization_pending') continue
      else if (body.error === 'slow_down') interval = body.interval ? body.interval * 1000 : interval + 5000
      else if (body.error === 'access_denied') throw new Error('The GitHub sign-in was declined.')
      else if (body.error === 'expired_token') throw new Error('The GitHub code expired before it was entered. Try again.')
      else throw new Error(`GitHub sign-in failed: ${body.error_description ?? body.error ?? response.status}`)
    }

    const copilot = await exchangeCopilotToken(github, signal)
    let login: string | undefined
    try {
      const user = await fetch(USER_URL, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${github}`, 'User-Agent': COPILOT_HEADERS['User-Agent'] },
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)])
      })
      if (user.ok) login = ((await user.json()) as { login?: string }).login
    } catch {
      /* the login is only shown in Settings */
    }
    store.set({ github, ...copilot, login })
    await enableUnconfiguredModels(copilot.copilot, signal).catch(() => {})
  },

  async signOut() {
    store.set(null)
  },

  isSignedIn() {
    return Boolean(store.get())
  },

  account() {
    const login = store.get()?.login
    return login ? `@${login}` : undefined
  },

  expire() {
    const tokens = store.get()
    if (tokens) store.set({ ...tokens, expires: 0 })
  },

  async credentials(_provider: Provider): Promise<Credentials> {
    let tokens = store.get()
    if (!tokens) throw new Error('Sign in with GitHub first, in Settings → Model providers.')
    if (tokens.expires - Date.now() < REFRESH_MARGIN_MS) tokens = await refresh()
    return { apiKey: tokens.copilot, baseUrl: copilotBaseUrl(tokens.copilot) }
  }
}

/** Exposed for the OAuth tests. */
export const __test = { store, exchangeCopilotToken }
