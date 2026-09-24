import type { McpServer, McpServerStatus } from '@shared/types'
import type { PluginSignInResult } from '@shared/plugins'
import { MCP_CATALOG, mcpCatalogEntry, type McpCatalogEntry } from '@shared/mcpCatalog'
import { store } from '../store'
import { secrets } from '../secrets'
import { getStatuses, reconnectMcpServer, syncMcpServers } from '../mcp'
import { cancelSignIn, ClientIdRequiredError, signIn, signOut, storedClientId } from '../mcpOAuth'
import type { Feature } from './types'

/**
 * Catalog plugins: connecting one writes an ordinary MCP server row (plus a
 * vault entry for its credentials), so from then on the tool loop, status
 * reporting and settings treat it like any other server. What differs per
 * plugin is only how it authenticates — none, a pasted token, or a browser
 * sign-in.
 */

const serverIdFor = (pluginId: string): string => `plugin-${pluginId}`

function catalogEntry(pluginId: string): McpCatalogEntry {
  const entry = mcpCatalogEntry(pluginId)
  if (!entry) throw new Error(`Unknown plugin "${pluginId}"`)
  return entry
}

/** Writes (or replaces) the server row for a catalog plugin. */
function upsertRow(entry: McpCatalogEntry): void {
  const servers = store.getMcpServers().filter((server) => server.pluginId !== entry.id)
  servers.push({
    id: serverIdFor(entry.id),
    name: entry.displayName,
    transport: 'http',
    command: '',
    args: [],
    env: {},
    url: entry.endpoint,
    enabled: true,
    official: true,
    pluginId: entry.id
  })
  store.saveMcpServers(servers)
}

function removeRow(pluginId: string): void {
  store.saveMcpServers(store.getMcpServers().filter((server) => server.pluginId !== pluginId))
}

/** Ids of catalog plugins that are connected (have a server row). Never credentials. */
function connectedIds(): string[] {
  const rows = new Set(store.getMcpServers().map((server) => server.pluginId).filter(Boolean))
  return MCP_CATALOG.filter((entry) => rows.has(entry.id)).map((entry) => entry.id)
}

/**
 * Browser sign-in for a catalog plugin or a hand-added HTTP server. Returns a
 * result rather than throwing so the renderer can tell "this server needs a
 * client id" apart from an ordinary failure — IPC errors arrive as bare text.
 */
async function signInTo(
  target: { pluginId?: string; serverId?: string },
  client?: { clientId: string; clientSecret?: string }
): Promise<PluginSignInResult> {
  let serverId: string
  let url: string
  let headers: Record<string, string> = {}
  let entry: McpCatalogEntry | undefined
  if (target.pluginId) {
    entry = catalogEntry(target.pluginId)
    if (entry.authMode !== 'oauth') throw new Error(`${entry.displayName} does not use a browser sign-in`)
    serverId = serverIdFor(entry.id)
    url = entry.endpoint
    headers = entry.extraHeaders
  } else {
    const server = store.getMcpServers().find((s) => s.id === target.serverId)
    if (!server || server.transport !== 'http' || !server.url) throw new Error('Only HTTP servers can sign in')
    serverId = server.id
    url = server.url
  }

  try {
    await signIn(serverId, url, { client, headers })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof ClientIdRequiredError) {
      return { ok: false, error: message, needsClientId: true, statuses: getStatuses() }
    }
    return { ok: false, error: message, statuses: getStatuses() }
  }

  // The row is only written once the sign-in has succeeded, so a cancelled
  // or failed attempt never leaves a broken server behind.
  if (entry) upsertRow(entry)
  const status = await reconnectMcpServer(serverId)
  if (status?.state !== 'ready') {
    return { ok: false, error: status?.error ?? 'Signed in, but the server did not connect', statuses: getStatuses() }
  }
  return { ok: true, statuses: getStatuses() }
}

/** Disconnects a catalog plugin: removes its row and forgets its credentials. */
async function disconnectPlugin(pluginId: string): Promise<McpServerStatus[]> {
  const entry = catalogEntry(pluginId)
  if (entry.authMode === 'oauth') await signOut(serverIdFor(pluginId), entry.endpoint)
  secrets.set(`plugin:${pluginId}`, '')
  removeRow(pluginId)
  await syncMcpServers()
  return getStatuses()
}

export const pluginsFeature: Feature = {
  id: 'plugins',
  register: ({ ipcMain }) => {
    /**
     * Token plugins (and, kept for the older callers, the general "connect"):
     * the token goes into the encrypted vault and a server row is written. An
     * empty token disconnects.
     */
    ipcMain.handle('plugins:connect', async (_e, pluginId: string, token: string) => {
      const entry = catalogEntry(pluginId)
      if (!token) return disconnectPlugin(pluginId)
      if (entry.authMode === 'pastedToken') secrets.set(`plugin:${pluginId}`, token)
      upsertRow(entry)
      await reconnectMcpServer(serverIdFor(pluginId))
      return getStatuses()
    })

    ipcMain.handle('plugins:connected', (): string[] => connectedIds())

    /** One-click connect for plugins that need no credentials. */
    ipcMain.handle('plugins:enable', async (_e, pluginId: string): Promise<McpServerStatus[]> => {
      const entry = catalogEntry(pluginId)
      if (entry.authMode !== 'none') throw new Error(`${entry.displayName} needs credentials to connect`)
      upsertRow(entry)
      await reconnectMcpServer(serverIdFor(pluginId))
      return getStatuses()
    })

    ipcMain.handle(
      'plugins:sign-in',
      (_e, target: { pluginId?: string; serverId?: string }, client?: { clientId: string; clientSecret?: string }) =>
        signInTo(target, client)
    )

    ipcMain.handle('plugins:cancel-sign-in', (_e, target: { pluginId?: string; serverId?: string }) => {
      cancelSignIn(target.pluginId ? serverIdFor(target.pluginId) : String(target.serverId))
    })

    ipcMain.handle('plugins:disconnect', (_e, pluginId: string) => disconnectPlugin(pluginId))

    /** Signs a hand-added server out; it stays configured and shows "Sign in". */
    ipcMain.handle('plugins:sign-out-server', async (_e, serverId: string) => {
      const server: McpServer | undefined = store.getMcpServers().find((s) => s.id === serverId)
      if (server?.url) await signOut(serverId, server.url)
      await reconnectMcpServer(serverId)
      return getStatuses()
    })

    /** The client id previously typed for a plugin, to pre-fill the form. */
    ipcMain.handle('plugins:client-id', (_e, pluginId: string): string | null => {
      const entry = catalogEntry(pluginId)
      return storedClientId(serverIdFor(pluginId), entry.endpoint)
    })
  }
}
