import { spawn, type ChildProcess } from 'node:child_process'
import type { EaonEvent } from '@shared/eaonCode'
import { attachJsonlReader } from './jsonl'

/** How much of stderr to keep for crash reports. */
const STDERR_TAIL = 8_000

export interface RpcExit {
  code: number | null
  signal: NodeJS.Signals | null
  stderr: string
  /** True when `stop()` asked for it; false means it crashed or quit on its own. */
  expected: boolean
}

export interface RpcChildOptions {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  /** Every record that is not the answer to a request: events, extension UI requests, stray responses. */
  onEvent: (event: EaonEvent) => void
  onExit: (exit: RpcExit) => void
}

interface Pending {
  resolve: (data: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | null
  type: string
}

/** Quote an argument for cmd.exe, which is what runs npm's `.cmd` shims. */
const winQuote = (arg: string): string => (/[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg)

/**
 * One `eaon-code --mode rpc` process: commands in on stdin, responses and
 * events out on stdout, each a JSON line.
 *
 * Requests carry an `id` and are matched to the response with the same id,
 * because responses and events interleave freely — a `prompt` is answered
 * only after preflight, by which point events for it may already be flowing.
 */
export class RpcChild {
  private readonly child: ChildProcess
  private readonly pending = new Map<string, Pending>()
  private readonly detach: () => void
  private stderr = ''
  private nextId = 0
  private stopping = false
  private exited = false

  constructor(private readonly options: RpcChildOptions) {
    const windowsShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(options.command)
    this.child = windowsShim
      ? spawn(winQuote(options.command), options.args.map(winQuote), {
          cwd: options.cwd,
          env: options.env,
          shell: true,
          windowsHide: true
        })
      : spawn(options.command, options.args, {
          cwd: options.cwd,
          env: options.env,
          stdio: ['pipe', 'pipe', 'pipe']
        })

    this.detach = attachJsonlReader(this.child.stdout!, (line) => this.handleLine(line))
    this.child.stderr?.on('data', (chunk: Buffer) => this.appendStderr(chunk.toString('utf8')))
    // A write racing the child's exit raises EPIPE here; the exit handler reports it.
    this.child.stdin?.on('error', () => {})
    this.child.on('error', (error) => {
      this.appendStderr(`${error.message}\n`)
      this.finish(null, null)
    })
    this.child.on('exit', (code, signal) => this.finish(code, signal))
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  get running(): boolean {
    return !this.exited
  }

  stderrTail(): string {
    return this.stderr
  }

  /**
   * Send a command and resolve with its `data`. Rejects with the command's own
   * error message on `success: false`, on timeout, or if the process exits
   * first. `timeoutMs` 0 waits indefinitely (compaction and bash can take as
   * long as they take).
   */
  request<T = unknown>(command: { type: string; [key: string]: unknown }, timeoutMs = 30_000): Promise<T> {
    if (this.exited) return Promise.reject(new Error('Eaon Code is not running.'))
    const id = typeof command.id === 'string' && command.id ? command.id : `desk-${++this.nextId}`
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id)
              reject(new Error(`Eaon Code did not answer "${command.type}" within ${Math.round(timeoutMs / 1000)}s.`))
            }, timeoutMs)
          : null
      this.pending.set(id, { resolve: resolve as (data: unknown) => void, reject, timer, type: command.type })
      this.write({ ...command, id })
    })
  }

  /** Write a record that expects no response (extension UI answers). */
  write(record: Record<string, unknown>): void {
    if (this.exited || !this.child.stdin?.writable) return
    this.child.stdin.write(`${JSON.stringify(record)}\n`)
  }

  /**
   * Ask the process to exit and wait for it. Closing stdin is Eaon Code's own
   * shutdown signal; SIGTERM follows for a process busy in a turn, and SIGKILL
   * if it still has not gone.
   */
  stop(graceMs = 3000): Promise<void> {
    if (this.exited) return Promise.resolve()
    this.stopping = true
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(term)
        clearTimeout(kill)
        resolve()
      }
      this.child.once('exit', done)
      this.child.stdin?.end()
      const term = setTimeout(() => this.child.kill('SIGTERM'), Math.min(500, graceMs))
      const kill = setTimeout(() => {
        this.child.kill('SIGKILL')
        // An unkillable child (uninterruptible IO) must not hang app quit.
        setTimeout(done, 500)
      }, graceMs)
    })
  }

  /** Synchronous last resort for app quit, where nothing can be awaited. */
  kill(): void {
    if (this.exited) return
    this.stopping = true
    this.child.kill('SIGTERM')
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    let record: EaonEvent
    try {
      record = JSON.parse(line) as EaonEvent
    } catch {
      // Anything printed before RPC mode takes over stdout (a migration
      // notice, a Node warning) is not protocol; keep it for diagnostics.
      this.appendStderr(`[stdout] ${line}\n`)
      return
    }
    if (record.type === 'response' && typeof record.id === 'string') {
      const pending = this.pending.get(record.id)
      if (pending) {
        this.pending.delete(record.id)
        if (pending.timer) clearTimeout(pending.timer)
        if (record.success === false) pending.reject(new Error(String(record.error ?? `${pending.type} failed`)))
        else pending.resolve(record.data)
        return
      }
    }
    this.options.onEvent(record)
  }

  private appendStderr(text: string): void {
    this.stderr = (this.stderr + text).slice(-STDERR_TAIL)
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return
    this.exited = true
    this.detach()
    const reason = this.stopping
      ? 'Eaon Code was stopped.'
      : `Eaon Code exited${code !== null ? ` with code ${code}` : signal ? ` (${signal})` : ''}.`
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    this.pending.clear()
    this.options.onExit({ code, signal, stderr: this.stderr, expected: this.stopping })
  }
}
