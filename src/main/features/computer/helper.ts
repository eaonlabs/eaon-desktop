import { spawn, type ChildProcess } from 'node:child_process'

/**
 * A long-lived helper process spoken to in JSON lines: `{id, cmd, ...}` in,
 * `{id, ok, result | error}` out.
 *
 * Why persistent: a fresh `osascript` costs 40–70 ms before it does anything
 * (measured on an M5) and PowerShell plus its Add-Type compile costs a second
 * or more, per action. One process started on first use makes each action a
 * pipe round trip.
 *
 * The wire is ASCII only — everything above 0x7E is \u-escaped. A pipe read
 * can split a multi-byte UTF-8 character, and JXA's NSString decoding turns a
 * split read into nil rather than half a character.
 */

export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class LineHelper {
  private proc: ChildProcess | null = null
  private buffer = ''
  private stderr = ''
  private nextId = 1
  private pending = new Map<number, Pending>()

  constructor(
    private readonly name: string,
    private readonly command: string,
    private readonly args: () => string[]
  ) {}

  request<T = unknown>(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    const proc = this.ensure()
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // A helper that stopped answering cannot be trusted with the next
        // action either; start a clean one next time.
        this.kill()
        reject(new Error(`The ${this.name} helper did not answer "${cmd}" within ${Math.round(timeoutMs / 1000)}s.`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      proc.stdin?.write(`${asciiJson({ id, cmd, ...args })}\n`)
    })
  }

  kill(): void {
    const proc = this.proc
    this.proc = null
    if (proc && proc.exitCode === null) proc.kill()
  }

  private ensure(): ChildProcess {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) return this.proc
    const proc = spawn(this.command, this.args(), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.proc = proc
    this.buffer = ''
    this.stderr = ''
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => this.onData(chunk))
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-2000)
    })
    const fail = (reason: string): void => {
      if (this.proc === proc) this.proc = null
      const detail = this.stderr.trim()
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer)
        entry.reject(new Error(`The ${this.name} helper ${reason}${detail ? `: ${detail.split('\n').slice(-3).join(' ')}` : '.'}`))
        this.pending.delete(id)
      }
    }
    proc.on('error', (error) => fail(`could not start (${error.message})`))
    proc.on('exit', (code, signal) => fail(`exited (${signal ?? code})`))
    // Writing to a helper that just died raises EPIPE on stdin; the exit
    // handler already reports it.
    proc.stdin?.on('error', () => {})
    return proc
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      newline = this.buffer.indexOf('\n')
      if (!line.startsWith('{')) continue
      let message: { id?: number; ok?: boolean; result?: unknown; error?: string }
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      const entry = typeof message.id === 'number' ? this.pending.get(message.id) : undefined
      if (!entry) continue
      this.pending.delete(message.id as number)
      clearTimeout(entry.timer)
      if (message.ok) entry.resolve(message.result ?? null)
      else entry.reject(new Error(message.error || 'The helper reported an unknown error.'))
    }
  }
}
