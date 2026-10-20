import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import { WORKER_HOST_PATH } from '@shared/workerHost'

/**
 * The link between Eaon Desktop and a worker computer: a WebSocket that is
 * authenticated and encrypted end to end with the secret the two share
 * (made by the desktop at install time and carried to the host over SSH, or
 * once in the install command).
 *
 * The secret never crosses the wire. Each side proves it holds it with an
 * HMAC over two fresh nonces, one from each side, so a recorded handshake is
 * useless later; the host proves itself too, so the desktop never sends keys
 * to an impostor. Both nonces and the secret derive one AES-256-GCM key per
 * direction, and every frame carries a counter that must go up by exactly one,
 * so frames can't be read, changed, replayed or reordered by anyone else on
 * the network. That matters because the desktop sends the host the user's
 * API keys, and the network is often a home Wi-Fi.
 *
 * Over the channel runs a small RPC: calls with replies, and events either
 * side can push. Large things (the host app, files for a worker) go in
 * chunks, so no frame is big.
 */

export const newHostSecret = (): string => randomBytes(32).toString('base64url')

const PROTOCOL = 'eaon-host-1'
const HANDSHAKE_MS = 10_000
/** Frames are capped well above the largest chunk (512 KB of file, base64) and the largest list. */
const MAX_FRAME = 24 * 1024 * 1024
/** A ping goes out this often; two missed and the connection is dropped. */
const PING_MS = 15_000
const FAILURES_ALLOWED = 10
const FAILURE_WINDOW_MS = 60_000

const mac = (secret: Buffer, role: 'client' | 'server', serverNonce: Buffer, clientNonce: Buffer): Buffer =>
  createHmac('sha256', secret).update(`${PROTOCOL} ${role}`).update(serverNonce).update(clientNonce).digest()

const equal = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b)

function sessionKeys(secret: Buffer, serverNonce: Buffer, clientNonce: Buffer): { toServer: Buffer; toClient: Buffer } {
  const material = Buffer.from(hkdfSync('sha256', secret, Buffer.concat([serverNonce, clientNonce]), PROTOCOL, 64))
  return { toServer: material.subarray(0, 32), toClient: material.subarray(32, 64) }
}

function secretBytes(secret: string): Buffer {
  const bytes = Buffer.from(secret, 'base64url')
  if (bytes.length < 16) throw new Error('The link secret is too short.')
  return bytes
}

/** Seals and opens frames for one direction each, with a counter that must climb by one. */
class Sealer {
  private sent = 0n
  private received = 0n
  constructor(
    private readonly sendKey: Buffer,
    private readonly receiveKey: Buffer
  ) {}

  seal(plain: Buffer): Buffer {
    const counter = Buffer.alloc(8)
    counter.writeBigUInt64BE(this.sent++)
    const iv = Buffer.concat([Buffer.alloc(4), counter])
    const cipher = createCipheriv('aes-256-gcm', this.sendKey, iv)
    const body = Buffer.concat([cipher.update(plain), cipher.final()])
    return Buffer.concat([counter, body, cipher.getAuthTag()])
  }

  open(frame: Buffer): Buffer {
    if (frame.length < 8 + 16) throw new Error('short frame')
    const counter = frame.readBigUInt64BE(0)
    if (counter !== this.received) throw new Error('frame out of order')
    const iv = Buffer.concat([Buffer.alloc(4), frame.subarray(0, 8)])
    const decipher = createDecipheriv('aes-256-gcm', this.receiveKey, iv)
    decipher.setAuthTag(frame.subarray(frame.length - 16))
    const plain = Buffer.concat([decipher.update(frame.subarray(8, frame.length - 16)), decipher.final()])
    this.received++
    return plain
  }
}

const toBuffer = (data: RawData): Buffer => (Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer))

type Message =
  | { t: 'call'; id: number; method: string; params: unknown }
  | { t: 'reply'; id: number; ok: true; value: unknown }
  | { t: 'reply'; id: number; ok: false; error: string }
  | { t: 'event'; name: string; data: unknown }

export type CallHandler = (method: string, params: unknown) => unknown
export type EventHandler = (name: string, data: unknown) => void

/** One side of an authenticated link: calls, replies and events, all sealed. */
export class Peer {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> | null }>()
  private callHandler: CallHandler = (method) => {
    throw new Error(`${method} isn't available.`)
  }
  private readonly eventHandlers = new Set<EventHandler>()
  private readonly closeHandlers = new Set<(reason: string) => void>()
  private closed = false
  private pinger: ReturnType<typeof setInterval> | null = null
  private alive = true

  constructor(
    private readonly socket: WebSocket,
    private readonly sealer: Sealer,
    /** The client pings; the host only answers. */
    ping: boolean
  ) {
    socket.on('message', (data) => this.receive(toBuffer(data)))
    socket.on('close', () => this.finish('closed'))
    socket.on('error', (error) => this.finish(error.message))
    socket.on('pong', () => (this.alive = true))
    if (ping) {
      this.pinger = setInterval(() => {
        if (!this.alive) {
          socket.terminate()
          this.finish('no answer')
          return
        }
        this.alive = false
        try {
          socket.ping()
        } catch {
          /* closing */
        }
      }, PING_MS)
      this.pinger.unref?.()
    }
  }

  get isOpen(): boolean {
    return !this.closed && this.socket.readyState === WebSocket.OPEN
  }

  /** Where the other end connected from (host side). */
  remoteAddress: string | null = null

  handle(handler: CallHandler): void {
    this.callHandler = handler
  }

  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  onClose(handler: (reason: string) => void): () => void {
    if (this.closed) handler('closed')
    else this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  call<T = unknown>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    if (!this.isOpen) return Promise.reject(new Error('The worker computer isn’t connected.'))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id)
              reject(new Error('The worker computer didn’t answer in time.'))
            }, timeoutMs)
          : null
      timer?.unref?.()
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      this.write({ t: 'call', id, method, params: params ?? null })
    })
  }

  emit(name: string, data: unknown): void {
    if (this.isOpen) this.write({ t: 'event', name, data })
  }

  close(): void {
    try {
      this.socket.close(1000)
    } catch {
      /* already gone */
    }
    this.finish('closed')
  }

  private write(message: Message): void {
    try {
      this.socket.send(this.sealer.seal(Buffer.from(JSON.stringify(message), 'utf8')))
    } catch (error) {
      this.finish(error instanceof Error ? error.message : String(error))
    }
  }

  private receive(frame: Buffer): void {
    let message: Message
    try {
      message = JSON.parse(this.sealer.open(frame).toString('utf8')) as Message
    } catch {
      // Anything that doesn't open is someone else's frame: end the link rather than guess.
      this.socket.terminate()
      this.finish('a frame failed to open')
      return
    }
    if (message.t === 'reply') {
      const waiting = this.pending.get(message.id)
      if (!waiting) return
      this.pending.delete(message.id)
      if (waiting.timer) clearTimeout(waiting.timer)
      if (message.ok) waiting.resolve(message.value)
      else waiting.reject(new Error(message.error))
    } else if (message.t === 'event') {
      for (const handler of this.eventHandlers) {
        try {
          handler(message.name, message.data)
        } catch (error) {
          console.error('[worker-host] event handler failed:', error)
        }
      }
    } else if (message.t === 'call') {
      const { id } = message
      void (async () => {
        try {
          const value = await this.callHandler(message.method, message.params)
          this.write({ t: 'reply', id, ok: true, value: value === undefined ? null : value })
        } catch (error) {
          this.write({ t: 'reply', id, ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      })()
    }
  }

  private finish(reason: string): void {
    if (this.closed) return
    this.closed = true
    if (this.pinger) clearInterval(this.pinger)
    for (const waiting of this.pending.values()) {
      if (waiting.timer) clearTimeout(waiting.timer)
      waiting.reject(new Error('The connection to the worker computer closed.'))
    }
    this.pending.clear()
    for (const handler of this.closeHandlers) handler(reason)
    this.closeHandlers.clear()
  }
}

/* ------------------------------------------------------------ the host */

export interface LinkServerOptions {
  port: number
  host?: string
  /** Read on every connection, so a new secret takes effect at once. */
  secret: () => string
  onPeer: (peer: Peer) => void
}

export interface LinkServer {
  port: number
  close: () => Promise<void>
}

/** Listens for the desktop. Only a client that proves it holds the secret gets a Peer. */
export function listen(options: LinkServerOptions): Promise<LinkServer> {
  const failures = new Map<string, number[]>()
  const wss = new WebSocketServer({ port: options.port, host: options.host, path: WORKER_HOST_PATH, maxPayload: MAX_FRAME })

  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    const address = request.socket.remoteAddress ?? 'unknown'
    const now = Date.now()
    const recent = (failures.get(address) ?? []).filter((at) => now - at < FAILURE_WINDOW_MS)
    failures.set(address, recent)
    // Pages in a browser can open WebSockets anywhere; only the app may talk to the host.
    if (request.headers.origin || recent.length >= FAILURES_ALLOWED) {
      socket.close(1008)
      return
    }
    const serverNonce = randomBytes(32)
    const timer = setTimeout(() => socket.terminate(), HANDSHAKE_MS)
    socket.send(JSON.stringify({ t: 'hello', v: PROTOCOL, nonce: serverNonce.toString('base64') }))
    socket.once('message', (data) => {
      clearTimeout(timer)
      try {
        const auth = JSON.parse(toBuffer(data).toString('utf8')) as { t?: string; nonce?: string; mac?: string }
        const clientNonce = Buffer.from(String(auth.nonce ?? ''), 'base64')
        const secret = secretBytes(options.secret())
        if (auth.t !== 'auth' || clientNonce.length !== 32 || !equal(Buffer.from(String(auth.mac ?? ''), 'base64'), mac(secret, 'client', serverNonce, clientNonce))) {
          throw new Error('denied')
        }
        socket.send(JSON.stringify({ t: 'ok', mac: mac(secret, 'server', serverNonce, clientNonce).toString('base64') }))
        const keys = sessionKeys(secret, serverNonce, clientNonce)
        const peer = new Peer(socket, new Sealer(keys.toClient, keys.toServer), false)
        peer.remoteAddress = address.replace(/^::ffff:/, '')
        options.onPeer(peer)
      } catch {
        failures.get(address)?.push(Date.now())
        socket.close(1008)
      }
    })
  })

  return new Promise((resolve, reject) => {
    wss.once('error', reject)
    wss.once('listening', () => {
      wss.off('error', reject)
      wss.on('error', (error) => console.error('[worker-host] server error:', error.message))
      const port = (wss.address() as { port: number }).port
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            for (const client of wss.clients) client.terminate()
            wss.close(() => done())
          })
      })
    })
  })
}

/* ---------------------------------------------------------- the desktop */

export interface ConnectOptions {
  address: string
  port: number
  secret: string
  timeoutMs?: number
}

const urlHost = (address: string): string => (address.includes(':') && !address.startsWith('[') ? `[${address}]` : address)

/** Connects to a host and proves both sides hold the secret. Rejects with something a person can read. */
export function connect(options: ConnectOptions): Promise<Peer> {
  const secret = secretBytes(options.secret)
  const url = `ws://${urlHost(options.address)}:${options.port}${WORKER_HOST_PATH}`
  return new Promise<Peer>((resolve, reject) => {
    const socket = new WebSocket(url, { maxPayload: MAX_FRAME, handshakeTimeout: options.timeoutMs ?? HANDSHAKE_MS })
    let settled = false
    const fail = (message: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.terminate()
      reject(new Error(message))
    }
    // A firewall that drops what it doesn't allow looks like this: the computer
    // is there (SSH works, it pings) but the host's port never answers at all.
    const silent = `Nothing answered on port ${options.port} at ${options.address}. If that computer is on, a firewall on it is probably blocking the port: run \`sudo ufw allow ${options.port}/tcp\` there, or install the host app again, which opens it.`
    let opened = false
    socket.once('open', () => (opened = true))
    const timer = setTimeout(() => fail(opened ? 'The worker computer didn’t answer.' : silent), options.timeoutMs ?? HANDSHAKE_MS)
    let clientNonce: Buffer | null = null
    let serverNonce: Buffer | null = null
    socket.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code
      fail(
        code === 'ECONNREFUSED'
          ? 'Nothing is listening on the worker computer. Is the host app running?'
          : code === 'EHOSTUNREACH' || code === 'ENETUNREACH'
            ? 'The worker computer can’t be reached. Is it on and on this network?'
            : code === 'ETIMEDOUT' || (!opened && /timed out/i.test(error.message))
              ? silent
              : code === 'ENOTFOUND'
                ? `No computer called ${options.address} was found.`
                : error.message
      )
    })
    socket.on('close', (code) => fail(code === 1008 ? 'The worker computer turned the link down: the link key doesn’t match.' : 'The worker computer closed the connection.'))
    const onMessage = (data: RawData): void => {
      try {
        const message = JSON.parse(toBuffer(data).toString('utf8')) as { t?: string; v?: string; nonce?: string; mac?: string }
        if (message.t === 'hello' && !serverNonce) {
          if (message.v !== PROTOCOL) return fail('The worker computer runs a version of the host app this Eaon can’t talk to.')
          serverNonce = Buffer.from(String(message.nonce ?? ''), 'base64')
          if (serverNonce.length !== 32) return fail('The worker computer sent something unexpected.')
          clientNonce = randomBytes(32)
          socket.send(JSON.stringify({ t: 'auth', nonce: clientNonce.toString('base64'), mac: mac(secret, 'client', serverNonce, clientNonce).toString('base64') }))
        } else if (message.t === 'ok' && serverNonce && clientNonce) {
          if (!equal(Buffer.from(String(message.mac ?? ''), 'base64'), mac(secret, 'server', serverNonce, clientNonce))) {
            return fail('The computer at that address isn’t the worker computer this Eaon linked.')
          }
          socket.off('message', onMessage)
          socket.removeAllListeners('close')
          socket.removeAllListeners('error')
          settled = true
          clearTimeout(timer)
          const keys = sessionKeys(secret, serverNonce, clientNonce)
          resolve(new Peer(socket, new Sealer(keys.toServer, keys.toClient), true))
        } else {
          fail('The worker computer sent something unexpected.')
        }
      } catch {
        fail('The worker computer sent something unexpected.')
      }
    }
    socket.on('message', onMessage)
  })
}
