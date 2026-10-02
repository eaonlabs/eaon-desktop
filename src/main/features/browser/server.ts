import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import {
  BRIDGE_PROTOCOL,
  isNewerVersion,
  V1_ACTIONS,
  type BrowserAction,
  type BrowserAsk,
  type BrowserBridgeStatus,
  type DesktopMessage,
  type ExtensionMessage,
  type PairingCode,
  type RejectReason
} from '@shared/browserBridge'

/**
 * The loopback WebSocket server the Eaon Chrome extension connects to.
 *
 * Who may connect is decided in three layers, cheapest first:
 *  1. The socket is bound to 127.0.0.1, so nothing off this machine can reach it.
 *  2. The handshake must carry a `chrome-extension://` Origin and a loopback
 *     Host. Browsers always stamp a page's real origin on WebSocket handshakes,
 *     so this is what stops any website the user visits from opening
 *     ws://127.0.0.1:<port> and talking to the agent.
 *  3. The first message must carry a token issued at pairing, bound to the
 *     extension origin that paired. That keeps out other installed extensions,
 *     which pass check 2 as easily as ours does — and a rogue one connected
 *     here could feed the agent fabricated pages.
 *
 * Only a SHA-256 of the token is stored. Pairing is a short code shown in
 * Settings and typed into the popup once; it expires, is single-use, and is
 * thrown away after a handful of wrong guesses.
 */

const ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/
/** No 0/O, 1/I/L: the code is read off one screen and typed into another. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 6
const MAX_CODE_ATTEMPTS = 5
const HEARTBEAT_MS = 20_000

export interface PairingRecord {
  tokenHash: string
  /** The extension origin that paired; the token is refused from any other. */
  origin: string
  browser: string
  extensionVersion: string
  pairedAt: number
  lastSeenAt: number
}

export interface PairingStore {
  load: () => PairingRecord | null
  save: (record: PairingRecord | null) => void
}

export interface BridgeOptions {
  store: PairingStore
  appVersion: string
  /** Called whenever anything `status()` reports may have changed. */
  onChange?: () => void
  helloTimeoutMs?: number
  pairingTtlMs?: number
  /** A connection silent for this long is presumed dead and dropped. */
  staleAfterMs?: number
  /** The extension version this app ships, offered to older extensions. */
  bundledVersion?: () => string | null
  /** The user sent something to Eaon from the extension's right-click menu. */
  onAsk?: (ask: BrowserAsk) => void
}

export class NotConnectedError extends Error {}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

interface ActiveConnection {
  socket: WebSocket
  origin: string
  lastSeen: number
  version: string
  /** What the extension said it can do; null for 1.0.0, which did not say. */
  features: Set<string> | null
  installType: string | null
}

type UpdateState = BrowserBridgeStatus['update']

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** Keeps what the extension says about itself short and printable. */
const clean = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() ? value.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 60) : fallback

function send(socket: WebSocket, message: DesktopMessage): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}

export class BrowserBridge {
  private wss: WebSocketServer | null = null
  private port = 0
  private error: string | null = null
  private active: ActiveConnection | null = null
  private record: PairingRecord | null
  private pairing: { code: string; expiresAt: number; attempts: number } | null = null
  private pending = new Map<string, Pending>()
  /**
   * Calls run one at a time, in the order the agent issued them. The loop runs
   * read-only calls concurrently, and "scroll, then snapshot" answered out of
   * order would describe the wrong part of the page.
   */
  private queue: Promise<unknown> = Promise.resolve()
  private heartbeat: NodeJS.Timeout | null = null
  private remote: { paused: boolean; agentTab: { title: string; url: string } | null } = { paused: false, agentTab: null }
  private updateState: UpdateState = 'idle'
  /** Versions already offered to the extension on connect, so a failed update is not retried in a loop. */
  private offered = new Set<string>()

  constructor(private readonly options: BridgeOptions) {
    this.record = options.store.load()
  }

  get listening(): boolean {
    return this.wss !== null
  }

  get boundPort(): number {
    return this.port
  }

  get connected(): boolean {
    return this.active !== null
  }

  get paired(): boolean {
    return this.record !== null
  }

  get paused(): boolean {
    return this.active !== null && this.remote.paused
  }

  get lastError(): string | null {
    return this.error
  }

  async start(port: number): Promise<void> {
    await this.stop()
    this.error = null
    try {
      await new Promise<void>((resolve, reject) => {
        const wss = new WebSocketServer({
          host: '127.0.0.1',
          port,
          // Screenshots arrive as base64; a 4K capture is a few MB at most.
          maxPayload: 32 * 1024 * 1024,
          verifyClient: (info, done) => {
            const ok = this.handshakeAllowed(info.req)
            if (ok) done(true)
            else done(false, 403, 'Forbidden')
          }
        })
        const onError = (error: Error): void => {
          wss.close()
          reject(error)
        }
        wss.once('error', onError)
        wss.once('listening', () => {
          wss.off('error', onError)
          wss.on('error', (error) => console.error('[browser-bridge]', error))
          const address = wss.address()
          this.port = typeof address === 'object' && address ? address.port : port
          this.wss = wss
          resolve()
        })
        wss.on('connection', (socket, req) => this.accept(socket, req))
      })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      this.port = port
      this.error =
        code === 'EADDRINUSE'
          ? `Port ${port} is already in use by another app. Choose a different port, and enter the same one in the extension popup.`
          : `Could not listen on port ${port}: ${error instanceof Error ? error.message : String(error)}`
      this.changed()
      return
    }
    this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS)
    this.heartbeat.unref()
    this.changed()
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    const wss = this.wss
    this.wss = null
    if (this.active) this.detach('Eaon stopped listening for the browser extension.')
    if (!wss) return
    for (const client of wss.clients) client.terminate()
    await new Promise<void>((resolve) => wss.close(() => resolve()))
    this.changed()
  }

  status(): Omit<BrowserBridgeStatus, 'enabled' | 'bundledExtensionVersion' | 'legacyExtensionSeenAt'> {
    const record = this.record
    const active = this.active
    return {
      canSelfUpdate: active !== null && active.installType === 'development' && active.features?.has('self-update') === true,
      update: active ? this.updateState : 'idle',
      listening: this.wss !== null,
      port: this.port,
      error: this.error,
      paired: record !== null,
      connected: this.active !== null,
      client: record
        ? {
            browser: record.browser,
            extensionVersion: record.extensionVersion,
            installType: active ? active.installType : null,
            pairedAt: record.pairedAt,
            lastSeenAt: this.active ? Date.now() : record.lastSeenAt
          }
        : null,
      paused: this.paused,
      agentTab: this.active ? this.remote.agentTab : null,
      pairing: this.pairing && Date.now() <= this.pairing.expiresAt ? formatCode(this.pairing) : null
    }
  }

  /** The current pairing code, or a new one if there is none, it expired, or `fresh` is set. */
  pairingCode(fresh = false): PairingCode {
    const ttl = this.options.pairingTtlMs ?? 10 * 60_000
    if (fresh || !this.pairing || Date.now() > this.pairing.expiresAt) {
      let code = ''
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
      this.pairing = { code, expiresAt: Date.now() + ttl, attempts: 0 }
      this.changed()
    }
    return formatCode(this.pairing)
  }

  /** Forgets the paired browser and drops its connection. It must pair again to reconnect. */
  unpair(): void {
    this.setRecord(null)
    if (this.active) {
      this.reject(this.active.socket, 'unpaired', 'Eaon unpaired this browser. Pair it again from Eaon → Settings → Browser extension.')
      this.detach('The browser was unpaired.')
    }
    this.changed()
  }

  /**
   * Sends one action to the extension and resolves with its result. Rejects
   * with NotConnectedError when no extension is connected, and with a plain
   * Error when the extension reports a failure, the call times out, or
   * `signal` aborts it.
   */
  call(
    action: BrowserAction,
    params: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<unknown> {
    const run = (): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const connection = this.active
        if (!connection) return reject(new NotConnectedError('The browser extension is not connected.'))
        if (options.signal?.aborted) return reject(new Error('Stopped by the user.'))
        const id = randomUUID()
        const timeoutMs = options.timeoutMs ?? 30_000
        const cleanup = (): void => {
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', onAbort)
          this.pending.delete(id)
        }
        const timer = setTimeout(() => {
          cleanup()
          send(connection.socket, { type: 'cancel', id })
          reject(new Error(`The browser did not answer within ${Math.round(timeoutMs / 1000)} seconds.`))
        }, timeoutMs)
        const onAbort = (): void => {
          cleanup()
          send(connection.socket, { type: 'cancel', id })
          reject(new Error('Stopped by the user.'))
        }
        options.signal?.addEventListener('abort', onAbort, { once: true })
        this.pending.set(id, {
          resolve: (value) => {
            cleanup()
            resolve(value)
          },
          reject: (error) => {
            cleanup()
            reject(error)
          }
        })
        send(connection.socket, { type: 'call', id, action, params })
      })
    const result = this.queue.then(run, run)
    this.queue = result.catch(() => undefined)
    return result
  }

  /** Whether the connected extension can carry out `action` — older ones lack the newer actions. */
  supports(action: BrowserAction): boolean {
    const active = this.active
    if (!active) return false
    return active.features ? active.features.has(action) : V1_ACTIONS.includes(action)
  }

  /** The connected extension's version, or null. */
  get extensionVersion(): string | null {
    return this.active?.version ?? null
  }

  /**
   * Asks the connected extension to update to the version this app ships.
   * Returns false when there is nothing to ask: no connection, nothing newer,
   * or an extension too old to update itself.
   */
  requestUpdate(): boolean {
    const active = this.active
    const latest = this.latestFor(active)
    if (!active || !latest || !active.features?.has('self-update')) return false
    this.updateState = 'reloading'
    send(active.socket, { type: 'update', version: latest })
    this.changed()
    return true
  }

  // ------------------------------------------------------------ Internals

  /** The shipped version, if it is newer than what this connection runs. */
  private latestFor(active: ActiveConnection | null): string | null {
    const latest = this.options.bundledVersion?.() ?? null
    return active && latest && isNewerVersion(latest, active.version) ? latest : null
  }

  /** Unpacked extensions are updated as soon as they connect — once per version per run of the app. */
  private offerUpdate(): void {
    const active = this.active
    const latest = this.latestFor(active)
    if (!active || !latest || active.installType !== 'development' || this.offered.has(latest)) return
    this.offered.add(latest)
    this.requestUpdate()
  }

  private handshakeAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin ?? ''
    if (!ORIGIN_RE.test(origin)) return false
    // A loopback Host as well: a DNS-rebound hostname would arrive with its
    // own name here even if it somehow carried an extension origin.
    const host = req.headers.host ?? ''
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`
  }

  private accept(socket: WebSocket, req: IncomingMessage): void {
    const origin = req.headers.origin ?? ''
    let authed = false
    const helloTimer = setTimeout(() => this.reject(socket, 'timeout', 'The extension did not identify itself in time.'), this.options.helloTimeoutMs ?? 5_000)

    socket.on('message', (data) => {
      let message: ExtensionMessage
      try {
        message = JSON.parse(String(data)) as ExtensionMessage
      } catch {
        this.reject(socket, 'malformed', 'Messages must be JSON.')
        return
      }
      if (!authed) {
        clearTimeout(helloTimer)
        authed = this.authenticate(socket, origin, message)
        return
      }
      if (this.active?.socket !== socket) return
      this.active.lastSeen = Date.now()
      this.handle(message)
    })
    socket.on('pong', () => {
      if (this.active?.socket === socket) this.active.lastSeen = Date.now()
    })
    socket.on('close', () => {
      clearTimeout(helloTimer)
      if (this.active?.socket === socket) this.detach('The browser extension disconnected.')
    })
    socket.on('error', () => {
      /* 'close' follows and does the cleanup */
    })
  }

  private authenticate(socket: WebSocket, origin: string, message: ExtensionMessage): boolean {
    if (message.type !== 'hello') {
      this.reject(socket, 'malformed', 'The first message must be a hello.')
      return false
    }
    if (message.protocol !== BRIDGE_PROTOCOL) {
      this.reject(
        socket,
        'protocol',
        (message.protocol ?? 0) > BRIDGE_PROTOCOL
          ? 'This extension is newer than the Eaon app. Update Eaon to keep using it.'
          : 'This extension is older than the Eaon app. Update the Eaon extension.'
      )
      return false
    }
    const browser = clean(message.browser, 'Browser')
    const extensionVersion = clean(message.extensionVersion, 'unknown')
    const now = Date.now()
    const client = {
      version: extensionVersion,
      features: Array.isArray(message.features) ? new Set(message.features.filter((f): f is string => typeof f === 'string').slice(0, 100)) : null,
      installType: typeof message.installType === 'string' ? clean(message.installType, 'unknown') : null
    }
    const latestExtension = this.latestFor({ ...client, socket, origin, lastSeen: now }) ?? undefined

    if (typeof message.pairingCode === 'string' && message.pairingCode) {
      if (!this.codeMatches(message.pairingCode)) {
        this.reject(socket, 'bad-code', 'That pairing code is wrong or has expired. Get a new one in Eaon → Settings → Browser extension.')
        return false
      }
      const token = randomBytes(32).toString('base64url')
      this.pairing = null
      this.setRecord({ tokenHash: sha256(token), origin, browser, extensionVersion, pairedAt: now, lastSeenAt: now })
      // Whoever was connected before held the previous token, which is now void.
      this.attach(socket, origin, 'unpaired', client)
      send(socket, { type: 'welcome', protocol: BRIDGE_PROTOCOL, appVersion: this.options.appVersion, token, latestExtension })
      this.changed()
      this.offerUpdate()
      return true
    }

    if (typeof message.token === 'string' && message.token) {
      const record = this.record
      if (!record || !tokenMatches(message.token, record.tokenHash) || record.origin !== origin) {
        this.reject(socket, 'bad-token', 'This browser is no longer paired with Eaon. Pair it again from Eaon → Settings → Browser extension.')
        return false
      }
      this.setRecord({ ...record, browser, extensionVersion, lastSeenAt: now })
      this.attach(socket, origin, 'replaced', client)
      send(socket, { type: 'welcome', protocol: BRIDGE_PROTOCOL, appVersion: this.options.appVersion, latestExtension })
      this.changed()
      this.offerUpdate()
      return true
    }

    this.reject(socket, 'bad-token', 'Pair this browser from Eaon → Settings → Browser extension first.')
    return false
  }

  private codeMatches(input: string): boolean {
    const pairing = this.pairing
    if (!pairing || Date.now() > pairing.expiresAt) return false
    const typed = Buffer.from(input.toUpperCase().replace(/[^A-Z0-9]/g, ''))
    const expected = Buffer.from(pairing.code)
    const ok = typed.length === expected.length && timingSafeEqual(typed, expected)
    if (!ok && ++pairing.attempts >= MAX_CODE_ATTEMPTS) {
      // Enough wrong guesses that someone may be trying them all; make the
      // user fetch a fresh code rather than leave this one open.
      this.pairing = null
      this.changed()
    }
    return ok
  }

  private attach(
    socket: WebSocket,
    origin: string,
    displacedReason: RejectReason,
    client: Pick<ActiveConnection, 'version' | 'features' | 'installType'>
  ): void {
    if (this.active && this.active.socket !== socket) {
      this.reject(
        this.active.socket,
        displacedReason,
        displacedReason === 'unpaired' ? 'Eaon was paired with another browser.' : 'Another connection from this extension took over.'
      )
      this.detach('The browser extension reconnected. Try again.')
    }
    // A reconnect after "reloading" is the update landing (or not — the
    // extension says 'stuck' if the reload brought no new version).
    if (this.updateState === 'reloading' && this.active?.version !== client.version) this.updateState = 'idle'
    this.active = { socket, origin, lastSeen: Date.now(), ...client }
    this.remote = { paused: false, agentTab: null }
  }

  private handle(message: ExtensionMessage): void {
    switch (message.type) {
      case 'result': {
        const pending = this.pending.get(message.id)
        if (!pending) return
        if (message.ok) pending.resolve(message.result)
        else pending.reject(new Error(typeof message.error === 'string' ? message.error : 'The browser action failed.'))
        return
      }
      case 'state':
        this.remote = {
          paused: message.paused === true,
          agentTab:
            message.agentTab && typeof message.agentTab === 'object'
              ? { title: String(message.agentTab.title ?? '').slice(0, 200), url: String(message.agentTab.url ?? '').slice(0, 500) }
              : null
        }
        this.changed()
        return
      case 'ping':
        if (this.active) send(this.active.socket, { type: 'pong' })
        return
      case 'update-status':
        if (message.state === 'reloading' || message.state === 'stuck' || message.state === 'store') {
          this.updateState = message.state
          this.changed()
        }
        return
      case 'ask': {
        if (message.kind !== 'page' && message.kind !== 'selection' && message.kind !== 'link') return
        // Page text is the page's words, not the user's: bounded here, and
        // the app only ever puts it in the composer for the user to send.
        this.options.onAsk?.({
          kind: message.kind,
          text: typeof message.text === 'string' ? message.text.slice(0, 20_000) : '',
          url: typeof message.url === 'string' ? message.url.slice(0, 2_000) : '',
          title: typeof message.title === 'string' ? message.title.replace(/[\u0000-\u001f]/g, ' ').slice(0, 300) : '',
          tabId: typeof message.tabId === 'number' && Number.isInteger(message.tabId) ? message.tabId : null
        })
        return
      }
      case 'unpair':
        this.setRecord(null)
        if (this.active) this.active.socket.close(1000, 'unpaired')
        this.detach('The user unpaired the browser from the extension.')
        return
      default:
        return
    }
  }

  private reject(socket: WebSocket, reason: RejectReason, message: string): void {
    send(socket, { type: 'rejected', reason, message })
    // 4000–4999 are application-defined close codes.
    socket.close(4001, reason)
  }

  /** Clears the active connection and fails whatever was waiting on it. */
  private detach(message: string): void {
    const record = this.record
    if (record) this.setRecord({ ...record, lastSeenAt: Date.now() })
    this.active = null
    this.remote = { paused: false, agentTab: null }
    for (const pending of [...this.pending.values()]) pending.reject(new NotConnectedError(message))
    this.pending.clear()
    this.changed()
  }

  private beat(): void {
    const active = this.active
    if (!active) return
    if (Date.now() - active.lastSeen > (this.options.staleAfterMs ?? 3 * HEARTBEAT_MS)) {
      // A laptop that slept, a browser that crashed: the socket never closed
      // cleanly, so nothing else would notice it is gone.
      active.socket.terminate()
      return
    }
    active.socket.ping()
  }

  private setRecord(record: PairingRecord | null): void {
    this.record = record
    this.options.store.save(record)
  }

  private changed(): void {
    this.options.onChange?.()
  }
}

function formatCode(pairing: { code: string; expiresAt: number }): PairingCode {
  return { code: `${pairing.code.slice(0, 3)}-${pairing.code.slice(3)}`, expiresAt: pairing.expiresAt }
}

function tokenMatches(token: string, storedHash: string): boolean {
  const a = Buffer.from(sha256(token), 'hex')
  const b = Buffer.from(storedHash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

export const __test = { sha256, ORIGIN_RE }
