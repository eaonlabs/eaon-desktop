import { closeSync, existsSync, mkdirSync, openSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { layout } from './setup'

/**
 * One Browser Use MCP server (`browser-use --mcp`), attached to the user's
 * browser at a DevTools address. Kept running between calls: each new
 * connection makes the browser ask the user to Allow it, so a session lasts
 * until the browser restarts (its address changes), the switch is turned
 * off, or Eaon quits.
 */

export interface BrowserUseTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface BrowserUseContent {
  type: string
  text?: string
  data?: string
  mimeType?: string
}

/** The environment Browser Use runs with: no telemetry, no cloud, no version checks, nothing in the user's home. */
export function browserUseEnv(root: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const paths = layout(root)
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value
  return {
    ...env,
    ANONYMIZED_TELEMETRY: 'false',
    BROWSER_USE_CLOUD_SYNC: 'false',
    BROWSER_USE_VERSION_CHECK: 'false',
    BROWSER_USE_CONFIG_DIR: paths.config,
    BROWSER_USE_LOGGING_LEVEL: 'warning',
    BROWSER_USE_DISABLE_EXTENSIONS: 'true',
    XDG_CONFIG_HOME: join(paths.home, '.config'),
    XDG_CACHE_HOME: join(paths.home, '.cache'),
    // Its scratch files (a to-do list it keeps, and the like) go here, not in the user's home.
    HOME: paths.home,
    USERPROFILE: paths.home
  }
}

/** Browser Use's config: one profile, attached to the user's browser, downloads in their Downloads folder. */
export function writeConfig(root: string, cdpUrl: string, downloads = join(homedir(), 'Downloads')): void {
  const paths = layout(root)
  mkdirSync(paths.config, { recursive: true })
  writeFileSync(
    join(paths.config, 'config.json'),
    JSON.stringify({
      browser_profile: { eaon: { id: 'eaon', default: true, cdp_url: cdpUrl, headless: false, keep_alive: true, downloads_path: downloads } },
      llm: {},
      agent: {}
    })
  )
}

export class BrowserUseSession {
  private client: Client | null = null
  private cdpUrl: string | null = null
  private tools: BrowserUseTool[] | null = null
  private starting: Promise<void> | null = null

  constructor(
    private readonly root: string,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {}

  get connectedTo(): string | null {
    return this.client ? this.cdpUrl : null
  }

  knownTools(): BrowserUseTool[] | null {
    return this.tools
  }

  /** Attached to `cdpUrl`, starting or restarting the server as needed. */
  ensure(cdpUrl: string): Promise<void> {
    if (this.client && this.cdpUrl === cdpUrl) return Promise.resolve()
    return (this.starting ??= this.start(cdpUrl).finally(() => (this.starting = null)))
  }

  private async start(cdpUrl: string): Promise<void> {
    await this.stop()
    const paths = layout(this.root)
    if (!existsSync(paths.browserUse)) throw new Error('Browser Use isn’t set up. Turn on browser control in Settings → Browser.')
    mkdirSync(paths.home, { recursive: true })
    writeConfig(this.root, cdpUrl)
    // Output to a file: with nobody reading a pipe after Eaon is gone, a write could stop it shutting down.
    const log = join(this.root, 'browser-use.log')
    if (existsSync(log) && statSync(log).size > 1_000_000) truncateSync(log, 0)
    const out = openSync(log, 'a')
    const transport = new StdioClientTransport({ command: paths.browserUse, args: ['--mcp'], env: browserUseEnv(this.root, this.env), stderr: out, cwd: paths.home })
    const client = new Client({ name: 'eaon', version: '1' })
    try {
      await client.connect(transport, { timeout: 60_000 })
      const { tools } = await client.listTools(undefined, { timeout: 60_000 })
      this.tools = tools.map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema as Record<string, unknown> }))
      this.client = client
      this.cdpUrl = cdpUrl
    } catch (error) {
      await client.close().catch(() => undefined)
      throw new Error(`Browser Use didn't start: ${(error as Error).message}`)
    } finally {
      closeSync(out)
    }
  }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ content: BrowserUseContent[]; isError: boolean }> {
    if (!this.client) throw new Error('Not connected to the browser.')
    const result = (await this.client.callTool({ name, arguments: args }, undefined, { signal, timeout: 180_000 })) as { content?: BrowserUseContent[]; isError?: boolean }
    return { content: result.content ?? [], isError: Boolean(result.isError) }
  }

  async stop(): Promise<void> {
    const client = this.client
    this.client = null
    this.cdpUrl = null
    // Closing its stdin ends the server; the SDK kills it if it lingers.
    await client?.close().catch(() => undefined)
  }
}
