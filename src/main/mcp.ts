import { homedir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ErrorCode, McpError, ToolListChangedNotificationSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js'
import type { McpServer, McpServerStatus, McpTool } from '@shared/types'
import { store } from './store'
import { secrets } from './secrets'
import { mcpCatalogEntry } from '@shared/mcpCatalog'
import { McpOAuthProvider, oauthFetch, SignInRequiredError } from './mcpOAuth'

/**
 * MCP client pool. Each enabled server gets a live connection; tools discovered
 * across all of them are merged into one list the chat loop can call.
 *
 * Servers are connected lazily and kept warm — spawning a stdio server costs a
 * process launch plus an npx download on first run, far too slow to do per
 * message.
 */

interface Connection {
  client: Client | null
  tools: McpTool[]
  status: McpServerStatus
  /** The settings it was connected with (`configKey`); after an edit it is reconnected. */
  config?: string
}

const connections = new Map<string, Connection>()
let onStatusChange: ((statuses: McpServerStatus[]) => void) | null = null

/**
 * The newest connect attempt per server. A connect takes seconds (a process
 * launch, an npx download, a network handshake), and meanwhile the server can
 * be reconnected, edited or switched off. An attempt that is no longer the
 * newest closes what it opened instead of installing it — otherwise it would
 * leave a second process running, or a disabled server connected.
 */
const attempts = new Map<string, number>()
let attemptSeq = 0
/** The newest attempt's promise, so a caller can wait for the one that counts. */
const inflight = new Map<string, Promise<void>>()

export function setMcpStatusListener(listener: (statuses: McpServerStatus[]) => void): void {
  onStatusChange = listener
}

function publish(): void {
  onStatusChange?.(getStatuses())
}

function setStatus(serverId: string, status: Partial<McpServerStatus>): void {
  const existing = connections.get(serverId)
  const base: McpServerStatus = existing?.status ?? { serverId, state: 'stopped', toolCount: 0 }
  const next = { ...base, ...status, serverId }
  if (existing) existing.status = next
  else connections.set(serverId, { client: null, tools: [], status: next })
  publish()
}

export function getStatuses(): McpServerStatus[] {
  return store.getMcpServers().map(
    (server) => connections.get(server.id)?.status ?? { serverId: server.id, state: 'stopped', toolCount: 0 }
  )
}

/**
 * Every tool across all connected servers, sorted by server then name. The
 * order is part of the cached prompt prefix, and connections finish in
 * whatever order the network allows — unsorted, the same set of tools could
 * serialise differently on every launch.
 */
export function getTools(): McpTool[] {
  return [...connections.values()]
    .flatMap((connection) => connection.tools)
    .sort((a, b) => a.serverId.localeCompare(b.serverId) || a.name.localeCompare(b.name))
}

const nameKey = (name: string): string => name.toLowerCase().replace(/[^a-z0-9_-]/g, '_')

/**
 * Display names for every configured server, for tool listings. Unique across
 * servers: the agent namespaces tools as `<server>__<tool>`, so two servers
 * both called "GitHub" (a catalog plugin and a hand-added one, say) would
 * otherwise produce identical tool names and one would silently shadow the
 * other. Later duplicates get a number, in mcp.json order so it is stable.
 *
 * One read of mcp.json for all of them: tool listings ask for a name per tool,
 * and each `store.getMcpServers()` is a synchronous file read and parse.
 */
export function serverNames(): Map<string, string> {
  const names = new Map<string, string>()
  const seen = new Map<string, number>()
  for (const server of store.getMcpServers()) {
    const key = nameKey(server.name)
    const index = seen.get(key) ?? 0
    seen.set(key, index + 1)
    names.set(server.id, index > 0 ? `${server.name} ${index + 1}` : server.name)
  }
  return names
}

/** Display name for one server; see `serverNames`. */
export function serverName(serverId: string): string {
  return serverNames().get(serverId) ?? serverId
}

type HttpAuth = 'token' | 'oauth' | 'none'

/**
 * How an HTTP server authenticates. Catalog entries say so explicitly; a
 * hand-added server gets an OAuth provider in case it asks for a sign-in —
 * one that never needs it simply never consults the provider.
 */
function httpAuthFor(server: McpServer): HttpAuth {
  const entry = server.pluginId ? mcpCatalogEntry(server.pluginId) : undefined
  if (!entry) return 'oauth'
  return entry.authMode === 'pastedToken' ? 'token' : entry.authMode
}

/**
 * Auth and vendor-specific headers for an HTTP server. Plugin tokens live in
 * the encrypted vault keyed by `plugin:<id>`; OAuth tokens are added by the
 * transport's auth provider instead, per request, so a refresh takes effect
 * without reconnecting.
 */
function httpHeadersFor(server: McpServer): Record<string, string> {
  if (!server.pluginId) return {}
  const entry = mcpCatalogEntry(server.pluginId)
  if (!entry) return {}
  const token = entry.authMode === 'pastedToken' ? secrets.get(`plugin:${server.pluginId}`) : undefined
  return {
    ...entry.extraHeaders,
    ...(token ? (entry.tokenHeader ? { [entry.tokenHeader]: token } : { Authorization: `${entry.authScheme} ${token}` }) : {})
  }
}

function httpTransport(server: McpServer, auth: HttpAuth, kind: 'streamable' | 'sse'): StreamableHTTPClientTransport | SSEClientTransport {
  // Token plugins send their vault token as a header (the scheme is
  // per-vendor: Sentry and Semrush do not use "Bearer"). OAuth servers get
  // a background auth provider, which supplies stored tokens and lets the
  // SDK refresh them on a 401 — but never opens a browser on its own.
  const options = {
    requestInit: { headers: httpHeadersFor(server) },
    authProvider: auth === 'oauth' ? new McpOAuthProvider(server.id, server.url) : undefined,
    fetch: auth === 'oauth' ? oauthFetch : undefined
  }
  const url = new URL(server.url)
  return kind === 'sse' ? new SSEClientTransport(url, options) : new StreamableHTTPClientTransport(url, options)
}

/** `~` and `~/…`, as a shell would have expanded them; servers are spawned without one. */
const expandHome = (value: string): string => value.replace(/^~(?=$|[\\/])/, homedir())

/**
 * Makes a server's launch command runnable on Windows.
 *
 * The MCP SDK spawns with `shell: false`, and most servers are published as
 * npm bins — on Windows those are `.cmd` shims, which Node has refused to spawn
 * directly since the CVE-2024-27980 fix (it throws EINVAL). Routing through
 * `cmd.exe /c` runs the shim as intended; anything already ending in `.exe`,
 * and every non-Windows platform, is passed through untouched.
 */
function resolveLaunch(rawCommand: string, rawArgs: string[]): { command: string; args: string[] } {
  const command = expandHome(rawCommand)
  const args = rawArgs.map(expandHome)
  if (process.platform !== 'win32') return { command, args }
  if (/\.(exe|com)$/i.test(command)) return { command, args }
  return { command: process.env.COMSPEC ?? 'cmd.exe', args: ['/c', command, ...args] }
}

/**
 * The last lines a stdio server wrote to stderr. A server that exits at
 * start-up (a missing API key, a bad path) says why there and nowhere else;
 * over the protocol all that arrives is "Connection closed". The stream must
 * be read either way, or a chatty server would fill the pipe and stall.
 */
function captureStderr(transport: StdioClientTransport): () => string {
  let tail = ''
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    tail = (tail + chunk.toString()).slice(-4000)
  })
  return () =>
    tail
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-4)
      .join('\n')
      .slice(-600)
}

const isAuthFailure = (error: unknown): boolean =>
  error instanceof SignInRequiredError ||
  error instanceof UnauthorizedError ||
  (error instanceof StreamableHTTPError && error.code === 401)

/** Turns a failed connect into something a person can act on. */
function describeFailure(
  server: McpServer,
  auth: HttpAuth | null,
  error: unknown,
  stderr = ''
): Pick<McpServerStatus, 'state' | 'error'> {
  const message = error instanceof Error ? error.message : String(error)
  if (auth === 'oauth' && isAuthFailure(error)) return { state: 'needs-auth', error: 'Sign in to connect' }
  if (auth === 'token' && isAuthFailure(error)) {
    return { state: 'error', error: 'The token was rejected (HTTP 401). Paste a new one.' }
  }
  // spawn ENOENT: the command is not on PATH. Worth spelling out, since a
  // Dock-launched app only sees the login shell's PATH (see shellEnv.ts).
  if (server.transport === 'stdio' && /ENOENT/.test(message)) {
    return { state: 'error', error: `"${server.command}" was not found on your PATH. Install it, or use its full path.` }
  }
  if (stderr) {
    const closed = error instanceof McpError && error.code === ErrorCode.ConnectionClosed
    return { state: 'error', error: `${closed ? 'The server stopped' : message}. Its last output:\n${stderr}` }
  }
  return { state: 'error', error: message }
}

/** All of a server's tools; servers with many page them with a cursor. */
async function listAllTools(client: Client): Promise<Tool[]> {
  const tools: Tool[] = []
  let cursor: string | undefined
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined)
    tools.push(...page.tools)
    cursor = page.nextCursor
  } while (cursor && tools.length < 2000)
  return tools
}

function toMcpTools(serverId: string, tools: Tool[]): McpTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    serverId,
    inputSchema: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
    readOnly: tool.annotations?.readOnlyHint === true,
    destructive: tool.annotations?.destructiveHint === true
  }))
}

/** Identity of a server's connection settings; a change means reconnecting. */
const configKey = (server: McpServer): string =>
  JSON.stringify([server.transport, server.command, server.args, server.env, server.url])

/**
 * Keeps a connection's tool list current. Servers whose tools depend on state
 * (a sign-in, a project opened) announce changes with `tools/list_changed`;
 * without this the list read at connect time would stand until a restart.
 */
function watchToolList(serverId: string, client: Client): void {
  let running = false
  let again = false
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    if (running) {
      again = true
      return
    }
    running = true
    try {
      do {
        again = false
        const tools = toMcpTools(serverId, await listAllTools(client))
        const connection = connections.get(serverId)
        if (connection?.client !== client) return
        connection.tools = tools
        connection.status = { ...connection.status, toolCount: tools.length }
        publish()
      } while (again)
    } catch {
      /* the list read last stays until the next reconnect */
    } finally {
      running = false
    }
  })
}

function newClient(serverId: string): Client {
  const client = new Client({ name: 'eaon-desktop', version: '0.1.0' })
  watchToolList(serverId, client)
  return client
}

/** Servers on the older HTTP+SSE transport turn a streamable POST away with one of these. */
const refusesStreamable = (error: unknown): boolean =>
  error instanceof StreamableHTTPError && [400, 404, 405].includes(error.code ?? 0)

function connect(server: McpServer): Promise<void> {
  const attempt = ++attemptSeq
  attempts.set(server.id, attempt)
  const done = attemptConnect(server, () => attempts.get(server.id) === attempt)
  inflight.set(server.id, done)
  void done.finally(() => {
    if (inflight.get(server.id) === done) inflight.delete(server.id)
  })
  return done
}

/** Waits until no connect is running for this server, including ones started meanwhile. */
async function settled(serverId: string): Promise<void> {
  for (let pending = inflight.get(serverId); pending; pending = inflight.get(serverId)) await pending
}

async function attemptConnect(server: McpServer, current: () => boolean): Promise<void> {
  const config = configKey(server)
  const previous = connections.get(server.id)?.client
  connections.set(server.id, { client: null, tools: [], config, status: { serverId: server.id, state: 'starting', toolCount: 0 } })
  publish()
  // Replaced above first, so the old client's onclose knows this close was ours.
  if (previous) await previous.close().catch(() => {})
  if (!current()) return

  const auth = server.transport === 'http' ? httpAuthFor(server) : null
  let client: Client | null = null
  let stderr: (() => string) | null = null

  try {
    if (server.transport === 'http') {
      if (!server.url) throw new Error('No URL configured')
      client = newClient(server.id)
      try {
        await client.connect(httpTransport(server, auth!, 'streamable'))
      } catch (error) {
        // Plenty of hand-run servers still speak only the older HTTP+SSE
        // transport. Catalog servers are verified streamable, so they skip it.
        if (server.pluginId || !refusesStreamable(error) || !current()) throw error
        client = newClient(server.id)
        try {
          await client.connect(httpTransport(server, auth!, 'sse'))
        } catch {
          throw error
        }
      }
    } else {
      if (!server.command) throw new Error('No command configured')
      const launch = resolveLaunch(server.command, server.args)
      const transport = new StdioClientTransport({
        command: launch.command,
        args: launch.args,
        // process.env.PATH is the login shell's by now (adoptLoginShellPath
        // runs before anything connects), so `npx`, `uvx` etc. resolve from
        // a Dock launch too. The server's own env entries take precedence.
        env: { ...(process.env as Record<string, string>), ...server.env },
        stderr: 'pipe'
      })
      stderr = captureStderr(transport)
      client = newClient(server.id)
      await client.connect(transport)
    }

    // A server with only prompts or resources has no tools to list; asking
    // anyway gets "method not found" and would read as a broken server.
    const tools = client.getServerCapabilities()?.tools ? toMcpTools(server.id, await listAllTools(client)) : []
    if (!current()) {
      void client.close().catch(() => {})
      return
    }

    const live = client
    connections.set(server.id, {
      client: live,
      tools,
      config,
      status: { serverId: server.id, state: 'ready', toolCount: tools.length }
    })
    // A stdio server that exits, or a stream the server drops, would otherwise
    // keep showing "ready" with tools that can no longer be called.
    live.onclose = () => {
      if (connections.get(server.id)?.client !== live) return
      const output = stderr?.()
      connections.set(server.id, {
        client: null,
        tools: [],
        config,
        status: {
          serverId: server.id,
          state: 'error',
          toolCount: 0,
          error: output ? `The server stopped. Its last output:\n${output}` : 'The server closed the connection'
        }
      })
      publish()
      scheduleRestart(server.id, config)
    }
    publish()
  } catch (error) {
    // A client that got as far as connecting (listing its tools failed, say)
    // still holds a session — and for stdio, a process. Close it.
    void client?.close().catch(() => {})
    if (!current()) return
    // stderr arrives through a pipe; give the last of it a moment to land.
    if (stderr) await new Promise((resolve) => setTimeout(resolve, 50))
    connections.set(server.id, {
      client: null,
      tools: [],
      config,
      status: { serverId: server.id, toolCount: 0, ...describeFailure(server, auth, error, stderr?.()) }
    })
    publish()
  }
}

/** Recent automatic restarts per server (epoch ms), and the restart waiting to run. */
const restarts = new Map<string, number[]>()
const restartTimers = new Map<string, NodeJS.Timeout>()
const RESTART_WINDOW_MS = 10 * 60_000
const RESTART_LIMIT = 3

/**
 * A server that stopped on its own (a crash, an out-of-memory kill) is started
 * again, rather than staying dead for the rest of the session with its tools
 * gone. A few times, backing off — one that keeps dying stays stopped, with
 * its last output on show, until the user acts.
 */
function scheduleRestart(serverId: string, config: string): void {
  const now = Date.now()
  const recent = (restarts.get(serverId) ?? []).filter((at) => now - at < RESTART_WINDOW_MS)
  if (recent.length >= RESTART_LIMIT) return
  restarts.set(serverId, [...recent, now])
  clearTimeout(restartTimers.get(serverId))
  const timer = setTimeout(() => {
    restartTimers.delete(serverId)
    const server = store.getMcpServers().find((s) => s.id === serverId)
    const connection = connections.get(serverId)
    // Only if nothing has happened since: not switched off, edited or reconnected.
    if (!server?.enabled || configKey(server) !== config || connection?.client || connection?.status.state !== 'error') return
    void connect(server)
  }, 1000 * 5 ** recent.length)
  timer.unref()
  restartTimers.set(serverId, timer)
}

async function disconnect(serverId: string): Promise<void> {
  clearTimeout(restartTimers.get(serverId))
  restartTimers.delete(serverId)
  const existing = connections.get(serverId)
  // Removed first so the client's onclose knows this close was ours.
  connections.delete(serverId)
  if (existing?.client) {
    try {
      await existing.client.close()
    } catch {
      /* the process may already be gone; nothing useful to do */
    }
  }
}

/** Bring live connections in line with what's enabled in settings. */
export async function syncMcpServers(): Promise<void> {
  const servers = store.getMcpServers()
  const enabled = servers.filter((s) => s.enabled)
  const wanted = new Set(enabled.map((s) => s.id))

  // Including servers whose connect is still under way: it gives up when it lands.
  const unwanted = [...new Set([...connections.keys(), ...attempts.keys()])].filter((id) => !wanted.has(id))
  for (const id of unwanted) attempts.delete(id)
  await Promise.all(unwanted.map((id) => disconnect(id)))

  await Promise.all(
    enabled
      .filter((server) => {
        const connection = connections.get(server.id)
        // Edited since it connected (command, URL, env…): what is live is the old server.
        if (connection?.config !== undefined && connection.config !== configKey(server)) return true
        // A server waiting on a sign-in stays that way until the user signs in;
        // retrying it on every sync would only repeat the same 401.
        return !['ready', 'starting', 'needs-auth'].includes(connection?.status.state ?? '')
      })
      .map((server) => connect(server))
  )
  publish()
}

/** Reconnects one server now, e.g. right after it was signed in to. */
export async function reconnectMcpServer(serverId: string): Promise<McpServerStatus | undefined> {
  const server = store.getMcpServers().find((s) => s.id === serverId)
  if (!server) return undefined
  if (server.enabled) {
    await connect(server)
    await settled(serverId)
  } else {
    attempts.delete(serverId)
    await disconnect(serverId)
    publish()
  }
  return getStatuses().find((s) => s.serverId === serverId)
}

export async function shutdownMcp(): Promise<void> {
  attempts.clear()
  await Promise.all([...connections.keys()].map((id) => disconnect(id)))
}

/** Several calls can find the session gone at once; they share one reconnect. */
const recovering = new Map<string, Promise<McpServerStatus | undefined>>()

function recover(serverId: string): Promise<McpServerStatus | undefined> {
  let pending = recovering.get(serverId)
  if (!pending) {
    pending = reconnectMcpServer(serverId).finally(() => recovering.delete(serverId))
    recovering.set(serverId, pending)
  }
  return pending
}

/**
 * A streamable HTTP server answers 404 to a session it no longer knows — after
 * a restart or a redeploy, typically. The spec's remedy is a new session; the
 * call never ran, so it is safe to send again.
 */
const sessionGone = (error: unknown): boolean => error instanceof StreamableHTTPError && error.code === 404

/** What a tool call returns to the agent loop; the same shape as the loop's `ToolResult`. */
export interface McpCallResult {
  text: string
  images?: { mime: string; data: string }[]
  isError?: boolean
}

/** Image types every provider takes, and a size they all accept (base64 characters). */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const IMAGE_LIMIT = 6_500_000
/**
 * Images kept from one result. Each is saved to disk and sent with every
 * later request of the turn; a server returning hundreds (or a hostile one)
 * would fill the disk and the context window.
 */
const MAX_IMAGES = 8
/** Text kept from one result before the loop's own cap: a runaway server can send hundreds of megabytes. */
const MAX_TEXT_CHARS = 2_000_000

/**
 * A tool result as the agent loop takes it. Text blocks are the answer.
 * Images go to the model as images — pasting base64 into the text would only
 * burn tokens on noise. Other blocks get a line saying what they are, so the
 * model knows they exist; `isError` stays an error rather than reading as a
 * successful answer that happens to describe a failure.
 */
export function toToolResult(result: CallToolResult): McpCallResult {
  const parts: string[] = []
  const images: { mime: string; data: string }[] = []
  for (const block of result.content ?? []) {
    if (block.type === 'text') {
      if (block.text) parts.push(block.text)
    } else if (block.type === 'image') {
      if (images.length >= MAX_IMAGES) parts.push(`[image: ${block.mimeType}, not shown: only the first ${MAX_IMAGES} images are kept]`)
      else if (IMAGE_TYPES.has(block.mimeType) && block.data.length <= IMAGE_LIMIT) images.push({ mime: block.mimeType, data: block.data })
      else parts.push(`[image: ${block.mimeType}, not shown]`)
    } else if (block.type === 'audio') {
      parts.push(`[audio: ${block.mimeType}, not shown]`)
    } else if (block.type === 'resource') {
      const resource = block.resource
      parts.push(
        'text' in resource && typeof resource.text === 'string'
          ? `${resource.uri}\n${resource.text}`
          : `[resource: ${resource.uri}${resource.mimeType ? ` (${resource.mimeType})` : ''}, binary, not shown]`
      )
    } else if (block.type === 'resource_link') {
      parts.push(`[resource: ${block.uri}${block.name ? ` — ${block.name}` : ''}]`)
    }
  }
  let text = parts.join('\n')
  if (text.length > MAX_TEXT_CHARS) text = `${text.slice(0, MAX_TEXT_CHARS)}\n…[the rest of a ${text.length.toLocaleString('en-US')}-character result was dropped]`
  if (!text && result.structuredContent) text = JSON.stringify(result.structuredContent).slice(0, MAX_TEXT_CHARS)
  if (!text && images.length === 0) text = result.isError ? 'The tool failed without saying why.' : '(no output)'
  return { text, ...(images.length > 0 ? { images } : {}), ...(result.isError ? { isError: true } : {}) }
}

/** A tool call's text alone; see `callMcpToolResult` for errors and images. */
export async function callMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  serverId?: string,
  signal?: AbortSignal
): Promise<string> {
  return (await callMcpToolResult(toolName, args, timeoutMs, serverId, signal)).text
}

export async function callMcpToolResult(
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  serverId?: string,
  signal?: AbortSignal
): Promise<McpCallResult> {
  // Two servers can expose the same tool name; the server id disambiguates.
  const tool = serverId
    ? connections.get(serverId)?.tools.find((t) => t.name === toolName)
    : getTools().find((t) => t.name === toolName)
  if (!tool) throw new Error(`Unknown tool "${toolName}"`)
  const connection = connections.get(tool.serverId)
  if (!connection?.client) throw new Error(`Server for "${toolName}" is not connected`)

  // The turn's signal cancels the request (and tells the server so): Stop
  // must not wait out the full timeout on a server that is stuck.
  const call = (client: Client): Promise<CallToolResult> =>
    client.callTool({ name: toolName, arguments: args }, undefined, { timeout: timeoutMs, signal }) as Promise<CallToolResult>

  const server = store.getMcpServers().find((s) => s.id === tool.serverId)
  const auth = server?.transport === 'http' ? httpAuthFor(server) : null
  const client = connection.client
  let result: CallToolResult
  try {
    result = await call(client).catch(async (error: unknown) => {
      if (signal?.aborted) throw error
      // Parallel calls that all find the token expired share one refresh
      // (oauthFetch); one whose 401 lands after another's refresh finished is
      // taken by the SDK for a server rejecting fresh tokens. The tokens
      // stored by then are good, so it gets one more try with them.
      if (auth === 'oauth' && error instanceof StreamableHTTPError && error.code === 401) return call(client)
      if (!sessionGone(error)) throw error
      const status = await recover(tool.serverId)
      const fresh = connections.get(tool.serverId)?.client
      if (status?.state !== 'ready' || !fresh) throw error
      return call(fresh)
    })
  } catch (error) {
    // A pasted token was revoked or expired: there is no sign-in to offer,
    // only a new token.
    if (auth === 'token' && isAuthFailure(error)) {
      setStatus(tool.serverId, { state: 'error', error: 'The token was rejected (HTTP 401). Paste a new one.' })
      throw new Error(`${serverName(tool.serverId)} rejected its token (HTTP 401). Paste a new one in Plugins → ${serverName(tool.serverId)}.`)
    }
    // The token expired and could not be refreshed mid-session. Say so
    // plainly, and flip the server to "Sign in" so the Plugins page offers it.
    if (isAuthFailure(error)) {
      setStatus(tool.serverId, { state: 'needs-auth', error: 'Sign in to connect' })
      throw new Error(`${serverName(tool.serverId)} needs you to sign in again (Plugins → ${serverName(tool.serverId)}).`)
    }
    throw error
  }
  // A refresh that failed only because the vendor was briefly down flips the
  // server to "Sign in" while its tokens are still good; a call that went
  // through proves they are.
  if (connections.get(tool.serverId)?.status.state === 'needs-auth') setStatus(tool.serverId, { state: 'ready', error: undefined })
  return toToolResult(result)
}
