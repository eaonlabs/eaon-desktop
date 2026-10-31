import { randomUUID } from 'node:crypto'
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { TokenUsage } from '@shared/types'
import { ProviderHttpError, type NeutralToolCall, type NeutralToolResult, type ToolSpec } from '../adapters/types'
import { mcpResult, PREFIX, SERVER, toolServer } from './tools'

/**
 * One Claude Code process, running one Claude session for Eaon's loop.
 *
 * The loop asks for one model step at a time; Claude Code runs a whole turn
 * in one go. They meet at Eaon's tools: when Claude calls one, the step ends
 * with that call, and Claude Code waits inside the tool's MCP handler until
 * the loop has run it and the next step hands back its result (`answer`). A
 * turn's end is a step that ends without a call. The session stays open
 * between turns; the next message is sent into it (`send`).
 */

export type QueryFn = (args: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query

/** Why a Claude turn stopped, in words; never retried by the loop, as Claude Code retries for itself. */
export class ClaudeAgentError extends Error {
  constructor(
    message: string,
    readonly detail?: string
  ) {
    super(message)
    this.name = 'ClaudeAgentError'
  }
}

export interface SessionSpec {
  executable: string
  env: Record<string, string | undefined>
  cwd: string
  model?: string
  effort?: Options['effort']
  /** Eaon's system prompt for the turn, after Claude Code's own. */
  system: string
  tools: ToolSpec[]
  /** A Claude session to continue. */
  resume?: string
  /** Kept in Claude Code's history, so a later process can resume it; not for a one-off (a title). */
  persist: boolean
  /** A one-off: Eaon's prompt alone, without Claude Code's, for a small task with no tools. */
  utility?: boolean
}

export interface StepResult {
  text: string
  calls: NeutralToolCall[]
  stop: 'end' | 'tool_use'
  usage: TokenUsage
}

export interface StepHandlers {
  onText: (delta: string) => void
  onReasoning: (delta: string) => void
}

interface Step extends StepHandlers {
  text: string
  resolve: (result: StepResult) => void
  reject: (error: Error) => void
}

/** Claude Code features Eaon has its own of, or that would hide Eaon's tools: off. */
const ISOLATION: Record<string, string> = {
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  DISABLE_AUTO_COMPACT: '1',
  CLAUDE_CODE_ENABLE_AWAY_SUMMARY: '0',
  // Every Eaon tool is an MCP tool: tool search would hide them all.
  ENABLE_TOOL_SEARCH: 'false',
  CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1',
  // Eaon cuts tool output to size itself.
  MAX_MCP_OUTPUT_TOKENS: '200000'
}

const RUNTIME =
  '<runtime_info>You are running in Eaon, a desktop app, through the Claude Code harness. Your tools are Eaon’s: Eaon runs each call, and asks the user first where their settings say to. Mention Claude Code only if asked.</runtime_info>'

const LIMIT_NAME: Record<string, string> = { five_hour: '5-hour', seven_day: 'weekly', seven_day_opus: 'weekly Opus', seven_day_sonnet: 'weekly Sonnet' }

/** A reset time as the user's clock reads it; the SDK gives seconds. */
function resetAt(value: number | undefined): string | null {
  if (!value) return null
  const at = new Date(value < 1e12 ? value * 1000 : value)
  const sameDay = at.toDateString() === new Date().toDateString()
  return at.toLocaleString(undefined, sameDay ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

/** The messages Claude Code reads its turns from, open for as long as the session. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private readonly queue: SDKUserMessage[] = []
  private wake: (() => void) | null = null
  private ended = false

  push(content: Record<string, unknown>[]): void {
    this.queue.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, origin: { kind: 'human' } } as unknown as SDKUserMessage)
    this.wake?.()
  }

  end(): void {
    this.ended = true
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const next = this.queue.shift()
      if (next) {
        yield next
        continue
      }
      if (this.ended) return
      await new Promise<void>((resolve) => (this.wake = resolve))
      this.wake = null
    }
  }
}

const sum = (usages: Iterable<TokenUsage>): TokenUsage => {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  for (const u of usages) {
    total.input += u.input
    total.output += u.output
    total.cacheRead += u.cacheRead
    total.cacheWrite += u.cacheWrite
  }
  return total
}

export class ClaudeSession {
  /** Claude's own id for the session, once it has started. */
  claudeSessionId: string | null = null
  /** The call Claude is waiting on, until its result is sent back. */
  pending: { call: NeutralToolCall; answer: (result: CallToolResult) => void } | null = null
  dead = false
  /** Until when the plan is on extra usage, when that is why it stopped. */
  extraUsageUntil: number | null = null
  private readonly inbox = new Inbox()
  private readonly controller = new AbortController()
  private readonly query: Query
  private step: Step | null = null
  /** Each response's usage, its highest count kept: Claude Code reports one response's several times as it streams. */
  private readonly usage = new Map<string, TokenUsage>()
  private lastError: string | null = null
  /** The response streaming now, whose usage its `message_delta` adds to. */
  private current: string | null = null
  private stderr = ''
  private idle: ReturnType<typeof setTimeout> | null = null

  constructor(
    readonly signature: string,
    spec: SessionSpec,
    query: QueryFn
  ) {
    const tools = spec.tools.length > 0
    const options: Options = {
      pathToClaudeCodeExecutable: spec.executable,
      cwd: spec.cwd,
      env: { ...spec.env, ...ISOLATION },
      // None of the user's Claude Code settings, CLAUDE.md files, hooks, MCP servers or skills: Eaon has its own.
      settingSources: [],
      settings: { disableAllHooks: true },
      strictMcpConfig: true,
      skills: [],
      // Claude Code's own tools off; Eaon's are the only ones, and they run without Claude Code asking, as Eaon asks itself.
      tools: [],
      permissionMode: 'dontAsk',
      allowedTools: tools ? [`${PREFIX}*`] : [],
      mcpServers: tools ? { [SERVER]: toolServer(spec.tools, (name, input) => this.called(name, input)) } : {},
      systemPrompt: spec.utility
        ? spec.system || 'You are a text generation helper. Return only the requested output.'
        : // Not a snapshot: a changed prompt (a new day, other memories) applies when the session resumes.
          { type: 'preset', preset: 'claude_code', snapshot: false, append: spec.system ? `${RUNTIME}\n\n${spec.system}` : RUNTIME },
      thinking: { type: 'adaptive', display: 'summarized' },
      includePartialMessages: true,
      // Eaon's messages as they are: no slash commands, file mentions or reminders added.
      verbatimPrompts: true,
      persistSession: spec.persist,
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.effort ? { effort: spec.effort } : {}),
      ...(spec.resume ? { resume: spec.resume } : {}),
      abortController: this.controller,
      stderr: (data: string) => {
        if (this.stderr.length < 8000) this.stderr += data
      }
    }
    this.query = query({ prompt: this.inbox, options })
    void this.read()
  }

  /** Sends a message and waits for the step it starts. */
  send(content: Record<string, unknown>[], handlers: StepHandlers): Promise<StepResult> {
    const step = this.begin(handlers)
    this.inbox.push(content)
    return step
  }

  /** Hands Claude the result of the call it is waiting on, and waits for the next step. */
  answer(result: NeutralToolResult, handlers: StepHandlers): Promise<StepResult> {
    const pending = this.pending
    if (!pending) return Promise.reject(new ClaudeAgentError('Claude wasn’t waiting for a tool’s result.'))
    this.pending = null
    const step = this.begin(handlers)
    pending.answer(mcpResult(result))
    return step
  }

  /** Stops what Claude is doing, then the process. */
  async stop(): Promise<void> {
    await Promise.race([this.query.interrupt().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 2000))])
    this.close()
  }

  close(): void {
    if (this.idle) clearTimeout(this.idle)
    this.pending?.answer({ isError: true, content: [{ type: 'text', text: 'Stopped.' }] })
    this.pending = null
    this.dead = true
    this.inbox.end()
    this.controller.abort()
    try {
      this.query.close()
    } catch {
      /* already gone */
    }
  }

  /** Closes the process after `ms` of nothing to do; the session itself can be resumed later. */
  closeWhenIdle(ms: number): void {
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => this.close(), ms)
    this.idle.unref?.()
  }

  private begin(handlers: StepHandlers): Promise<StepResult> {
    if (this.dead) return Promise.reject(new ClaudeAgentError('Claude Code stopped.', this.stderr))
    if (this.idle) clearTimeout(this.idle)
    return new Promise<StepResult>((resolve, reject) => {
      this.step = { ...handlers, text: '', resolve, reject }
    })
  }

  private finish(stop: StepResult['stop'], calls: NeutralToolCall[]): void {
    const step = this.step
    if (!step) return
    this.step = null
    const usage = sum(this.usage.values())
    this.usage.clear()
    step.resolve({ text: step.text, calls, stop, usage })
  }

  private fail(error: Error): void {
    const step = this.step
    this.step = null
    step?.reject(error)
    this.close()
  }

  /** A call of one of Eaon's tools: the step ends with it, and Claude waits here for its result. */
  private called(name: string, input: Record<string, unknown>): Promise<CallToolResult> {
    return new Promise<CallToolResult>((answer) => {
      const call: NeutralToolCall = { id: `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`, name, input }
      this.pending = { call, answer }
      this.finish('tool_use', [call])
    })
  }

  private async read(): Promise<void> {
    try {
      for await (const message of this.query) this.handle(message)
      if (!this.dead) this.fail(new ClaudeAgentError('Claude Code stopped unexpectedly.', this.stderr))
    } catch (error) {
      if (!this.dead) this.fail(new ClaudeAgentError('Claude Code stopped unexpectedly.', `${error instanceof Error ? error.message : String(error)}\n${this.stderr}`))
    }
  }

  private noteUsage(id: string | undefined, raw: Record<string, number | undefined> | undefined): void {
    if (!id || !raw) return
    const seen = this.usage.get(id) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    this.usage.set(id, {
      input: Math.max(seen.input, raw.input_tokens ?? 0),
      output: Math.max(seen.output, raw.output_tokens ?? 0),
      cacheRead: Math.max(seen.cacheRead, raw.cache_read_input_tokens ?? 0),
      cacheWrite: Math.max(seen.cacheWrite, raw.cache_creation_input_tokens ?? 0)
    })
  }

  private handle(message: SDKMessage): void {
    switch (message.type) {
      case 'system':
        if (message.subtype !== 'init') return
        this.claudeSessionId = message.session_id
        // Eaon runs Claude on the user's plan, never on a key charged per use.
        if (message.apiKeySource !== 'none' && message.apiKeySource !== 'oauth') {
          this.fail(new ClaudeAgentError('Claude Code is using an API key here, which Anthropic charges per use, so Eaon stopped. Sign in with your Claude account instead: claude auth login.'))
        }
        return
      case 'stream_event': {
        if (message.parent_tool_use_id) return
        const event = message.event as {
          type: string
          message?: { id?: string; usage?: Record<string, number> }
          delta?: { type?: string; text?: string; thinking?: string }
          usage?: Record<string, number>
        }
        if (event.type === 'message_start') {
          this.current = event.message?.id ?? null
          this.noteUsage(event.message?.id, event.message?.usage)
        } else if (event.type === 'message_delta') this.noteUsage(this.current ?? undefined, event.usage)
        else if (event.type === 'content_block_delta' && this.step) {
          if (event.delta?.type === 'text_delta' && event.delta.text) {
            this.step.text += event.delta.text
            this.step.onText(event.delta.text)
          } else if (event.delta?.type === 'thinking_delta' && event.delta.thinking) this.step.onReasoning(event.delta.thinking)
        }
        return
      }
      case 'assistant':
        if (message.parent_tool_use_id) return
        if (message.error) this.lastError = message.error
        this.noteUsage(message.message.id, message.message.usage as unknown as Record<string, number>)
        return
      case 'rate_limit_event': {
        const info = message.rate_limit_info
        const name = LIMIT_NAME[info.rateLimitType ?? ''] ?? 'usage'
        const resets = resetAt(info.resetsAt ?? info.overageResetsAt)
        // Past the plan's limit with extra usage on, every further request is charged: stop here.
        if (info.isUsingOverage || info.overageInUse || info.rateLimitType === 'overage') {
          const until = info.resetsAt ?? info.overageResetsAt
          this.extraUsageUntil = until ? (until < 1e12 ? until * 1000 : until) : Date.now() + 60 * 60_000
          this.fail(new ClaudeAgentError(`Your Claude plan’s limit is used up, and going on would use extra usage, which Anthropic charges for. Eaon stopped${resets ? `; your plan resets ${resets}` : ''}.`))
        } else if (info.status === 'rejected') {
          this.fail(new ClaudeAgentError(`Your Claude plan’s ${name} limit is used up${resets ? `. It resets ${resets}` : ''}.`))
        }
        return
      }
      case 'result':
        this.claudeSessionId = message.session_id
        if (message.subtype === 'success' && !message.is_error) {
          this.finish('end', [])
          return
        }
        this.fail(errorOf(this.lastError, message.subtype === 'success' ? message.result : message.errors.join('\n'), message.subtype))
        return
      default:
      // Tool results Claude Code echoes, hooks, status and anything newer: nothing for the loop.
    }
  }
}

function errorOf(code: string | null, said: string, subtype: string): Error {
  if (code === 'authentication_failed' || code === 'oauth_org_not_allowed') {
    return new ProviderHttpError(401, 'Claude isn’t signed in. Sign in with Claude Code: run claude auth login in a terminal.')
  }
  if (code === 'rate_limit' || code === 'billing_error') return new ClaudeAgentError('Your Claude plan’s usage limit is used up for now. Try again once it resets.', said)
  if (code === 'model_not_found') return new ClaudeAgentError('Your Claude account can’t use that model. Pick another one.', said)
  if (subtype === 'error_max_turns') return new ClaudeAgentError('Claude stopped at its limit for one turn.', said)
  const line = said.trim().split('\n')[0]
  return new ClaudeAgentError(line ? `Claude: ${line}` : 'Claude stopped with an error.', said)
}
