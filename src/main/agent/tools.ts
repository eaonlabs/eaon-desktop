import type { AgentMode, GoalState, PlanProposal, Settings, StreamEvent, StreamRequest, TokenUsage } from '@shared/types'
import type { NeutralImage, ToolSpec } from '../providers/adapters/types'

/**
 * The tool registry.
 *
 * Every capability the agent has — files, shell, web, plugins, the browser
 * extension, computer use, schedules, sub-agents — is a `ToolSource` that
 * registers itself here. The loop asks for the tools that apply to a turn and
 * never needs to know which feature a tool came from, so adding a capability
 * is one new module and one import in `sources.ts`.
 */

export interface ToolResult {
  text: string
  /** Screenshots and other images; saved to disk by the loop and shown in the transcript. */
  images?: NeutralImage[]
  isError?: boolean
}

/**
 * State tools share with the loop for the length of one turn — how a tool
 * says "stop here and wait for the user" (a presented plan) or "the goal is
 * done" without the loop special-casing tool names.
 */
export interface TurnState {
  /** Set by present_plan: the loop ends the turn once the round's tools finish. */
  plan?: PlanProposal
  /** Set by goal_complete / goal_blocked. */
  goalResolution?: { status: Extract<GoalState['status'], 'achieved' | 'blocked'>; summary: string }
  /** Anything a tool wants to hand back to the loop that the loop does not interpret. */
  notes: string[]
  /** Tokens spent inside a tool (sub-agents), folded into the turn's usage by the loop. */
  extraUsage?: TokenUsage
}

export interface ToolContext {
  request: StreamRequest
  turn: TurnState
  /** Folder the agent works in. Always set in Work mode. */
  cwd: string
  signal: AbortSignal
  emit: (event: StreamEvent) => void
  /** This call's id, for tool-progress events. */
  toolId: string
  /** 0 for the main agent, 1 inside a swarm sub-agent. */
  depth: number
  readOnly: boolean
  settings: Settings
  /** Streams partial output into the transcript while a slow tool is still running. */
  progress: (output: string) => void
  /**
   * Asks the user to approve something this tool is about to do, beyond the
   * standard gate the loop already applied — e.g. computer use confirming a
   * single click. Resolves false when denied.
   */
  confirm: (title: string, detail: Record<string, unknown>) => Promise<boolean>
}

export interface AgentTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /**
   * Whether a call changes anything outside the conversation — files,
   * commands, clicks, messages sent through a plugin. Mutating calls are
   * blocked in plan mode and go through approval.
   */
  mutating: boolean | ((input: Record<string, unknown>, ctx: ToolContext) => boolean)
  /**
   * Whether a mutating call is risky enough to ask even in "Approve for me".
   * Defaults to false: auto mode then runs it without asking.
   */
  risky?: (input: Record<string, unknown>, ctx: ToolContext) => boolean
  /** One-line summary for the approval dialog and the thinking trace. */
  describe?: (input: Record<string, unknown>) => string
  run: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult | string>
}

export interface ToolQuery {
  mode: AgentMode
  cwd: string | null
  depth: number
  readOnly: boolean
  settings: Settings
  request: StreamRequest
}

export interface ToolSource {
  id: string
  tools: (query: ToolQuery) => AgentTool[]
  /**
   * Optional text appended to the Work system prompt while this source offers
   * tools — how to use them well. Kept short: it is sent on every request.
   */
  guidance?: (query: ToolQuery) => string | null
}

const sources: ToolSource[] = []

export function registerToolSource(source: ToolSource): void {
  const existing = sources.findIndex((s) => s.id === source.id)
  if (existing === -1) sources.push(source)
  else sources[existing] = source
}

/**
 * Names providers accept are `^[a-zA-Z0-9_-]{1,64}$`; MCP servers are not
 * bound by that and routinely use dots and slashes.
 */
export function safeToolName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  return cleaned.length <= 64 ? cleaned : `${cleaned.slice(0, 55)}_${hash(cleaned)}`
}

function hash(text: string): string {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36).slice(0, 8)
}

/**
 * Tools for one turn, deduplicated by name and in a stable order. The order
 * matters for cost: the tool list is the head of every cached prompt prefix,
 * so the same set must serialise identically from one request to the next.
 */
export function toolsFor(query: ToolQuery): AgentTool[] {
  const seen = new Set<string>()
  const out: AgentTool[] = []
  for (const source of sources) {
    let offered: AgentTool[]
    try {
      offered = source.tools(query)
    } catch (error) {
      console.error(`[tools] source ${source.id} failed:`, error)
      continue
    }
    for (const tool of offered) {
      if (seen.has(tool.name)) continue
      seen.add(tool.name)
      out.push(tool)
    }
  }
  return out
}

export function guidanceFor(query: ToolQuery): string[] {
  const out: string[] = []
  for (const source of sources) {
    try {
      const text = source.guidance?.(query)
      if (text && source.tools(query).length > 0) out.push(text)
    } catch {
      /* a broken source must not take the prompt down with it */
    }
  }
  return out
}

export function toSpec(tool: AgentTool): ToolSpec {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema }
}

export function isMutating(tool: AgentTool, input: Record<string, unknown>, ctx: ToolContext): boolean {
  return typeof tool.mutating === 'function' ? tool.mutating(input, ctx) : tool.mutating
}

/** Keeps a tool result's head and tail, which is where errors and summaries live. */
export function capOutput(text: string, limit = 16_000): string {
  if (text.length <= limit) return text
  const head = Math.floor(limit * 0.7)
  const tail = limit - head
  return `${text.slice(0, head)}\n\n…[${(text.length - limit).toLocaleString()} characters omitted]…\n\n${text.slice(-tail)}`
}
