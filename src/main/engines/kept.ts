import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { app } from 'electron'
import type { SshHost } from '@shared/adeRemote'
import { shQuote, sshBinary } from '../features/ade/ssh'
import { sshCallArgv, sshRun } from '../remoteWork'
import { KEEPER_PATH, KEEPER_SOURCE } from './keeper'
import type { RemotePlace } from './remote'

/**
 * An agent on a cloud environment's machine that keeps running when this
 * computer doesn't: started there by the keeper (engines/keeper.ts), and
 * driven from here as if it were a child process. Codex's app-server and
 * Claude Code see their stdin and stdout as always; in between, what Eaon
 * sends is appended to the run's `in` file and what the agent says is read
 * back from its `out` file, from the byte Eaon had got to.
 *
 * So the connection can drop (the laptop shut, the Wi-Fi gone) and the agent
 * goes on. The reader reconnects by itself, quietly and for as long as the
 * run lasts, and picks up exactly where it was; what Eaon sent while it was
 * away goes once it is back. Quitting Eaon leaves the run going too: `kill`
 * and closing stdin then only let go of it here.
 */

/** Quitting: whatever is running over there stays running. */
let quitting = false
app?.on?.('before-quit', () => {
  quitting = true
})
// However the app ends (a crash, a signal), nothing on its way out ends a run there either.
process.once('exit', () => {
  quitting = true
})

/** The keeper, as the remote shell writes its path. */
const KEEPER = KEEPER_PATH.replace(/^~/, '"$HOME"')
/** A run's file, as the remote shell writes its path. */
const fileOf = (dir: string, name: string): string => `${dir.replace(/^~/, '"$HOME"')}/${name}`
/** The keeper doing `what` to the run in `dir`. */
const keeper = (what: string, dir: string, ...rest: string[]): string => `python3 ${KEEPER} ${[what, dir, ...rest].map(shQuote).join(' ')}`

/** Where a run's files are on the host; the keeper reads `~` itself. */
export const runDir = (id: string): string => `~/.eaon/runs/${id}`

/** The keeper put on each host this run, by host id. */
const installed = new Map<string, Promise<void>>()

/** The keeper on the host: written once (its name is its hash), and python3 there to run it. */
export function ensureKeeper(host: SshHost): Promise<void> {
  let ready = installed.get(host.id)
  if (!ready) {
    const line = `command -v python3 >/dev/null || exit 3; mkdir -p "$HOME/.eaon/runs" && f=${KEEPER} && { [ -s "$f" ] || cat > "$f"; }`
    ready = sshRun(host, `sh -c ${shQuote(line)}`, { stdin: KEEPER_SOURCE, timeoutMs: 60_000 }).then((result) => {
      if (result.code === 0) return
      installed.delete(host.id)
      if (result.code === 3) throw new Error(`python3 isn’t installed on ${host.label}, and Eaon needs it there to keep the agent running while this computer is away. Install it there, then try again.`)
      throw new Error(`Couldn’t set up ${host.label}: ${result.stderr.trim().split('\n').pop() || 'no answer'}`)
    })
    installed.set(host.id, ready)
  }
  return ready
}

export type RunState = { state: 'running'; size: number } | { state: 'done'; code: number } | { state: 'missing' }

/** How a run on the host is doing; null when the host can't say. */
export async function runState(host: SshHost, dir: string): Promise<RunState | null> {
  await ensureKeeper(host)
  const result = await sshRun(host, keeper('status', dir), { timeoutMs: 20_000 })
  if (result.code !== 0) return null
  const said = result.stdout.toString('utf8').trim()
  if (said === 'missing') return { state: 'missing' }
  const done = /^done (-?\d+)/.exec(said)
  if (done) return { state: 'done', code: Number(done[1]) }
  const running = /^running (\d+)/.exec(said)
  return running ? { state: 'running', size: Number(running[1]) } : null
}

/** Ends a run on the host. */
export async function stopRun(host: SshHost, dir: string): Promise<void> {
  await ensureKeeper(host)
  await sshRun(host, keeper('stop', dir), { timeoutMs: 20_000 })
}

export interface KeptOptions {
  place: Pick<RemotePlace, 'host' | 'root' | 'where'>
  program: string
  args: string[]
  env?: Record<string, string>
  /** Picks up a run already going there, reading its output from byte `from` on. */
  attach?: { dir: string; from: number }
  /**
   * Closing stdin ends the agent's input there (Claude Code, which ends with
   * its turn), and `kill` ends it. Off for a server that outlives its
   * connections (Codex's app-server): both then only let go of it here.
   */
  endInput?: boolean
}

/** Delays between tries to reach the run again: quick at first, then every 15 s for as long as it runs. */
const RETRY_MS = [500, 1000, 2000, 4000, 8000, 15_000]

/**
 * A run on the host, as a child process: `stdin`, `stdout`, `stderr`, `kill`
 * and the `exit` event, which is all Codex's app-server wrapper and the Claude
 * Agent SDK use of one.
 */
export class KeptProcess extends EventEmitter {
  readonly stdin: Writable
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  /** The run's folder on the host. */
  readonly dir: string
  readonly pid: number | undefined = undefined
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false
  /** Bytes of `out` read so far: where a reader picks up. */
  offset: number
  private reader: ChildProcess | null = null
  private retries = 0
  private readonly outbox: Buffer[] = []
  private sending = false
  private inputEnded = false
  private released = false
  private readonly started: Promise<void>

  constructor(private readonly options: KeptOptions) {
    super()
    this.dir = options.attach?.dir ?? runDir(randomUUID())
    this.offset = options.attach?.from ?? 0
    const self = this
    this.stdin = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        self.outbox.push(Buffer.from(chunk))
        void self.flush()
        callback()
      },
      final(callback) {
        self.inputEnded = true
        void self.flush()
        callback()
      }
    })
    this.started = this.start()
    this.started.then(
      () => this.read(),
      (error: Error) => this.fail(error)
    )
  }

  private get host(): SshHost {
    return this.options.place.host
  }

  /** The keeper there, then the agent started under it, in the session's folder (unless picking one up). */
  private async start(): Promise<void> {
    await ensureKeeper(this.host)
    if (this.options.attach) return
    const vars = Object.entries(this.options.env ?? {}).map(([name, value]) => `${name}=${value}`)
    const { root, where } = this.options.place
    // Through a login shell, so the agent is found on the PATH a terminal there has.
    const line = `cd ${shQuote(root)} && exec ${keeper('start', this.dir, root, ...vars, '--', this.options.program, ...this.options.args)}`
    const result = await sshRun(this.host, `exec "$SHELL" -lc ${shQuote(line)}`, { timeoutMs: 60_000 })
    if (result.code !== 0 || !result.stdout.toString('utf8').includes('started')) {
      throw new Error(`Couldn’t start ${this.options.program} on ${where}: ${result.stderr.trim().split('\n').pop() || 'no answer'}`)
    }
  }

  /** Reads `out` from where it got to: a dropped connection is tried again, the run's end ends it. */
  private read(): void {
    if (this.released || this.exitCode !== null) return
    const child = spawn(sshBinary(), [...sshCallArgv(this.host), keeper('read', this.dir, String(this.offset))], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    this.reader = child
    child.stdout?.on('data', (chunk: Buffer) => {
      this.retries = 0
      this.offset += chunk.length
      this.stdout.write(chunk)
    })
    child.stderr?.resume()
    child.on('error', () => undefined)
    child.on('close', (code) => {
      if (this.reader === child) this.reader = null
      if (this.released || this.exitCode !== null) return
      if (code === 0) return void this.finished()
      if (code === 4) return this.fail(new Error(`The run on ${this.options.place.where} is gone.`))
      // A reader that had nothing to pass on for a while: another, at once.
      if (code === 6) return this.read()
      // The connection went, or the machine was away: again, from the same byte.
      const wait = RETRY_MS[Math.min(this.retries++, RETRY_MS.length - 1)]
      setTimeout(() => this.read(), wait).unref?.()
    })
  }

  /** Sends what is waiting, in order, each piece until it arrives; then the end of input, when asked for. */
  private async flush(): Promise<void> {
    if (this.sending) return
    this.sending = true
    try {
      await this.started.catch(() => undefined)
      while (!this.released && this.exitCode === null) {
        if (this.outbox.length > 0) {
          const count = this.outbox.length
          const sent = await sshRun(this.host, `cat >> ${fileOf(this.dir, 'in')}`, { stdin: Buffer.concat(this.outbox.slice(0, count)), timeoutMs: 60_000 })
          if (sent.code === 0) this.outbox.splice(0, count)
          else await new Promise((resolve) => setTimeout(resolve, 2000))
          continue
        }
        if (this.inputEnded && this.options.endInput && !quitting) {
          await sshRun(this.host, keeper('eof', this.dir), { timeoutMs: 30_000 })
          this.inputEnded = false
        }
        return
      }
    } finally {
      this.sending = false
    }
  }

  /** The run ended there: its code, and the end of what it said on stderr when it failed. */
  private async finished(): Promise<void> {
    const state = await runState(this.host, this.dir).catch(() => null)
    const code = state?.state === 'done' ? state.code : 0
    if (code !== 0) {
      const err = await sshRun(this.host, `tail -c 4000 ${fileOf(this.dir, 'err')}`, { timeoutMs: 20_000 })
      this.stderr.write(err.stdout)
    }
    this.exit(code, null)
  }

  private fail(error: Error): void {
    if (this.exitCode !== null) return
    this.stderr.write(`${error.message}\n`)
    this.emit('error', error)
    this.exit(1, null)
  }

  private exit(code: number, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null) return
    this.exitCode = code
    this.signalCode = signal
    this.stdout.end()
    this.stderr.end()
    this.emit('exit', code, signal)
    this.emit('close', code, signal)
  }

  /**
   * Ends the agent there; for a server that outlives its connections, or
   * while Eaon quits, only lets go of it here, and it goes on.
   */
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.exitCode !== null) return false
    this.killed = true
    if (!quitting && this.options.endInput) void stopRun(this.host, this.dir)
    this.release(signal)
    return true
  }

  /** Lets go of the run here; it keeps going there. */
  release(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.released) return
    this.released = true
    this.reader?.kill('SIGTERM')
    this.reader = null
    this.exit(0, signal)
  }
}
