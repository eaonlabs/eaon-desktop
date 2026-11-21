import { joinArgs } from './plugins'
import type { McpServer } from './types'

/**
 * A project's own MCP servers: the `mcpServers` of a `.mcp.json` or
 * `.eaon/mcp.json` in the project folder, as Claude Code, Cursor and VS Code
 * write them. Reading is all this does. Nothing in a project file runs until
 * the user has been shown each server's exact command and approved it
 * (main/features/mcpTools.ts), and a file that changes afterwards has to be
 * approved again.
 */

export const PROJECT_MCP_FILES = ['.mcp.json', '.eaon/mcp.json'] as const
export type ProjectMcpFile = (typeof PROJECT_MCP_FILES)[number]

/** A file bigger than this isn't a hand-written server list. */
export const MAX_PROJECT_MCP_BYTES = 100_000
const MAX_SERVERS = 20

/** One server as the project file describes it, checked. */
export interface ProjectServer {
  name: string
  transport: 'stdio' | 'http'
  command: string
  args: string[]
  env: Record<string, string>
  url: string
}

export interface ParsedProjectMcp {
  servers: ProjectServer[]
  /** What was left out or can't be honoured, one line each, for the review. */
  problems: string[]
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The server list of a project file, checked entry by entry; a bad entry is left out and said so. */
export function parseProjectMcp(text: string): ParsedProjectMcp {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return { servers: [], problems: ['The file isn’t valid JSON.'] }
  }
  const table = isObject(doc) ? (isObject(doc.mcpServers) ? doc.mcpServers : isObject(doc.servers) ? doc.servers : null) : null
  if (!table) return { servers: [], problems: ['The file has no “mcpServers” list.'] }
  const servers: ProjectServer[] = []
  const problems: string[] = []
  for (const [name, raw] of Object.entries(table)) {
    if (servers.length >= MAX_SERVERS) {
      problems.push(`Only the first ${MAX_SERVERS} servers are read.`)
      break
    }
    if (!name.trim() || name.length > 80) {
      problems.push('A server with an empty or very long name was left out.')
      continue
    }
    if (!isObject(raw)) {
      problems.push(`“${name}” isn’t an object, so it was left out.`)
      continue
    }
    const url = typeof raw.url === 'string' ? raw.url.trim() : ''
    const command = typeof raw.command === 'string' ? raw.command.trim() : ''
    if (command) {
      const args = Array.isArray(raw.args) ? raw.args.filter((arg): arg is string => typeof arg === 'string') : []
      if (Array.isArray(raw.args) && args.length !== raw.args.length) problems.push(`“${name}” has arguments that aren’t text; they were left out.`)
      const env: Record<string, string> = {}
      for (const [key, value] of Object.entries(isObject(raw.env) ? raw.env : {})) {
        if (typeof value === 'string' && key) env[key] = value
        else problems.push(`“${name}”: the environment value for ${key} isn’t text, so it was left out.`)
      }
      for (const [key, value] of Object.entries(env)) if (value.includes('${')) problems.push(`“${name}”: ${key} uses a variable; Eaon passes it as written, without expanding it.`)
      if ([command, ...args].some((part) => part.includes('${'))) problems.push(`“${name}”: its command uses a variable; Eaon runs it as written, without expanding it.`)
      servers.push({ name, transport: 'stdio', command, args, env, url: '' })
    } else if (url) {
      if (!/^https?:\/\//i.test(url)) {
        problems.push(`“${name}” has an address that isn’t http or https, so it was left out.`)
        continue
      }
      if (isObject(raw.headers) && Object.keys(raw.headers).length > 0) problems.push(`“${name}”: its headers aren’t sent; Eaon signs in to a remote server itself.`)
      servers.push({ name, transport: 'http', command: '', args: [], env: {}, url })
    } else {
      problems.push(`“${name}” has no command or address, so it was left out.`)
    }
  }
  if (servers.length === 0 && problems.length === 0) problems.push('The file lists no servers.')
  return { servers, problems }
}

/** A short, stable hash of text (FNV-1a), for ids; not for security. */
export function shortHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'server'

/** The id a project's server is saved under: stable for the folder and name, and apart from every other server's. */
export const projectServerId = (folder: string, name: string): string => `project-${shortHash(folder)}-${slug(name)}`

const folderName = (folder: string): string => folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder

/** The row saved for an approved project server. Starts on, because the person just approved it. */
export function projectServerRow(folder: string, server: ProjectServer): McpServer {
  return {
    id: projectServerId(folder, server.name),
    name: `${server.name} (${folderName(folder)})`,
    transport: server.transport,
    command: server.command,
    args: server.args,
    env: server.env,
    url: server.url,
    enabled: true,
    official: false,
    projectPath: folder
  }
}

/** What will run, as one line a person can read before approving: the command and its arguments exactly, or the address. */
export const projectServerCommand = (server: Pick<ProjectServer, 'transport' | 'command' | 'args' | 'url'>): string =>
  server.transport === 'http' ? server.url : [server.command, joinArgs(server.args)].filter(Boolean).join(' ')

/** Where a project's decision stands: nothing yet, approved or declined as the file is now, or the file changed since. */
export type ProjectMcpStatus = 'new' | 'approved' | 'declined' | 'changed'

/** What was decided about a project's file: its fingerprint then, and what the person chose. */
export interface ProjectMcpDecision {
  fingerprint: string
  decision: 'approved' | 'declined'
  at: number
}

export function projectStatus(decision: ProjectMcpDecision | undefined, fingerprint: string): ProjectMcpStatus {
  if (!decision) return 'new'
  return decision.fingerprint === fingerprint ? decision.decision : 'changed'
}

/** One project folder with a server file in it, as Settings → MCP Servers offers it. */
export interface ProjectMcpOffer {
  folder: string
  /** The project's name, or the folder's. */
  name: string
  file: ProjectMcpFile
  servers: ProjectServer[]
  problems: string[]
  /** Identifies this exact file text; approval is for this and nothing else. */
  fingerprint: string
  status: ProjectMcpStatus
  /** Servers saved from this folder now. */
  importedIds: string[]
}
