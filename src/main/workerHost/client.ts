import type { HostConnection, HostHello } from '@shared/workerHost'
import { connect, type Peer } from './channel'

/**
 * The desktop's end of the link to its worker computer: connects, stays
 * connected (trying again with a growing pause when the computer is off or
 * unplugged), and tells the feature what it is talking to.
 */

export interface LinkTarget {
  address: string
  port: number
  secret: string
}

export interface HostLinkOptions {
  target: () => LinkTarget | null
  onState: () => void
  /** Each time the link comes up: sync, update, take over the Workers tab. */
  onConnected: (peer: Peer, hello: HostHello) => Promise<void> | void
  onEvent: (name: string, data: unknown) => void
  /** For tests. */
  retryMs?: number[]
}

const RETRY_MS = [1000, 3000, 6000, 12_000, 20_000, 30_000]
/** How long a host has to restart on an update (it may download a new Electron) before it counts as gone. */
const UPDATE_GRACE_MS = 5 * 60_000

export class HostLink {
  connection: HostConnection = 'offline'
  hello: HostHello | null = null
  error: string | null = null
  seenAt: number | null = null
  private peer: Peer | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private running = false
  private connecting: Promise<void> | null = null

  constructor(private readonly options: HostLinkOptions) {}

  get connected(): boolean {
    return Boolean(this.peer?.isOpen) && this.connection !== 'connecting'
  }

  /** Starts connecting, and keeps the link up until `stop`. */
  start(): void {
    if (this.running) return
    this.running = true
    this.attempt = 0
    void this.tryConnect()
  }

  stop(): void {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const peer = this.peer
    this.peer = null
    peer?.close()
    this.connection = 'offline'
    this.options.onState()
  }

  /** Drops the connection and connects again at once (a new address, or "Try again"). */
  reconnect(): void {
    if (!this.running) return this.start()
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.attempt = 0
    const peer = this.peer
    this.peer = null
    peer?.close()
    void this.tryConnect()
  }

  private updatingSince = 0

  /** Marks the link as busy updating the host; the host restarts and the link comes back by itself. */
  setUpdating(): void {
    this.connection = 'updating'
    this.updatingSince = Date.now()
    this.options.onState()
  }

  async call<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    const peer = this.peer
    if (!peer?.isOpen) throw new Error(this.error ?? 'The worker computer isn’t connected.')
    return peer.call<T>(method, params, timeoutMs)
  }

  /** Waits (up to `ms`, or three minutes while the host updates and restarts) for the link to be up. */
  async ready(ms = 15_000): Promise<boolean> {
    const started = Date.now()
    while (Date.now() - started < (this.connection === 'updating' ? Math.max(ms, 180_000) : ms)) {
      if (this.connected && this.connection === 'connected') return true
      if (!this.running) return false
      await new Promise((r) => setTimeout(r, 200))
    }
    return this.connected
  }

  private tryConnect(): Promise<void> {
    if (this.connecting) return this.connecting
    this.connecting = this.connectOnce().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async connectOnce(): Promise<void> {
    const target = this.options.target()
    if (!this.running || !target) return
    if (this.connection !== 'updating') this.connection = 'connecting'
    this.options.onState()
    let peer: Peer
    try {
      peer = await connect({ address: target.address, port: target.port, secret: target.secret })
    } catch (error) {
      if (!this.running) return
      // While updating, the host is restarting: not an error worth showing, unless it never comes back.
      if (this.connection === 'updating' && Date.now() - this.updatingSince > UPDATE_GRACE_MS) {
        this.connection = 'offline'
        this.error = 'The host app didn’t come back after updating. Reinstall it from Settings → Worker computer.'
      } else if (this.connection !== 'updating') {
        this.connection = 'offline'
        this.error = error instanceof Error ? error.message : String(error)
      }
      this.options.onState()
      this.schedule()
      return
    }
    if (!this.running) {
      peer.close()
      return
    }
    this.peer = peer
    this.attempt = 0
    this.error = null
    peer.onEvent((name, data) => {
      this.seenAt = Date.now()
      if (name === 'hello') this.hello = data as HostHello
      this.options.onEvent(name, data)
    })
    peer.onClose(() => {
      if (this.peer !== peer) return
      this.peer = null
      if (this.connection !== 'updating') this.connection = 'offline'
      this.options.onState()
      if (this.running) this.schedule()
    })
    try {
      this.hello = await peer.call<HostHello>('hello', null, 15_000)
      this.seenAt = Date.now()
      this.connection = 'connected'
      this.options.onState()
      await this.options.onConnected(peer, this.hello)
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      this.options.onState()
    }
  }

  private schedule(): void {
    if (this.timer || !this.running) return
    const retry = this.options.retryMs ?? RETRY_MS
    const wait = retry[Math.min(this.attempt, retry.length - 1)]
    this.attempt++
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tryConnect()
    }, wait)
    this.timer.unref?.()
  }
}
