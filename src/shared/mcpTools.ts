import type { McpServer, McpToolPermission } from './types'

/**
 * Per-server rules for MCP tools, as plain functions over the saved server:
 * which tools are turned off, which have their own permission, and where a
 * project's servers are offered. Settings → MCP Servers edits them, and
 * `main/mcp.ts` and the agent's permission policy read them, so the two
 * can't disagree.
 */

type Rules = Pick<McpServer, 'disabledTools' | 'toolPermissions'>

/** One line of a server's log (Settings → MCP Servers → Logs). `stderr` is the server's own; the others are Eaon's notes. */
export interface McpLogLine {
  at: number
  stream: 'stderr' | 'info' | 'error'
  text: string
}

export const isToolOff = (server: Pick<McpServer, 'disabledTools'>, name: string): boolean => server.disabledTools?.includes(name) ?? false

export function toolPermission(server: Pick<McpServer, 'toolPermissions'>, name: string): McpToolPermission {
  const rule = server.toolPermissions?.[name]
  return rule === 'allow' || rule === 'block' ? rule : 'default'
}

/** The server with `names` switched off or back on; nothing is saved for a tool that is on. */
export function withToolsOff<T extends Rules>(server: T, names: string[], off: boolean): T {
  const wanted = new Set(server.disabledTools ?? [])
  for (const name of names) {
    if (off) wanted.add(name)
    else wanted.delete(name)
  }
  const { disabledTools: _before, ...rest } = server
  return wanted.size > 0 ? { ...(rest as T), disabledTools: [...wanted].sort() } : (rest as T)
}

/** The server with one tool's permission set; `default` removes the rule. */
export function withToolPermission<T extends Rules>(server: T, name: string, permission: McpToolPermission): T {
  const rules = { ...(server.toolPermissions ?? {}) }
  if (permission === 'default') delete rules[name]
  else rules[name] = permission
  const { toolPermissions: _before, ...rest } = server
  return Object.keys(rules).length > 0 ? { ...(rest as T), toolPermissions: rules } : (rest as T)
}

/**
 * Why a call may not be made at all, in words for the model and the person:
 * the tool is turned off or blocked in settings. Null when no rule stops it.
 */
export function toolRefusal(server: Rules, name: string): string | null {
  if (isToolOff(server, name)) return `"${name}" is turned off in Settings → MCP Servers, so it can't be called. Don't retry it; tell the user if it is needed.`
  if (toolPermission(server, name) === 'block') return `"${name}" is blocked in Settings → MCP Servers, so it was not run. Don't retry it or look for another way around it; tell the user if it is needed.`
  return null
}

/** The rules a saved server may carry, cleaned: names as strings, permissions only `allow` or `block`. */
export function cleanToolRules(raw: { disabledTools?: unknown; toolPermissions?: unknown }): Rules {
  const out: Rules = {}
  if (Array.isArray(raw.disabledTools)) {
    const names = [...new Set(raw.disabledTools.filter((n): n is string => typeof n === 'string' && n.length > 0 && n.length <= 200))].sort()
    if (names.length > 0) out.disabledTools = names
  }
  if (typeof raw.toolPermissions === 'object' && raw.toolPermissions !== null && !Array.isArray(raw.toolPermissions)) {
    const rules: Record<string, 'allow' | 'block'> = {}
    for (const [name, rule] of Object.entries(raw.toolPermissions)) if (name && name.length <= 200 && (rule === 'allow' || rule === 'block')) rules[name] = rule
    if (Object.keys(rules).length > 0) out.toolPermissions = rules
  }
  return out
}

/** The path with its separators made `/`, no trailing one, and the drive letter lower-cased: for comparing folders. */
function normalizedPath(path: string): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:/.test(slashed) ? slashed[0].toLowerCase() + slashed.slice(1) : slashed
}

/** `child` is `parent` or a folder inside it. */
export function isInside(child: string, parent: string): boolean {
  const c = normalizedPath(child)
  const p = normalizedPath(parent)
  return p !== '' && (c === p || c.startsWith(`${p}/`))
}

/**
 * Whether a server's tools are offered in a run in `cwd`: always, unless it
 * came from a project's own file, and then only in that project's folder.
 */
export const serverOfferedIn = (server: Pick<McpServer, 'projectPath'>, cwd: string | null): boolean =>
  !server.projectPath || (cwd !== null && isInside(cwd, server.projectPath))

/** A tool counts as on unless its server lists it in `disabledTools`; no server (not configured) counts as on. */
export const toolEnabled = (server: Pick<McpServer, 'disabledTools'> | undefined, tool: string): boolean => !server || !isToolOff(server, tool)

/** `disabledTools` with `tool` turned on or off. Undefined when none are off, so the row stays as it was written. */
export function withTool(server: Pick<McpServer, 'disabledTools'>, tool: string, on: boolean): string[] | undefined {
  const off = new Set(server.disabledTools ?? [])
  if (on) off.delete(tool)
  else off.add(tool)
  return off.size > 0 ? [...off].sort() : undefined
}

/** `disabledTools` with every one of `tools` on or off, leaving names for tools not listed (a server that is stopped) as they were. */
export function withAllTools(server: Pick<McpServer, 'disabledTools'>, tools: string[], on: boolean): string[] | undefined {
  const off = new Set(server.disabledTools ?? [])
  for (const tool of tools) {
    if (on) off.delete(tool)
    else off.add(tool)
  }
  return off.size > 0 ? [...off].sort() : undefined
}
