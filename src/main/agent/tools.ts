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
  /**
   * Set by a worker's sleep: it stops until a wake-up it scheduled. The loop
   * ends the turn once the round's tools finish, and a goal is not sent back
   * to work meanwhile; it resumes when the worker wakes.
   */
  yielded?: { until: number }
  /** Anything a tool wants to hand back to the loop that the loop does not interpret. */
  notes: string[]
  /** Tokens spent inside a tool (sub-agents), folded into the turn's usage by the loop. */
  extraUsage?: TokenUsage
  /**
   * Evidence bookkeeping for goal_complete, kept by the loop: the most recent
   * successful change and the most recent call that looked at the result.
   * Numbers are positions in the turn's sequence of tool calls.
   */
  evidence?: { seq: number; lastChange?: { seq: number; tool: string }; lastCheck?: number; verifyAsked?: boolean }
}

/** Tools that steer the turn itself; calling them neither changes nor checks anything. */
export const WORKFLOW_TOOLS = new Set(['update_plan', 'present_plan', 'goal_complete', 'goal_blocked', 'wait', 'sleep'])

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
  confirm: (title: string, detail: Record<string, unknown>, summary?: string) => Promise<boolean>
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
  /**
   * Whether a call could do lasting damage nobody can undo: wiping a disk,
   * `sudo`, spending money, typing a card number, a plugin action its server
   * marks destructive. An autonomous worker runs risky calls on its own but
   * never these. Defaults to false.
   */
  catastrophic?: (input: Record<string, unknown>, ctx: ToolContext) => boolean
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
/** Which source offered each tool, for policies that depend on where a tool came from. */
const offeredBy = new WeakMap<AgentTool, string>()

export function toolSourceOf(tool: AgentTool): string | undefined {
  return offeredBy.get(tool)
}

/** A registered source by id, so another front end (the CLI) can wrap it before replacing it. */
export function getToolSource(id: string): ToolSource | undefined {
  return sources.find((s) => s.id === id)
}

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
      // Plan mode withholds tools that can only change things rather than
      // offering them and refusing every call: cheaper, and the model does not
      // waste rounds trying them. Tools whose effect depends on their input
      // (run_command, plugin calls, the browser) stay and are checked per call.
      if (query.readOnly && tool.mutating === true) continue
      seen.add(tool.name)
      offeredBy.set(tool, source.id)
      out.push(tool)
    }
  }
  return out
}

/**
 * Each source's guidance, for the sources that offer this run a tool. With
 * `offer` (a run held to a few tools, like a trading check), a source counts
 * only if one of its offered tools passes: guidance about tools the model
 * can't call costs tokens on every request and invites calls that fail.
 */
export function guidanceFor(query: ToolQuery, offer?: (name: string) => boolean): string[] {
  const out: string[] = []
  for (const source of sources) {
    try {
      const text = source.guidance?.(query)
      if (text && source.tools(query).some((tool) => !offer || offer(tool.name))) out.push(text)
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
