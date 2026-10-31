import type { PermissionResult, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { StreamEvent, TokenUsage } from '@shared/types'
import type { EngineApprovalRequest, EngineBilling, EngineErrorKind } from '../types'
import { todosOf, toolOf } from './tools'

/**
 * One Claude turn, as the transcript draws it: the Agent SDK's messages
 * become the same events Eaon's own loop, Codex and the ACP engines send, and
 * each call Claude Code would ask about goes to Eaon's approval policy.
 *
 * Only the session's own messages are drawn; a subagent's work shows as
 * progress on the call that started it.
 */

/** How much of a tool's output to keep in the transcript. */
const OUTPUT_LIMIT = 20_000

const EMPTY: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** The Agent SDK's error codes for a turn, as the kinds Eaon offers a fix for. */
const ERROR_KIND: Record<string, EngineErrorKind> = {
  authentication_failed: 'signed-out',
  oauth_org_not_allowed: 'signed-out',
  rate_limit: 'rate-limited',
  billing_error: 'rate-limited',
  model_not_found: 'model-unavailable',
  overloaded: 'network',
  server_error: 'network'
}

const LIMIT_NAME: Record<string, string> = {
  five_hour: '5-hour',
  seven_day: 'weekly',
  seven_day_opus: 'weekly Opus',
  seven_day_sonnet: 'weekly Sonnet',
  overage: 'extra usage'
}

type Block = { type: string; id?: string; name?: string; input?: unknown; text?: string; thinking?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

/** A tool result's text: a string, or the text blocks it holds. */
function outputOf(content: unknown): string {
  const joined =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((part) => (record(part).type === 'text' ? String(record(part).text ?? '') : ''))
            .filter(Boolean)
            .join('\n')
        : ''
  return joined.length > OUTPUT_LIMIT ? `${joined.slice(0, OUTPUT_LIMIT)}\n…` : joined
}

/** A reset time as the user's clock reads it; the SDK gives seconds (a status line's `resets_at` does too). */
function resetAt(value: number | undefined): string | null {
  if (!value) return null
  const at = new Date(value < 1e12 ? value * 1000 : value)
  const sameDay = at.toDateString() === new Date().toDateString()
  return at.toLocaleString(undefined, sameDay ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

export class ClaudeTurn {
  /** Everything the session said this turn. */
  text = ''
  /** The final answer, as the result reports it. */
  answer: string | null = null
  sessionId: string | null = null
  usage: TokenUsage = { ...EMPTY }
  sideEffects = false
  billing: EngineBilling = 'unknown'
  error: { kind: EngineErrorKind; message: string; detail: string } | null = null
  notice: string | null = null
  /** The result arrived: the turn is over. */
  finished = false
  /**
   * The turn must end now, before Claude Code makes another request: it is
   * billing a key, or the plan's limit is used up and the requests have gone
   * on to extra usage, which Anthropic charges for. `error` says which.
   */
  stop = false
  /** Until when the plan is on extra usage, when that's why the turn stopped. */
  extraUsageUntil: number | null = null
  /** Messages whose text came as stream events, so their whole copy isn't drawn again. */
  private readonly streamed = new Set<string>()
  private readonly shown = new Map<string, { mutating: boolean; todo: boolean }>()
  private readonly done = new Set<string>()
  private readonly denied = new Set<string>()
  /** What each subagent did, as progress on the call that started it. */
  private readonly subagents = new Map<string, string[]>()
  private readonly waiting = new Set<() => void>()
  private lastErrorCode: string | null = null

  constructor(
    private readonly messageId: string,
    private readonly emit: (event: StreamEvent) => void,
    private readonly approve: (request: EngineApprovalRequest) => Promise<boolean>
  ) {}

  handle(message: SDKMessage): void {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          this.sessionId = message.session_id
          // A key Claude Code was given is billed per token; a Claude account's sign-in, to its plan.
          const source = message.apiKeySource
          this.billing = source === 'none' || source === 'oauth' ? 'plan' : 'api-key'
          // Eaon runs Claude on the user's plan, never on a key that is charged per use.
          if (this.billing === 'api-key') this.halt('misconfigured', 'Claude Code is using an API key here, which Anthropic charges per use, so Eaon stopped. To use your Claude plan, sign in with your Claude account: claude auth login.', String(source))
        }
        return
      case 'stream_event': {
        if (message.parent_tool_use_id) return
        const event = message.event as { type: string; message?: { id?: string }; delta?: { type?: string; text?: string; thinking?: string } }
        if (event.type === 'message_start' && event.message?.id) this.streamed.add(event.message.id)
        if (event.type !== 'content_block_delta') return
        if (event.delta?.type === 'text_delta' && event.delta.text) this.say(event.delta.text)
        else if (event.delta?.type === 'thinking_delta' && event.delta.thinking) this.emit({ type: 'reasoning', messageId: this.messageId, text: event.delta.thinking })
        return
      }
      case 'assistant': {
        if (message.error) this.lastErrorCode = message.error
        const blocks = (message.message.content ?? []) as Block[]
        if (message.parent_tool_use_id) {
          this.subagentDid(message.parent_tool_use_id, blocks)
          return
        }
        const streamed = this.streamed.has(message.message.id)
        for (const block of blocks) {
          if (block.type === 'text' && !streamed && block.text) this.say(block.text)
          else if (block.type === 'thinking' && !streamed && block.thinking) this.emit({ type: 'reasoning', messageId: this.messageId, text: block.thinking })
          else if (block.type === 'tool_use' && block.id && block.name) this.show(block.id, block.name, record(block.input))
        }
        return
      }
      case 'user': {
        if (message.parent_tool_use_id) return
        const content = (message.message as { content?: unknown }).content
        if (!Array.isArray(content)) return
        for (const block of content as Block[]) {
          if (block.type !== 'tool_result' || !block.tool_use_id) continue
          this.finish(block.tool_use_id, outputOf(block.content), block.is_error === true)
        }
        return
      }
      case 'rate_limit_event': {
        const info = message.rate_limit_info
        const name = LIMIT_NAME[info.rateLimitType ?? ''] ?? 'usage'
        const resets = resetAt(info.resetsAt)
        // Past the plan's limit, with extra usage switched on: every further request is charged. Stop here.
        if (info.isUsingOverage || info.overageInUse || info.rateLimitType === 'overage') {
          this.lastErrorCode = 'rate_limit'
          const until = info.resetsAt ?? info.overageResetsAt
          this.extraUsageUntil = until ? (until < 1e12 ? until * 1000 : until) : Date.now() + 60 * 60_000
          this.halt(
            'rate-limited',
            `Your Claude plan’s ${name === 'extra usage' ? 'usage' : name} limit is used up, and going on would use extra usage, which Anthropic charges for. Eaon stopped${resets ? `; your plan resets ${resets}` : ''}.`,
            JSON.stringify(info)
          )
          return
        }
        if (info.status === 'rejected') {
          this.lastErrorCode = 'rate_limit'
          this.error = {
            kind: 'rate-limited',
            message: `Your Claude plan’s ${name} limit is used up${resets ? `. It resets ${resets}` : ''}.`,
            detail: JSON.stringify(info)
          }
        } else if (info.status === 'allowed_warning' && typeof info.utilization === 'number') {
          this.notice = `You’ve used ${Math.round(info.utilization * (info.utilization <= 1 ? 100 : 1))}% of your Claude plan’s ${name} limit${resets ? `; it resets ${resets}` : ''}.`
        }
        return
      }
      case 'result': {
        this.finished = true
        this.sessionId = message.session_id
        const u = message.usage
        this.usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 }
        if (message.subtype === 'success' && !message.is_error) {
          this.answer = message.result
          return
        }
        const said = message.subtype === 'success' ? message.result : message.errors.join('\n')
        if (this.error) return
        const kind = ERROR_KIND[this.lastErrorCode ?? ''] ?? 'other'
        this.error = { kind, message: errorMessage(kind, said, message.subtype), detail: said }
        return
      }
      default:
      // Hooks, tasks, status and anything newer: nothing the transcript draws.
    }
  }

  private halt(kind: EngineErrorKind, message: string, detail: string): void {
    this.error = { kind, message, detail }
    this.stop = true
    this.cancelPending()
  }

  private say(chunk: string): void {
    this.text += chunk
    this.emit({ type: 'delta', messageId: this.messageId, text: chunk })
  }

  /** A call's first sighting: drawn once (Claude's todo list as the transcript's todos). */
  private show(id: string, name: string, input: Record<string, unknown>): void {
    if (this.shown.has(id)) return
    if (name === 'TodoWrite') {
      this.shown.set(id, { mutating: false, todo: true })
      const todos = todosOf(input)
      if (todos) this.emit({ type: 'todos', messageId: this.messageId, todos })
      return
    }
    const tool = toolOf(name, input)
    this.shown.set(id, { mutating: tool.mutating, todo: false })
    this.emit({ type: 'tool-call', messageId: this.messageId, toolId: id, name: tool.name, input: tool.input })
  }

  private finish(id: string, output: string, failed: boolean): void {
    const shown = this.shown.get(id)
    if (!shown || shown.todo || this.done.has(id)) return
    this.done.add(id)
    const denied = this.denied.has(id)
    if (!failed && !denied && shown.mutating) this.sideEffects = true
    this.emit({ type: 'tool-result', messageId: this.messageId, toolId: id, output, status: denied ? 'denied' : failed ? 'error' : 'done' })
  }

  private subagentDid(parent: string, blocks: Block[]): void {
    if (!this.shown.has(parent)) return
    const lines = this.subagents.get(parent) ?? []
    for (const block of blocks) if (block.type === 'tool_use' && block.name) lines.push(`→ ${toolOf(block.name, record(block.input)).summary}`)
    this.subagents.set(parent, lines)
    if (lines.length) this.emit({ type: 'tool-progress', messageId: this.messageId, toolId: parent, output: lines.slice(-40).join('\n') })
  }

  /**
   * Claude Code's `canUseTool`: a call its own permission rules would ask
   * about, answered by Eaon's approval policy. The call is drawn first, so the
   * approval names something on screen. Claude's questions form and leaving
   * plan mode have no place in Eaon's transcript: Claude is told to say it in
   * its reply instead.
   */
  async permission(toolName: string, input: Record<string, unknown>, options: { signal: AbortSignal; toolUseID: string; title?: string }): Promise<PermissionResult> {
    if (toolName === 'AskUserQuestion') {
      return { behavior: 'deny', message: 'Eaon can’t show this as a form. Ask the user in your reply instead, then stop and wait for their answer.' }
    }
    if (toolName === 'ExitPlanMode') {
      return { behavior: 'deny', message: 'This is a plan-only turn in Eaon. Give the plan in your reply; the user switches to building when they are ready.' }
    }
    const id = options.toolUseID
    this.show(id, toolName, input)
    const tool = toolOf(toolName, input)
    let cancel = (): void => {}
    const allowed = await new Promise<boolean | null>((resolve) => {
      cancel = (): void => resolve(null)
      this.waiting.add(cancel)
      options.signal.addEventListener('abort', cancel, { once: true })
      this.approve({ tool: tool.name, input: tool.input, summary: options.title || tool.summary, mutating: tool.mutating }).then(
        (yes) => resolve(yes === true),
        () => resolve(false)
      )
    }).finally(() => {
      this.waiting.delete(cancel)
      options.signal.removeEventListener('abort', cancel)
    })
    if (allowed) return { behavior: 'allow', updatedInput: input }
    this.denied.add(id)
    return allowed === null ? { behavior: 'deny', message: 'The turn was stopped.', interrupt: true } : { behavior: 'deny', message: 'The user didn’t allow this.' }
  }

  /** The turn was stopped: every approval still waiting is answered at once. */
  cancelPending(): void {
    for (const cancel of this.waiting) cancel()
    this.waiting.clear()
  }
}

function errorMessage(kind: EngineErrorKind, said: string, subtype: string): string {
  if (kind === 'signed-out') return 'Claude isn’t signed in. Sign in in Settings → Agent engines.'
  if (kind === 'rate-limited') return 'Your Claude plan’s usage limit is used up for now. Try again once it resets, or pick another model.'
  if (kind === 'model-unavailable') return 'Your Claude account can’t use that model. Pick another one.'
  if (kind === 'network') return 'Claude’s servers didn’t answer. Try again in a moment.'
  if (subtype === 'error_max_turns') return 'Claude stopped at its limit for one turn.'
  const line = said.trim().split('\n')[0]
  return line ? `Claude: ${line}` : 'Claude stopped with an error.'
}
