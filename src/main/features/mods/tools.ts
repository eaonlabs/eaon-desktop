import { toolHost, type ModManifest, type ModTool } from '@shared/mods'
import { privateAddressOf } from '../../netGuard'
import { registerToolSource, safeToolName, type AgentTool } from '../../agent/tools'

/**
 * Mods' tools: each one HTTPS GET to the host fixed in its URL, with the
 * call's arguments filled into the path and query. Offered to agents in Work
 * mode (Chat's agent and the workers) while their mod is on. Nothing else
 * reaches the network: the host can't come from an argument, a redirect
 * can't leave it, and private addresses are refused.
 */

const DEFAULT_MAX_CHARS = 6000
const MAX_BYTES = 1024 * 1024

/** The tool's URL with `{name}` placeholders filled from `input`, each encoded. Throws on a missing required one. */
export function buildToolUrl(tool: ModTool, input: Record<string, unknown>): URL {
  const filled = tool.url.replace(/\{([a-zA-Z_]\w*)\}/g, (_match, name: string) => {
    const param = tool.params.find((p) => p.name === name)
    const value = input[name]
    if (value === undefined || value === null || value === '') {
      if (param?.required) throw new Error(`${name} is required`)
      return ''
    }
    if (param?.enum && !param.enum.includes(String(value))) throw new Error(`${name} must be one of ${param.enum.join(', ')}`)
    return encodeURIComponent(String(value).slice(0, 300))
  })
  const url = new URL(filled)
  // Query parameters a missing optional argument left empty are dropped, so the server sees no "q=".
  for (const [key, value] of [...url.searchParams]) if (value === '') url.searchParams.delete(key)
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== toolHost(tool.url)) throw new Error('The tool’s address changed host')
  return url
}

/** The parts of a JSON answer the tool keeps: dotted paths, `*` for every item of a list. */
export function pickJson(value: unknown, paths: string[]): unknown {
  const at = (node: unknown, parts: string[]): unknown => {
    if (parts.length === 0) return node
    const [head, ...rest] = parts
    if (head === '*') return Array.isArray(node) ? node.map((item) => at(item, rest)) : undefined
    if (node === null || typeof node !== 'object') return undefined
    return at((node as Record<string, unknown>)[head], rest)
  }
  const out: Record<string, unknown> = {}
  for (const path of paths) out[path] = at(value, path.split('.'))
  return out
}

function asSchema(tool: ModTool): Record<string, unknown> {
  return {
    type: 'object',
    properties: Object.fromEntries(
      tool.params.map((p) => [p.name, { type: p.type, description: p.description, ...(p.enum ? { enum: p.enum } : {}) }])
    ),
    required: tool.params.filter((p) => p.required).map((p) => p.name),
    additionalProperties: false
  }
}

async function call(tool: ModTool, input: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  const url = buildToolUrl(tool, input)
  if (await privateAddressOf(url.hostname)) throw new Error(`${url.hostname} points into the local network`)
  const response = await fetch(url, {
    redirect: 'error',
    headers: { 'User-Agent': 'Eaon', Accept: 'application/json, text/plain;q=0.8, */*;q=0.5' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)])
  })
  const body = await response.arrayBuffer()
  const text = Buffer.from(body.byteLength > MAX_BYTES ? body.slice(0, MAX_BYTES) : body).toString('utf8')
  if (!response.ok) return `${url.hostname} answered ${response.status}: ${text.slice(0, 500)}`
  let out = text
  if (/json/i.test(response.headers.get('content-type') ?? '') || /^\s*[[{]/.test(text)) {
    try {
      const json = JSON.parse(text)
      out = JSON.stringify(tool.pick ? pickJson(json, tool.pick) : json)
    } catch {
      // Not JSON after all: sent as text.
    }
  }
  const max = tool.maxChars ?? DEFAULT_MAX_CHARS
  return out.length > max ? `${out.slice(0, max)}… (cut at ${max} characters)` : out
}

/** The agent tools for these mods' HTTP tools. */
export function modAgentTools(mods: ModManifest[]): AgentTool[] {
  return mods.flatMap((mod) =>
    (mod.contributes.tools ?? []).map(
      (tool): AgentTool => ({
        name: safeToolName(tool.name),
        description: `${tool.description} (From the ${mod.name} mod. Reads ${toolHost(tool.url)}.)`,
        inputSchema: asSchema(tool),
        mutating: false,
        describe: (input) => {
          try {
            return `${mod.name}: ${buildToolUrl(tool, input).toString().slice(0, 160)}`
          } catch {
            return `${mod.name}: ${tool.name}`
          }
        },
        run: async (input, ctx) => {
          try {
            return await call(tool, input, ctx.signal)
          } catch (error) {
            return `${tool.name} failed: ${error instanceof Error ? error.message : String(error)}`
          }
        }
      })
    )
  )
}

export function registerModTools(enabled: () => ModManifest[]): void {
  registerToolSource({
    id: 'mods',
    tools: (query) => (query.mode === 'work' ? modAgentTools(enabled()) : [])
  })
}
