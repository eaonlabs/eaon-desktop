import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpServer, McpServerStatus, McpTool } from '@shared/types'
import { store } from './store'
import { secrets } from './secrets'
import { MCP_CATALOG } from '@shared/mcpCatalog'

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

/** Every tool across all connected servers, name-prefixed to stay unique. */
export function getTools(): McpTool[] {
  return [...connections.values()].flatMap((connection) => connection.tools)
}

/**
 * Makes a server's launch command runnable on Windows.
 *
 * The MCP SDK spawns with `shell: false`, and most servers are published as
 * npm bins — on Windows those are `.cmd` shims, which Node has refused to spawn
 * directly since the CVE-2024-27980 fix (it throws EINVAL). Both servers we
 * ship by default use `npx`, so without this they fail to start on Windows
 * while working fine everywhere else. Routing through `cmd.exe /c` runs the
 * shim as intended; anything already ending in `.exe`, and every non-Windows
 * platform, is passed through untouched.
 */
/**
 * Auth and vendor-specific headers for an HTTP server. Plugin tokens live in
 * the encrypted vault keyed by `plugin:<id>`; a hand-added custom server has
 * none and simply connects unauthenticated.
 */
function httpHeadersFor(server: McpServer): Record<string, string> {
  if (!server.pluginId) return {}
  const entry = MCP_CATALOG.find((e) => e.id === server.pluginId)
  if (!entry) return {}
  const token = secrets.get(`plugin:${server.pluginId}`)
  return {
    ...entry.extraHeaders,
    ...(token ? { Authorization: `${entry.authScheme} ${token}` } : {})
  }
}

function resolveLaunch(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== 'win32') return { command, args }
  if (/\.(exe|com)$/i.test(command)) return { command, args }
  return { command: process.env.COMSPEC ?? 'cmd.exe', args: ['/c', command, ...args] }
}

async function connect(server: McpServer): Promise<void> {
  await disconnect(server.id)
  setStatus(server.id, { state: 'starting', toolCount: 0 })

  try {
    const client = new Client({ name: 'eaon-desktop', version: '0.1.0' })

    if (server.transport === 'http') {
      if (!server.url) throw new Error('No URL configured')
      // Catalog plugins authenticate with a token held in the encrypted vault,
      // never in mcp.json. The scheme is per-vendor (Sentry and Semrush do not
      // use "Bearer"), so it comes from the catalog entry rather than assumed.
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: httpHeadersFor(server) }
        })
      )
    } else {
      if (!server.command) throw new Error('No command configured')
      const launch = resolveLaunch(server.command, server.args)
      await client.connect(
        new StdioClientTransport({
          command: launch.command,
          args: launch.args,
          // Inherit the user's PATH so `npx`, `uvx` etc. resolve; the server's
          // own env entries take precedence.
          env: { ...(process.env as Record<string, string>), ...server.env }
        })
      )
    }

    const listed = await client.listTools()
    const tools: McpTool[] = listed.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      serverId: server.id,
      inputSchema: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>
    }))

    connections.set(server.id, {
      client,
      tools,
      status: { serverId: server.id, state: 'ready', toolCount: tools.length }
    })
    publish()
  } catch (error) {
    connections.set(server.id, {
      client: null as never,
      tools: [],
      status: {
        serverId: server.id,
        state: 'error',
        toolCount: 0,
        error: error instanceof Error ? error.message : String(error)
      }
    })
    publish()
  }
}

async function disconnect(serverId: string): Promise<void> {
  const existing = connections.get(serverId)
  if (existing?.client) {
    try {
      await existing.client.close()
    } catch {
      /* the process may already be gone; nothing useful to do */
    }
  }
  connections.delete(serverId)
}

/** Bring live connections in line with what's enabled in settings. */
export async function syncMcpServers(): Promise<void> {
  const servers = store.getMcpServers()
  const enabled = servers.filter((s) => s.enabled)

  for (const id of [...connections.keys()]) {
    if (!enabled.some((s) => s.id === id)) {
      await disconnect(id)
      setStatus(id, { state: 'stopped', toolCount: 0 })
    }
  }

  await Promise.all(
    enabled
      .filter((server) => connections.get(server.id)?.status.state !== 'ready')
      .map((server) => connect(server))
  )
  publish()
}

export async function shutdownMcp(): Promise<void> {
  await Promise.all([...connections.keys()].map((id) => disconnect(id)))
}

export async function callMcpTool(
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number
): Promise<string> {
  const tool = getTools().find((t) => t.name === toolName)
  if (!tool) throw new Error(`Unknown tool "${toolName}"`)
  const connection = connections.get(tool.serverId)
  if (!connection?.client) throw new Error(`Server for "${toolName}" is not connected`)

  const result = await connection.client.callTool({ name: toolName, arguments: args }, undefined, {
    timeout: timeoutMs
  })

  // Tool results are content blocks; flatten the text ones, which is what a
  // chat model can actually consume.
  const content = (result.content ?? []) as { type: string; text?: string }[]
  const text = content
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text)
    .join('\n')
  return text || JSON.stringify(result)
}
