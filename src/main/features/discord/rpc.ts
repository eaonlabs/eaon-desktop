import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A minimal client for the Discord desktop app's local RPC socket — enough to
 * set Rich Presence, so no dependency is needed for it.
 *
 * Discord listens on `discord-ipc-0` … `discord-ipc-9`: a Unix socket in the
 * temp directory on macOS and Linux, a named pipe on Windows. Every message
 * either way is a frame — little-endian int32 opcode, int32 byte length, then
 * that many bytes of JSON. The browser version of Discord has no socket, so
 * only the desktop app can show activity from apps.
 */

const OP_HANDSHAKE = 0
const OP_FRAME = 1
const OP_CLOSE = 2
const OP_PING = 3
const OP_PONG = 4

const HEADER = 8

/** No Discord desktop app is listening on this computer. */
export class DiscordUnavailable extends Error {
  constructor() {
    super('Discord is not running')
  }
}

export interface DiscordUser {
  id: string
  username: string
  global_name?: string | null
}

export interface ActivityButton {
  label: string
  url: string
}

/** The subset of Discord's activity object that SET_ACTIVITY accepts and Eaon uses. */
export interface Activity {
  type?: 0 | 2 | 3 | 5
  details?: string
  state?: string
  timestamps?: { start?: number; end?: number }
  assets?: {
    large_image?: string
    large_text?: string
    large_url?: string
    small_image?: string
    small_text?: string
  }
  buttons?: ActivityButton[]
  instance?: boolean
}

function socketPaths(): string[] {
  if (process.platform === 'win32') return Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`)
  const env = process.env
  const bases = [...new Set([env.XDG_RUNTIME_DIR, env.TMPDIR, env.TMP, env.TEMP, tmpdir(), '/tmp'].filter(Boolean))] as string[]
  // Flatpak and Snap builds of Discord keep the socket in a subfolder.
  const subdirs = process.platform === 'linux' ? ['', 'app/com.discordapp.Discord', 'snap.discord'] : ['']
  const paths: string[] = []
  for (const base of bases) {
    for (const sub of subdirs) {
      for (let i = 0; i < 10; i++) paths.push(join(base, sub, `discord-ipc-${i}`))
    }
  }
  // A stat is far cheaper than a failed connect, and this runs on every retry.
  return paths.filter((path) => existsSync(path))
}

function open(path: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    const fail = (error: Error): void => {
      clearTimeout(timer)
      socket.destroy()
      reject(error)
    }
    const timer = setTimeout(() => fail(new Error('Timed out connecting to Discord')), timeoutMs)
    socket.once('error', fail)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.removeListener('error', fail)
      resolve(socket)
    })
  })
}

interface Waiter {
  resolve: (data: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class DiscordRpc {
  /** Who is signed in to Discord, from the READY event. */
  user: DiscordUser | null = null
  /** Called once when the connection drops. Not called for close(). */
  onClose: ((reason: string) => void) | null = null

  private buffer = Buffer.alloc(0)
  private pending = new Map<string, Waiter>()
  private ready: Waiter | null = null
  private closed = false

  private constructor(private readonly socket: Socket) {
    socket.on('data', (chunk) => this.receive(chunk))
    socket.on('close', () => this.finish('Discord closed the connection'))
    socket.on('error', (error) => this.finish(error.message))
  }

  /**
   * Connects and completes the handshake. Throws DiscordUnavailable when no
   * Discord is listening, or Discord's own reason when it refuses — an unknown
   * application id, most often.
   */
  static async connect(clientId: string, timeoutMs = 4000): Promise<DiscordRpc> {
    let refused: Error | null = null
    for (const path of socketPaths()) {
      let socket: Socket
      try {
        socket = await open(path, timeoutMs)
      } catch {
        continue // a stale socket file left by a Discord that quit
      }
      const rpc = new DiscordRpc(socket)
      try {
        await rpc.handshake(clientId, timeoutMs)
        return rpc
      } catch (error) {
        rpc.close()
        refused = error as Error
      }
    }
    throw refused ?? new DiscordUnavailable()
  }

  /** Sets this app's activity, or clears it when `activity` is null. */
  setActivity(activity: Activity | null): Promise<unknown> {
    return this.request('SET_ACTIVITY', activity ? { pid: process.pid, activity } : { pid: process.pid })
  }

  close(): void {
    this.onClose = null
    if (!this.closed) {
      try {
        this.write(OP_CLOSE, {})
      } catch {
        /* already gone */
      }
    }
    this.socket.end()
    this.finish('Closed')
  }

  private handshake(clientId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ready = null
        reject(new Error('Discord did not answer'))
      }, timeoutMs)
      this.ready = { resolve: () => resolve(), reject, timer }
      this.write(OP_HANDSHAKE, { v: 1, client_id: clientId })
    })
  }

  private request(cmd: string, args: Record<string, unknown>, timeoutMs = 5000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Not connected to Discord'))
    const nonce = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(nonce)
        reject(new Error('Discord did not answer'))
      }, timeoutMs)
      this.pending.set(nonce, { resolve, reject, timer })
      this.write(OP_FRAME, { cmd, args, nonce })
    })
  }

  private write(op: number, payload: unknown): void {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    const header = Buffer.alloc(HEADER)
    header.writeInt32LE(op, 0)
    header.writeInt32LE(body.length, 4)
    this.socket.write(Buffer.concat([header, body]))
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= HEADER) {
      const op = this.buffer.readInt32LE(0)
      const length = this.buffer.readInt32LE(4)
      if (this.buffer.length < HEADER + length) return
      const body = this.buffer.subarray(HEADER, HEADER + length).toString('utf8')
      this.buffer = this.buffer.subarray(HEADER + length)
      let message: Record<string, unknown>
      try {
        message = JSON.parse(body)
      } catch {
        continue
      }
      this.handle(op, message)
    }
  }

  private handle(op: number, message: Record<string, unknown>): void {
    if (op === OP_PING) {
      this.write(OP_PONG, message)
      return
    }
    if (op === OP_CLOSE) {
      // Discord says why before hanging up, e.g. { code: 4000, message: 'Invalid Client ID' }.
      this.finish(typeof message.message === 'string' ? message.message : 'Discord closed the connection')
      this.socket.destroy()
      return
    }
    if (op !== OP_FRAME) return

    const data = message.data as Record<string, unknown> | undefined
    if (message.cmd === 'DISPATCH' && message.evt === 'READY') {
      this.user = (data?.user as DiscordUser | undefined) ?? null
      if (this.ready) {
        clearTimeout(this.ready.timer)
        this.ready.resolve(undefined)
        this.ready = null
      }
      return
    }
    const nonce = typeof message.nonce === 'string' ? message.nonce : null
    const waiter = nonce ? this.pending.get(nonce) : undefined
    if (!nonce || !waiter) return
    this.pending.delete(nonce)
    clearTimeout(waiter.timer)
    if (message.evt === 'ERROR') {
      waiter.reject(new Error(typeof data?.message === 'string' ? data.message : 'Discord refused the request'))
    } else {
      waiter.resolve(data)
    }
  }

  private finish(reason: string): void {
    if (this.closed) return
    this.closed = true
    const error = new Error(reason)
    if (this.ready) {
      clearTimeout(this.ready.timer)
      this.ready.reject(error)
      this.ready = null
    }
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
    this.onClose?.(reason)
  }
}
