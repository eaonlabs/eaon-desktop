import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { secrets } from '../../secrets'

/**
 * Pieces every browser sign-in shares: PKCE, JWT claims, a one-shot loopback
 * callback server, token storage in the encrypted vault, and a refresh guard.
 */

const base64url = (bytes: Buffer): string => bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function pkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export const randomState = (): string => randomBytes(16).toString('hex')

/** The payload of a JWT, or null. Signatures are not checked: the token came straight from the issuer over TLS. */
export function jwtClaims(token: string | undefined): Record<string, unknown> | null {
  const part = token?.split('.')[1]
  if (!part) return null
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/* ---------------------------------------------------------- token vault */

/**
 * Tokens live in the same encrypted vault as API keys, under a key no
 * provider id can collide with, and are cached in memory so a request does
 * not decrypt the vault every time it asks for credentials.
 */
export function tokenStore<T>(flowId: string): { get(): T | null; set(value: T | null): void } {
  const key = `oauth::${flowId}`
  let cache: { value: T | null } | null = null
  return {
    get() {
      if (!cache) {
        const raw = secrets.get(key)
        let value: T | null = null
        try {
          value = raw ? (JSON.parse(raw) as T) : null
        } catch {
          value = null
        }
        cache = { value }
      }
      return cache.value
    },
    set(value) {
      cache = { value }
      secrets.set(key, value ? JSON.stringify(value) : '')
    }
  }
}

/**
 * Runs `refresh` at most once at a time. Refresh tokens are single-use on
 * OpenAI's side: two requests refreshing concurrently would each spend the
 * same token, the second would fail, and the user would be signed out.
 */
export function singleFlight<T>(refresh: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null
  return () => {
    running ??= refresh().finally(() => {
      running = null
    })
    return running
  }
}

/* ------------------------------------------------------ loopback server */

const page = (title: string, body: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: #111113; color: #ededed; }
  main { max-width: 440px; padding: 24px; text-align: center; }
  h1 { font-size: 22px; font-weight: 600; margin: 0 0 8px; }
  p { margin: 0; color: #a1a1aa; }
</style></head>
<body><main><h1>${title}</h1><p>${body}</p></main></body></html>`

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)

export interface LoopbackServer {
  /** The redirect URI the provider sends the browser back to. */
  redirectUri: string
  /** Resolves with the authorization code, or null once `cancel` is called. */
  code: Promise<string | null>
  /**
   * Every query parameter of the redirect that delivered the code — some
   * providers return more than the code (OpenAI's issued `client_id`).
   */
  params(): URLSearchParams | null
  cancel(): void
  close(): void
}

/**
 * Listens once for the provider's redirect. `port` 0 picks a free port
 * (OpenRouter); Codex's client id is registered for exactly
 * `localhost:1455/auth/callback`, so that one is fixed.
 */
export async function startLoopback(options: {
  port: number
  path: string
  /** Host written into the redirect URI; the server itself listens on 127.0.0.1. */
  redirectHost: string
  state?: string
  service: string
}): Promise<LoopbackServer> {
  let settle: (code: string | null) => void = () => {}
  let received: URLSearchParams | null = null
  const code = new Promise<string | null>((resolve) => {
    let settled = false
    settle = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
  })

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const reply = (status: number, title: string, body: string): void => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(page(title, body))
    }
    if (url.pathname !== options.path) return reply(404, 'Not found', 'This is not the sign-in callback.')
    const error = url.searchParams.get('error')
    if (error) {
      reply(400, 'Sign-in was cancelled', escapeHtml(url.searchParams.get('error_description') ?? error))
      settle(null)
      return
    }
    if (options.state && url.searchParams.get('state') !== options.state) {
      return reply(400, 'Sign-in failed', 'The response did not match this sign-in attempt. Start again from Eaon.')
    }
    const value = url.searchParams.get('code')
    if (!value) return reply(400, 'Sign-in failed', 'No authorization code came back.')
    reply(200, `Signed in to ${escapeHtml(options.service)}`, 'You can close this tab and return to Eaon.')
    received = url.searchParams
    settle(value)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) =>
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(`Port ${options.port} is in use — another app (often a Codex CLI sign-in) is waiting on it. Close it and try again.`)
          : error
      )
    )
    server.listen(options.port, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as { port: number }).port

  return {
    redirectUri: `http://${options.redirectHost}:${port}${options.path}`,
    code,
    params: () => received,
    cancel: () => settle(null),
    close: () => server.close()
  }
}

/** Pulls an authorization code (and state) out of a pasted redirect URL or bare code. */
export function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim()
  if (!value) return {}
  try {
    const url = new URL(value)
    return { code: url.searchParams.get('code') ?? undefined, state: url.searchParams.get('state') ?? undefined }
  } catch {
    /* not a URL */
  }
  if (value.includes('code=')) {
    const params = new URLSearchParams(value.replace(/^[?#]/, ''))
    return { code: params.get('code') ?? undefined, state: params.get('state') ?? undefined }
  }
  if (value.includes('#')) {
    const [code, state] = value.split('#', 2)
    return { code, state }
  }
  return { code: value }
}

/** Resolves after `ms`, or rejects as soon as `signal` aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Sign-in cancelled'))
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('Sign-in cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
