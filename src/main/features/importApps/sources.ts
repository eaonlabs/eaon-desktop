import { join } from 'node:path'
import type { ImportAppId } from '@shared/importApps'
import type { McpServer } from '@shared/types'

/**
 * Where other apps keep their list of MCP servers, and how to read one.
 * Plain data and parsing, with no file or Electron access, so it is tested
 * without either (the files are read in ../importApps.ts).
 *
 * Each of these is a file that holds the MCP server list (Gemini CLI's also
 * holds its other preferences, none of which are read). Claude Code's own
 * file is left out on purpose: it holds the account's sign-in details
 * alongside its servers, and Eaon doesn't open files like that.
 */

export interface Source {
  id: ImportAppId
  name: string
  /** The key of the servers in the file. */
  key: 'mcpServers' | 'servers'
  file: (platform: NodeJS.Platform, home: string, appData: string) => string
}

const support = (platform: NodeJS.Platform, home: string, appData: string, ...rest: string[]): string =>
  platform === 'darwin' ? join(home, 'Library', 'Application Support', ...rest) : platform === 'win32' ? join(appData, ...rest) : join(home, '.config', ...rest)

export const SOURCES: Source[] = [
  { id: 'claude-desktop', name: 'Claude', key: 'mcpServers', file: (p, h, a) => support(p, h, a, 'Claude', 'claude_desktop_config.json') },
  { id: 'cursor', name: 'Cursor', key: 'mcpServers', file: (_p, h) => join(h, '.cursor', 'mcp.json') },
  { id: 'windsurf', name: 'Windsurf', key: 'mcpServers', file: (_p, h) => join(h, '.codeium', 'windsurf', 'mcp_config.json') },
  { id: 'vscode', name: 'VS Code', key: 'servers', file: (p, h, a) => support(p, h, a, 'Code', 'User', 'mcp.json') },
  { id: 'gemini-cli', name: 'Gemini CLI', key: 'mcpServers', file: (_p, h) => join(h, '.gemini', 'settings.json') }
]

/** A server as the other app wrote it, reduced to what Eaon runs. */
export interface ParsedServer {
  name: string
  transport: 'stdio' | 'http'
  command: string
  args: string[]
  env: Record<string, string>
  url: string
  /** The other app had it switched off. */
  disabled: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/**
 * The servers in a file's text. A file that isn't JSON, has no server list,
 * or lists an entry that is neither a command nor a web address gives
 * nothing for it: an import never fails on someone else's file.
 */
export function parseServers(source: Pick<Source, 'key'>, content: string): ParsedServer[] {
  let doc: unknown
  try {
    doc = JSON.parse(content)
  } catch {
    return []
  }
  const list = isRecord(doc) ? doc[source.key] : null
  if (!isRecord(list)) return []
  const found: ParsedServer[] = []
  for (const [name, raw] of Object.entries(list)) {
    if (!name.trim() || !isRecord(raw)) continue
    const command = text(raw.command)
    const url = text(raw.url) || text(raw.serverUrl) || text(raw.httpUrl)
    const env: Record<string, string> = {}
    if (isRecord(raw.env)) {
      for (const [key, value] of Object.entries(raw.env)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') env[key] = String(value)
      }
    }
    const disabled = raw.disabled === true
    if (command) {
      const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === 'string') : []
      found.push({ name: name.trim(), transport: 'stdio', command, args, env, url: '', disabled })
    } else if (/^https?:\/\//i.test(url)) {
      found.push({ name: name.trim(), transport: 'http', command: '', args: [], env: {}, url, disabled })
    }
  }
  return found
}

/** What a server runs, as one readable line. */
export const summaryOf = (server: ParsedServer): string => (server.transport === 'http' ? server.url : [server.command, ...server.args].join(' '))

/** Whether Eaon already has a server that runs the same thing. */
export function duplicateOf(server: ParsedServer, existing: McpServer[]): boolean {
  return existing.some((have) =>
    server.transport === 'http'
      ? have.transport === 'http' && have.url === server.url
      : have.transport === 'stdio' && have.command === server.command && JSON.stringify(have.args) === JSON.stringify(server.args)
  )
}

/** A name safe for an id and for the tool names built from it. */
export const slug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'server'

/** Eaon's server row for an imported one: switched on (it was picked), its id never one in use. */
export function toMcpServer(server: ParsedServer, taken: Set<string>): McpServer {
  let id = slug(server.name)
  for (let n = 2; taken.has(id); n++) id = `${slug(server.name)}-${n}`
  taken.add(id)
  return {
    id,
    name: server.name,
    transport: server.transport,
    command: server.command,
    args: server.args,
    env: server.env,
    url: server.url,
    enabled: !server.disabled,
    official: false
  }
}
