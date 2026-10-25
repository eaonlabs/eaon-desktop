import type { StreamEvent, TodoItem } from '@shared/types'
import type { EngineApprovalRequest } from '../types'
import type { AcpContentBlock, AcpPermissionRequest, AcpSessionUpdate, AcpToolCall } from './protocol'

/**
 * One ACP prompt turn, as the transcript draws it: the agent's
 * `session/update`s become the same events Eaon's own loop and Codex send,
 * and its permission requests go to Eaon's approval policy.
 */

/** ACP tool kinds as Eaon's own tool names, so the work rows read "Read 2 files and ran a command". */
const TOOL_NAME: Record<string, string> = {
  read: 'read_file',
  edit: 'edit_file',
  delete: 'delete_file',
  move: 'move_file',
  search: 'grep',
  execute: 'run_command',
  fetch: 'web_fetch'
}
const MUTATING = new Set(['edit', 'delete', 'move', 'execute'])
/** How much of a tool's output to keep in the transcript. */
const OUTPUT_LIMIT = 20_000

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined)
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

/** An ACP tool call as one of Eaon's: its own name where the kind matches one, the agent's title otherwise. */
export function toolOf(call: AcpToolCall): { name: string; input: Record<string, unknown>; mutating: boolean } {
  const kind = call.kind ?? 'other'
  const raw = record(call.rawInput)
  const title = call.title ?? ''
  const path = call.locations?.[0]?.path ?? text(raw.path) ?? text(raw.file_path) ?? text(raw.filePath)
  const mutating = MUTATING.has(kind)
  switch (kind) {
    case 'read':
      return { name: 'read_file', input: path ? { path } : { title }, mutating }
    case 'edit': {
      const diff = call.content?.find((c) => c.type === 'diff') as { path: string; oldText?: string | null; newText: string } | undefined
      if (diff && (diff.oldText === null || diff.oldText === undefined)) return { name: 'write_file', input: { path: diff.path, content: diff.newText }, mutating }
      if (diff) return { name: 'edit_file', input: { path: diff.path, old_text: diff.oldText, new_text: diff.newText }, mutating }
      return { name: 'edit_file', input: path ? { path } : { title }, mutating }
    }
    case 'delete':
      return { name: 'delete_file', input: path ? { path } : { title }, mutating }
    case 'move':
      return { name: 'move_file', input: { from: text(raw.from) ?? path ?? title, to: text(raw.to) ?? '' }, mutating }
    case 'search':
      return { name: 'grep', input: { pattern: text(raw.pattern) ?? text(raw.query) ?? title, ...(path ? { path } : {}) }, mutating }
    case 'execute': {
      const command = text(raw.command) ?? (Array.isArray(raw.command) ? raw.command.join(' ') : undefined) ?? title
      return { name: 'run_command', input: { command, ...(text(raw.cwd) ? { cwd: raw.cwd } : {}) }, mutating }
    }
    case 'fetch':
      return { name: 'web_fetch', input: { url: text(raw.url) ?? title }, mutating }
    default:
      // The agent's own words name it: "Searching the web", "Viewing image".
      return { name: title.slice(0, 80) || 'tool', input: path ? { path } : {}, mutating }
  }
}

/** What a finished call printed: its text content, or its raw output. */
function outputOf(call: AcpToolCall): string {
  const parts: string[] = []
  for (const item of call.content ?? []) {
    if (item.type === 'content') {
      const block = (item as { content: AcpContentBlock }).content
      if (block.type === 'text') parts.push(String((block as { text: string }).text))
    }
  }
  if (parts.length === 0 && call.rawOutput !== undefined && call.rawOutput !== null) {
    const raw = call.rawOutput
    const out = record(raw)
    parts.push(text(raw) ?? text(out.output) ?? text(out.stdout) ?? JSON.stringify(raw))
  }
  const joined = parts.join('\n')
  return joined.length > OUTPUT_LIMIT ? `${joined.slice(0, OUTPUT_LIMIT)}\n…` : joined
}

interface ToolState {
  call: AcpToolCall
  /** The transcript has its tool-call event. */
  shown: boolean
  finished: boolean
}

export class AcpTurn {
  /** The answer so far: the agent's message chunks. */
  text = ''
  /** A call that changes something ran (or was allowed to). */
  sideEffects = false
  private readonly tools = new Map<string, ToolState>()
  private readonly waiting = new Set<() => void>()

  constructor(
    private readonly messageId: string,
    private readonly emit: (event: StreamEvent) => void,
    private readonly approve: (request: EngineApprovalRequest) => Promise<boolean>
  ) {}

  update(update: AcpSessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const block = (update as { content: AcpContentBlock }).content
        if (block?.type === 'text') {
          const chunk = String((block as { text: string }).text)
          this.text += chunk
          this.emit({ type: 'delta', messageId: this.messageId, text: chunk })
        }
        return
      }
      case 'agent_thought_chunk': {
        const block = (update as { content: AcpContentBlock }).content
        if (block?.type === 'text') this.emit({ type: 'reasoning', messageId: this.messageId, text: String((block as { text: string }).text) })
        return
      }
      case 'tool_call':
      case 'tool_call_update':
        this.tool(update as unknown as AcpToolCall)
        return
      case 'plan': {
        const entries = (update as { entries?: { content: string; status: string }[] }).entries ?? []
        const todos: TodoItem[] = entries.map((e) => ({ text: e.content, status: e.status === 'completed' ? 'done' : e.status === 'in_progress' ? 'in_progress' : 'pending' }))
        this.emit({ type: 'todos', messageId: this.messageId, todos })
        return
      }
      default:
      // Commands, modes, usage and anything newer: nothing the transcript draws.
    }
  }

  /** A call's first sighting or a later update: merged, shown once, finished once. */
  private tool(update: AcpToolCall): void {
    const id = update.toolCallId
    if (!id) return
    const known = this.tools.get(id)
    const call: AcpToolCall = known ? { ...known.call, ...defined(update) } : update
    const state: ToolState = known ?? { call, shown: false, finished: false }
    state.call = call
    this.tools.set(id, state)
    const done = call.status === 'completed' || call.status === 'failed'
    // An edit is held back until its diff (or its end) arrives, so its card shows the change.
    const ready = call.kind !== 'edit' || done || call.content?.some((c) => c.type === 'diff')
    if (!state.shown && ready) this.show(state)
    if (done && !state.finished) {
      if (!state.shown) this.show(state)
      state.finished = true
      const output = outputOf(call)
      if (call.status === 'completed' && toolOf(call).mutating) this.sideEffects = true
      this.emit({ type: 'tool-result', messageId: this.messageId, toolId: id, output, status: call.status === 'failed' ? 'error' : 'done' })
    } else if (state.shown && call.status === 'in_progress') {
      const output = outputOf(call)
      if (output) this.emit({ type: 'tool-progress', messageId: this.messageId, toolId: id, output })
    }
  }

  private show(state: ToolState): void {
    state.shown = true
    const { name, input } = toolOf(state.call)
    this.emit({ type: 'tool-call', messageId: this.messageId, toolId: state.call.toolCallId, name, input })
  }

  /**
   * Answers `session/request_permission` with Eaon's decision. The call is
   * shown first, so the approval names something on screen. Never answers
   * on Eaon's behalf with an option the agent didn't offer.
   */
  async permission(request: AcpPermissionRequest): Promise<{ outcome: { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string } }> {
    const call = request.toolCall
    this.tool({ ...call, status: call.status === 'completed' || call.status === 'failed' ? null : call.status })
    const merged = this.tools.get(call.toolCallId)?.call ?? call
    const { name, input, mutating } = toolOf(merged)
    let cancel = (): void => {}
    const allowed = await new Promise<boolean | null>((resolve) => {
      cancel = (): void => resolve(null)
      this.waiting.add(cancel)
      this.approve({ tool: name, input, summary: merged.title ?? name, mutating }).then(
        (yes) => resolve(yes === true),
        () => resolve(false)
      )
    }).finally(() => this.waiting.delete(cancel))
    if (allowed === null) return { outcome: { outcome: 'cancelled' } }
    const pick = (kinds: string[]): string | undefined => kinds.map((k) => request.options.find((o) => o.kind === k)?.optionId).find(Boolean)
    const optionId = allowed ? pick(['allow_once', 'allow_always']) : pick(['reject_once', 'reject_always'])
    if (!optionId) return { outcome: { outcome: 'cancelled' } }
    if (allowed && mutating) this.sideEffects = true
    return { outcome: { outcome: 'selected', optionId } }
  }

  /** The turn was stopped: every approval still waiting is answered `cancelled`, as ACP requires. */
  cancelPending(): void {
    for (const cancel of this.waiting) cancel()
    this.waiting.clear()
  }
}

/** An update's fields that are set, so merging it doesn't blank what an earlier one said. */
function defined(update: AcpToolCall): Partial<AcpToolCall> {
  return Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined && value !== null)) as Partial<AcpToolCall>
}
