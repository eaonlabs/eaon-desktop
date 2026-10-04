import { randomBytes, randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { cliHome } from '../runtime/paths'

/**
 * The bus: how CLI sessions on one machine find and talk to each other.
 *
 * Every session — an Eaon CLI in another terminal, or a Claude Code or Codex
 * session that loaded `eaon mcp` — registers a small JSON file under
 * `<profile>/bus/` and listens on a Unix socket (a named pipe on Windows).
 * Peers are discovered by listing that folder; a file whose process is gone
 * is cleaned up by whoever notices. The folder sits in the profile, which
 * only the user can open, so only the user's own processes can join.
 *
 * Over a connection go newline-delimited JSON requests with an `rid`, each
 * answered once, plus `event` lines on a subscription. A session can:
 * - **message** another (`message`); a reply is just another message that
 *   names the one it answers (`replyTo`), so the sender can wait for it;
 * - **reach the engines**. One session per profile owns the workers and
 *   trading engines (`engines.lock`); the others call its handlers
 *   (`invoke`), run its tools (`tool`) and follow its events (`subscribe`),
 *   so every terminal sees one desk and one team, never two.
 */

export type PeerKind = 'eaon' | 'claude-code' | 'codex' | 'other'

export interface PeerInfo {
  id: string
  name: string
  kind: PeerKind
  pid: number
  cwd: string
  startedAt: number
  /** What the session is looking at: chat, workers, trading, or `mcp` for a bridge. */
  mode?: string
  /** True for the session that runs the engines. */
  owner?: boolean
  socket: string
}

export interface PeerMessage {
  id: string
  from: { id: string; name: string; kind: PeerKind }
  to: string
  text: string
  at: number
  /** The message this answers. */
  replyTo?: string
  /** The sender is waiting for an answer. */
  expectReply?: boolean
}

/** A tool the owner offers, as other sessions see it. */
export interface RemoteToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** `input` when it depends on the call (treated as mutating by callers that can't ask). */
  mutating: 'always' | 'never' | 'input'
  source: string
}

export interface ToolCallMeta {
  chatId: string
  messageId: string
  cwd: string
  providerId: string
  modelId: string
}

export interface ServeHandlers {
  invoke?: (channel: string, args: unknown[]) => Promise<unknown>
  channels?: () => string[]
  tools?: () => RemoteToolSpec[]
  tool?: (name: string, input: Record<string, unknown>, meta: ToolCallMeta) => Promise<string>
}

type Request =
  | { rid: string; type: 'hello' }
  | { rid: string; type: 'message'; message: PeerMessage }
  | { rid: string; type: 'invoke'; channel: string; args: unknown[] }
  | { rid: string; type: 'channels' }
  | { rid: string; type: 'tools' }
  | { rid: string; type: 'tool'; name: string; input: Record<string, unknown>; meta: ToolCallMeta }
  | { rid: string; type: 'subscribe'; channels: string[] }

type Response = { rid: string; ok: true; value?: unknown } | { rid: string; ok: false; error: string }

/** `Omit` that keeps a union a union: each member loses the key on its own. */
type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/* ------------------------------------------------------------------ files */

export const busDir = (): string => join(cliHome(), 'bus')
const lockFile = (): string => join(cliHome(), 'engines.lock')

/** Sockets have a ~104-byte path limit on macOS; a long home folder falls back to a private temp folder. */
function socketPath(id: string): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\eaon-cli-${id}`
  const preferred = join(busDir(), `${id}.sock`)
  if (Buffer.byteLength(preferred) < 100) return preferred
  const dir = join(tmpdir(), `eaon-cli-${process.getuid?.() ?? 'user'}`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return join(dir, `${id}.sock`)
}

export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function writeAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, path)
}

/** Every live peer, the caller included. Files left by processes that died are removed. */
export function listPeers(): PeerInfo[] {
  const dir = busDir()
  if (!existsSync(dir)) return []
  const out: PeerInfo[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const file = join(dir, name)
    let peer: PeerInfo
    try {
      peer = JSON.parse(readFileSync(file, 'utf8')) as PeerInfo
    } catch {
      continue
    }
    if (!isAlive(peer.pid)) {
      rmSync(file, { force: true })
      if (process.platform !== 'win32') rmSync(peer.socket, { force: true })
      continue
    }
    out.push(peer)
  }
  return out.sort((a, b) => a.startedAt - b.startedAt)
}

/** Finds a peer by id, by name (any case), or by the start of its id. */
export function resolvePeer(target: string, peers = listPeers()): PeerInfo | null {
  const wanted = target.trim().replace(/^@/, '')
  const lower = wanted.toLowerCase()
  return (
    peers.find((p) => p.id === wanted) ??
    peers.find((p) => p.name.toLowerCase() === lower) ??
    peers.find((p) => p.id.startsWith(wanted)) ??
    peers.find((p) => p.name.toLowerCase().startsWith(lower)) ??
    null
  )
}

/* ------------------------------------------------------- the engines lock */

export interface EngineLock {
  pid: number
  peerId: string
  at: number
}

/** How long a new owner has to put up its bus registration before its lock counts as abandoned. */
const LOCK_GRACE_MS = 15_000

/**
 * The lock, if its holder is still there. A live pid alone isn't proof: pids
 * are reused, so a lock whose session never registered on the bus (or has
 * since gone from it) is stale once the grace period is over.
 */
export function readEngineLock(): EngineLock | null {
  try {
    const lock = JSON.parse(readFileSync(lockFile(), 'utf8')) as EngineLock
    if (!isAlive(lock.pid)) return null
    if (lock.pid === process.pid || Date.now() - lock.at < LOCK_GRACE_MS) return lock
    return existsSync(join(busDir(), `${lock.peerId}.json`)) ? lock : null
  } catch {
    return null
  }
}

/**
 * Takes the engines for this process if nobody holds them. Creating the file
 * with `wx` is atomic, so two sessions starting together can't both win; a
 * lock left by a process that died is cleared and taken over.
 */
export function claimEngines(peerId: string): boolean {
  mkdirSync(cliHome(), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockFile(), 'wx', 0o600)
      writeSync(fd, JSON.stringify({ pid: process.pid, peerId, at: Date.now() } satisfies EngineLock))
      closeSync(fd)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false
      const held = readEngineLock()
      if (held) return held.pid === process.pid
      rmSync(lockFile(), { force: true })
    }
  }
  return false
}

export function releaseEngines(): void {
  const held = readEngineLock()
  if (held?.pid === process.pid) rmSync(lockFile(), { force: true })
}

/* ---------------------------------------------------------------- clients */

/** One request on a fresh connection; rejects on timeout, refusal or a dead socket. */
function request<T>(peer: Pick<PeerInfo, 'socket'>, body: Without<Request, 'rid'>, timeoutMs = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const rid = randomBytes(6).toString('hex')
    const socket = createConnection(peer.socket)
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('The other session did not answer in time.'))
    }, timeoutMs)
    const done = (fn: () => void): void => {
      clearTimeout(timer)
      socket.destroy()
      fn()
    }
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify({ ...body, rid })}\n`))
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        let reply: Response
        try {
          reply = JSON.parse(line) as Response
        } catch {
          continue
        }
        if (reply.rid !== rid) continue
        if (reply.ok) done(() => resolve(reply.value as T))
        else done(() => reject(new Error(reply.error)))
      }
    })
    socket.on('error', (error) => done(() => reject(error)))
    socket.on('close', () => done(() => reject(new Error('The other session closed the connection.'))))
  })
}

/* ------------------------------------------------------------------- node */

export interface BusOptions {
  name?: string
  kind: PeerKind
  cwd?: string
  mode?: string
}

export interface SendResult {
  delivered: boolean
  to?: PeerInfo
  reply?: PeerMessage
  error?: string
}

/** This process on the bus: its registration, its socket, and what it can ask of others. */
export class BusNode {
  readonly self: PeerInfo
  private server: Server | null = null
  private handlers: ServeHandlers = {}
  private messageListeners = new Set<(message: PeerMessage) => void>()
  private replyWaiters = new Map<string, (message: PeerMessage) => void>()
  private subscribers = new Set<{ socket: Socket; channels: string[] }>()
  private closed = false

  constructor(options: BusOptions) {
    const id = randomBytes(4).toString('hex')
    const cwd = options.cwd ?? process.cwd()
    this.self = {
      id,
      name: uniqueName(options.name ?? defaultName(options.kind, cwd)),
      kind: options.kind,
      pid: process.pid,
      cwd,
      startedAt: Date.now(),
      mode: options.mode,
      socket: socketPath(id)
    }
  }

  async open(): Promise<this> {
    mkdirSync(busDir(), { recursive: true })
    if (process.platform !== 'win32') rmSync(this.self.socket, { force: true })
    this.server = createServer((socket) => this.accept(socket))
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.self.socket, () => resolve())
    })
    this.server.on('error', () => {})
    this.register()
    return this
  }

  private register(): void {
    if (this.closed) return
    writeAtomic(join(busDir(), `${this.self.id}.json`), this.self)
  }

  /** Changes what other sessions see: the name, the mode, ownership. */
  update(patch: Partial<Pick<PeerInfo, 'name' | 'mode' | 'cwd' | 'owner'>>): void {
    if (patch.name !== undefined) patch.name = uniqueName(patch.name, this.self.id)
    Object.assign(this.self, patch)
    this.register()
  }

  serve(handlers: ServeHandlers): void {
    this.handlers = { ...this.handlers, ...handlers }
  }

  /** Every other live session. */
  peers(): PeerInfo[] {
    return listPeers().filter((p) => p.id !== this.self.id)
  }

  onMessage(fn: (message: PeerMessage) => void): () => void {
    this.messageListeners.add(fn)
    return () => this.messageListeners.delete(fn)
  }

  /**
   * Sends a message. With `waitMs`, the message asks for an answer and this
   * waits that long for one; a session that is busy, or a person who hasn't
   * read it yet, may take longer, so no reply is not an error.
   */
  async send(to: string, text: string, options: { replyTo?: string; waitMs?: number } = {}): Promise<SendResult> {
    const peer = resolvePeer(to, this.peers())
    if (!peer) return { delivered: false, error: `No session called “${to}” is running. Sessions: ${this.peers().map((p) => p.name).join(', ') || 'none'}.` }
    const message: PeerMessage = {
      id: randomUUID(),
      from: { id: this.self.id, name: this.self.name, kind: this.self.kind },
      to: peer.id,
      text,
      at: Date.now(),
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      ...(options.waitMs ? { expectReply: true } : {})
    }
    const waiting = options.waitMs
      ? new Promise<PeerMessage | undefined>((resolve) => {
          const timer = setTimeout(() => {
            this.replyWaiters.delete(message.id)
            resolve(undefined)
          }, options.waitMs)
          this.replyWaiters.set(message.id, (reply) => {
            clearTimeout(timer)
            this.replyWaiters.delete(message.id)
            resolve(reply)
          })
        })
      : Promise.resolve(undefined)
    try {
      await request(peer, { type: 'message', message })
    } catch (error) {
      this.replyWaiters.get(message.id)?.(undefined as never)
      return { delivered: false, to: peer, error: error instanceof Error ? error.message : String(error) }
    }
    const reply = await waiting
    return { delivered: true, to: peer, ...(reply ? { reply } : {}) }
  }

  /* ------------------------------------------------ talking to the owner */

  /** The session running the engines, if it is another live session. */
  owner(): PeerInfo | null {
    const lock = readEngineLock()
    if (!lock || lock.peerId === this.self.id) return null
    return listPeers().find((p) => p.id === lock.peerId) ?? null
  }

  invokeOwner<T = unknown>(channel: string, args: unknown[], timeoutMs = 60_000): Promise<T> {
    const owner = this.owner()
    if (!owner) return Promise.reject(new Error('The session running Eaon’s engines has closed.'))
    return request<T>(owner, { type: 'invoke', channel, args }, timeoutMs)
  }

  ownerChannels(): Promise<string[]> {
    const owner = this.owner()
    return owner ? request<string[]>(owner, { type: 'channels' }) : Promise.resolve([])
  }

  ownerTools(): Promise<RemoteToolSpec[]> {
    const owner = this.owner()
    return owner ? request<RemoteToolSpec[]>(owner, { type: 'tools' }) : Promise.resolve([])
  }

  callOwnerTool(name: string, input: Record<string, unknown>, meta: ToolCallMeta): Promise<string> {
    const owner = this.owner()
    if (!owner) return Promise.reject(new Error('The session running Eaon’s engines has closed.'))
    // A tool may run for a while (a session start checks the market first).
    return request<string>(owner, { type: 'tool', name, input, meta }, 5 * 60_000)
  }

  /** Follows the owner's events on `channels` until the returned function is called or the owner goes. */
  subscribeOwner(channels: string[], onEvent: (channel: string, args: unknown[]) => void, onClose?: () => void): () => void {
    const owner = this.owner()
    if (!owner) {
      onClose?.()
      return () => {}
    }
    const socket = createConnection(owner.socket)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify({ rid: 'sub', type: 'subscribe', channels })}\n`))
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        try {
          const event = JSON.parse(line) as { type?: string; channel?: string; args?: unknown[] }
          if (event.type === 'event' && event.channel) onEvent(event.channel, event.args ?? [])
        } catch {
          /* a partial line from a dying socket */
        }
      }
    })
    let ended = false
    const end = (): void => {
      if (ended) return
      ended = true
      onClose?.()
    }
    socket.on('error', end)
    socket.on('close', end)
    return () => {
      ended = true
      socket.destroy()
    }
  }

  /** Sends an event to every session following `channel`. */
  publish(channel: string, args: unknown[]): void {
    if (this.subscribers.size === 0) return
    let line: string
    try {
      line = `${JSON.stringify({ type: 'event', channel, args })}\n`
    } catch {
      return
    }
    for (const sub of this.subscribers) {
      if (sub.channels.some((c) => c === '*' || channel === c || (c.endsWith('*') && channel.startsWith(c.slice(0, -1))))) sub.socket.write(line)
    }
  }

  /* --------------------------------------------------------- the server */

  private accept(socket: Socket): void {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        let req: Request
        try {
          req = JSON.parse(line) as Request
        } catch {
          continue
        }
        void this.answer(socket, req)
      }
    })
  }

  private async answer(socket: Socket, req: Request): Promise<void> {
    const reply = (response: Without<Response, 'rid'>): void => {
      if (!socket.destroyed) socket.write(`${JSON.stringify({ ...response, rid: req.rid })}\n`)
    }
    try {
      switch (req.type) {
        case 'hello':
          return reply({ ok: true, value: this.self })
        case 'message': {
          const message = req.message
          if (!message || typeof message.text !== 'string') return reply({ ok: false, error: 'Not a message.' })
          reply({ ok: true })
          if (message.replyTo) this.replyWaiters.get(message.replyTo)?.(message)
          for (const fn of this.messageListeners) fn(message)
          return
        }
        case 'invoke':
          if (!this.handlers.invoke) return reply({ ok: false, error: 'This session does not run Eaon’s engines.' })
          return reply({ ok: true, value: await this.handlers.invoke(req.channel, Array.isArray(req.args) ? req.args : []) })
        case 'channels':
          return reply({ ok: true, value: this.handlers.channels?.() ?? [] })
        case 'tools':
          return reply({ ok: true, value: this.handlers.tools?.() ?? [] })
        case 'tool':
          if (!this.handlers.tool) return reply({ ok: false, error: 'This session does not run Eaon’s engines.' })
          return reply({ ok: true, value: await this.handlers.tool(req.name, req.input ?? {}, req.meta) })
        case 'subscribe': {
          const sub = { socket, channels: Array.isArray(req.channels) ? req.channels : [] }
          this.subscribers.add(sub)
          socket.on('close', () => this.subscribers.delete(sub))
          return
        }
        default:
          return reply({ ok: false, error: 'Unknown request.' })
      }
    } catch (error) {
      reply({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const sub of this.subscribers) sub.socket.destroy()
    this.subscribers.clear()
    rmSync(join(busDir(), `${this.self.id}.json`), { force: true })
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
    if (process.platform !== 'win32') rmSync(this.self.socket, { force: true })
  }

  /** For exit handlers, where nothing async runs: just take the registration down. */
  closeSync(): void {
    this.closed = true
    rmSync(join(busDir(), `${this.self.id}.json`), { force: true })
    if (process.platform !== 'win32') rmSync(this.self.socket, { force: true })
  }
}

function defaultName(kind: PeerKind, cwd: string): string {
  const prefix = kind === 'eaon' ? 'eaon' : kind
  const folder = basename(cwd) || 'home'
  return `${prefix}@${folder}`.replace(/\s+/g, '-')
}

/** "eaon@api", then "eaon@api-2" if a live session already has that name. */
function uniqueName(wanted: string, selfId?: string): string {
  const taken = new Set(
    listPeers()
      .filter((p) => p.id !== selfId)
      .map((p) => p.name.toLowerCase())
  )
  if (!taken.has(wanted.toLowerCase())) return wanted
  for (let i = 2; ; i++) if (!taken.has(`${wanted}-${i}`.toLowerCase())) return `${wanted}-${i}`
}
