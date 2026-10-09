import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { GatewayModel } from '@shared/gateway'
import type { ChatToolPart } from '@shared/types'
import {
  REMOTE_BASE_PATH,
  REMOTE_FAILURE_WINDOW_MS,
  REMOTE_MAX_BODY,
  REMOTE_MAX_CHAT_BODY,
  REMOTE_MAX_FAILURES,
  REMOTE_PING_MS,
  type RemoteEvent,
  type RemoteStatus
} from '@shared/remote'
import type { WorkersHub } from '../features/workers/hub'
import { gatewayModels } from '../gateway/models'
import { serveChatCompletions } from '../gateway/openaiChat'
import { ApiError, errorBody, handleApi, type ApiResponse, type ErrorCode, type RemoteApiDeps } from './api'
import { EventTranslator } from './view'

/**
 * The remote API's HTTP server: Eaon's Workers, for a phone on the user's
 * network (docs/remote-api.md).
 *
 * Unlike the Local API Server this one listens on every interface, so the
 * rules are stricter. Every request, whichever route, needs the remote key
 * (compared in constant time; the Local API Server's key is not accepted). A
 * request with an `Origin` is a web page, which this is not for, and is
 * refused. Wrong keys are counted per address and turned away after ten in a
 * minute. No CORS headers are ever sent. The key is only ever read from the
 * Authorization header, so it never lands in a URL or a log.
 *
 * Routing and validation of `/remote/v1/*` are in `api.ts`; this file does
 * the sockets, the limits, the event stream and the two model routes.
 */

/** The Mac's models, for the phone's chat: what the Local API Server's `/v1` serves. */
export interface GatewayAccess {
  models: () => GatewayModel[]
  chat: (res: ServerResponse, body: Record<string, unknown>) => Promise<void>
}

export interface RemoteServerOptions {
  /** The current key. Read for every request, so a reset takes effect at once. */
  token: () => string
  api: RemoteApiDeps
  hub: WorkersHub
  gateway?: GatewayAccess
  /** How often an idle event stream is pinged. */
  pingMs?: number
  maxBody?: number
  maxChatBody?: number
  maxFailures?: number
  failureWindowMs?: number
  now?: () => number
  onStatus?: (status: RemoteStatus) => void
}

const defaultGateway: GatewayAccess = { models: gatewayModels, chat: serveChatCompletions }

/** What an early 413 will read and throw away before giving up on the connection. */
const DRAIN_LIMIT = 4 * 1024 * 1024
/** A phone that stopped reading would otherwise make us hold its stream's backlog forever. */
const MAX_BACKLOG = 4 * 1024 * 1024

const digest = (text: string): Buffer => createHash('sha256').update(text).digest()

/** Constant time, and the same for every length: both sides are hashed first. */
export function sameKey(sent: string, expected: string): boolean {
  if (!expected) return false
  return timingSafeEqual(digest(sent), digest(expected))
}

function sentKey(req: IncomingMessage): string | null {
  const header = req.headers.authorization
  return typeof header === 'string' ? (/^Bearer\s+(\S+)\s*$/i.exec(header)?.[1] ?? null) : null
}

/** The address a request came from, as `::ffff:192.168.1.5` or `192.168.1.5`. */
function peer(req: IncomingMessage): string {
  return (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/i, '')
}

function listenError(error: NodeJS.ErrnoException, port: number): string {
  if (error.code === 'EADDRINUSE') return `Port ${port} is already in use by another app. Pick a different one.`
  if (error.code === 'EACCES') return `Eaon isn't allowed to listen on port ${port}. Pick one above 1024.`
  if (error.code === 'ERR_SOCKET_BAD_PORT') return `${port} is not a valid port.`
  return error.message
}

export class RemoteServer {
  private server: Server | null = null
  private current: RemoteStatus = { running: false, port: 0 }
  /** Every response that stays open: event streams, and chat completions while they run. */
  private readonly live = new Set<ServerResponse>()
  private readonly streams = new Set<ServerResponse>()
  /** When each address last sent a wrong key. */
  private readonly failures = new Map<string, number[]>()
  private readonly translator: EventTranslator
  private unsubscribe: (() => void) | null = null
  /** The last `workers` event sent, so a commit that changed nothing a phone sees sends nothing. */
  private lastWorkers = ''

  constructor(private readonly options: RemoteServerOptions) {
    this.translator = new EventTranslator({
      list: () => options.api.engine.list(),
      findTool: (workerId, messageId, toolId) => {
        try {
          const message = options.api.engine.getThread(workerId).messages.find((m) => m.id === messageId)
          return message?.parts.find((p): p is ChatToolPart => p.type === 'tool' && p.id === toolId)
        } catch {
          return undefined
        }
      },
      modelLabel: options.api.modelLabel,
      now: options.api.now,
      home: options.api.home
    })
  }

  status(): RemoteStatus {
    return this.current
  }

  /** The port it is listening on (which is what was asked for, unless that was 0). */
  get port(): number {
    return this.current.port
  }

  /** How many phones have an event stream open. */
  get streamCount(): number {
    return this.streams.size
  }

  private publish(status: RemoteStatus): void {
    this.current = status
    this.options.onStatus?.(status)
  }

  start(port: number): Promise<RemoteStatus> {
    if (this.server) return Promise.resolve(this.current)
    return new Promise((resolve) => {
      const next = createServer((req, res) => {
        void this.handle(req, res).catch((error) => {
          // Only the message: a stack can name paths, and nothing here needs it.
          console.error('[remote] a request failed:', error instanceof Error ? error.message : 'unknown error')
          this.send(res, 500, errorBody('server_error', 'Something went wrong in Eaon.'))
        })
      })
      const fail = (error: NodeJS.ErrnoException): void => {
        this.server = null
        this.publish({ running: false, port, error: listenError(error, port) })
        resolve(this.current)
      }
      next.once('error', fail)
      try {
        // Every interface: the phone is another device. The key is the lock.
        next.listen(port, '0.0.0.0', () => {
          next.off('error', fail)
          // A later error (the socket dying) must not crash the app.
          next.on('error', (error) => console.error('[remote] server error:', error.message))
          this.server = next
          this.unsubscribe = this.options.hub.subscribe({
            changed: (workers) => this.broadcastWorkers(this.translator.workers(workers)),
            message: (workerId, message) => {
              const event = this.translator.message(workerId, message)
              if (event) this.broadcast(event)
            },
            event: (workerId, event) => {
              for (const out of this.translator.stream(workerId, event)) this.broadcast(out)
            }
          })
          this.publish({ running: true, port: (next.address() as { port: number }).port })
          resolve(this.current)
        })
      } catch (error) {
        // A port out of range throws here instead of emitting 'error'.
        fail(error as NodeJS.ErrnoException)
      }
    })
  }

  /** Stops listening and hangs up on every client, event streams included. */
  async stop(): Promise<RemoteStatus> {
    this.unsubscribe?.()
    this.unsubscribe = null
    const closing = this.server
    this.server = null
    this.disconnect()
    if (closing) {
      const closed = new Promise<void>((resolve) => closing.close(() => resolve()))
      closing.closeAllConnections()
      await closed
    }
    this.publish({ running: false, port: this.current.port })
    return this.current
  }

  /** Ends every open stream and connection (Reset key: every phone has to pair again). */
  disconnect(): void {
    for (const res of [...this.live]) res.destroy()
    this.live.clear()
    this.streams.clear()
    this.server?.closeAllConnections()
  }

  /* ----------------------------------------------------------------- requests */

  private send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    if (res.headersSent) {
      res.end()
      return
    }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers })
    res.end(JSON.stringify(body))
  }

  private fail(res: ServerResponse, status: number, code: ErrorCode, message: string, headers: Record<string, string> = {}): void {
    this.send(res, status, errorBody(code, message), headers)
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  /** Seconds until this address may try again; 0 when it may. */
  private blockedFor(ip: string): number {
    const window = this.options.failureWindowMs ?? REMOTE_FAILURE_WINDOW_MS
    const now = this.now()
    const recent = (this.failures.get(ip) ?? []).filter((at) => at > now - window)
    if (recent.length === 0) {
      this.failures.delete(ip)
      return 0
    }
    this.failures.set(ip, recent)
    if (recent.length < (this.options.maxFailures ?? REMOTE_MAX_FAILURES)) return 0
    return Math.max(1, Math.ceil((recent[0] + window - now) / 1000))
  }

  private noteFailure(ip: string): void {
    const list = this.failures.get(ip) ?? []
    list.push(this.now())
    this.failures.set(ip, list)
    // Addresses that stopped trying fall out here rather than piling up.
    if (this.failures.size > 1000) {
      const window = this.options.failureWindowMs ?? REMOTE_FAILURE_WINDOW_MS
      for (const [address, times] of this.failures) if (times[times.length - 1] <= this.now() - window) this.failures.delete(address)
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // A web page: not who this is for, whatever key it holds.
    if (req.headers.origin !== undefined) {
      this.fail(res, 403, 'forbidden', 'Eaon’s remote API is for the Eaon app, not web pages.')
      return
    }

    const ip = peer(req)
    const wait = this.blockedFor(ip)
    if (wait > 0) {
      this.fail(res, 429, 'rate_limited', 'Too many wrong keys. Try again in a minute.', { 'Retry-After': String(wait) })
      return
    }
    const key = sentKey(req)
    if (key === null || !sameKey(key, this.options.token())) {
      this.noteFailure(ip)
      this.fail(res, 401, 'unauthorized', 'The key is missing or wrong. Pair this device again from Eaon → Settings → Remote devices.', { 'WWW-Authenticate': 'Bearer' })
      return
    }

    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://eaon.local')
    } catch {
      this.fail(res, 400, 'invalid_request', 'That address is not valid.')
      return
    }
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const method = req.method ?? 'GET'

    if (path === `${REMOTE_BASE_PATH}/events` && method === 'GET') {
      this.openStream(res)
      return
    }

    if (path === '/v1/models' && method === 'GET') {
      const created = Math.floor(this.now() / 1000)
      const models = (this.options.gateway ?? defaultGateway).models()
      this.send(res, 200, { object: 'list', data: models.map((m) => ({ id: m.id, object: 'model', created, owned_by: m.provider })) })
      return
    }

    if (path === '/v1/chat/completions' && method === 'POST') {
      const read = await this.readJson(req, res, this.options.maxChatBody ?? REMOTE_MAX_CHAT_BODY)
      if (!read) return
      const body = read.value
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        this.fail(res, 400, 'invalid_request', 'The body must be a JSON object.')
        return
      }
      // Dropped with the key: Reset key must not leave a stream running on the old one.
      this.live.add(res)
      res.once('close', () => this.live.delete(res))
      await (this.options.gateway ?? defaultGateway).chat(res, body as Record<string, unknown>)
      return
    }

    if (!path.startsWith(`${REMOTE_BASE_PATH}/`)) {
      this.fail(res, 404, 'not_found', `There is no ${method} ${path}.`)
      return
    }

    let body: unknown
    if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
      const read = await this.readJson(req, res, this.options.maxBody ?? REMOTE_MAX_BODY)
      if (!read) return
      body = read.value
    }
    let result: ApiResponse
    try {
      result = await handleApi(this.options.api, { method, path, query: url.searchParams, body })
    } catch (error) {
      if (error instanceof ApiError) {
        this.fail(res, error.status, error.code, error.message)
        return
      }
      throw error
    }
    this.send(res, result.status, result.body)
  }

  /**
   * The JSON body of a request (`undefined` when there is none), or null once
   * the error has been sent: too large, or not JSON.
   */
  private async readJson(req: IncomingMessage, res: ServerResponse, limit: number): Promise<{ value: unknown } | null> {
    let raw: Buffer
    try {
      raw = await readBody(req, limit)
    } catch (error) {
      if (error instanceof ApiError) {
        this.fail(res, error.status, error.code, error.message)
        return null
      }
      throw error
    }
    if (raw.length === 0) return { value: undefined }
    try {
      return { value: JSON.parse(raw.toString('utf8')) as unknown }
    } catch {
      this.fail(res, 400, 'invalid_request', 'The body is not valid JSON.')
      return null
    }
  }

  /* ------------------------------------------------------------ event stream */

  private openStream(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // A proxy in front (Tailscale funnel, nginx) must not hold events back.
      'X-Accel-Buffering': 'no'
    })
    // Nagle's delay would hold back the small writes a stream is made of.
    res.socket?.setNoDelay(true)
    res.socket?.setKeepAlive(true)
    this.live.add(res)
    this.streams.add(res)
    const ping = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n')
    }, this.options.pingMs ?? REMOTE_PING_MS)
    ping.unref?.()
    res.once('close', () => {
      clearInterval(ping)
      this.live.delete(res)
      this.streams.delete(res)
    })
    const snapshot = this.translator.workers(this.options.api.engine.list())
    this.lastWorkers = JSON.stringify(snapshot.data)
    this.write(res, snapshot)
  }

  private write(res: ServerResponse, event: RemoteEvent): void {
    if (res.writableEnded || res.destroyed) return
    if (res.writableLength > MAX_BACKLOG) {
      res.destroy()
      return
    }
    res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`)
  }

  private broadcast(event: RemoteEvent): void {
    for (const res of this.streams) this.write(res, event)
  }

  private broadcastWorkers(event: RemoteEvent): void {
    const json = JSON.stringify(event.data)
    if (json === this.lastWorkers) return
    this.lastWorkers = json
    this.broadcast(event)
  }
}

/**
 * The body, up to `limit` bytes. One that is larger (it says so, or turns out
 * to be) is read and thrown away, up to a point, before it is refused: a client
 * that is still writing when the answer comes back (and one that asked for
 * `Connection: close` has the socket closed on it the moment we answer) never
 * sees the 413, only a reset. Past DRAIN_LIMIT it is refused at once.
 */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const tooLarge = (): ApiError => new ApiError(413, 'too_large', `That request is too large. The limit is ${Math.round(limit / 1024)} KB.`)
    const declared = Number(req.headers['content-length'])
    const chunks: Buffer[] = []
    let size = 0
    let oversize = Number.isFinite(declared) && declared > limit
    let settled = false
    const settle = (done: () => void): void => {
      if (settled) return
      settled = true
      done()
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) oversize = true
      if (oversize) {
        chunks.length = 0
        if (size > DRAIN_LIMIT) settle(() => reject(tooLarge()))
        return
      }
      chunks.push(chunk)
    })
    req.once('end', () => settle(() => (oversize ? reject(tooLarge()) : resolve(Buffer.concat(chunks)))))
    req.once('error', (error) => settle(() => reject(error)))
    req.once('close', () => {
      if (!req.complete) settle(() => reject(oversize ? tooLarge() : new Error('The client went away.')))
    })
  })
}
