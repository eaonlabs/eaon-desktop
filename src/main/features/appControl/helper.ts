import { spawn, type ChildProcess } from 'node:child_process'
import { failure, AppControlFailure, type AppControlEngine } from './protocol'

/**
 * The engine process: one long-lived child per app run, speaking JSON lines
 * (native/app-control/mac, resources/app-control/linux and win32). Requests
 * go one at a time, in order. A request that takes too long kills the
 * process (an app that has hung can wedge an accessibility call), and the
 * next one starts a fresh engine; `epoch` moves on, so refs from before are
 * stale rather than pointing at the wrong element.
 */

export interface HelperLaunch {
  command: string
  args: string[]
  env?: Record<string, string>
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_TIMEOUT_MS = 15_000

export class HelperEngine implements AppControlEngine {
  epoch = 0
  private child: ChildProcess | null = null
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private queue: Promise<unknown> = Promise.resolve()
  private buffer = ''
  private stderr = ''

  constructor(
    readonly platform: NodeJS.Platform,
    private readonly launch: () => HelperLaunch | null
  ) {}

  call<T>(op: string, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    const run = (): Promise<T> => this.send<T>(op, params, timeoutMs)
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  /** The last thing the engine wrote to stderr, for the status line when it won't start. */
  lastError(): string | null {
    return this.stderr.trim().split('\n').slice(-3).join(' ') || null
  }

  private start(): ChildProcess {
    const launch = this.launch()
    if (!launch) throw failure('ENGINE_UNAVAILABLE', 'This build has no app-control engine for this computer.')
    const child = spawn(launch.command, launch.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...launch.env },
      windowsHide: true
    })
    this.epoch += 1
    this.buffer = ''
    this.stderr = ''
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => this.receive(chunk))
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000)
    })
    const gone = (why: string): void => {
      if (this.child !== child) return
      this.child = null
      for (const [id, waiting] of this.pending) {
        clearTimeout(waiting.timer)
        waiting.reject(failure('ENGINE_UNAVAILABLE', `The app-control engine stopped (${why}).${this.lastError() ? ` ${this.lastError()}` : ''}`))
        this.pending.delete(id)
      }
    }
    child.on('error', (error) => gone(error.message))
    child.on('exit', (code, signal) => gone(signal ? `signal ${signal}` : `exit ${code}`))
    // Writing to an engine that has just died is reported through 'exit'.
    child.stdin!.on('error', () => undefined)
    this.child = child
    return child
  }

  private receive(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      newline = this.buffer.indexOf('\n')
      if (!line) continue
      let message: { id?: unknown; ok?: unknown; result?: unknown; code?: unknown; message?: unknown }
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      const waiting = typeof message.id === 'number' ? this.pending.get(message.id) : undefined
      if (!waiting) continue
      this.pending.delete(message.id as number)
      clearTimeout(waiting.timer)
      if (message.ok === true) waiting.resolve(message.result)
      else waiting.reject(new AppControlFailure((typeof message.code === 'string' ? message.code : 'INTERNAL') as AppControlFailure['code'], typeof message.message === 'string' ? message.message : 'The engine failed.'))
    }
  }

  private send<T>(op: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const child = this.child ?? this.start()
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(failure('TIMEOUT', `The app didn't answer within ${Math.round(timeoutMs / 1000)}s (it may be busy or hung).`, 'Try again, or snapshot a smaller part of it with --root.'))
        // Whatever it was stuck on would hold up every later request.
        this.kill()
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      child.stdin!.write(`${JSON.stringify({ id, op, ...params })}\n`)
    })
  }

  private kill(): void {
    const child = this.child
    this.child = null
    if (!child) return
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer)
      waiting.reject(failure('ENGINE_UNAVAILABLE', 'The app-control engine was restarted.'))
      this.pending.delete(id)
    }
    child.stdin?.end()
    child.kill()
  }

  dispose(): void {
    this.kill()
  }
}
