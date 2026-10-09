import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { openExternalSafely } from './externalLinks'
import {
  auth,
  extractWWWAuthenticateParams,
  type OAuthClientProvider,
  type OAuthDiscoveryState
} from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { MCP_OAUTH_CLIENT_METADATA, MCP_OAUTH_REDIRECT_URI } from '@shared/mcpCatalog'
import { secrets } from './secrets'

/**
 * Browser sign-in for MCP servers (OAuth 2.1 with PKCE), built on the SDK's
 * `auth()` orchestrator rather than a hand-rolled flow: discovery (RFC 9728 →
 * RFC 8414), Dynamic Client Registration, the PKCE authorization URL, the code
 * exchange and refreshes all come from the SDK. This module supplies the parts
 * the SDK leaves to the app — where state lives, how the browser is opened,
 * and how the redirect comes back.
 *
 * Two kinds of provider share one class:
 *
 *  - Interactive, created only by `signIn()` when the user clicks Sign in. It
 *    may register a client and open the browser.
 *  - Background, attached to every OAuth server's transport. It hands out
 *    stored tokens and lets the SDK refresh them on a 401, but it must never
 *    open a browser or register a client on its own — a launch-time reconnect
 *    popping a login page, or registering a new client with the vendor on
 *    every start, would both be wrong. When it would have to, it throws
 *    `SignInRequiredError` and the server shows "Sign in" instead.
 */

/** Everything kept for one server, encrypted in the vault under `mcp-oauth:<serverId>`. */
interface StoredAuth {
  /**
   * The server these credentials were issued for. A custom server can be
   * edited to point somewhere else, or deleted and re-added under the same
   * id; tokens must never follow it to a different URL.
   */
  serverUrl?: string
  client?: OAuthClientInformationMixed
  /** The user typed this client in (no DCR); never thrown away automatically. */
  manualClient?: boolean
  tokens?: OAuthTokens
  /** Epoch ms the access token expires, computed from `expires_in` at save time. */
  expiresAt?: number
  discovery?: OAuthDiscoveryState
}

export class SignInRequiredError extends Error {
  constructor(message = 'Sign in to connect') {
    super(message)
    this.name = 'SignInRequiredError'
  }
}

/** The server has no registration endpoint, so the user must supply a client id. */
export class ClientIdRequiredError extends Error {
  constructor() {
    super('This server does not let apps register themselves. Create an OAuth app with the vendor and enter its client ID.')
    this.name = 'ClientIdRequiredError'
  }
}

const vaultKey = (serverId: string): string => `mcp-oauth:${serverId}`

// The vault decrypts the whole file on every read, and the transport asks for
// tokens on every request, so reads are served from memory after the first.
const cache = new Map<string, StoredAuth>()

function read(serverId: string): StoredAuth {
  const cached = cache.get(serverId)
  if (cached) return cached
  let stored: StoredAuth = {}
  try {
    const raw = secrets.get(vaultKey(serverId))
    if (raw) stored = JSON.parse(raw) as StoredAuth
  } catch {
    /* unreadable entry: treat as signed out */
  }
  cache.set(serverId, stored)
  return stored
}

function write(serverId: string, patch: Partial<StoredAuth>): void {
  const next = { ...read(serverId), ...patch }
  for (const key of Object.keys(next) as (keyof StoredAuth)[]) if (next[key] === undefined) delete next[key]
  cache.set(serverId, next)
  secrets.set(vaultKey(serverId), Object.keys(next).length > 0 ? JSON.stringify(next) : '')
}

/** What is stored for this server and URL, or nothing if it was issued for another URL. */
function readFor(serverId: string, serverUrl: string): StoredAuth {
  const stored = read(serverId)
  return !stored.serverUrl || stored.serverUrl === serverUrl ? stored : {}
}

/** True when a server holds OAuth tokens (it may still need a refresh). */
export function hasOAuthTokens(serverId: string, serverUrl: string): boolean {
  return Boolean(readFor(serverId, serverUrl).tokens?.access_token)
}

/** The client id stored for a server, for pre-filling the manual-client form. Never the secret. */
export function storedClientId(serverId: string, serverUrl: string): string | null {
  const stored = readFor(serverId, serverUrl)
  return stored.manualClient ? (stored.client?.client_id ?? null) : null
}

type Mode = { interactive: false } | { interactive: true; openBrowser: (url: URL) => Promise<void> }

export class McpOAuthProvider implements OAuthClientProvider {
  private verifier = ''

  constructor(
    readonly serverId: string,
    readonly serverUrl: string,
    private readonly mode: Mode = { interactive: false }
  ) {}

  private get stored(): StoredAuth {
    return readFor(this.serverId, this.serverUrl)
  }

  private save(patch: Partial<StoredAuth>): void {
    // Anything issued for an old URL is dropped rather than merged.
    const base = this.stored === read(this.serverId) ? {} : { client: undefined, manualClient: undefined, tokens: undefined, expiresAt: undefined, discovery: undefined }
    write(this.serverId, { ...base, ...patch, serverUrl: this.serverUrl })
  }

  get redirectUrl(): string {
    return MCP_OAUTH_REDIRECT_URI
  }

  get clientMetadata(): OAuthClientMetadata {
    return MCP_OAUTH_CLIENT_METADATA as OAuthClientMetadata
  }

  state(): string {
    return randomBytes(16).toString('base64url')
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const client = this.stored.client
    // Returning undefined here is what makes the SDK register a new client,
    // which only an explicit sign-in may do.
    if (!client && !this.mode.interactive) throw new SignInRequiredError()
    return client
  }

  saveClientInformation(client: OAuthClientInformationMixed): void {
    this.save({ client, manualClient: false })
  }

  tokens(): OAuthTokens | undefined {
    return this.stored.tokens
  }

  saveTokens(tokens: OAuthTokens): void {
    // A refresh response may omit the refresh token; the SDK carries the old
    // one over, so what arrives here is always the full set.
    this.save({
      tokens,
      expiresAt: typeof tokens.expires_in === 'number' ? Date.now() + tokens.expires_in * 1000 : undefined
    })
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.mode.interactive) throw new SignInRequiredError()
    await this.mode.openBrowser(authorizationUrl)
  }

  saveCodeVerifier(codeVerifier: string): void {
    // Only ever needed within one sign-in, by this same provider instance.
    this.verifier = codeVerifier
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error('No sign-in in progress')
    return this.verifier
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.save({ discovery: state })
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.stored.discovery
  }

  /**
   * A fresh sign-in starts from no tokens (the user may be switching
   * accounts). A registered client is kept so the vendor does not collect a
   * new one on every sign-in; a hand-made one replaces whatever was there.
   */
  resetForSignIn(client?: { clientId: string; clientSecret?: string }): void {
    const clientId = client?.clientId.trim()
    const secret = client?.clientSecret?.trim()
    this.save({
      tokens: undefined,
      expiresAt: undefined,
      discovery: undefined,
      ...(clientId ? { client: { client_id: clientId, ...(secret ? { client_secret: secret } : {}) }, manualClient: true } : {})
    })
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    const stored = this.stored
    const dropClient = (scope === 'all' || scope === 'client') && !stored.manualClient
    this.save({
      client: dropClient ? undefined : stored.client,
      manualClient: dropClient ? undefined : stored.manualClient,
      tokens: scope === 'all' || scope === 'tokens' ? undefined : stored.tokens,
      expiresAt: scope === 'all' || scope === 'tokens' ? undefined : stored.expiresAt,
      discovery: scope === 'all' || scope === 'discovery' ? undefined : stored.discovery
    })
    if (scope === 'all' || scope === 'verifier') this.verifier = ''
  }
}

/* ------------------------------------------------------ Shared refreshes */

interface RefreshAnswer {
  status: number
  statusText: string
  headers: [string, string][]
  body: string
}

/** Successful refreshes by (token endpoint, refresh token), replayed for a minute. */
const refreshes = new Map<string, { at: number; answer: Promise<RefreshAnswer> }>()
const REFRESH_REPLAY_MS = 60_000

/**
 * The fetch every OAuth server's transport uses, which shares refreshes.
 *
 * Each request that finds the access token expired runs its own refresh, and
 * the agent sends read-only plugin calls in parallel. Vendors that rotate
 * refresh tokens honour only the first of those; the SDK answers the others'
 * `invalid_grant` by dropping the stored tokens — including the ones the first
 * refresh has just saved — and the user is signed out. So one refresh goes out
 * per refresh token, and its answer is handed to every request that asks with
 * that same token, in flight or shortly after.
 */
export async function oauthFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const body = init?.body
  const refreshToken =
    init?.method === 'POST' && body instanceof URLSearchParams && body.get('grant_type') === 'refresh_token' ? body.get('refresh_token') : null
  if (!refreshToken) return fetch(input, init)

  const now = Date.now()
  for (const [key, entry] of refreshes) if (now - entry.at > REFRESH_REPLAY_MS) refreshes.delete(key)
  const key = `${String(input)}\n${refreshToken}`
  let entry = refreshes.get(key)
  if (!entry) {
    const answer = fetch(input, init).then(async (res) => ({
      status: res.status,
      statusText: res.statusText,
      headers: [...res.headers],
      body: await res.text()
    }))
    entry = { at: now, answer }
    refreshes.set(key, entry)
    // Only a success is replayed; a failure is left for the next caller to retry.
    answer.then(
      (a) => a.status >= 400 && refreshes.delete(key),
      () => refreshes.delete(key)
    )
  }
  const answer = await entry.answer
  return new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers: answer.headers })
}

/* ------------------------------------------------------ Loopback redirect */

interface Waiter {
  serverId: string
  /** The sign-in this waiter belongs to, so it cleans up only its own. */
  owner: AbortController
  resolve: (code: string) => void
  reject: (error: Error) => void
}

/** Sign-ins waiting for the browser, keyed by their OAuth `state`. */
const waiting = new Map<string, Waiter>()
/**
 * Sign-ins under way, from the click on. Most of a sign-in happens before the
 * browser opens (discovery, registration), so a cancel has to reach it there
 * too, and the listener must stay up for it even while nothing is waiting yet.
 */
const signingIn = new Map<string, AbortController>()
let listener: Server | null = null
let listening: Promise<void> | null = null

const redirect = new URL(MCP_OAUTH_REDIRECT_URI)

function page(title: string, detail: string): string {
  const escape = (text: string): string =>
    text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
  // Self-contained and theme-aware: this page is seen in whatever browser the
  // user has, with no access to the app's stylesheet.
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)} — Eaon</title>
<meta name="color-scheme" content="light dark">
<style>body{font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0}
main{max-width:420px;padding:24px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{margin:0;opacity:.7}</style></head>
<body><main><h1>${escape(title)}</h1><p>${escape(detail)}</p></main></body></html>`
}

function handleCallback(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', MCP_OAUTH_REDIRECT_URI)
  if (url.pathname !== redirect.pathname) {
    res.writeHead(404).end()
    return
  }
  const state = url.searchParams.get('state') ?? ''
  const waiter = waiting.get(state)
  const reply = (status: number, title: string, detail: string): void => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(title, detail))
  }
  // Without a matching state this is not a redirect we asked for — possibly a
  // forged one — so it is refused rather than guessed at.
  if (!waiter) {
    reply(400, 'Nothing to finish', 'This sign-in link has expired or was already used. Start again from Eaon.')
    return
  }
  waiting.delete(state)
  const error = url.searchParams.get('error')
  const code = url.searchParams.get('code')
  if (error || !code) {
    const detail = url.searchParams.get('error_description') ?? error ?? 'No authorization code was returned.'
    reply(400, 'Sign-in failed', detail)
    waiter.reject(new Error(detail === 'access_denied' ? 'Sign-in was cancelled in the browser.' : detail))
  } else {
    reply(200, 'You’re signed in', 'You can close this tab and go back to Eaon.')
    waiter.resolve(code)
  }
  closeListenerIfIdle()
}

/** Starts the loopback listener once, however many sign-ins ask for it at the same moment. */
function ensureListener(): Promise<void> {
  if (listener) return Promise.resolve()
  listening ??= new Promise<void>((resolve, reject) => {
    const server = createServer(handleCallback)
    server.once('error', (error: NodeJS.ErrnoException) => {
      listening = null
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(`Port ${redirect.port} is in use by another program, so the sign-in cannot finish. Close it and try again.`)
          : error
      )
    })
    server.listen(Number(redirect.port), redirect.hostname, () => {
      listener = server
      listening = null
      resolve()
    })
  })
  return listening
}

function closeListenerIfIdle(): void {
  if (waiting.size > 0 || signingIn.size > 0 || !listener) return
  listener.close()
  listener = null
}

/** Cancels a sign-in, whether it is still finding its way or already waiting on the browser. */
export function cancelSignIn(serverId: string): void {
  signingIn.get(serverId)?.abort()
  signingIn.delete(serverId)
  for (const [state, waiter] of waiting) {
    if (waiter.serverId !== serverId) continue
    waiting.delete(state)
    waiter.reject(new Error('Sign-in cancelled.'))
  }
  closeListenerIfIdle()
}

export function isSigningIn(serverId: string): boolean {
  return signingIn.has(serverId) || [...waiting.values()].some((w) => w.serverId === serverId)
}

/* ------------------------------------------------------------ The flow */

export interface SignInOptions {
  /** A client created by hand, for servers without Dynamic Client Registration. */
  client?: { clientId: string; clientSecret?: string }
  /** Headers the server needs on every request (catalog `extraHeaders`). */
  headers?: Record<string, string>
  /** How long to wait for the browser before giving up. */
  timeoutMs?: number
}

/**
 * Asks the server what it wants before the SDK does, the same way the
 * transport would on its first 401: the WWW-Authenticate header can name the
 * protected-resource metadata and the scope, and servers that publish their
 * metadata somewhere other than the well-known path only say so there.
 */
async function challenge(
  serverUrl: string,
  headers: Record<string, string>,
  cancelled: AbortSignal
): Promise<{ resourceMetadataUrl?: URL; scope?: string }> {
  try {
    const res = await fetch(serverUrl, {
      method: 'POST',
      signal: AbortSignal.any([AbortSignal.timeout(15_000), cancelled]),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'eaon-desktop', version: '0.1.0' } }
      })
    })
    await res.body?.cancel().catch(() => {})
    const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(res)
    return { resourceMetadataUrl, scope }
  } catch {
    // Discovery falls back to the well-known paths on its own.
    return {}
  }
}

/**
 * Runs the full browser sign-in for one server and stores the result. Resolves
 * once tokens are saved; the caller reconnects the server afterwards.
 */
export async function signIn(serverId: string, serverUrl: string, options: SignInOptions = {}): Promise<void> {
  cancelSignIn(serverId)
  const owner = new AbortController()
  signingIn.set(serverId, owner)
  const stopIfCancelled = (): void => {
    if (owner.signal.aborted) throw new Error('Sign-in cancelled.')
  }
  try {
    await ensureListener()
    stopIfCancelled()
    await authorize(serverId, serverUrl, options, owner, stopIfCancelled)
  } finally {
    if (signingIn.get(serverId) === owner) signingIn.delete(serverId)
    // Only this sign-in's own waiter: a newer one for the same server may already be under way.
    for (const [state, waiter] of waiting) {
      if (waiter.owner !== owner) continue
      waiting.delete(state)
      waiter.reject(new Error('Sign-in cancelled.'))
    }
    closeListenerIfIdle()
  }
}

async function authorize(
  serverId: string,
  serverUrl: string,
  options: SignInOptions,
  owner: AbortController,
  stopIfCancelled: () => void
): Promise<void> {
  // Filled in when the SDK hands over the authorization URL.
  const browser: { code?: Promise<string> } = {}
  const provider = new McpOAuthProvider(serverId, serverUrl, {
    interactive: true,
    openBrowser: async (url) => {
      // Cancelled while discovery or registration was still running: the
      // browser must not open for a sign-in the user already called off.
      stopIfCancelled()
      const state = url.searchParams.get('state') ?? ''
      browser.code = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(state)
          closeListenerIfIdle()
          reject(new Error('Timed out waiting for the browser sign-in.'))
        }, options.timeoutMs ?? 5 * 60_000)
        waiting.set(state, {
          serverId,
          owner,
          resolve: (code) => {
            clearTimeout(timer)
            resolve(code)
          },
          reject: (error) => {
            clearTimeout(timer)
            reject(error)
          }
        })
      })
      // Settled rejections are consumed below; this keeps an early one (a
      // cancel before we await) from surfacing as unhandled.
      browser.code.catch(() => {})
      // A server's metadata names this URL: only a web page is opened, never
      // a file: or another app's scheme.
      await openExternalSafely(url.href)
    }
  })

  provider.resetForSignIn(options.client)

  const { resourceMetadataUrl, scope } = await challenge(serverUrl, options.headers ?? {}, owner.signal)
  stopIfCancelled()
  try {
    const result = await auth(provider, { serverUrl, resourceMetadataUrl, scope })
    if (result === 'AUTHORIZED') return
    if (!browser.code) throw new Error('The server did not start a browser sign-in.')
    const code = await browser.code
    stopIfCancelled()
    const exchanged = await auth(provider, { serverUrl, resourceMetadataUrl, scope, authorizationCode: code })
    if (exchanged !== 'AUTHORIZED') throw new Error('The server did not issue a token.')
  } catch (error) {
    if (error instanceof Error && /does not support dynamic client registration/i.test(error.message)) {
      throw new ClientIdRequiredError()
    }
    throw error
  }
}

/**
 * Forgets a server's tokens, first asking the vendor to revoke them when it
 * advertises a revocation endpoint. Best effort: signing out locally must
 * work even when the vendor is unreachable. The client registration is kept
 * so signing back in does not register yet another client.
 */
export async function signOut(serverId: string, serverUrl: string): Promise<void> {
  cancelSignIn(serverId)
  const stored = readFor(serverId, serverUrl)
  const endpoint = (stored.discovery?.authorizationServerMetadata as { revocation_endpoint?: string } | undefined)
    ?.revocation_endpoint
  const token = stored.tokens?.refresh_token ?? stored.tokens?.access_token
  if (endpoint && token && stored.client) {
    const body = new URLSearchParams({ token, client_id: stored.client.client_id })
    if (stored.client.client_secret) body.set('client_secret', stored.client.client_secret)
    await fetch(endpoint, { method: 'POST', body, signal: AbortSignal.timeout(5000) }).catch(() => {})
  }
  write(serverId, { tokens: undefined, expiresAt: undefined, discovery: undefined })
}

/** Drops everything stored for a server, client registration included. */
export function forgetServer(serverId: string): void {
  cancelSignIn(serverId)
  cache.delete(serverId)
  secrets.set(vaultKey(serverId), '')
}

/** For tests: drops the in-memory cache so the next read goes to the vault. */
export function resetOAuthCache(): void {
  cache.clear()
}
