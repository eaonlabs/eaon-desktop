import { hostname } from 'node:os'
import { app } from 'electron'
import { TOKN_HOST, type ToknAccount } from '@shared/usage'
import { parseAuthorizationInput, pkce, randomState, startLoopback, tokenStore } from '../../providers/oauth/shared'
import type { ToknPricing, ToknSyncRow } from './rows'

/**
 * Tokn (toknhq.com): "Sign in with Tokn", and the Tokn endpoints Eaon uses.
 *
 * Sign-in is OAuth 2.0 authorization code with PKCE and a loopback redirect
 * (RFC 8252), the way a native app should: Tokn's page asks the user to
 * approve Eaon, then sends the browser back to a one-shot server on
 * 127.0.0.1. The token it issues is an ordinary Tokn device token, so it
 * shows on the user's Tokn account page (where revoking it signs Eaon out)
 * and works with Tokn's CLI endpoints as they are: `/api/cli/me`,
 * `/api/cli/pricing`, `/api/cli/sync`. It lives in the encrypted vault and
 * never reaches the renderer.
 */

export const CLIENT_ID = 'eaon-desktop'
const SCOPE = 'profile usage:write'
/**
 * Long enough for someone new to Tokn to make an account and go through its
 * setup guide (install the CLI, link a machine) before approving Eaon.
 */
const SIGN_IN_TIMEOUT_MS = 30 * 60_000
const REQUEST_TIMEOUT_MS = 30_000

/** `EAON_TOKN_HOST` points Eaon at a local Tokn while developing it. */
export const toknHost = (): string => (process.env.EAON_TOKN_HOST || TOKN_HOST).replace(/\/+$/, '')

interface Saved {
  token: string
  account: ToknAccount
  linkedAt: string
}

const saved = tokenStore<Saved>('tokn')

/** A Tokn request that failed, with the reason in words and the status kept. */
export class ToknError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

export function toknAccount(): ToknAccount | null {
  return saved.get()?.account ?? null
}

const appVersion = (): string => {
  try {
    return app.getVersion()
  } catch {
    return '0.0.0'
  }
}

/** The version Tokn records for this device, as `<client>/<version>`. */
export const clientVersion = (): string => `${CLIENT_ID}/${appVersion()}`

/** The message a Tokn error body carries: OAuth's `error_description`, or the CLI endpoints' `error`. */
async function reason(response: Response): Promise<string | undefined> {
  const body = (await response.json().catch(() => null)) as { error?: unknown; error_description?: unknown } | null
  const text = typeof body?.error_description === 'string' ? body.error_description : typeof body?.error === 'string' ? body.error : undefined
  return text?.slice(0, 300)
}

let manualInput: ((input: string) => void) | null = null

/**
 * Signs in: opens Tokn's approval page through `onUrl`, waits for the
 * redirect (or a pasted redirect URL, via `submitCode`), and trades the code
 * for a token.
 */
export async function signIn(onUrl: (url: string) => void, signal: AbortSignal): Promise<ToknAccount> {
  const { verifier, challenge } = pkce()
  const state = randomState()
  const server = await startLoopback({ port: 0, path: '/callback', redirectHost: '127.0.0.1', state, service: 'Tokn' })
  const onAbort = (): void => server.cancel()
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => server.cancel(), SIGN_IN_TIMEOUT_MS)
  let pasted: string | null = null
  manualInput = (input) => {
    pasted = input
    server.cancel()
  }

  try {
    const url = new URL(`${toknHost()}/oauth/authorize`)
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: server.redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: SCOPE,
      state
    }).toString()
    onUrl(url.toString())

    let code = await server.code
    if (!code && pasted) {
      const parsed = parseAuthorizationInput(pasted)
      if (parsed.state && parsed.state !== state) throw new Error('That redirect is from a different sign-in. Start again.')
      code = parsed.code ?? null
    }
    if (signal.aborted) throw new Error('Sign-in cancelled')
    if (!code) throw new Error('Tokn didn’t send Eaon back a sign-in. Try again, and approve Eaon on the Tokn page.')

    const response = await fetch(`${toknHost()}/api/oauth/token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: server.redirectUri,
        client_id: CLIENT_ID,
        code_verifier: verifier,
        device_name: hostname(),
        platform: process.platform,
        app_version: appVersion()
      }).toString(),
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    })
    if (!response.ok) throw new ToknError(`Tokn didn’t sign Eaon in (${response.status})${tail(await reason(response))}`, response.status)
    const body = (await response.json()) as {
      access_token?: unknown
      user?: { id?: unknown; handle?: unknown; name?: unknown }
      profile_url?: unknown
    }
    if (typeof body.access_token !== 'string' || !body.access_token || typeof body.user?.handle !== 'string') {
      throw new Error('Tokn’s reply was missing the sign-in. Try again.')
    }
    const account: ToknAccount = {
      id: typeof body.user.id === 'string' ? body.user.id : body.user.handle,
      handle: body.user.handle,
      ...(typeof body.user.name === 'string' && body.user.name ? { name: body.user.name } : {}),
      profileUrl: typeof body.profile_url === 'string' ? body.profile_url : `${toknHost()}/profile/${encodeURIComponent(body.user.handle)}`
    }
    saved.set({ token: body.access_token, account, linkedAt: new Date().toISOString() })
    return account
  } finally {
    manualInput = null
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    server.close()
  }
}

const tail = (text: string | undefined): string => (text ? `: ${text}` : '.')

/** A pasted redirect URL, for when the browser can't reach the loopback server. */
export function submitCode(input: string): void {
  manualInput?.(input)
}

/** Forgets the token here, and asks Tokn to revoke it (best effort: signing out works offline too). */
export async function signOut(): Promise<void> {
  const token = saved.get()?.token
  saved.set(null)
  if (!token) return
  await fetch(`${toknHost()}/api/oauth/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, client_id: CLIENT_ID }).toString(),
    signal: AbortSignal.timeout(10_000)
  }).catch(() => undefined)
}

/** A request with the token. A 401 means the token was revoked on Tokn: Eaon is signed out. */
async function authed(path: string, init: RequestInit = {}): Promise<Response> {
  const token = saved.get()?.token
  if (!token) throw new ToknError('Sign in with Tokn first.', 401)
  const response = await fetch(`${toknHost()}${path}`, {
    ...init,
    headers: { Accept: 'application/json', ...init.headers, Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (response.status === 401) {
    saved.set(null)
    throw new ToknError('Tokn signed Eaon out (it was removed from your Tokn account). Sign in again to keep syncing.', 401)
  }
  return response
}

/** The signed-in account as Tokn has it now (a changed handle shows up here). */
export async function refreshAccount(): Promise<ToknAccount | null> {
  const current = saved.get()
  if (!current) return null
  const response = await authed('/api/cli/me')
  if (!response.ok) throw new ToknError(`Tokn couldn’t be reached (${response.status})${tail(await reason(response))}`, response.status)
  const body = (await response.json()) as { user?: { id?: unknown; handle?: unknown; name?: unknown } }
  const handle = typeof body.user?.handle === 'string' ? body.user.handle : current.account.handle
  const account: ToknAccount = {
    ...current.account,
    handle,
    ...(typeof body.user?.name === 'string' && body.user.name ? { name: body.user.name } : {}),
    profileUrl: `${toknHost()}/profile/${encodeURIComponent(handle)}`
  }
  saved.set({ ...current, account })
  return account
}

/** Tokn's price table. Public: no token needed. */
export async function fetchPricing(): Promise<ToknPricing> {
  const response = await fetch(`${toknHost()}/api/cli/pricing`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (!response.ok) throw new ToknError(`Tokn’s prices couldn’t be loaded (${response.status}).`, response.status)
  const body = (await response.json()) as { models?: unknown }
  const models = body.models && typeof body.models === 'object' ? (body.models as Record<string, unknown>) : {}
  const pricing: ToknPricing = {}
  for (const [id, value] of Object.entries(models)) {
    const price = value as Record<string, unknown>
    if (typeof price?.input !== 'number' || typeof price?.output !== 'number') continue
    pricing[id.toLowerCase()] = {
      input: price.input,
      output: price.output,
      ...(typeof price.cacheRead === 'number' ? { cacheRead: price.cacheRead } : {}),
      ...(typeof price.cacheWrite === 'number' ? { cacheWrite: price.cacheWrite } : {}),
      ...(typeof price.cacheWrite1h === 'number' ? { cacheWrite1h: price.cacheWrite1h } : {})
    }
  }
  return pricing
}

export interface UploadResult {
  accepted: number
  rejected: number
  rank: number | null
  profileUrl?: string
}

/** Uploads every day's totals. Tokn replaces each (day, tool, model) row, so re-sending is safe. */
export async function upload(rows: ToknSyncRow[], timezone: string): Promise<UploadResult> {
  const response = await authed('/api/cli/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows, timezone, scannedAt: new Date().toISOString(), cliVersion: clientVersion() })
  })
  if (!response.ok) {
    const why = await reason(response)
    if (response.status === 429) throw new ToknError('Synced a moment ago. Try again in a few seconds.', 429)
    throw new ToknError(`Tokn didn’t take the upload (${response.status})${tail(why)}`, response.status)
  }
  const body = (await response.json()) as { accepted?: unknown; rejected?: unknown; rank?: unknown; profileUrl?: unknown }
  return {
    accepted: typeof body.accepted === 'number' ? body.accepted : 0,
    rejected: Array.isArray(body.rejected) ? body.rejected.length : 0,
    rank: typeof body.rank === 'number' ? body.rank : null,
    ...(typeof body.profileUrl === 'string' ? { profileUrl: body.profileUrl } : {})
  }
}
