import type { McpServer } from './types'

/**
 * Which of an MCP server's tools are on. A server's tools are all on unless
 * the server row lists them in `disabledTools`: a tool the server adds later
 * is on, and a tool that goes away leaves a harmless name behind.
 */

export const toolEnabled = (server: Pick<McpServer, 'disabledTools'> | undefined, tool: string): boolean => !server?.disabledTools?.includes(tool)

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
