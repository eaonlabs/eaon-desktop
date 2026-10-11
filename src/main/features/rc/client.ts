import WebSocket from 'ws'
import type { RcConnection } from '@shared/rc'

/**
 * The one connection a linked computer keeps to the Eaon Remote relay
 * (cloud/rc, `/relay/device`): outgoing, so nothing on this computer listens
 * for the internet. It reconnects with backoff when the network drops, keeps
 * itself alive through proxies with a ping, and stops for good when the relay
 * says the computer was unlinked.
 */

export interface RelayClientOptions {
  /** `https://rc.eaon.dev` (the WebSocket URL is derived). */
  server: string
  token: string
  /** This computer's name, refreshed on the website at each connect. */
  name: string
  onMessage: (message: Record<string, unknown>) => void
  onStatus: (status: RcConnection, problem: string | null) => void
  /** The relay says this computer isn't linked any more (unlinked on the website, or a revoked token). */
  onUnlinked: () => void
}

const PING_MS = 25_000
const MAX_BACKOFF_MS = 60_000

export class RelayClient {
  private ws: WebSocket | null = null
  private stopped = false
  private backoff = 1000
  private retry: NodeJS.Timeout | null = null
  private ping: NodeJS.Timeout | null = null

  constructor(private readonly opts: RelayClientOptions) {}

  start(): void {
    this.stopped = false
    this.open()
  }

  stop(): void {
    this.stopped = true
    if (this.retry) clearTimeout(this.retry)
    if (this.ping) clearInterval(this.ping)
    this.retry = this.ping = null
    const ws = this.ws
    this.ws = null
    try {
      ws?.close(1000, 'off')
    } catch {
      /* already closed */
    }
    this.opts.onStatus('off', null)
  }

  send(message: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message))
  }

  private open(): void {
    if (this.stopped) return
    this.opts.onStatus('connecting', null)
    const url = `${this.opts.server.replace(/^http/, 'ws').replace(/\/$/, '')}/relay/device`
    const ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.opts.token}`, 'X-RC-Name': encodeURIComponent(this.opts.name).slice(0, 200) },
      handshakeTimeout: 15_000,
      maxPayload: 2 * 1024 * 1024
    })
    this.ws = ws

    ws.on('open', () => {
      this.backoff = 1000
      this.opts.onStatus('connected', null)
      this.ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), PING_MS)
    })
    ws.on('message', (raw) => {
      const text = raw.toString()
      if (text === 'pong') return
      try {
        this.opts.onMessage(JSON.parse(text) as Record<string, unknown>)
      } catch {
        /* not ours */
      }
    })
    ws.on('unexpected-response', (_req, res) => {
      // 401: the token doesn't name a device on the account any more.
      if (res.statusCode === 401) {
        this.stopped = true
        this.opts.onUnlinked()
      }
      ws.terminate()
    })
    ws.on('close', (code) => {
      if (this.ping) clearInterval(this.ping)
      this.ping = null
      if (this.ws === ws) this.ws = null
      if (code === 4001) {
        this.stopped = true
        this.opts.onUnlinked()
        return
      }
      if (this.stopped) return
      this.opts.onStatus('offline', 'Can’t reach Eaon Remote. Trying again…')
      this.retry = setTimeout(() => this.open(), this.backoff)
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS)
    })
    ws.on('error', () => {
      /* 'close' follows and retries */
    })
  }
}
