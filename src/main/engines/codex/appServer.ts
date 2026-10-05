import { spawn, type ChildProcess } from 'node:child_process'
import { attachJsonlReader } from '../../features/eaonCode/jsonl'
import { spawnSpec } from '../../features/eaonCode/locate'
import type { InitializeResponse, RequestId, RpcMessage } from './protocol'

/**
 * One `codex app-server` process: Eaon's JSON-RPC client for it.
 *
 * Requests carry an id and resolve with the matching response; notifications
 * go to every listener; requests *from* Codex (approvals, questions) go to
 * the one request handler, whose answer — or error — is sent back. The
 * process is ours: it is stopped by closing stdin (Codex then ends its own
 * commands and MCP servers), then SIGTERM, and SIGKILL only as a last resort,
 * because SIGKILL leaves Codex's running commands orphaned.
 */

/** How much of stderr to keep for diagnostics. */
const STDERR_TAIL = 8_000
/** Startup includes loading config, plugins and the auth file; the first launch after an update is slower. */
const INITIALIZE_TIMEOUT_MS = 30_000

export class RpcError extends Error {
  constructor(
    readonly code: number | null,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

/** The process ended (crashed, was killed or stopped) while something waited on it. */
export class AppServerExited extends Error {
  constructor(
    message: string,
    readonly exit: AppServerExit
  ) {
    super(message)
    this.name = 'AppServerExited'
  }
}

export class RpcTimeout extends Error {
  constructor(readonly method: string, ms: number) {
    super(`Codex did not answer "${method}" within ${Math.round(ms / 1000)} s.`)
    this.name = 'RpcTimeout'
  }
}

export interface AppServerExit {
  code: number | null
  signal: NodeJS.Signals | null
  stderr: string
  /** True when `stop()`/`kill()` asked for it; false means it crashed or quit on its own. */
  expected: boolean
}

export type NotificationListener = (method: string, params: unknown) => void
export type ServerRequestHandler = (method: string, params: unknown) => Promise<unknown>

export interface AppServerOptions {
  /** The `codex` executable. */
  command: string
  /** Defaults to `['app-server']`. */
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Eaon's version, sent as `clientInfo.version`. */
  clientVersion: string
  /** Notification methods this connection never needs; Codex skips sending them. */
  optOut?: string[]
}

interface Pending {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

/** Every live app-server, so a quit that can't wait still ends them. */
const live = new Set<AppServer>()
let exitHookInstalled = false
function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  // Last resort when the app exits without awaiting dispose(): SIGTERM still
  // lets Codex end its own commands, which SIGKILL would orphan.
  process.once('exit', () => {
    for (const server of live) server.kill('SIGTERM')
  })
}

export class AppServer {
  readonly child: ChildProcess
  private readonly pending = new Map<RequestId, Pending>()
  private readonly listeners = new Set<NotificationListener>()
  private requestHandler: ServerRequestHandler | null = null
  private readonly exitListeners = new Set<(exit: AppServerExit) => void>()
  private readonly detach: () => void
  private stderr = ''
  private nextId = 0
  private stopping = false
  private exitInfo: AppServerExit | null = null
  private readonly exited: Promise<AppServerExit>

  private constructor(readonly options: AppServerOptions) {
    const args = options.args ?? ['app-server']
    const spec = spawnSpec(options.command, args)
    this.child = spawn(spec.command, spec.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: spec.shell,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    live.add(this)
    installExitHook()
    this.detach = attachJsonlReader(this.child.stdout!, (line) => this.handleLine(line))
    this.child.stderr?.on('data', (chunk: Buffer) => this.appendStderr(chunk.toString('utf8')))
    // A write racing the child's exit raises EPIPE here; the exit handler reports it.
    this.child.stdin?.on('error', () => {})
    let resolveExit!: (exit: AppServerExit) => void
    this.exited = new Promise((resolve) => (resolveExit = resolve))
    this.child.on('error', (error) => {
      this.appendStderr(`${error.message}\n`)
      this.finish(null, null, resolveExit)
    })
    this.child.on('exit', (code, signal) => this.finish(code, signal, resolveExit))
  }

  /**
   * Starts `codex app-server` and completes the handshake (`initialize`, then
   * the `initialized` notification). Rejects if the process can't start or
   * doesn't answer, and makes sure it is gone in that case.
   */
  static async start(options: AppServerOptions): Promise<{ server: AppServer; info: InitializeResponse }> {
    const server = new AppServer(options)
    try {
      const info = await server.request<InitializeResponse>(
        'initialize',
        {
          clientInfo: { name: 'eaon_desktop', title: 'Eaon', version: options.clientVersion },
          capabilities: { experimentalApi: false, ...(options.optOut?.length ? { optOutNotificationMethods: options.optOut } : {}) }
        },
        INITIALIZE_TIMEOUT_MS
      )
      server.notify('initialized')
      return { server, info: info ?? {} }
    } catch (error) {
      await server.stop(1000)
      throw error
    }
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  get running(): boolean {
    return this.exitInfo === null
  }

  /** Resolves once the process has exited, however that happened. */
  whenExited(): Promise<AppServerExit> {
    return this.exited
  }

  stderrTail(): string {
    return this.stderr
  }

  onNotification(listener: NotificationListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onExit(listener: (exit: AppServerExit) => void): () => void {
    if (this.exitInfo) {
      listener(this.exitInfo)
      return () => {}
    }
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  setRequestHandler(handler: ServerRequestHandler | null): void {
    this.requestHandler = handler
  }

  /** Sends a request and resolves with its `result`. `timeoutMs` 0 waits as long as the process lives. */
  request<T = unknown>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.exitInfo) return Promise.reject(new AppServerExited(this.exitMessage(this.exitInfo), this.exitInfo))
    const id = ++this.nextId
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id)
              reject(new RpcTimeout(method, timeoutMs))
            }, timeoutMs)
          : null
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer })
      this.write(params === undefined ? { id, method } : { id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params })
  }

  /**
   * Ends the process and waits for it: stdin closed first (Codex's own
   * shutdown, which also ends its commands), SIGTERM after a moment, SIGKILL
   * only if it still hasn't gone by `graceMs`.
   */
  stop(graceMs = 2500): Promise<void> {
    if (this.exitInfo) return Promise.resolve()
    this.stopping = true
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(term)
        clearTimeout(kill)
        resolve()
      }
      void this.exited.then(done)
      this.child.stdin?.end()
      const term = setTimeout(() => this.child.kill('SIGTERM'), Math.min(1000, graceMs / 2))
      const kill = setTimeout(() => {
        this.child.kill('SIGKILL')
        // An unkillable child (stuck in IO) must not hang quitting.
        setTimeout(done, 500)
      }, graceMs)
    })
  }

  /** Synchronous, for when nothing can be awaited. */
  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.exitInfo) return
    this.stopping = true
    this.child.kill(signal)
  }

  private write(message: RpcMessage): void {
    if (this.exitInfo || !this.child.stdin?.writable) return
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    let message: RpcMessage
    try {
      message = JSON.parse(line) as RpcMessage
    } catch {
      // Anything that isn't protocol (a stray print) is kept for diagnostics.
      this.appendStderr(`[stdout] ${line.slice(0, 500)}\n`)
      return
    }
    if (message.method && message.id !== undefined) {
      void this.answer(message.id, message.method, message.params)
      return
    }
    if (message.method) {
      for (const listener of this.listeners) {
        try {
          listener(message.method, message.params)
        } catch (error) {
          console.error('[codex] a notification listener failed:', error)
        }
      }
      return
    }
    if (message.id === undefined) return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (pending.timer) clearTimeout(pending.timer)
    if (message.error) pending.reject(new RpcError(message.error.code ?? null, message.error.message ?? `${pending.method} failed`, message.error.data))
    else pending.resolve(message.result)
  }

  private async answer(id: RequestId, method: string, params: unknown): Promise<void> {
    const handler = this.requestHandler
    if (!handler) {
      this.write({ id, error: { code: -32601, message: `Eaon doesn't handle ${method} here.` } })
      return
    }
    try {
      const result = await handler(method, params)
      this.write({ id, result: result ?? {} })
    } catch (error) {
      const code = error instanceof RpcError && error.code !== null ? error.code : -32603
      this.write({ id, error: { code, message: error instanceof Error ? error.message : String(error) } })
    }
  }

  private appendStderr(text: string): void {
    this.stderr = (this.stderr + text).slice(-STDERR_TAIL)
  }

  private exitMessage(exit: AppServerExit): string {
    if (exit.expected) return 'Codex was stopped.'
    const how = exit.code !== null ? ` with code ${exit.code}` : exit.signal ? ` (${exit.signal})` : ''
    return `Codex stopped unexpectedly${how}.`
  }

  private finish(code: number | null, signal: NodeJS.Signals | null, resolveExit: (exit: AppServerExit) => void): void {
    if (this.exitInfo) return
    const exit: AppServerExit = { code, signal, stderr: this.stderr, expected: this.stopping }
    this.exitInfo = exit
    live.delete(this)
    this.detach()
    const error = new AppServerExited(this.exitMessage(exit), exit)
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    for (const listener of this.exitListeners) {
      try {
        listener(exit)
      } catch (err) {
        console.error('[codex] an exit listener failed:', err)
      }
    }
    this.exitListeners.clear()
    resolveExit(exit)
  }
}
