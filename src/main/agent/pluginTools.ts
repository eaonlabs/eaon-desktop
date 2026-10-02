import type { McpTool } from '@shared/types'
import { callMcpToolResult, getTools, serverNames, type McpCallResult } from '../mcp'
import { brokerOf, brokerWriteNeedsUser, tradingHalted, writesToBroker } from '../features/trading/access'
import { capOutput, registerToolSource, safeToolName, type AgentTool, type ToolContext, type ToolResult } from './tools'

/**
 * Connected plugins (MCP servers) as agent tools, in Work mode only.
 *
 * A handful of plugin tools are offered directly. Past that, their schemas
 * are held back behind two small tools — one to look tools up, one to call
 * them — because a single GitHub connection alone is dozens of schemas, and
 * every schema offered is paid for on every request of every turn whether the
 * model touches it or not. Deferring keeps the tool list (the head of the
 * cached prefix) small and stable; a schema costs tokens only once the model
 * actually asks for it.
 *
 * This replaces keyword "smart routing", which re-picked tools from the
 * conversation's words each turn: that changed the tool list between
 * requests, which throws away the prompt cache every time it shifts.
 */

const DIRECT_LIMIT = 12

/** Server display names, read once per listing (each lookup would otherwise re-read mcp.json). */
type Names = Map<string, string>
const nameOf = (names: Names, tool: McpTool): string => names.get(tool.serverId) ?? tool.serverId
const directName = (names: Names, tool: McpTool): string => safeToolName(`${nameOf(names, tool).toLowerCase()}__${tool.name}`)

async function call(tool: McpTool, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | string> {
  // The trading desk's kill switch stops every order, a broker plugin's too.
  if (tradingHalted() && writesToBroker(tool) && brokerOf(tool.serverId, ctx.request.chatId)) {
    return { text: 'Trading is halted: the kill switch on the trading desk is on, so no orders can be placed or changed until it is switched off.', isError: true }
  }
  const result: McpCallResult = await callMcpToolResult(tool.name, input, ctx.settings.mcp.toolCallTimeoutSeconds * 1000, tool.serverId, ctx.signal)
  const text = capOutput(result.text)
  return result.images || result.isError ? { ...result, text } : text
}

function plugin(tool: McpTool, names: Names): AgentTool {
  return {
    name: directName(names, tool),
    description: `[${nameOf(names, tool)}] ${tool.description}`.slice(0, 1024),
    inputSchema: tool.inputSchema,
    mutating: !tool.readOnly,
    // An action through a plugin reaches another service — a message sent,
    // an issue filed — so only calls the server marks non-destructive skip
    // the question in "Approve for me".
    risky: () => tool.destructive === true || !tool.readOnly,
    // The server itself says this deletes or overwrites something — or it is
    // an order at a broker the user hasn't let this run trade at on its own.
    catastrophic: (_input, ctx) => tool.destructive === true || brokerWriteNeedsUser(tool, ctx.request.chatId),
    run: (input, ctx) => call(tool, input, ctx)
  }
}

function findTool(all: McpTool[], names: Names, name: string): McpTool | undefined {
  const wanted = name.trim()
  return (
    all.find((t) => `${nameOf(names, t)}/${t.name}` === wanted) ??
    all.find((t) => directName(names, t) === wanted) ??
    all.find((t) => t.name === wanted)
  )
}

/**
 * `use_plugin_tool`'s arguments. The schema says object, but models often
 * send an untyped object parameter as a JSON string instead; reading that as
 * "no arguments" would run the tool with none. Anything else is refused.
 */
function pluginArguments(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null || value === '') return {}
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value)
    } catch {
      return null
    }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
}

function deferred(all: McpTool[], names: Names): AgentTool[] {
  const servers = [...new Set(all.map((t) => nameOf(names, t)))]
  return [
    {
      name: 'plugin_tools',
      description: `Look up tools from connected plugins (${servers.join(', ')}). Without arguments lists every tool briefly; pass name to get one tool's full input schema before calling it.`,
      inputSchema: {
        type: 'object',
        properties: {
          plugin: { type: 'string', description: 'Only list this plugin\'s tools' },
          name: { type: 'string', description: 'A tool name ("Plugin/tool") to get its full schema' }
        }
      },
      mutating: false,
      describe: (input) => String(input.name ?? input.plugin ?? 'all'),
      run: async (input) => {
        if (typeof input.name === 'string' && input.name) {
          const tool = findTool(all, names, input.name)
          if (!tool) return `No plugin tool named "${input.name}". Call plugin_tools without arguments to list them.`
          return `${nameOf(names, tool)}/${tool.name}\n${tool.description}\n\nInput schema:\n${JSON.stringify(tool.inputSchema)}`
        }
        const filter = typeof input.plugin === 'string' ? input.plugin.toLowerCase() : ''
        const rows = all
          .filter((t) => !filter || nameOf(names, t).toLowerCase().includes(filter))
          .map((t) => `${nameOf(names, t)}/${t.name}${t.readOnly ? '' : ' ✎'} — ${t.description.split('\n')[0].slice(0, 110)}`)
        return rows.length > 0
          ? `${rows.join('\n')}\n\n(✎ = changes data.) Get a schema with plugin_tools {name}, then call use_plugin_tool.`
          : 'No matching plugin tools.'
      }
    },
    {
      name: 'use_plugin_tool',
      description: 'Call a connected plugin\'s tool by name ("Plugin/tool") with its arguments. Look the schema up with plugin_tools first.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          arguments: { type: 'object', description: 'Arguments matching the tool\'s input schema' }
        },
        required: ['name']
      },
      mutating: (input) => !findTool(all, names, String(input.name ?? ''))?.readOnly,
      risky: (input) => {
        const tool = findTool(all, names, String(input.name ?? ''))
        return !tool || tool.destructive === true || !tool.readOnly
      },
      catastrophic: (input, ctx) => {
        const tool = findTool(all, names, String(input.name ?? ''))
        return tool?.destructive === true || (tool !== undefined && brokerWriteNeedsUser(tool, ctx.request.chatId))
      },
      describe: (input) => String(input.name ?? ''),
      run: async (input, ctx) => {
        const tool = findTool(all, names, String(input.name ?? ''))
        if (!tool) return { text: `No plugin tool named "${String(input.name ?? '')}". Call plugin_tools to list them.`, isError: true }
        const args = pluginArguments(input.arguments)
        if (!args) return { text: 'arguments must be a JSON object matching the tool\'s input schema.', isError: true }
        return call(tool, args, ctx)
      }
    }
  ]
}

registerToolSource({
  id: 'plugins',
  tools: (query) => {
    if (query.mode !== 'work') return []
    const all = getTools()
    if (all.length === 0) return []
    const usable = query.readOnly ? all.filter((t) => t.readOnly) : all
    if (usable.length === 0) return []
    const names = serverNames()
    // "Smart routing" in Settings now means: defer schemas once there are many.
    return usable.length <= DIRECT_LIMIT || !query.settings.mcp.smartRouting
      ? usable.map((tool) => plugin(tool, names))
      : deferred(usable, names)
  }
})
