import { createHash } from 'node:crypto'
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { NeutralToolResult, ToolSpec } from '../adapters/types'

/**
 * Eaon's tools, offered to Claude as an MCP server inside Eaon's own process.
 * Claude Code's built-in tools are switched off, so these are the only tools
 * it has: when Claude calls one, the call is held (`onCall`) until Eaon's
 * loop has run it, through Eaon's approvals, and sent back its result.
 */

export const SERVER = 'eaon'
export const PREFIX = `mcp__${SERVER}__`
/** Claude Code cuts each MCP tool description at this many characters. */
const DESCRIPTION_LIMIT = 2048

/** A tool's name as Claude may call it: MCP names are 64 characters at most, prefix included. */
export function shortName(name: string): string {
  const limit = 64 - PREFIX.length
  if (name.length <= limit && /^[a-zA-Z0-9_-]+$/.test(name)) return name
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 10)
  return `${name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, limit - 11)}_${hash}`
}

/** A tool's result as MCP carries it back to Claude: its text, and its screenshots. */
export function mcpResult(result: NeutralToolResult): CallToolResult {
  const content: CallToolResult['content'] = [{ type: 'text', text: result.output || '(no output)' }]
  for (const image of result.images ?? []) content.push({ type: 'image', data: image.data, mimeType: image.mime })
  return { content, ...(result.isError ? { isError: true } : {}) }
}

export function toolServer(
  tools: ToolSpec[],
  onCall: (name: string, input: Record<string, unknown>) => Promise<CallToolResult>
): McpSdkServerConfigWithInstance {
  const byShort = new Map(tools.map((tool) => [shortName(tool.name), tool.name]))
  const server = new McpServer({ name: SERVER, version: '1.0.0' }, { capabilities: { tools: {} } })
  const definitions = tools.map((tool) => ({
    name: shortName(tool.name),
    description: tool.description.slice(0, DESCRIPTION_LIMIT),
    inputSchema: { type: 'object', ...tool.inputSchema } as { type: 'object'; [key: string]: unknown },
    // Not read-only: Claude Code then makes one call at a time, so each is held and answered in order.
    annotations: { readOnlyHint: false },
    // Every tool listed up front (no tool search), with room for Eaon's own output limits.
    _meta: { 'anthropic/alwaysLoad': true, 'anthropic/maxResultSizeChars': 500_000 }
  }))
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }))
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = byShort.get(request.params.name)
    if (!name) return { isError: true, content: [{ type: 'text', text: `There’s no tool called ${request.params.name}.` }] }
    return onCall(name, (request.params.arguments ?? {}) as Record<string, unknown>)
  })
  return { type: 'sdk', name: SERVER, instance: server }
}
