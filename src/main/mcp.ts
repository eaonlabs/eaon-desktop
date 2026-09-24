import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { McpServer, McpServerStatus, McpTool } from '@shared/types'
import { store } from './store'
import { secrets } from './secrets'
import { mcpCatalogEntry } from '@shared/mcpCatalog'
import { McpOAuthProvider, SignInRequiredError } from './mcpOAuth'

/**
 * MCP client pool. Each enabled server gets a live connection; tools discovered
 * across all of them are merged into one list the chat loop can call.
 *
 * Servers are connected lazily and kept warm — spawning a stdio server costs a
 * process launch plus an npx download on first run, far too slow to do per
 * message.
 */

interface Connection {
  client: Client
  tools: McpTool[]
  status: McpServerStatus
}

const connections = new Map<string, Connection>()
let onStatusChange: ((statuses: McpServerStatus[]) => void) | null = null

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
  else connections.set(serverId, { client: null as never, tools: [], status: next })
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
 * Display name for a connected server, for tool listings. Unique across
 * servers: the agent namespaces tools as `<server>__<tool>`, so two servers
 * both called "GitHub" (a catalog plugin and a hand-added one, say) would
 * otherwise produce identical tool names and one would silently shadow the
 * other. Later duplicates get a number, in mcp.json order so it is stable.
 */
export function serverName(serverId: string): string {
  const servers = store.getMcpServers()
  const server = servers.find((s) => s.id === serverId)
  if (!server) return serverId
  const twins = servers.filter((s) => nameKey(s.name) === nameKey(server.name))
  const index = twins.findIndex((s) => s.id === serverId)
  return index > 0 ? `${server.name} ${index + 1}` : server.name
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
    ...(token ? { Authorization: `${entry.authScheme} ${token}` } : {})
  }
}

/**
 * Makes a server's launch command runnable on Windows.
 *
 * The MCP SDK spawns with `shell: false`, and most servers are published as
 * npm bins — on Windows those are `.cmd` shims, which Node has refused to spawn
 * directly since the CVE-2024-27980 fix (it throws EINVAL). Routing through
 * `cmd.exe /c` runs the shim as intended; anything already ending in `.exe`,
 * and every non-Windows platform, is passed through untouched.
 */
function resolveLaunch(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== 'win32') return { command, args }
  if (/\.(exe|com)$/i.test(command)) return { command, args }
  return { command: process.env.COMSPEC ?? 'cmd.exe', args: ['/c', command, ...args] }
}

const isAuthFailure = (error: unknown): boolean =>
  error instanceof SignInRequiredError ||
  error instanceof UnauthorizedError ||
  (error instanceof StreamableHTTPError && error.code === 401)

/** Turns a failed connect into something a person can act on. */
function describeFailure(server: McpServer, auth: HttpAuth | null, error: unknown): Pick<McpServerStatus, 'state' | 'error'> {
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

async function connect(server: McpServer): Promise<void> {
  await disconnect(server.id)
  setStatus(server.id, { state: 'starting', toolCount: 0, error: undefined })
  const auth = server.transport === 'http' ? httpAuthFor(server) : null

  try {
    const client = new Client({ name: 'eaon-desktop', version: '0.1.0' })

    if (server.transport === 'http') {
      if (!server.url) throw new Error('No URL configured')
      // Token plugins send their vault token as a header (the scheme is
      // per-vendor: Sentry and Semrush do not use "Bearer"). OAuth servers get
      // a background auth provider, which supplies stored tokens and lets the
      // SDK refresh them on a 401 — but never opens a browser on its own.
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: httpHeadersFor(server) },
          authProvider: auth === 'oauth' ? new McpOAuthProvider(server.id, server.url) : undefined
        })
      )
    } else {
      if (!server.command) throw new Error('No command configured')
      const launch = resolveLaunch(server.command, server.args)
      await client.connect(
        new StdioClientTransport({
          command: launch.command,
          args: launch.args,
          // process.env.PATH is the login shell's by now (adoptLoginShellPath
          // runs before anything connects), so `npx`, `uvx` etc. resolve from
          // a Dock launch too. The server's own env entries take precedence.
          env: { ...(process.env as Record<string, string>), ...server.env }
        })
      )
    }

    const tools: McpTool[] = (await listAllTools(client)).map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      serverId: server.id,
      inputSchema: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
      readOnly: tool.annotations?.readOnlyHint === true,
      destructive: tool.annotations?.destructiveHint === true
    }))

    connections.set(server.id, {
      client,
      tools,
      status: { serverId: server.id, state: 'ready', toolCount: tools.length }
    })
    // A stdio server that exits, or a stream the server drops, would otherwise
    // keep showing "ready" with tools that can no longer be called.
    client.onclose = () => {
      if (connections.get(server.id)?.client !== client) return
      connections.set(server.id, {
        client: null as never,
        tools: [],
        status: { serverId: server.id, state: 'error', toolCount: 0, error: 'The server closed the connection' }
      })
      publish()
    }
    publish()
  } catch (error) {
    connections.set(server.id, {
      client: null as never,
      tools: [],
      status: { serverId: server.id, toolCount: 0, ...describeFailure(server, auth, error) }
    })
    publish()
  }
}

async function disconnect(serverId: string): Promise<void> {
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

  for (const id of [...connections.keys()]) {
    if (!enabled.some((s) => s.id === id)) {
      await disconnect(id)
      setStatus(id, { state: 'stopped', toolCount: 0, error: undefined })
    }
  }

  await Promise.all(
    enabled
      // A server waiting on a sign-in stays that way until the user signs in;
      // retrying it on every sync would only repeat the same 401.
      .filter((server) => !['ready', 'starting', 'needs-auth'].includes(connections.get(server.id)?.status.state ?? ''))
      .map((server) => connect(server))
  )
  publish()
}

/** Reconnects one server now, e.g. right after it was signed in to. */
export async function reconnectMcpServer(serverId: string): Promise<McpServerStatus | undefined> {
  const server = store.getMcpServers().find((s) => s.id === serverId)
  if (!server) return undefined
  if (server.enabled) await connect(server)
  else {
    await disconnect(serverId)
    publish()
  }
  return getStatuses().find((s) => s.serverId === serverId)
}

export async function shutdownMcp(): Promise<void> {
  await Promise.all([...connections.keys()].map((id) => disconnect(id)))
}

export async function callMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  serverId?: string
): Promise<string> {
  // Two servers can expose the same tool name; the server id disambiguates.
  const tool = getTools().find((t) => t.name === toolName && (!serverId || t.serverId === serverId))
  if (!tool) throw new Error(`Unknown tool "${toolName}"`)
  const connection = connections.get(tool.serverId)
  if (!connection?.client) throw new Error(`Server for "${toolName}" is not connected`)

  let result: Awaited<ReturnType<Client['callTool']>>
  try {
    result = await connection.client.callTool({ name: toolName, arguments: args }, undefined, {
      timeout: timeoutMs
    })
  } catch (error) {
    // The token expired and could not be refreshed mid-session. Say so
    // plainly, and flip the server to "Sign in" so the Plugins page offers it.
    if (isAuthFailure(error)) {
      setStatus(tool.serverId, { state: 'needs-auth', error: 'Sign in to connect' })
      throw new Error(`${serverName(tool.serverId)} needs you to sign in again (Plugins → ${serverName(tool.serverId)}).`)
    }
    throw error
  }

  // Tool results are content blocks; flatten the text ones, which is what a
  // chat model can actually consume.
  const content = (result.content ?? []) as { type: string; text?: string }[]
  const text = content
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text)
    .join('\n')
  return text || JSON.stringify(result)
}
