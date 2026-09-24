import type { McpTool } from '@shared/types'
import { callMcpTool, getTools, serverName } from '../mcp'
import { capOutput, registerToolSource, safeToolName, type AgentTool } from './tools'

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

const directName = (tool: McpTool): string => safeToolName(`${serverName(tool.serverId).toLowerCase()}__${tool.name}`)

function plugin(tool: McpTool): AgentTool {
  return {
    name: directName(tool),
    description: `[${serverName(tool.serverId)}] ${tool.description}`.slice(0, 1024),
    inputSchema: tool.inputSchema,
    mutating: !tool.readOnly,
    // An action through a plugin reaches another service — a message sent,
    // an issue filed — so only calls the server marks non-destructive skip
    // the question in "Approve for me".
    risky: () => tool.destructive === true || !tool.readOnly,
    run: async (input, ctx) =>
      capOutput(await callMcpTool(tool.name, input, ctx.settings.mcp.toolCallTimeoutSeconds * 1000, tool.serverId))
  }
}

function findTool(all: McpTool[], name: string): McpTool | undefined {
  const wanted = name.trim()
  return (
    all.find((t) => `${serverName(t.serverId)}/${t.name}` === wanted) ??
    all.find((t) => directName(t) === wanted) ??
    all.find((t) => t.name === wanted)
  )
}

function deferred(all: McpTool[]): AgentTool[] {
  const servers = [...new Set(all.map((t) => serverName(t.serverId)))]
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
          const tool = findTool(all, input.name)
          if (!tool) return `No plugin tool named "${input.name}". Call plugin_tools without arguments to list them.`
          return `${serverName(tool.serverId)}/${tool.name}\n${tool.description}\n\nInput schema:\n${JSON.stringify(tool.inputSchema)}`
        }
        const filter = typeof input.plugin === 'string' ? input.plugin.toLowerCase() : ''
        const rows = all
          .filter((t) => !filter || serverName(t.serverId).toLowerCase().includes(filter))
          .map((t) => `${serverName(t.serverId)}/${t.name}${t.readOnly ? '' : ' ✎'} — ${t.description.split('\n')[0].slice(0, 110)}`)
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
      mutating: (input) => !findTool(all, String(input.name ?? ''))?.readOnly,
      risky: (input) => {
        const tool = findTool(all, String(input.name ?? ''))
        return !tool || tool.destructive === true || !tool.readOnly
      },
      describe: (input) => String(input.name ?? ''),
      run: async (input, ctx) => {
        const tool = findTool(all, String(input.name ?? ''))
        if (!tool) return { text: `No plugin tool named "${String(input.name ?? '')}". Call plugin_tools to list them.`, isError: true }
        const args = (input.arguments && typeof input.arguments === 'object' ? input.arguments : {}) as Record<string, unknown>
        return capOutput(await callMcpTool(tool.name, args, ctx.settings.mcp.toolCallTimeoutSeconds * 1000, tool.serverId))
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
    // "Smart routing" in Settings now means: defer schemas once there are many.
    return usable.length <= DIRECT_LIMIT || !query.settings.mcp.smartRouting ? usable.map(plugin) : deferred(usable)
  }
})
