import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { accessSync, constants, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'

/**
 * Eaon's own local runtime: the `llama-server` built from Eaon's llama.cpp
 * (scripts/build-llama.sh — upstream plus the pull requests for architectures
 * not merged yet), shipped inside the app. No Ollama, nothing to install.
 *
 * One chat model and one embedding model can be loaded at a time, each its
 * own llama-server on a random loopback port with a random API key. A model
 * is loaded on first use and unloaded after sitting idle, so a 17 GB model
 * does not hold the memory once the chat is over.
 *
 * Each server runs in its own process group and is sent exactly one SIGTERM.
 * llama-server treats a second SIGTERM/SIGINT during shutdown as "terminate
 * immediately" and calls exit() from inside its signal handler, which aborts in
 * Metal's teardown — macOS then reports "llama-server quit unexpectedly". In
 * Eaon's process group, a terminal's Ctrl+C (or closing the terminal Eaon was
 * started from) reached llama-server as well as Eaon's own SIGTERM on quit.
 * Being detached also means a server can outlive an Eaon that crashed, so live
 * pids are recorded and any left over are stopped on the next launch.
 */

export interface RuntimeModel {
  id: string
  path: string
  mmprojPath?: string
  /** Largest context the model was trained for; the runtime asks for less. */
  contextLength?: number
}

export interface RuntimeTarget {
  baseUrl: string
  apiKey: string
}

export interface RuntimeStatus {
  binary: string | null
  version: string | null
  chat: { modelId: string; state: 'loading' | 'ready' } | null
  embedding: { modelId: string; state: 'loading' | 'ready' } | null
}

const IDLE_MS = 15 * 60_000
const LOAD_TIMEOUT_MS = 5 * 60_000
/** Chat context per request. The KV cache is allocated up front, so this is memory, not a limit anyone reaches often. */
const CHAT_CONTEXT = 32_768
const EMBED_CONTEXT = 8_192
/**
 * CPU threads for generation and prompt processing. Left to itself llama.cpp
 * takes every core, and on a machine without a GPU it can use (Linux, Intel
 * Macs, Windows on Arm) each local reply, worker heartbeat and indexing batch
 * then pins the whole computer. Half the cores keeps it usable.
 */
const THREADS = Math.max(1, Math.floor(availableParallelism() / 2))

const platformDir = (): string => `${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
const binaryName = (): string => (process.platform === 'win32' ? 'llama-server.exe' : 'llama-server')

/** The bundled llama-server for this machine, or null when this build has none. */
export function llamaBinary(): string | null {
  const candidates = [
    // A llama-server of your own (a development build, or a test's stand-in).
    process.env.EAON_LLAMA_SERVER || null,
    // Packaged: extraResources copies resources/llama to <Resources>/llama.
    app.isPackaged ? join(process.resourcesPath, 'llama', platformDir(), binaryName()) : null,
    // Development: the project's resources folder, next to out/.
    fileURLToPath(new URL(`../../resources/llama/${platformDir()}/${binaryName()}`, import.meta.url))
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      /* not here */
    }
  }
  return null
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('No free port'))))
    })
  })
}

/**
 * Windows' NTSTATUS exit codes, which Node reports unsigned (3221225781) and
 * some tools signed (-1073741515). DLL_NOT_FOUND and ENTRYPOINT_NOT_FOUND are
 * a missing or outdated Visual C++ runtime: the upstream Windows builds Eaon
 * ships link against it but do not include it.
 */
const isStatus = (code: number | null, status: number): boolean => code === status || code === status - 2 ** 32
const STATUS_DLL_NOT_FOUND = 0xc0000135
const STATUS_ENTRYPOINT_NOT_FOUND = 0xc0000139
const STATUS_ILLEGAL_INSTRUCTION = 0xc000001d

/**
 * A failed load, said plainly. llama-server's own last lines are kept for the
 * details; the common causes get a sentence a person can act on.
 */
export function explainFailure(log: string[], exitCode: number | null, signal: NodeJS.Signals | null = null): string {
  // These die before llama-server writes anything useful, so how it exited is the whole story.
  if (isStatus(exitCode, STATUS_DLL_NOT_FOUND) || isStatus(exitCode, STATUS_ENTRYPOINT_NOT_FOUND)) {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    return (
      'The local runtime could not start because the Microsoft Visual C++ Redistributable is missing or out of date. ' +
      `Install the Microsoft Visual C++ Redistributable for Visual Studio 2015–2022 (${arch}) from https://aka.ms/vs/17/release/vc_redist.${arch}.exe, then try again.`
    )
  }
  if (signal === 'SIGILL' || isStatus(exitCode, STATUS_ILLEGAL_INSTRUCTION)) {
    return `This computer’s processor lacks instructions the local runtime needs${process.arch === 'x64' ? ' (AVX2)' : ''}, so local models cannot run on it. Use a cloud model instead.`
  }
  const text = log.join('\n')
  const arch = /unknown model architecture: '([^']+)'/.exec(text)
  if (arch) return `This model’s architecture (${arch[1]}) isn’t supported by Eaon’s llama.cpp yet.`
  if (/failed to allocate|out of memory|ggml_metal.*error|insufficient memory/i.test(text)) {
    return 'The model did not fit in memory. Close other apps, or pick a smaller variant of this model.'
  }
  if (/invalid magic|failed to load model|gguf_init/i.test(text)) return 'The model file could not be read. Delete it on the Models page and download it again.'
  // Eaon's own stop is reported before this is reached, so a SIGKILL came from the system: the OOM killer, or macOS reclaiming memory.
  if (signal === 'SIGKILL') return 'The system stopped the local model while it loaded, most likely because the computer ran out of memory. Close other apps, or pick a smaller variant of this model.'
  const tail = log.filter((line) => line.trim()).slice(-3).join(' ').slice(0, 300)
  const how = signal ? ` (${signal})` : exitCode !== null ? ` (exit ${exitCode})` : ''
  return `The local model stopped while loading${how}${tail ? `: ${tail}` : '.'}`
}

/** Servers this process started and has not seen exit; recorded so a crash cannot leave them behind. */
const running = new Set<LlamaServer>()
const recordPath = (): string => join(app.getPath('userData'), 'llama-servers.json')

function readRecord(): number[] {
  try {
    const pids: unknown = JSON.parse(readFileSync(recordPath(), 'utf8'))
    return Array.isArray(pids) ? pids.filter((pid): pid is number => Number.isInteger(pid) && pid > 0) : []
  } catch {
    return []
  }
}

function writeRecord(): void {
  try {
    writeFileSync(recordPath(), JSON.stringify([...running].map((server) => server.pid).filter(Boolean)))
  } catch {
    // Best effort: without the record, a crash can leave a server running until it is quit by hand.
  }
}

// Eaon going away without its normal quit (an uncaught exception, app.exit) still stops its servers.
process.on('exit', () => {
  for (const server of running) server.stop()
})

export class LlamaServer {
  readonly apiKey = randomBytes(24).toString('hex')
  readonly log: string[] = []
  state: 'loading' | 'ready' = 'loading'
  lastUsed = Date.now()
  /** Requests running against it right now (`LlamaRuntime.use`); a server in use is never unloaded as idle. */
  inUse = 0
  ready!: Promise<void>
  private child: ChildProcess | null = null
  private exited = false
  private stopping = false

  constructor(
    readonly modelId: string,
    readonly key: string,
    readonly port: number
  ) {}

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  start(binary: string, args: string[]): void {
    // Its own process group (see the top of this file). Windows has no process-group signals, and there
    // `detached` would open a console window.
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
    this.child = child
    if (child.pid) {
      running.add(this)
      writeRecord()
    }
    const keep = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (!line.trim()) continue
        this.log.push(line)
        if (this.log.length > 80) this.log.shift()
      }
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('exit', (code, signal) => {
        this.exited = true
        if (running.delete(this)) writeRecord()
        resolve({ code, signal })
      })
      child.on('error', (error) => {
        this.log.push(String(error))
        this.exited = true
        if (running.delete(this)) writeRecord()
        resolve({ code: null, signal: null })
      })
    })
    this.ready = (async () => {
      const deadline = Date.now() + LOAD_TIMEOUT_MS
      while (Date.now() < deadline) {
        const outcome = await Promise.race([exit, this.probe(), new Promise<'wait'>((r) => setTimeout(() => r('wait'), 300))])
        if (outcome === 'ok') {
          this.state = 'ready'
          return
        }
        if (typeof outcome === 'object') {
          // Unloaded (or replaced by another model) before it was ready: Eaon's doing, not a failure to explain.
          if (this.stopping) throw new Error('The local model was unloaded before it finished loading.')
          throw new Error(explainFailure(this.log, outcome.code, outcome.signal))
        }
      }
      this.stop()
      throw new Error('The local model took more than 5 minutes to load, so Eaon gave up. It may be too big for this computer.')
    })()
  }

  /** llama-server answers /health with 503 while loading and 200 once the model is in. */
  private async probe(): Promise<'ok' | 'wait'> {
    if (this.exited) return 'wait'
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(1000) })
      return response.ok ? 'ok' : 'wait'
    } catch {
      return 'wait'
    }
  }

  get alive(): boolean {
    return !this.exited
  }

  /** One SIGTERM, however often it is called; SIGKILL if it is still there 3 seconds later. */
  stop(): void {
    if (this.exited || this.stopping || !this.child) return
    this.stopping = true
    this.child.kill('SIGTERM')
    const child = this.child
    setTimeout(() => {
      if (!this.exited) child.kill('SIGKILL')
    }, 3000).unref()
  }
}

class LlamaRuntime {
  private servers: { chat: LlamaServer | null; embedding: LlamaServer | null } = { chat: null, embedding: null }
  /**
   * A start in progress per slot. Starting awaits a free port before the
   * server is in its slot, so callers that arrive together (workers waking at
   * once) each spawned a server and loaded the model again, and all but the
   * last were never stopped. They share this one instead.
   */
  private starting: Record<'chat' | 'embedding', { key: string; server: Promise<LlamaServer> } | null> = { chat: null, embedding: null }
  /** Every server this runtime started and has not stopped, so one no slot holds any more is still stopped. */
  private started = new Set<LlamaServer>()
  private version: string | null = null
  private idleTimer: ReturnType<typeof setInterval> | null = null

  /** The server for `model`, loading it (and unloading whatever else held the slot) first. */
  async ensure(model: RuntimeModel, kind: 'chat' | 'embedding' = 'chat'): Promise<RuntimeTarget> {
    const server = await this.serverFor(model, kind)
    return { baseUrl: server.baseUrl, apiKey: server.apiKey }
  }

  /**
   * Runs one request against `model`, holding its server for as long as the
   * request lasts: a server with a request in flight is never unloaded as
   * idle, however long the reply streams.
   */
  async use<T>(model: RuntimeModel, kind: 'chat' | 'embedding', request: (target: RuntimeTarget) => Promise<T>): Promise<T> {
    const server = await this.serverFor(model, kind)
    server.inUse++
    try {
      return await request({ baseUrl: server.baseUrl, apiKey: server.apiKey })
    } finally {
      server.inUse--
      server.lastUsed = Date.now()
    }
  }

  private async serverFor(model: RuntimeModel, kind: 'chat' | 'embedding'): Promise<LlamaServer> {
    const binary = llamaBinary()
    if (!binary) throw new Error('This build of Eaon has no local runtime (llama-server). Run scripts/build-llama.sh, or use a cloud model.')
    const key = [model.path, model.mmprojPath ?? '', kind].join('|')
    let server = this.servers[kind]
    if (!server || server.key !== key || !server.alive) server = await this.start(binary, model, kind, key)
    server.lastUsed = Date.now()
    try {
      await server.ready
    } catch (error) {
      if (this.servers[kind] === server) this.servers[kind] = null
      throw error
    }
    server.lastUsed = Date.now()
    return server
  }

  /** Starts `model` in its slot, or joins the start already under way for it. */
  private start(binary: string, model: RuntimeModel, kind: 'chat' | 'embedding', key: string): Promise<LlamaServer> {
    const pending = this.starting[kind]
    if (pending?.key === key) return pending.server
    const entry: { key: string; server: Promise<LlamaServer> } = {
      key,
      server: freePort().then((port) => {
        // Asked for something else (or unloaded) while the port was found: whatever came later has the slot.
        if (this.starting[kind] !== entry) {
          throw new Error(this.starting[kind] ? 'Another local model was loaded in its place: one runs at a time.' : 'The local model was unloaded before it finished loading.')
        }
        this.starting[kind] = null
        const server = new LlamaServer(model.id, key, port)
        this.servers[kind] = server
        // Stops the server this one replaces before it starts, so its memory is on its way back first.
        this.sweep()
        this.started.add(server)
        server.start(binary, this.args(model, kind, server))
        this.watchIdle()
        return server
      })
    }
    this.starting[kind] = entry
    // A failed start must not hold the slot; nobody else needs to see the error twice.
    entry.server.catch(() => {
      if (this.starting[kind] === entry) this.starting[kind] = null
    })
    return entry.server
  }

  /** Stops every server this runtime started that no slot holds. */
  private sweep(): void {
    for (const server of this.started) {
      if (server === this.servers.chat || server === this.servers.embedding) continue
      this.started.delete(server)
      server.stop()
    }
  }

  private args(model: RuntimeModel, kind: 'chat' | 'embedding', server: LlamaServer): string[] {
    const context = Math.min(kind === 'chat' ? CHAT_CONTEXT : EMBED_CONTEXT, model.contextLength ?? Infinity)
    const common = [
      '-m', model.path,
      '--host', '127.0.0.1',
      '--port', String(server.port),
      '--api-key', server.apiKey,
      '--alias', model.id,
      '-c', String(context),
      // Every layer on the GPU (Metal); llama.cpp keeps what does not fit on the CPU.
      '-ngl', '999',
      '-t', String(THREADS),
      '-tb', String(THREADS),
      // Threads waiting for work sleep. llama.cpp's default (50) spins them, which on a CPU-only
      // machine keeps every one of them busy between tokens and between requests.
      '--poll', '0',
      '--no-webui'
    ]
    if (kind === 'embedding') return [...common, '--embedding']
    return [
      ...common,
      // The model's own chat template (tool calls included), not a guess.
      '--jinja',
      '-fa', 'auto',
      ...(model.mmprojPath ? ['--mmproj', model.mmprojPath] : [])
    ]
  }

  private watchIdle(): void {
    if (this.idleTimer) return
    this.idleTimer = setInterval(() => {
      for (const kind of ['chat', 'embedding'] as const) {
        const server = this.servers[kind]
        if (server && server.state === 'ready' && server.inUse === 0 && Date.now() - server.lastUsed > IDLE_MS) {
          server.stop()
          this.servers[kind] = null
        }
      }
      this.sweep()
      if (!this.servers.chat && !this.servers.embedding && !this.starting.chat && !this.starting.embedding && this.idleTimer) {
        clearInterval(this.idleTimer)
        this.idleTimer = null
      }
    }, 60_000)
    this.idleTimer.unref()
  }

  async status(): Promise<RuntimeStatus> {
    const binary = llamaBinary()
    if (binary && this.version === null) this.version = await readVersion(binary)
    const describe = (server: LlamaServer | null): RuntimeStatus['chat'] => (server?.alive ? { modelId: server.modelId, state: server.state } : null)
    return { binary, version: this.version, chat: describe(this.servers.chat), embedding: describe(this.servers.embedding) }
  }

  unload(kind?: 'chat' | 'embedding'): void {
    for (const k of kind ? [kind] : (['chat', 'embedding'] as const)) {
      // A start still finding its port sees this and never spawns.
      this.starting[k] = null
      this.servers[k] = null
    }
    this.sweep()
  }

  /**
   * Launch: stop any llama-server a crashed Eaon left running (it would hold the model's memory).
   * Only pids from the record whose process is still a llama-server; a pid reused by anything else is left alone.
   */
  async reapOrphans(): Promise<void> {
    const pids = readRecord().filter((pid) => ![...running].some((server) => server.pid === pid))
    writeRecord()
    if (process.platform === 'win32') return
    await Promise.all(
      pids.map(async (pid) => {
        if (!(await isLlamaServer(pid))) return
        try {
          process.kill(pid, 'SIGTERM')
        } catch {
          return
        }
        setTimeout(() => {
          void isLlamaServer(pid).then((still) => still && process.kill(pid, 'SIGKILL'))
        }, 3000).unref()
      })
    )
  }

  /** Quit: stop every server, and wait a moment for them to go. */
  async shutdown(): Promise<void> {
    this.unload()
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

/** Whether `pid` is a running llama-server (by its executable's name). */
function isLlamaServer(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'comm=', '-p', String(pid)], (error, stdout) => resolve(!error && /(^|\/)llama-server$/.test(stdout.trim())))
  })
}

function readVersion(binary: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (out += d.toString()))
    child.on('error', () => resolve(null))
    child.on('exit', () => resolve(/version:\s*(\S+(?:\s*\([^)]*\))?)/.exec(out)?.[1] ?? null))
    setTimeout(() => child.kill(), 5000).unref()
  })
}

export const llamaRuntime = new LlamaRuntime()
