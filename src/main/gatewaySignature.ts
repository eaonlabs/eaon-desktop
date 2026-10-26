import { createHash, createHmac, randomBytes } from 'node:crypto'
import { app } from 'electron'

/**
 * Signed requests to Eaon's gateway. Set to "Eaon apps only" on its dashboard
 * (Access), the gateway answers nothing but requests signed with an Eaon
 * app's secret; open, it still checks a signature that comes with one. Every
 * request main makes to it is signed here, through providerFetch: Eaon Lite,
 * Eaon Event, their model lists and code redemption, from the app, the Eaon
 * CLI and the worker computer alike.
 *
 * The scheme is the gateway's own (openai-gateway/app-auth.js): an
 * HMAC-SHA256, with the app's secret, of the time, a one-use nonce, the
 * method, the path with its query and a SHA-256 of the exact body. The
 * gateway takes it once, within five minutes.
 *
 * The app's ID and secret come from the dashboard (Access → Eaon apps) and
 * are put in at build time from EAON_GATEWAY_APP_ID and
 * EAON_GATEWAY_APP_SECRET (electron.vite.config.ts, scripts/build-host.mjs,
 * scripts/build-cli.mjs), never kept in this repository. A build without them
 * signs nothing, which an open gateway still answers. The secret can be dug
 * out of a shipped app: the signature stops casual use of the gateway from
 * outside Eaon, not a determined person.
 */

declare const __EAON_GATEWAY_APP_ID__: string | undefined
declare const __EAON_GATEWAY_APP_SECRET__: string | undefined

interface GatewayApp {
  id: string
  secret: string
}

let credentials: GatewayApp | null = (() => {
  const id = typeof __EAON_GATEWAY_APP_ID__ === 'string' ? __EAON_GATEWAY_APP_ID__ : ''
  const secret = typeof __EAON_GATEWAY_APP_SECRET__ === 'string' ? __EAON_GATEWAY_APP_SECRET__ : ''
  return id && secret ? { id, secret } : null
})()

/** Whether this build signs its requests to the gateway. */
export const signsGatewayRequests = (): boolean => credentials !== null

/** Tests sign with their own app, or with none. */
export function setGatewayAppForTests(next: GatewayApp | null): void {
  credentials = next
  skew = 0
}

/**
 * Seconds the gateway's clock is ahead of this computer's. A signature is
 * good for five minutes of the gateway's time, and a computer's clock can be
 * further out than that: its answers' Date header says by how much.
 */
let skew = 0

/** Reads the gateway's clock off one of its answers. Within a minute counts as agreeing. */
export function noteGatewayClock(response: Response, receivedAt = Date.now()): void {
  const date = Date.parse(response.headers.get('date') ?? '')
  if (!Number.isFinite(date)) return
  const ahead = Math.round((date - receivedAt) / 1000)
  skew = Math.abs(ahead) >= 60 ? ahead : 0
}

let version: string | null | undefined
const appVersion = (): string | null => {
  if (version === undefined) {
    try {
      version = app.getVersion() || null
    } catch {
      version = null
    }
  }
  return version
}

/** The headers that sign one request, or none when this build has no app to sign as. */
export function gatewaySignature(method: string, url: string, body: Uint8Array, now = Date.now()): Record<string, string> {
  if (!credentials) return {}
  const { pathname, search } = new URL(url)
  const timestamp = String(Math.floor(now / 1000) + skew)
  const nonce = randomBytes(18).toString('base64url')
  const bodyHash = createHash('sha256').update(body).digest('base64url')
  const message = ['eaon-v1', timestamp, nonce, method.toUpperCase(), `${pathname}${search}`, bodyHash].join('\n')
  const signature = createHmac('sha256', credentials.secret).update(message).digest('base64url')
  const shown = appVersion()
  return {
    'X-Eaon-App': credentials.id,
    'X-Eaon-Timestamp': timestamp,
    'X-Eaon-Nonce': nonce,
    'X-Eaon-Signature': `v1=${signature}`,
    ...(shown ? { 'X-Eaon-App-Version': shown } : {})
  }
}

/**
 * A request to the gateway, signed: its headers with the signature added, and
 * its body. A body that isn't text or bytes already (a form, a stream) is
 * made into bytes once, so what was signed is exactly what gets sent, a
 * form's boundary included.
 */
export async function signedRequest(url: string, init: Pick<RequestInit, 'method' | 'body' | 'headers'>): Promise<Pick<RequestInit, 'body' | 'headers'>> {
  if (!credentials) return { body: init.body, headers: init.headers }
  const method = (init.method ?? 'GET').toUpperCase()
  const raw = init.body
  let headers = new Headers(init.headers)
  let body: RequestInit['body'] = raw
  let bytes: Uint8Array
  if (raw == null || method === 'GET' || method === 'HEAD') bytes = new Uint8Array(0)
  else if (typeof raw === 'string') bytes = new TextEncoder().encode(raw)
  else if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw)
  else if (ArrayBuffer.isView(raw)) bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  else {
    const request = new Request(url, { method, body: raw, headers, duplex: 'half' } as RequestInit)
    bytes = new Uint8Array(await request.arrayBuffer())
    headers = new Headers(request.headers)
    body = bytes
  }
  for (const [name, value] of Object.entries(gatewaySignature(method, url, bytes))) headers.set(name, value)
  return { body, headers }
}

/** Whether the gateway turned a request down for a signature older than its five minutes (this computer's clock). */
export async function signatureExpired(response: Response): Promise<boolean> {
  if (response.status !== 401 || !credentials) return false
  try {
    return /signature has expired/i.test(await response.clone().text())
  } catch {
    return false
  }
}
