import type { EngineAuth } from '@shared/engines'
import type { StreamEvent, TodoItem, TokenUsage } from '@shared/types'
import { isReadOnlyCommand } from '../../agent/approvals'
import type { EngineAccess, EngineApprovalRequest, EngineErrorKind, EngineTurnInput } from '../types'
import { AppServerExited, RpcError, type AppServer } from './appServer'
import { isAuthRefusal } from './auth'
import {
  MCP_APPROVAL_ALLOW,
  MCP_APPROVAL_CANCEL,
  MCP_APPROVAL_QUESTION_PREFIX,
  type AskForApproval,
  type CodexErrorInfo,
  type CommandExecutionRequestApprovalParams,
  type FileChangeRequestApprovalParams,
  type McpServerElicitationRequestParams,
  type PermissionsRequestApprovalParams,
  type SandboxMode,
  type SandboxPolicy,
  type ThreadItem,
  type ThreadTokenUsage,
  type ToolRequestUserInputParams,
  type Turn,
  type TurnError,
  type TurnPlanStep,
  type UserInput
} from './protocol'

/**
 * One Codex turn on a loaded thread: `turn/start`, then Codex's notifications
 * turned into the `StreamEvent`s Eaon's transcript draws, and Codex's
 * approval requests turned into calls to `input.approve` — Eaon's policy
 * decides, never Codex.
 *
 * Access levels map onto Codex's own sandbox and approval policy:
 *
 * - `read-only` → read-only sandbox, approval policy `never`. Commands run but
 *   can't write or reach the network; anything that would need more is
 *   refused by Codex itself, and so are MCP tools that aren't marked
 *   read-only. Nothing is asked, because nothing mutating is allowed.
 * - `safe` → workspace-write sandbox, policy `untrusted`. Codex asks before
 *   every command it doesn't know to be read-only and before every file edit,
 *   and each ask goes to `input.approve`, so Eaon's policy sees every change.
 * - `autonomous` → workspace-write sandbox, policy `on-request`. Codex works
 *   inside the project on its own (as Eaon's autonomous workers do) and asks
 *   only to leave the sandbox — network, files outside the project — or to
 *   use an MCP tool with side effects; those asks go to `input.approve`.
 *
 * `approvalsReviewer: "user"` is sent every time so a Codex set up to route
 * approvals to its own reviewer agent still sends them to Eaon.
 */

export interface AccessPlan {
  approvalPolicy: AskForApproval
  sandbox: SandboxMode
  sandboxPolicy: SandboxPolicy
}

export function accessPlan(access: EngineAccess): AccessPlan {
  if (access === 'read-only') return { approvalPolicy: 'never', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } }
  return {
    approvalPolicy: access === 'safe' ? 'untrusted' : 'on-request',
    sandbox: 'workspace-write',
    sandboxPolicy: { type: 'workspaceWrite' }
  }
}

/** The command as the user would type it: Codex wraps it as `/bin/zsh -lc '…'`. */
export function displayCommand(command: string | null | undefined, actions?: { command?: string }[] | null): string {
  if (actions && actions.length === 1 && typeof actions[0]?.command === 'string' && actions[0].command) return actions[0].command
  const raw = (command ?? '').trim()
  const wrapped = /^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+'([\s\S]*)'$/.exec(raw)
  return wrapped ? wrapped[1].replace(/'\\''/g, "'") : raw
}

const NO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

export interface TurnOutcome {
  turnId: string | null
  text: string
  usage: TokenUsage
  cancelled: boolean
  sideEffects: boolean
  error?: string
  errorKind?: EngineErrorKind
  /** Codex's own words for the failure, for "Copy diagnostics". */
  detail?: string
  /** The process died: the caller must not reuse it. */
  crashed: boolean
  /** Codex never acknowledged an interrupt: the caller should stop the process. */
  stuck: boolean
}

export interface TurnOptions {
  server: AppServer
  threadId: string
  input: EngineTurnInput
  /** Effort as Codex spells it for this model; null leaves Codex's default. */
  effort: string | null
  /** What `account/read` last said, to tell an expired session from a missing one. */
  auth: EngineAuth | null
  /** How long to wait for Codex to confirm an interrupt before giving up on the process. */
  interruptGraceMs?: number
  /** Called once Codex has accepted the turn, with its id (for steering). */
  onStarted?: (turnId: string) => void
}

/** Live output is sent at most this often per command, and only its tail. */
const PROGRESS_EVERY_MS = 150
const PROGRESS_TAIL = 16_000

interface Notification {
  method: string
  params: Record<string, unknown>
}

export function runTurn(options: TurnOptions): Promise<TurnOutcome> {
  return new CodexTurn(options).run()
}

class CodexTurn {
  private readonly server: AppServer
  private readonly input: EngineTurnInput
  private readonly plan: AccessPlan
  private turnId: string | null = null
  private readonly buffered: Notification[] = []

  // Text: every agent message, in order, joined by blank lines.
  private readonly messages = new Map<string, string>()
  private readonly messageOrder: string[] = []
  private streamedAny = false
  private reasoningAny = false

  private readonly started = new Set<string>()
  private readonly finished = new Set<string>()
  private readonly items = new Map<string, ThreadItem>()
  private readonly output = new Map<string, string>()
  private readonly progressTimers = new Map<string, ReturnType<typeof setTimeout>>()

  private usageBaseline: ThreadTokenUsage['total'] | null = null
  private usage: TokenUsage = { ...NO_USAGE }
  private sideEffects = false
  private lastError: TurnError | null = null

  /** Answers for Codex's requests still waiting on Eaon's policy, so a cancel can refuse them at once. */
  private readonly pendingAsks = new Set<() => void>()
  private aborted = false

  constructor(private readonly options: TurnOptions) {
    this.server = options.server
    this.input = options.input
    this.plan = accessPlan(options.input.access)
  }

  async run(): Promise<TurnOutcome> {
    const { server, input } = this
    if (input.signal.aborted) return this.outcome({ cancelled: true })

    let complete!: (turn: Turn | null) => void
    const completed = new Promise<Turn | null>((resolve) => (complete = resolve))
    const unsubscribe = server.onNotification((method, params) => {
      const p = (params ?? {}) as Record<string, unknown>
      if (p.threadId !== undefined && p.threadId !== this.options.threadId) return
      if (this.turnId === null) {
        this.buffered.push({ method, params: p })
        return
      }
      this.handle({ method, params: p }, complete)
    })
    server.setRequestHandler((method, params) => this.answer(method, (params ?? {}) as Record<string, unknown>))
    let exited: ((error: AppServerExited) => void) | null = null
    const died = new Promise<AppServerExited>((resolve) => (exited = resolve))
    const stopExit = server.onExit((exit) => exited?.(new AppServerExited('Codex stopped unexpectedly.', exit)))
    const onAbort = (): void => {
      this.aborted = true
      for (const refuse of this.pendingAsks) refuse()
      this.pendingAsks.clear()
    }
    input.signal.addEventListener('abort', onAbort, { once: true })
    const onAbortInterrupt = (): void => void this.interrupt()
    let arm: (() => void) | null = null
    let graceTimer: ReturnType<typeof setTimeout> | null = null

    try {
      // Start the turn. A crash here is the same as a crash mid-turn.
      const inputs: UserInput[] = [{ type: 'text', text: input.text, text_elements: [] }]
      for (const path of input.images) inputs.push({ type: 'localImage', path })
      const startRequest = server.request<{ turn: Turn }>(
        'turn/start',
        {
          threadId: this.options.threadId,
          input: inputs,
          cwd: input.cwd,
          approvalPolicy: this.plan.approvalPolicy,
          approvalsReviewer: 'user',
          sandboxPolicy: this.plan.sandboxPolicy,
          ...(input.model ? { model: input.model } : {}),
          ...(this.options.effort ? { effort: this.options.effort } : {})
        },
        60_000
      )
      const first = await Promise.race([startRequest.then((r) => ({ ok: r }) as const), died.then((e) => ({ died: e }) as const)])
      if ('died' in first) return this.crashed(first.died)
      const turn = first.ok?.turn
      if (!turn?.id) return this.outcome({ error: 'Codex didn\u2019t start the turn.', errorKind: 'other' })
      this.turnId = turn.id
      this.options.onStarted?.(turn.id)
      for (const n of this.buffered.splice(0)) this.handle(n, complete)

      // Cancelled while starting: interrupt straight away.
      if (input.signal.aborted) void this.interrupt()
      else input.signal.addEventListener('abort', onAbortInterrupt, { once: true })

      const grace = this.options.interruptGraceMs ?? 10_000
      const abortTimeout = new Promise<'stuck'>((resolve) => {
        arm = (): void => {
          graceTimer = setTimeout(() => resolve('stuck'), grace)
        }
        if (input.signal.aborted) arm()
        else input.signal.addEventListener('abort', arm, { once: true })
      })
      const end = await Promise.race([
        completed.then((t) => ({ turn: t }) as const),
        died.then((e) => ({ died: e }) as const),
        abortTimeout.then(() => ({ stuck: true }) as const)
      ])
      if ('died' in end) return this.crashed(end.died)
      if ('stuck' in end) return this.outcome({ cancelled: true, stuck: true })
      return this.finish(end.turn)
    } catch (error) {
      if (error instanceof AppServerExited) return this.crashed(error)
      const message = error instanceof Error ? error.message : String(error)
      return this.outcome({ ...classifyStartError(message), detail: message })
    } finally {
      unsubscribe()
      stopExit()
      server.setRequestHandler(null)
      input.signal.removeEventListener('abort', onAbort)
      input.signal.removeEventListener('abort', onAbortInterrupt)
      if (arm) input.signal.removeEventListener('abort', arm)
      if (graceTimer) clearTimeout(graceTimer)
      for (const timer of this.progressTimers.values()) clearTimeout(timer)
      this.progressTimers.clear()
      for (const refuse of this.pendingAsks) refuse()
      this.pendingAsks.clear()
    }
  }

  private async interrupt(): Promise<void> {
    if (!this.turnId) return
    try {
      await this.server.request('turn/interrupt', { threadId: this.options.threadId, turnId: this.turnId }, 5000)
    } catch {
      /* the turn already ended, or Codex is stuck: the grace timer decides */
    }
  }

  private emit(event: StreamEvent): void {
    try {
      this.input.emit(event)
    } catch (error) {
      console.error('[codex] emit failed:', error)
    }
  }

  /* ------------------------------------------------------------- results */

  private outcome(partial: Partial<TurnOutcome>): TurnOutcome {
    return {
      turnId: this.turnId,
      text: this.finalText(),
      usage: this.usage,
      cancelled: false,
      sideEffects: this.sideEffects,
      crashed: false,
      stuck: false,
      ...partial
    }
  }

  private crashed(error: AppServerExited): TurnOutcome {
    if (this.aborted) return this.outcome({ cancelled: true, crashed: true })
    const how = error.exit.code !== null ? ` (exit code ${error.exit.code})` : error.exit.signal ? ` (${error.exit.signal})` : ''
    return this.outcome({
      crashed: true,
      error: `Codex stopped unexpectedly during this turn${how}. The next turn starts it again.`,
      errorKind: 'engine-crashed',
      detail: error.exit.stderr.trim().split('\n').slice(-20).join('\n') || undefined
    })
  }

  private finish(turn: Turn | null): TurnOutcome {
    if (!turn) return this.outcome({ error: 'Codex ended the turn without saying how.', errorKind: 'other' })
    if (turn.status === 'completed') return this.outcome({})
    if (turn.status === 'interrupted') {
      if (this.aborted) return this.outcome({ cancelled: true })
      return this.outcome({ error: 'Codex stopped this turn before it finished.', errorKind: 'other' })
    }
    const failure = turn.error ?? this.lastError
    const classified = classifyTurnError(failure, this.options.auth)
    return this.outcome({ ...classified, detail: [failure?.message, failure?.additionalDetails].filter(Boolean).join('\n') || undefined })
  }

  private finalText(): string {
    return this.messageOrder
      .map((id) => this.messages.get(id) ?? '')
      .filter((t) => t.trim())
      .join('\n\n')
  }

  /* -------------------------------------------------------- notifications */

  private handle(n: Notification, complete: (turn: Turn | null) => void): void {
    const p = n.params
    // Everything below belongs to one turn; a resumed thread replays an older turn's usage first.
    if (typeof p.turnId === 'string' && p.turnId !== this.turnId) return
    const messageId = this.input.messageId
    switch (n.method) {
      case 'item/agentMessage/delta':
        this.textDelta(String(p.itemId ?? ''), String(p.delta ?? ''))
        break
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        if (typeof p.delta === 'string' && p.delta) {
          this.reasoningAny = true
          this.emit({ type: 'reasoning', messageId, text: p.delta })
        }
        break
      case 'item/reasoning/summaryPartAdded':
        if (this.reasoningAny) this.emit({ type: 'reasoning', messageId, text: '\n\n' })
        break
      case 'item/started':
        this.itemStarted(p.item as ThreadItem)
        break
      case 'item/completed':
        this.itemCompleted(p.item as ThreadItem)
        break
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta':
        this.outputDelta(String(p.itemId ?? ''), String(p.delta ?? ''))
        break
      case 'item/mcpToolCall/progress':
        if (typeof p.itemId === 'string' && typeof p.message === 'string') this.emit({ type: 'tool-progress', messageId, toolId: p.itemId, output: p.message })
        break
      case 'turn/plan/updated':
        this.emit({ type: 'todos', messageId, todos: toTodos(p.plan as TurnPlanStep[] | undefined) })
        break
      case 'turn/diff/updated':
        if (typeof p.diff === 'string' && p.diff.trim() && this.input.access !== 'read-only') this.sideEffects = true
        break
      case 'thread/tokenUsage/updated':
        this.tokenUsage(p.tokenUsage as ThreadTokenUsage | undefined)
        break
      case 'error': {
        // Retried errors are Codex's business; the last unretried one explains a failed turn.
        if (p.willRetry !== true && p.error) this.lastError = p.error as TurnError
        break
      }
      case 'turn/completed': {
        const turn = p.turn as Turn | undefined
        if (turn && turn.id === this.turnId) complete(turn)
        break
      }
    }
  }

  private textDelta(itemId: string, delta: string): void {
    if (!delta) return
    if (!this.messages.has(itemId)) this.beginMessage(itemId)
    this.messages.set(itemId, (this.messages.get(itemId) ?? '') + delta)
    this.streamedAny = true
    this.emit({ type: 'delta', messageId: this.input.messageId, text: delta })
  }

  /** A new agent message after earlier text gets a paragraph break, so two messages don't run together. */
  private beginMessage(itemId: string): void {
    this.messageOrder.push(itemId)
    this.messages.set(itemId, '')
    if (this.streamedAny) this.emit({ type: 'delta', messageId: this.input.messageId, text: '\n\n' })
  }

  private tokenUsage(usage: ThreadTokenUsage | undefined): void {
    if (!usage?.total || !usage.last) return
    // `total` is the whole thread; `last` the latest request. Before this
    // turn's first request the thread stood at total − last.
    this.usageBaseline ??= {
      totalTokens: usage.total.totalTokens - usage.last.totalTokens,
      inputTokens: usage.total.inputTokens - usage.last.inputTokens,
      cachedInputTokens: usage.total.cachedInputTokens - usage.last.cachedInputTokens,
      cacheWriteInputTokens: (usage.total.cacheWriteInputTokens ?? 0) - (usage.last.cacheWriteInputTokens ?? 0),
      outputTokens: usage.total.outputTokens - usage.last.outputTokens
    }
    const base = this.usageBaseline
    const input = Math.max(0, usage.total.inputTokens - base.inputTokens)
    const cached = Math.max(0, usage.total.cachedInputTokens - base.cachedInputTokens)
    const written = Math.max(0, (usage.total.cacheWriteInputTokens ?? 0) - (base.cacheWriteInputTokens ?? 0))
    // Eaon counts uncached input separately from cache reads and writes (as the Responses adapter does).
    this.usage = {
      input: Math.max(0, input - cached - written),
      output: Math.max(0, usage.total.outputTokens - base.outputTokens),
      cacheRead: cached,
      cacheWrite: written
    }
    this.emit({ type: 'usage', messageId: this.input.messageId, usage: this.usage })
  }

  private outputDelta(itemId: string, delta: string): void {
    if (!itemId || !delta) return
    this.output.set(itemId, ((this.output.get(itemId) ?? '') + delta).slice(-PROGRESS_TAIL * 2))
    if (this.progressTimers.has(itemId)) return
    this.progressTimers.set(
      itemId,
      setTimeout(() => {
        this.progressTimers.delete(itemId)
        if (this.finished.has(itemId)) return
        this.emit({ type: 'tool-progress', messageId: this.input.messageId, toolId: itemId, output: (this.output.get(itemId) ?? '').slice(-PROGRESS_TAIL) })
      }, PROGRESS_EVERY_MS)
    )
  }

  private itemStarted(item: ThreadItem | undefined): void {
    if (!item?.id || this.started.has(item.id)) return
    this.items.set(item.id, item)
    if (item.type === 'agentMessage') {
      if (!this.messages.has(item.id)) this.beginMessage(item.id)
      return
    }
    const call = toolCall(item)
    if (!call) return
    this.started.add(item.id)
    this.emit({ type: 'tool-call', messageId: this.input.messageId, toolId: item.id, name: call.name, input: call.input })
  }

  private itemCompleted(item: ThreadItem | undefined): void {
    if (!item?.id) return
    this.items.set(item.id, item)
    const messageId = this.input.messageId
    if (item.type === 'agentMessage') {
      const text = typeof (item as { text?: unknown }).text === 'string' ? (item as { text: string }).text : ''
      if (!this.messages.has(item.id)) this.beginMessage(item.id)
      const streamed = this.messages.get(item.id) ?? ''
      // Some providers send no deltas, or stop short: send what wasn't streamed.
      if (text.length > streamed.length && text.startsWith(streamed)) {
        const rest = text.slice(streamed.length)
        this.streamedAny = true
        this.emit({ type: 'delta', messageId, text: rest })
      }
      if (text) this.messages.set(item.id, text)
      return
    }
    const call = toolCall(item)
    if (!call) return
    if (!this.started.has(item.id)) {
      this.started.add(item.id)
      this.emit({ type: 'tool-call', messageId, toolId: item.id, name: call.name, input: call.input })
    }
    this.finished.add(item.id)
    const timer = this.progressTimers.get(item.id)
    if (timer) clearTimeout(timer)
    this.progressTimers.delete(item.id)
    const result = toolResult(item, this.output.get(item.id) ?? '')
    if (result.changed && (this.input.access !== 'read-only' || item.type === 'mcpToolCall')) this.sideEffects = true
    this.emit({ type: 'tool-result', messageId, toolId: item.id, output: result.output, status: result.status })
  }

  /* ------------------------------------------------------------ approvals */

  /**
   * Asks Eaon's policy, and refuses straight away if the turn is cancelled
   * meanwhile — Codex must never be left waiting on an answer nobody gives.
   */
  private ask(request: EngineApprovalRequest): Promise<boolean> {
    if (this.aborted || this.input.signal.aborted) return Promise.resolve(false)
    // Read-only work never needs to ask: Codex shouldn't, and if it does the answer is no.
    if (this.input.access === 'read-only' && request.mutating) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      const refuse = (): void => resolve(false)
      this.pendingAsks.add(refuse)
      Promise.resolve()
        .then(() => this.input.approve(request))
        .then(
          (allowed) => resolve(allowed === true),
          () => resolve(false)
        )
        .finally(() => this.pendingAsks.delete(refuse))
    })
  }

  private async answer(method: string, p: Record<string, unknown>): Promise<unknown> {
    // Requests for another thread (a sub-agent's) still need an answer; Eaon's policy decides those too.
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const r = p as unknown as CommandExecutionRequestApprovalParams
        const allowed = await this.ask(commandApproval(r))
        return { decision: allowed ? 'accept' : 'decline' }
      }
      case 'item/fileChange/requestApproval': {
        const r = p as unknown as FileChangeRequestApprovalParams
        const allowed = await this.ask(fileChangeApproval(r, this.items.get(r.itemId)))
        return { decision: allowed ? 'accept' : 'decline' }
      }
      case 'item/permissions/requestApproval': {
        const r = p as unknown as PermissionsRequestApprovalParams
        const allowed = await this.ask(permissionsApproval(r))
        const granted: Record<string, unknown> = {}
        if (allowed && r.permissions?.network) granted.network = r.permissions.network
        if (allowed && r.permissions?.fileSystem) granted.fileSystem = r.permissions.fileSystem
        return { permissions: granted, scope: 'turn' }
      }
      case 'item/tool/requestUserInput': {
        const r = p as unknown as ToolRequestUserInputParams
        const questions = Array.isArray(r.questions) ? r.questions : []
        const mcp = questions.find((q) => q.id?.startsWith(MCP_APPROVAL_QUESTION_PREFIX))
        if (mcp) {
          const allowed = await this.ask(mcpApproval(this.items.get(r.itemId), mcp.question))
          return { answers: { [mcp.id]: { answers: [allowed ? MCP_APPROVAL_ALLOW : MCP_APPROVAL_CANCEL] } } }
        }
        // Questions for the user mid-turn: a worker has nobody to ask, so there is no answer and Codex carries on.
        return { answers: {} }
      }
      case 'mcpServer/elicitation/request': {
        const r = p as unknown as McpServerElicitationRequestParams
        if (r._meta && r._meta.codex_approval_kind === 'mcp_tool_call') {
          const item = [...this.items.values()].reverse().find((i) => i.type === 'mcpToolCall' && (i as { server?: string }).server === r.serverName)
          const allowed = await this.ask(mcpApproval(item, r.message, r.serverName, r._meta))
          return allowed ? { action: 'accept', content: {}, _meta: null } : { action: 'decline', content: null, _meta: null }
        }
        // A form or link an MCP server wants filled in: Eaon can't show it for Codex.
        return { action: 'decline', content: null, _meta: null }
      }
      case 'execCommandApproval': {
        const command = Array.isArray(p.command) ? (p.command as string[]).join(' ') : ''
        const allowed = await this.ask(commandApproval({ command, cwd: String(p.cwd ?? '') } as CommandExecutionRequestApprovalParams))
        return { decision: allowed ? 'approved' : 'abort' }
      }
      case 'applyPatchApproval': {
        const files = Object.keys((p.fileChanges as Record<string, unknown>) ?? {})
        const allowed = await this.ask({ tool: 'apply_patch', input: { files }, summary: describeFiles(files), mutating: true })
        return { decision: allowed ? 'approved' : 'abort' }
      }
      case 'currentTime/read':
        return { currentTimeAt: Math.floor(Date.now() / 1000) }
      default:
        throw new RpcError(-32601, `Eaon doesn\u2019t handle ${method}.`)
    }
  }
}

/* --------------------------------------------------------- approval shapes */

export function commandApproval(r: CommandExecutionRequestApprovalParams): EngineApprovalRequest {
  if (r.kind === 'writeStdin') {
    return { tool: 'run_command', input: { stdin: true, reason: r.reason ?? null }, summary: 'Type into a command that is already running', mutating: true }
  }
  if (!r.command && r.networkApprovalContext) {
    const host = r.networkApprovalContext.host ?? 'the network'
    return {
      tool: 'network_access',
      input: { host, protocol: r.networkApprovalContext.protocol ?? null, reason: r.reason ?? null },
      summary: `Reach ${host} from a command`,
      mutating: true
    }
  }
  const command = displayCommand(r.command, r.commandActions)
  return {
    tool: 'run_command',
    input: { command, ...(r.cwd ? { cwd: r.cwd } : {}), ...(r.reason ? { reason: r.reason } : {}) },
    summary: command,
    mutating: !isReadOnlyCommand(command)
  }
}

function describeFiles(files: string[]): string {
  if (files.length === 0) return 'Change files'
  const names = files.map((f) => f.split(/[\\/]/).pop() || f)
  return names.length <= 3 ? `Edit ${names.join(', ')}` : `Edit ${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
}

export function fileChangeApproval(r: FileChangeRequestApprovalParams, item: ThreadItem | undefined): EngineApprovalRequest {
  const changes = item?.type === 'fileChange' ? ((item as { changes?: { path: string; kind?: { type: string }; diff?: string }[] }).changes ?? []) : []
  const files = changes.map((c) => c.path)
  return {
    tool: 'apply_patch',
    input: {
      files,
      changes: changes.map((c) => ({ path: c.path, kind: c.kind?.type ?? 'update', diff: c.diff ?? '' })),
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.grantRoot ? { grantRoot: r.grantRoot } : {})
    },
    summary: r.grantRoot ? `Write files under ${r.grantRoot}` : describeFiles(files),
    mutating: true
  }
}

export function permissionsApproval(r: PermissionsRequestApprovalParams): EngineApprovalRequest {
  const parts: string[] = []
  if (r.permissions?.network?.enabled) parts.push('use the network')
  const write = r.permissions?.fileSystem?.write ?? []
  const read = r.permissions?.fileSystem?.read ?? []
  if (write.length) parts.push(`write to ${write.join(', ')}`)
  if (read.length) parts.push(`read ${read.join(', ')}`)
  return {
    tool: 'request_permissions',
    input: { permissions: r.permissions ?? {}, ...(r.reason ? { reason: r.reason } : {}) },
    summary: parts.length ? `Let Codex ${parts.join(' and ')}` : 'Give Codex more access',
    mutating: write.length > 0 || r.permissions?.network?.enabled === true
  }
}

export function mcpApproval(item: ThreadItem | undefined, question?: string, serverName?: string, meta?: Record<string, unknown>): EngineApprovalRequest {
  const call = item?.type === 'mcpToolCall' ? (item as { server?: string; tool?: string; arguments?: unknown; readOnlyHint?: boolean | null }) : null
  const server = call?.server ?? serverName ?? 'MCP'
  const tool = call?.tool ?? (typeof meta?.tool_name === 'string' ? meta.tool_name : null) ?? (typeof meta?.tool_title === 'string' ? meta.tool_title : 'tool')
  const args = call?.arguments ?? meta?.tool_params ?? null
  return {
    tool: 'mcp_tool',
    input: { server, tool, ...(args && typeof args === 'object' ? { arguments: args } : {}) },
    summary: question?.trim() || `Use ${tool} from ${server}`,
    mutating: call?.readOnlyHint !== true
  }
}

/* ------------------------------------------------------------ tool events */

function toolCall(item: ThreadItem): { name: string; input: Record<string, unknown> } | null {
  switch (item.type) {
    case 'commandExecution': {
      const c = item as Extract<ThreadItem, { type: 'commandExecution' }>
      return { name: 'run_command', input: { command: displayCommand(c.command, c.commandActions), ...(c.cwd ? { cwd: c.cwd } : {}) } }
    }
    case 'fileChange': {
      const f = item as Extract<ThreadItem, { type: 'fileChange' }>
      const changes = f.changes ?? []
      return { name: 'apply_patch', input: { files: changes.map((c) => c.path), changes: changes.map((c) => ({ path: c.path, kind: c.kind?.type ?? 'update', diff: c.diff ?? '' })) } }
    }
    case 'mcpToolCall': {
      const m = item as Extract<ThreadItem, { type: 'mcpToolCall' }>
      return { name: m.tool || 'mcp_tool', input: { server: m.server ?? null, ...(m.arguments && typeof m.arguments === 'object' ? (m.arguments as Record<string, unknown>) : {}) } }
    }
    case 'webSearch': {
      const w = item as Extract<ThreadItem, { type: 'webSearch' }>
      return { name: 'web_search', input: { query: w.query ?? '' } }
    }
    case 'imageView':
      return { name: 'view_image', input: { path: (item as { path?: string }).path ?? '' } }
    default:
      return null
  }
}

function toolResult(item: ThreadItem, streamed: string): { output: string; status: 'done' | 'denied' | 'error'; changed: boolean } {
  switch (item.type) {
    case 'commandExecution': {
      const c = item as Extract<ThreadItem, { type: 'commandExecution' }>
      const text = (c.aggregatedOutput ?? streamed).replace(/\s+$/, '')
      if (c.status === 'declined') return { output: 'Not run: the request to run it was declined.', status: 'denied', changed: false }
      const ran = c.status === 'completed' || (c.exitCode !== null && c.exitCode !== undefined)
      // The command card reads "exit code N" off the first line, as for Eaon's own run_command.
      const head = typeof c.exitCode === 'number' ? `exit code ${c.exitCode}\n` : ''
      return { output: `${head}${text || '(no output)'}`, status: ran ? 'done' : 'error', changed: ran }
    }
    case 'fileChange': {
      const f = item as Extract<ThreadItem, { type: 'fileChange' }>
      const changes = f.changes ?? []
      if (f.status === 'declined') return { output: 'Not changed: the edit was declined.', status: 'denied', changed: false }
      const verb = (k?: string): string => (k === 'add' ? 'Added' : k === 'delete' ? 'Deleted' : 'Updated')
      const lines = changes.map((c) => `${verb(c.kind?.type)} ${c.path}`)
      const diffs = changes.map((c) => c.diff ?? '').filter(Boolean).join('\n')
      if (f.status === 'failed') return { output: `The edit failed.\n${lines.join('\n')}`, status: 'error', changed: false }
      return { output: [lines.join('\n'), diffs].filter(Boolean).join('\n\n') || 'Files changed.', status: 'done', changed: changes.length > 0 }
    }
    case 'mcpToolCall': {
      const m = item as Extract<ThreadItem, { type: 'mcpToolCall' }>
      if (m.status === 'failed' || m.error) return { output: m.error?.message ?? 'The tool call failed.', status: 'error', changed: false }
      const text = (m.result?.content ?? [])
        .map((c) => (c && typeof c === 'object' && (c as { type?: string }).type === 'text' ? String((c as { text?: unknown }).text ?? '') : ''))
        .filter(Boolean)
        .join('\n')
      return { output: text || 'Done.', status: 'done', changed: m.readOnlyHint !== true }
    }
    case 'webSearch': {
      const w = item as Extract<ThreadItem, { type: 'webSearch' }>
      return { output: w.query ? `Searched the web for \u201c${w.query}\u201d.` : 'Searched the web.', status: 'done', changed: false }
    }
    case 'imageView':
      return { output: 'Viewed the image.', status: 'done', changed: false }
    default:
      return { output: '', status: 'done', changed: false }
  }
}

function toTodos(plan: TurnPlanStep[] | undefined): TodoItem[] {
  return (plan ?? [])
    .filter((s) => s && typeof s.step === 'string')
    .map((s) => ({ text: s.step, status: s.status === 'completed' ? 'done' : s.status === 'inProgress' ? 'in_progress' : 'pending' }))
}

/* ----------------------------------------------------------------- errors */

function errorInfo(info: CodexErrorInfo | null | undefined): { kind: string | null; status: number | null } {
  if (!info) return { kind: null, status: null }
  if (typeof info === 'string') return { kind: info, status: null }
  const [kind] = Object.keys(info)
  return { kind: kind ?? null, status: info[kind]?.httpStatusCode ?? null }
}

const MODEL_UNAVAILABLE = /model\b[^.]*\b(not supported|does not exist|doesn't exist|not found|unavailable|not available|isn't available|unknown|no access|not allowed|requires)|unsupported model|unknown model|invalid model/i

/** Turns a failed turn into what the user can do about it. */
export function classifyTurnError(error: TurnError | null, auth: EngineAuth | null): { error: string; errorKind: EngineErrorKind } {
  const message = error?.message?.trim() || 'Codex couldn\u2019t finish this turn.'
  const { kind, status } = errorInfo(error?.codexErrorInfo)
  const words = `${message} ${error?.additionalDetails ?? ''}`
  if (kind === 'unauthorized' || status === 401 || (kind === null && isAuthRefusal(words))) {
    if (auth?.state === 'signed-out') return { error: 'Codex isn\u2019t signed in. Sign in under Settings \u2192 Agent engines.', errorKind: 'signed-out' }
    const what = auth?.method === 'API key' ? 'Codex\u2019s API key was refused' : 'Codex\u2019s ChatGPT session has expired'
    return { error: `${what}. Reconnect it under Settings \u2192 Agent engines.`, errorKind: 'auth-expired' }
  }
  if (kind === 'usageLimitExceeded' || kind === 'sessionBudgetExceeded') {
    return { error: `You\u2019ve reached your plan\u2019s Codex usage limit. ${message}`.trim(), errorKind: 'rate-limited' }
  }
  if (kind === 'rateLimitExceeded' || status === 429) return { error: `Codex is being rate limited. Try again in a little while. (${message})`, errorKind: 'rate-limited' }
  if (MODEL_UNAVAILABLE.test(words) && (kind === 'badRequest' || status === 400 || status === 404 || kind === null || kind === 'other')) {
    return { error: `That model isn\u2019t available to Codex with this account. Pick another Codex model. (${message})`, errorKind: 'model-unavailable' }
  }
  if (kind === 'contextWindowExceeded') return { error: 'This conversation is too long for the model. Start a new one, or pick a model with a bigger context.', errorKind: 'other' }
  if (
    (kind === 'httpConnectionFailed' || kind === 'responseStreamConnectionFailed' || kind === 'responseStreamDisconnected' || kind === 'responseTooManyFailedAttempts') &&
    (status === null || status === 0)
  ) {
    return { error: `Codex couldn\u2019t reach its model. Check your connection and try again. (${message})`, errorKind: 'network' }
  }
  if (kind === 'serverOverloaded' || kind === 'internalServerError' || (status !== null && status >= 500)) {
    return { error: `Codex\u2019s model service had a problem. Try again in a moment. (${message})`, errorKind: 'other' }
  }
  return { error: message, errorKind: 'other' }
}

/** A `turn/start` that was refused outright. */
function classifyStartError(message: string): { error: string; errorKind: EngineErrorKind } {
  if (MODEL_UNAVAILABLE.test(message)) return { error: `That model isn\u2019t available to Codex. Pick another Codex model. (${message})`, errorKind: 'model-unavailable' }
  if (/timed? ?out|did not answer/i.test(message)) return { error: 'Codex didn\u2019t answer when asked to start the turn.', errorKind: 'engine-crashed' }
  return { error: `Codex refused to start the turn: ${message}`, errorKind: 'other' }
}
