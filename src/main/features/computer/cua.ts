import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

/**
 * Cua Driver (github.com/trycua/cua, MIT), the engine behind computer use.
 *
 * Eaon runs Cua's daemon (`cua-driver serve`) as its own direct child, so on
 * macOS it acts with Eaon's Accessibility and Screen Recording grants — the
 * user approves Eaon and nothing else, and no other name appears in System
 * Settings. Eaon talks to it over MCP through `cua-driver mcp --embedded`,
 * which relays to the daemon's socket.
 *
 * It runs with telemetry and update checks off (Eaon's own releases bring new
 * versions; scripts/fetch-cua-driver.mjs pins it), and keeps its files in
 * Eaon's data folder rather than ~/.cua-driver. With
 * CUA_DRIVER_PARENT_LIVENESS_STDIN the daemon exits when Eaon does, even if
 * Eaon is killed.
 */

export interface CuaTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface CuaContent {
  type: string
  text?: string
  data?: string
  mimeType?: string
}

export interface CuaCallResult {
  content: CuaContent[]
  isError: boolean
}

const HOST_BUNDLE_ID = 'dev.eaon.desktop'
const START_TIMEOUT_MS = 15_000

function platformDir(): string {
  return process.platform === 'darwin' ? 'darwin' : `${process.platform}-${process.arch}`
}

const exeName = (): string => (process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver')

function runnable(path: string | null): path is string {
  if (!path) return false
  try {
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The bundled driver, or null when this build doesn't have one (the old computer tool is used then). */
export function cuaDriverBinary(): string | null {
  const candidates = [
    process.env.EAON_CUA_DRIVER || null,
    // Packaged: extraResources copies resources/cua-driver/<target> to <Resources>/cua-driver/<target>.
    app.isPackaged ? join(process.resourcesPath, 'cua-driver', platformDir(), exeName()) : null,
    // Development: the project's resources folder, next to out/.
    fileURLToPath(new URL(`../../resources/cua-driver/${platformDir()}/${exeName()}`, import.meta.url))
  ]
  return candidates.find(runnable) ?? null
}

/** The version the build ships, from the stamp beside the binary. */
export function cuaDriverVersion(binary: string | null = cuaDriverBinary()): string | null {
  if (!binary) return null
  try {
    return readFileSync(join(binary, '..', 'VERSION'), 'utf8').trim() || null
  } catch {
    return null
  }
}

/**
 * Where the daemon listens. Unix sockets allow about 100 characters, so it
 * lives in the short temp folder, not in Eaon's data folder; on Windows it is
 * a named pipe.
 */
export function socketPath(pid = process.pid): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\eaon-cua-${pid}`
  return join(process.platform === 'darwin' ? tmpdir() : '/tmp', `eaon-cua-${pid}.sock`)
}

/** The environment both Cua processes run with. */
export function cuaEnv(home: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value
  return {
    ...env,
    // No usage data sent anywhere, and no update checks: both are Eaon's business.
    DO_NOT_TRACK: '1',
    CUA_DRIVER_RS_TELEMETRY_ENABLED: '0',
    CUA_DRIVER_RS_UPDATE_CHECK: '0',
    // Its state in Eaon's folder, not the user's home.
    CUA_DRIVER_RS_HOME: home,
    CUA_DRIVER_TELEMETRY_HOME: home,
    CUA_HOME: home,
    // Embedded in Eaon: permissions are Eaon's, and it ends when Eaon does.
    CUA_DRIVER_EMBEDDED: '1',
    CUA_DRIVER_HOST_BUNDLE_ID: HOST_BUNDLE_ID,
    CUA_DRIVER_PARENT_LIVENESS_STDIN: '1'
  }
}

export interface CuaDriverOptions {
  binary: string
  /** Cua's own state folder (inside Eaon's data folder). */
  home: string
  socket?: string
  /** For tests: a different environment to start from. */
  env?: NodeJS.ProcessEnv
}

/** One Cua Driver daemon and Eaon's MCP connection to it, started on first use. */
export class CuaDriver {
  private daemon: ChildProcess | null = null
  private client: Client | null = null
  private starting: Promise<void> | null = null
  private tools: CuaTool[] | null = null
  private lastError: string | null = null
  private readonly socket: string

  constructor(private readonly options: CuaDriverOptions) {
    this.socket = options.socket ?? socketPath()
  }

  get running(): boolean {
    return this.client !== null && this.daemon !== null && this.daemon.exitCode === null
  }

  get error(): string | null {
    return this.lastError
  }

  /** The tools Cua offers, as it describes them; starts it if needed. */
  async listTools(): Promise<CuaTool[]> {
    await this.ensure()
    return this.tools ?? []
  }

  /**
   * The tools, if they are known; never starts anything. Kept on disk per
   * version, so a turn right after launch already has them and Cua only
   * starts when one is used.
   */
  cachedTools(): CuaTool[] | null {
    if (this.tools) return this.tools
    try {
      const saved = JSON.parse(readFileSync(this.toolsFile(), 'utf8')) as CuaTool[]
      if (Array.isArray(saved) && saved.length) this.tools = saved
    } catch {
      /* not fetched yet with this version */
    }
    return this.tools
  }

  private toolsFile(): string {
    return join(this.options.home, `tools-${cuaDriverVersion(this.options.binary) ?? 'unknown'}.json`)
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CuaCallResult> {
    await this.ensure()
    const result = (await this.client!.callTool({ name, arguments: args }, undefined, { signal, timeout: 120_000 })) as {
      content?: CuaContent[]
      isError?: boolean
    }
    return { content: result.content ?? [], isError: Boolean(result.isError) }
  }

  ensure(): Promise<void> {
    if (this.running) return Promise.resolve()
    return (this.starting ??= this.start().finally(() => (this.starting = null)))
  }

  private async start(): Promise<void> {
    await this.stop()
    const { binary, home } = this.options
    mkdirSync(home, { recursive: true })
    if (process.platform !== 'win32') rmSync(this.socket, { force: true })
    const env = cuaEnv(home, this.options.env)
    // Its output goes to a file, not a pipe: once Eaon is gone a pipe has no
    // reader, and the daemon fails to say it is shutting down — and doesn't.
    const log = join(home, 'serve.log')
    if (existsSync(log) && statSync(log).size > 1_000_000) truncateSync(log, 0)
    const out = openSync(log, 'a')
    // Only what this start printed: an earlier run's "listening" isn't this one's.
    const from = statSync(log).size
    const printed = (): string => {
      try {
        return readFileSync(log).subarray(from).toString('utf8').slice(-4000)
      } catch {
        return ''
      }
    }
    // Spawned directly by Eaon: launched any other way (open, a shell), macOS would not lend it Eaon's permissions.
    const daemon = spawn(binary, ['serve', '--socket', this.socket], { env, stdio: ['pipe', out, out], windowsHide: true })
    closeSync(out)
    this.daemon = daemon
    daemon.on('exit', () => {
      if (this.daemon === daemon) {
        this.daemon = null
        void this.client?.close().catch(() => undefined)
        this.client = null
      }
    })
    try {
      await this.waitForSocket(daemon, printed)
      const transport = new StdioClientTransport({
        command: binary,
        args: ['mcp', '--embedded', '--socket', this.socket, '--host-bundle-id', HOST_BUNDLE_ID],
        env,
        stderr: 'pipe'
      })
      const client = new Client({ name: 'eaon', version: app.getVersion() })
      await client.connect(transport, { timeout: START_TIMEOUT_MS })
      const { tools } = await client.listTools(undefined, { timeout: START_TIMEOUT_MS })
      this.client = client
      this.tools = tools.map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema as Record<string, unknown> }))
      this.lastError = null
      try {
        writeFileSync(this.toolsFile(), JSON.stringify(this.tools))
      } catch {
        /* fetched again next launch */
      }
    } catch (error) {
      const said = printed().trim().split('\n').pop()
      this.lastError = `Cua Driver didn't start: ${(error as Error).message}${said ? ` (${said})` : ''}`
      await this.stop()
      throw new Error(this.lastError)
    }
  }

  private async waitForSocket(daemon: ChildProcess, printed: () => string): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (daemon.exitCode !== null) throw new Error(`it exited (${daemon.exitCode})`)
      // A named pipe can't be checked for; the daemon says when it listens.
      if (process.platform === 'win32' ? /listening/i.test(printed()) : existsSync(this.socket)) return
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error('it took too long to start')
  }

  /** Ends both processes: on quit, when computer use is turned off, and as the emergency stop. */
  async stop(): Promise<void> {
    const client = this.client
    const daemon = this.daemon
    this.client = null
    this.daemon = null
    await client?.close().catch(() => undefined)
    if (daemon && daemon.exitCode === null) {
      // Closing its stdin is how it is told Eaon is done (PARENT_LIVENESS_STDIN); a kill if it doesn't listen.
      daemon.stdin?.end()
      const exited = new Promise<void>((r) => daemon.once('exit', () => r()))
      const timer = setTimeout(() => daemon.kill('SIGKILL'), 2000)
      await exited
      clearTimeout(timer)
    }
    if (process.platform !== 'win32') rmSync(this.socket, { force: true })
  }
}

let driver: CuaDriver | null | undefined

/** The app's one driver, or null when this build has none. */
export function cuaDriver(): CuaDriver | null {
  if (driver !== undefined) return driver
  const binary = cuaDriverBinary()
  driver = binary ? new CuaDriver({ binary, home: join(app.getPath('userData'), 'cua-driver') }) : null
  return driver
}

/** For tests: a driver of their own (or none). */
export function setCuaDriver(next: CuaDriver | null): void {
  driver = next
}
