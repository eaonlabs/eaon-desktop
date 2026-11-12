import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { ImportableApp, ImportResult } from '@shared/importApps'
import type { McpServer } from '@shared/types'
import { store } from '../store'
import { audit } from '../enterprise/audit'
import { syncMcpServers } from '../mcp'
import { duplicateOf, parseServers, SOURCES, summaryOf, toMcpServer, type ParsedServer, type Source } from './importApps/sources'
import type { Feature } from './types'

/**
 * Import from another app (shared/importApps.ts): reads the MCP server list
 * of apps the person already uses, offers it in the setup and in Settings →
 * MCP Servers, and adds the ones they pick. Channels: `import-apps:scan`,
 * `import-apps:apply`.
 *
 * `scan` tells the window each server's name, what it runs and the names of
 * its environment variables. `apply` takes only the keys of the servers
 * picked and reads the files again here, so a value in a server's
 * environment (an API key) goes from the other app's file into Eaon's list
 * without passing through the window.
 */

/** A list is a few lines; a file past this isn't one and is left alone. */
const MAX_BYTES = 1024 * 1024

async function read(source: Source): Promise<ParsedServer[] | null> {
  const file = source.file(process.platform, homedir(), process.env['APPDATA'] || '')
  try {
    if ((await stat(file)).size > MAX_BYTES) return null
    return parseServers(source, await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

export async function scan(existing: McpServer[] = store.getMcpServers()): Promise<ImportableApp[]> {
  const apps: ImportableApp[] = []
  for (const source of SOURCES) {
    const servers = await read(source)
    apps.push({
      id: source.id,
      name: source.name,
      found: servers !== null,
      servers: (servers ?? []).map((server) => ({
        key: `${source.id}:${server.name}`,
        name: server.name,
        transport: server.transport,
        summary: summaryOf(server),
        envNames: Object.keys(server.env),
        duplicate: duplicateOf(server, existing)
      }))
    })
  }
  return apps
}

export async function apply(keys: unknown): Promise<ImportResult & { servers: McpServer[] }> {
  const wanted = new Set(Array.isArray(keys) ? keys.filter((k): k is string => typeof k === 'string') : [])
  const existing = store.getMcpServers()
  const taken = new Set(existing.map((s) => s.id))
  const added: McpServer[] = []
  let skipped = 0
  for (const source of SOURCES) {
    const servers = await read(source)
    for (const server of servers ?? []) {
      if (!wanted.delete(`${source.id}:${server.name}`)) continue
      if (duplicateOf(server, [...existing, ...added])) {
        skipped++
        continue
      }
      const row = toMcpServer(server, taken)
      added.push(row)
      audit('mcp.server_added', { id: row.id, name: row.name, importedFrom: source.id })
    }
  }
  // Keys that matched nothing: the other app dropped the server since the scan.
  skipped += wanted.size
  const servers = added.length > 0 ? store.saveMcpServers([...existing, ...added]) : existing
  if (added.length > 0) void syncMcpServers()
  return { added: added.map((s) => s.name), skipped, servers }
}

export const importAppsFeature: Feature = {
  id: 'import-apps',
  register: ({ ipcMain }) => {
    ipcMain.handle('import-apps:scan', () => scan())
    ipcMain.handle('import-apps:apply', (_event, keys: unknown) => apply(keys))
  }
}
