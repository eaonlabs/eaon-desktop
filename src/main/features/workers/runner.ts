import { randomUUID } from 'node:crypto'
import type { ChatMessage, GoalState, Settings, StreamEvent, StreamRequest, TokenUsage } from '@shared/types'
import { clampEffort } from '@shared/effort'
import { MAIN_THREAD, threadKey, type Worker, type WorkerMail, type WorkerRoutine, type WorkerThread } from '@shared/workers'
import { CHANNEL_LABEL, type GuestAccess } from '@shared/channels'
import type { RunOptions, RunOutcome } from '../../agent/loop'
import type { TurnOrigin } from '../../agent/policy'
import type { EngineApprovalRequest, EngineTurnInput, EngineTurnResult } from '../../engines/types'
import { ENGINE_LABEL } from '@shared/engines'
import { isCatastrophicCommand, isRiskyCommand } from '@shared/commandRisk'
import { resolveModel, STALL_MS } from '../scheduler/runner'
import { applyStreamEvent } from '../scheduler/transcript'
import { guestGate, guestNote, guestPolicy } from './guests'

/**
 * One worker turn: turn the mail (and heartbeat) that woke it into a single
 * user message, run the agent headlessly on the worker's thread, and keep the
 * thread up to date as events arrive. The engine decides when; this decides
 * what a turn is.
 */

export type RunAgent = (request: StreamRequest, emit: (event: StreamEvent) => void, options: RunOptions) => Promise<RunOutcome>

/**
 * Runs a turn on an installed agent engine (Codex) rather than Eaon's own
 * loop: the engine keeps its own session, tools and model list. Wired in the
 * service from `main/engines`; tests pass a fake.
 */
export type RunEngineTurn = (engine: Worker['engine'], input: EngineTurnInput) => Promise<EngineTurnResult>

const EMPTY_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** "[From Nova, a fellow worker] …" — the header each piece of mail gets in the model's copy. */
function mailHeader(mail: WorkerMail): string {
  const channel = mail.channel
  if (channel) {
    const where = `${channel.isGroup ? `in ${channel.chatName}` : 'in a direct message'} on ${CHANNEL_LABEL[channel.kind]}`
    return mail.from === 'user' ? `[From the user, ${where}]` : `[From ${mail.fromName}, ${where} — a guest, not the user]`
  }
  if (mail.room) {
    return mail.from === 'user'
      ? `[In the group chat "${mail.room.name}", from the user]`
      : `[In the group chat "${mail.room.name}", from ${mail.fromName}, who @mentioned you]`
  }
  if (mail.handoff) return `[Task ${mail.handoff.id}, handed to you by ${mail.fromName}]`
  if (mail.handoffResult) {
    const task = mail.handoffResult.task.length > 120 ? `${mail.handoffResult.task.slice(0, 119)}…` : mail.handoffResult.task
    return `[${mail.fromName} ${mail.handoffResult.ok ? 'finished' : 'could not finish'} task ${mail.handoffResult.id} you handed over ("${task}")]`
  }
  if (mail.from !== 'user') return `[From ${mail.fromName}, a fellow worker]`
  if (mail.via) return `[From the user, in a message to ${mail.via.name} that @mentioned you]`
  return mail.goal ? '[From the user, set as your goal]' : '[From the user]'
}

/**
 * The user message a turn starts with. The model reads one combined text; the
 * transcript keeps the pieces (`mail`, `heartbeat`) so it can show each as its
 * own bubble. Files the user attached go in `attachments`, which is how images
 * reach a vision model (context.ts reads them); files a colleague sent were
 * copied into this worker's folder and are listed by path in the text.
 */
export function buildTurnMessage(
  mail: WorkerMail[],
  heartbeatNote: string | null,
  now: number,
  routines: Pick<WorkerRoutine, 'name' | 'task'>[] = [],
  /** Set when a guest's message is in this turn: what the turn may do. */
  guest: GuestAccess | null = null,
  /** The goal this turn works on, when it isn't the message that set it. */
  goal: string | null = null,
  /**
   * Work still open that the thread's older messages may have been summarised
   * away from: jobs this thread delegated and is waiting on, and questions
   * put to the user with no answer yet. Restated every turn so compaction
   * can't make the worker forget it is waiting.
   */
  open: { delegations: { id: string; to: string; objective: string; state: string }[]; asks: string[] } | null = null
): ChatMessage {
  // The system prompt only carries the date (it stays cached all day); a
  // worker checking on something needs the time too. Per turn, so it costs
  // nothing in the cached prefix.
  const lines: string[] = [
    `[${new Date(now).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}]`
  ]
  if (heartbeatNote !== null) {
    lines.push(
      heartbeatNote === CHECK_IN_NOTE
        ? `[Check-in] ${CHECK_IN_NOTE}.`
        : heartbeatNote === RESUME_NOTE
          ? `[Resumed] ${RESUME_NOTE}`
          : heartbeatNote.startsWith(RETRY_NOTE)
            ? `[Retry] ${heartbeatNote}`
            : `[Heartbeat] You scheduled this wake-up${heartbeatNote ? `: "${heartbeatNote}"` : ''}.`
    )
  }
  for (const routine of routines) lines.push(`[Routine "${routine.name}"] ${routine.task}`)
  if (open && (open.delegations.length > 0 || open.asks.length > 0)) {
    const parts = [
      ...open.delegations.map((d) => `waiting on ${d.to} for ${d.id} ("${d.objective.length > 100 ? `${d.objective.slice(0, 99)}…` : d.objective}", ${d.state})`),
      ...open.asks.map((q) => `your question to the user, not answered yet: "${q.length > 100 ? `${q.slice(0, 99)}…` : q}"`)
    ]
    lines.push(`[Still open] ${parts.join('; ')}. Don't redo these; their answers arrive as mail.`)
  }
  if (goal) {
    lines.push(
      `[Goal] Keep working toward your goal: "${goal}". Take the next concrete step. Call goal_complete once it is achieved and verified, goal_blocked if you need the user, or sleep if you are waiting for something.`
    )
  }
  for (const item of mail) {
    const files = item.from !== 'user' && item.files.length > 0 ? `\nFiles (copied into your folder): ${item.files.join(', ')}` : ''
    // The mentioned colleagues were sent their own copy (engine.send).
    const names = (item.mentions ?? []).map((m) => m.name)
    const mentions = names.length > 0 ? `\n(${names.join(', ')} ${names.length === 1 ? 'was' : 'were'} @mentioned and got this message too, so there's no need to forward it.)` : ''
    const extra = [
      item.brief ? `\nBackground from ${item.fromName}:\n${item.brief}` : '',
      item.context ? `\n${item.fromName}'s recent thread, shared with you so you have the background:\n${item.context}` : '',
      item.roomContext ? `\nSaid in "${item.room?.name}" since you last looked:\n${item.roomContext}` : '',
      item.handoff?.requiredOutput ? `\nWhat to send back: ${item.handoff.requiredOutput}` : '',
      item.handoff?.deadlineAt ? `\nDeadline: ${new Date(item.handoff.deadlineAt).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}.` : '',
      item.handoff ? `\nWhen it's done (or you can't do it), report back with finish_handoff {task_id: "${item.handoff.id}", result}; the result goes straight to ${item.fromName}.` : ''
    ].join('')
    lines.push(`${mailHeader(item)} ${item.text.trim()}${files}${mentions}${extra}`)
  }
  if (mail.some((m) => m.room)) {
    lines.push('[Group chat] Your final reply is posted to the group chat. Write it for everyone there; @Name a colleague in the room to wake them for their part.')
  }
  // Per turn rather than in the persona, so the cached prompt prefix stays put.
  if (mail.some((m) => m.channel)) {
    lines.push('[Chat apps] Your reply is posted back to the chat each message came from, so write it like a chat message: short, plain, no headings.')
  }
  if (guest) lines.push(guestNote(guest))
  const userFiles = mail.filter((m) => m.from === 'user').flatMap((m) => m.files)
  return {
    id: randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text: lines.join('\n') }],
    createdAt: now,
    ...(mail.length > 0 ? { mail } : {}),
    ...(heartbeatNote !== null
      ? { heartbeat: heartbeatNote }
      : routines.length > 0
        ? { heartbeat: routines.map((r) => r.name).join(', ') }
        : goal && mail.length === 0
          ? { heartbeat: 'Continuing toward its goal' }
          : {}),
    ...(userFiles.length > 0 ? { attachments: userFiles } : {})
  }
}

/** The note on a turn the user asked for with "Wake now". */
export const CHECK_IN_NOTE = 'The user asked you to check in now'
/** The note on a turn that picks up one a quit cut off (one that hadn't changed anything yet). */
export const RESUME_NOTE =
  'Your last turn here was cut off when Eaon quit, before you finished. Pick up where you left off; a step shown as interrupted may or may not have happened, so check before repeating it.'
/** How a retry's note starts; the rest says which run it retries and how that went. */
export const RETRY_NOTE = 'The user asked you to retry an earlier run'

/** What the model is sent as history: everything after the compaction summary, minus the reply being written. */
export function historyFor(thread: WorkerThread, exceptMessageId: string): ChatMessage[] {
  let history = thread.messages.filter((m) => m.id !== exceptMessageId && m.role !== 'system')
  if (thread.summary) {
    const cut = history.findIndex((m) => m.id === thread.summary!.throughMessageId)
    if (cut !== -1) history = history.slice(cut + 1)
  }
  return history
}

export interface TurnInput {
  worker: Worker
  /** MAIN_THREAD or another of the worker's threads. */
  threadId?: string
  thread: WorkerThread
  /** The thread's model if it has its own, else the worker's; null follows the app. */
  model?: Worker['model']
  /** The engine session this thread continues (agent engines only). */
  engineSession?: Worker['engineSession']
  /** The placeholder the reply streams into; already in `thread.messages`. */
  assistant: ChatMessage
  persona: string
  settings: Settings
  signal: AbortSignal
  runAgent: RunAgent
  runEngineTurn?: RunEngineTurn
  /** Each tool as it is about to run, and whether it changes anything (RunOptions.onToolRun). */
  onToolRun?: (name: string, mutating: boolean) => void
  /** Every event, after it has been applied to the thread. */
  onEvent: (event: StreamEvent) => void
  /** Whether the user approved this exact call ahead of time (an answered ask_user); spends the approval. */
  allowOnce?: (tool: string, input: Record<string, unknown>) => boolean
  /** A guest's message is in this turn: hold it to this level (see guests.ts). */
  guestCap?: GuestAccess | null
  /** Who the work in this turn came from; a guest's or a colleague's can't spend money (agent/policy). */
  origin?: TurnOrigin
  stallMs?: number
  /**
   * The goal this turn works toward (the composer's Goal): the loop keeps it
   * going until goal_complete, goal_blocked, a sleep or its limits.
   */
  goal?: GoalState | null
}

export interface TurnOutcome {
  text: string
  error?: string
  cancelled: boolean
  usage?: TokenUsage
  providerId?: string
  modelId?: string
  /** An agent engine's session to continue next turn; null when it should start afresh. Absent for Eaon's own loop. */
  sessionId?: string | null
  /** An agent engine ran something that changes things outside the transcript. */
  sideEffects?: boolean
  /** Something about this turn worth knowing that isn't an error ("started a fresh Codex session"). */
  notice?: string | null
  /** Who pays for an agent engine turn's tokens: the user's plan (no price to show), their API key, or unknown. */
  billing?: EngineTurnResult['billing']
}

/**
 * The model a worker's turn runs on. A pinned model must be available as
 * pinned; a worker that follows the app's model gets exactly that model or
 * a clear error — never some other model the providers happen to list first,
 * which is what a stale selection used to fall back to.
 */
export function resolveWorkerModel(model: Worker['model'], settings: Settings): ReturnType<typeof resolveModel> {
  const target = resolveModel({ model }, settings, undefined, 'worker')
  if (!model && settings.selectedModelId && (!target.ok || target.modelId !== settings.selectedModelId)) {
    return {
      ok: false,
      error: `This worker follows Chat's model (${settings.selectedModelId}), which isn't available right now. Pick a model for the worker in its settings, or fix the provider in Settings → Model providers.`
    }
  }
  return target
}

/**
 * The turn's own abort signal — the engine's (stop, pause, remove) or a stall
 * watchdog that fires after `stallMs` with no sign of life. Monotonic, so
 * time the computer spent asleep does not count as silence.
 */
function watchdog(signal: AbortSignal, stallMs: number): { signal: AbortSignal; alive: () => void; stalled: () => boolean; dispose: () => void } {
  const controller = new AbortController()
  const stop = (): void => controller.abort()
  signal.addEventListener('abort', stop, { once: true })
  let stalled = false
  let lastSign = performance.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const check = (): void => {
    const quiet = performance.now() - lastSign
    if (quiet < stallMs) {
      timer = setTimeout(check, stallMs - quiet)
      return
    }
    stalled = true
    controller.abort()
  }
  timer = setTimeout(check, stallMs)
  return {
    signal: controller.signal,
    alive: () => {
      lastSign = performance.now()
    },
    stalled: () => stalled,
    dispose: () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
    }
  }
}

const stallError = (stallMs: number): string =>
  `No progress for ${Math.round(stallMs / 60_000)} minutes, so the turn was stopped. The model or a tool stopped responding — a dropped connection, or the computer sleeping mid-turn, can do that.`

export async function runWorkerTurn(input: TurnInput): Promise<TurnOutcome> {
  const { worker, thread, assistant, settings } = input
  if (worker.engine && worker.engine !== 'native') return runOnEngine(input)
  const target = resolveWorkerModel(input.model === undefined ? worker.model : input.model, settings)
  if (!target.ok) {
    assistant.error = target.error
    return { text: '', error: target.error, cancelled: false }
  }
  assistant.model = target.modelId

  // The worker's own level, else the app's, clamped down to what the model
  // takes as the composer shows it — never bumped to the model's highest,
  // which ran workers at Max.
  const wanted = worker.effort ?? settings.effort
  const effort = clampEffort(wanted, target.model?.efforts) ?? wanted
  const threadId = input.threadId && input.threadId !== MAIN_THREAD ? input.threadId : undefined
  const request: StreamRequest = {
    chatId: `worker:${threadKey(worker.id, input.threadId)}`,
    chatTitle: worker.name,
    messageId: assistant.id,
    providerId: target.providerId,
    modelId: target.modelId,
    effort,
    mode: 'work',
    history: historyFor(thread, assistant.id),
    summary: thread.summary?.text ?? null,
    projectInstructions: '',
    cwd: worker.folder,
    // Swarm sub-agents build their own approval gate, which knows nothing of
    // the unattended policy, and plan mode would stop at a plan nobody can
    // approve — the same reasons scheduled runs use neither.
    work: { swarm: false, plan: false },
    goal: input.goal ?? null,
    workerId: worker.id,
    ...(threadId ? { workerThreadId: threadId } : {}),
    persona: input.persona
  }

  // A guest's message holds the whole turn to what that guest may do.
  const access = input.guestCap ? guestPolicy(input.guestCap) : worker.access
  const gate = input.guestCap ? guestGate(input.guestCap) : undefined
  const stallMs = input.stallMs ?? STALL_MS
  const dog = watchdog(input.signal, stallMs)

  let outcome: RunOutcome
  try {
    outcome = input.signal.aborted
      ? { text: '', usage: EMPTY_USAGE, cancelled: true }
      : await input.runAgent(
          request,
          (event) => {
            dog.alive()
            applyStreamEvent(thread, event)
            input.onEvent(event)
          },
          {
            signal: dog.signal,
            unattended: access,
            ...(input.allowOnce ? { allowOnce: input.allowOnce } : {}),
            ...(gate ? { toolGate: gate } : {}),
            ...(input.onToolRun ? { onToolRun: input.onToolRun } : {}),
            ...(input.origin ? { origin: input.origin } : {}),
            // Only a tool's own extra confirmation (computer use before each
            // click) reaches this. An autonomous worker was trusted to act;
            // anyone else has nobody to ask, so the answer is no.
            approver: async () => access === 'autonomous'
          }
        )
  } catch (error) {
    outcome = { text: '', usage: EMPTY_USAGE, error: error instanceof Error ? error.message : String(error) }
  } finally {
    dog.dispose()
  }

  const error = outcome.error ?? (dog.stalled() ? stallError(stallMs) : undefined)
  if (error && !assistant.error) assistant.error = error
  const cancelled = !error && (input.signal.aborted || outcome.cancelled === true)
  return { text: outcome.text, ...(error ? { error } : {}), cancelled, usage: outcome.usage, providerId: target.providerId, modelId: target.modelId }
}

/** What to tell the user when an agent engine's turn fails, by why it failed. */
export function engineErrorText(engine: Worker['engine'], kind: EngineTurnResult['errorKind'], detail: string, model: string | null): string {
  const name = ENGINE_LABEL[engine] ?? engine
  switch (kind) {
    case 'auth-expired':
      return `${name}'s sign-in expired. Reconnect it in Settings → Agent engines, then retry.`
    case 'signed-out':
      return `${name} isn't signed in. Sign in under Settings → Agent engines, then retry.`
    case 'not-installed':
      return `${name} isn't installed on this computer (or Eaon can't find it). Install it, or switch this worker to Eaon's own engine.`
    case 'outdated':
      return `This copy of ${name} is too old for Eaon to drive. Update it, then retry.`
    case 'model-unavailable':
      return model ? `${name} doesn't offer ${model} on your account. Pick another ${name} model for this worker.` : `${name} has no model it can use on your account.`
    case 'rate-limited':
      return `${name} hit a usage limit on your account. It can try again later.`
    case 'network':
      return `${name} couldn't reach its service. Check your connection, then retry.`
    case 'engine-crashed':
      return `${name} stopped responding and was restarted. Retry the run.`
    case 'misconfigured':
      return `${name} is set up to send its requests through Eaon, so Eaon can't run it (that would loop back into itself). Switch it back in Settings → Connect apps, or give this worker Eaon's own engine.`
    default:
      return detail || `${name} couldn't finish this turn.`
  }
}

/**
 * A turn on an installed agent engine (Codex): the engine runs its own loop
 * in its own session; Eaon sends the turn's message and the worker's persona,
 * applies the events it streams back to the thread, and answers its approval
 * requests from the worker's access level — the engine never approves its
 * own calls. The session id comes back so the thread continues it next time.
 */
async function runOnEngine(input: TurnInput): Promise<TurnOutcome> {
  const { worker, thread, assistant } = input
  const engine = worker.engine
  const name = ENGINE_LABEL[engine] ?? engine
  if (!input.runEngineTurn) {
    const error = `${name} isn't available in this version of Eaon. Switch this worker to Eaon's own engine.`
    assistant.error = error
    return { text: '', error, cancelled: false }
  }
  const pinned = input.model === undefined ? worker.model : input.model
  const model = pinned && pinned.providerId === engine ? pinned.modelId : null
  assistant.model = model ?? `${name} default`
  const message = thread.messages.filter((m) => m.role === 'user').at(-1)
  const text = message ? message.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n') : ''
  const access = input.guestCap ? guestPolicy(input.guestCap) : worker.access
  const stallMs = input.stallMs ?? STALL_MS
  const dog = watchdog(input.signal, stallMs)
  let result: EngineTurnResult
  try {
    result = input.signal.aborted
      ? { sessionId: input.engineSession?.sessionId ?? null, text: '', usage: EMPTY_USAGE, cancelled: true, sideEffects: false }
      : await input.runEngineTurn(engine, {
          sessionId: input.engineSession?.engine === engine ? input.engineSession.sessionId : null,
          messageId: assistant.id,
          cwd: worker.folder,
          model,
          effort: worker.effort ?? input.settings.effort,
          instructions: input.persona,
          text,
          images: message?.attachments ?? [],
          access,
          signal: dog.signal,
          emit: (event) => {
            dog.alive()
            applyStreamEvent(thread, event)
            input.onEvent(event)
          },
          approve: async (request) => {
            dog.alive()
            if (request.mutating) input.onToolRun?.(request.tool, true)
            if (input.allowOnce?.(request.tool, request.input)) return true
            return engineApproval(access, request)
          }
        })
  } catch (error) {
    result = { sessionId: input.engineSession?.sessionId ?? null, text: '', usage: EMPTY_USAGE, cancelled: false, sideEffects: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    dog.dispose()
  }
  const error = result.error ? engineErrorText(engine, result.errorKind, result.error, model) : dog.stalled() ? stallError(stallMs) : undefined
  if (error && !assistant.error) assistant.error = error
  const cancelled = !error && (input.signal.aborted || result.cancelled)
  return {
    text: result.text,
    ...(error ? { error } : {}),
    cancelled,
    usage: result.usage,
    providerId: engine,
    modelId: model ?? '',
    // A session the engine no longer knows (auth expired, wiped) starts afresh next time.
    sessionId: result.errorKind === 'auth-expired' || result.errorKind === 'signed-out' ? (input.engineSession?.sessionId ?? null) : result.sessionId,
    sideEffects: result.sideEffects,
    notice: result.notice ?? null,
    billing: result.billing
  }
}

/**
 * Eaon's answer to an engine's approval request, from the worker's access
 * level — the same lines Eaon's own loop draws for an unattended worker:
 * look-only refuses anything that changes things, Careful refuses what is
 * risky, Autonomous refuses only what can't be undone.
 */
export function engineApproval(access: Worker['access'], request: EngineApprovalRequest): boolean {
  if (!request.mutating) return true
  if (access === 'read-only') return false
  const command = typeof request.input.command === 'string' ? request.input.command : Array.isArray(request.input.command) ? request.input.command.join(' ') : ''
  if (command && isCatastrophicCommand(command)) return false
  if (access === 'autonomous') return true
  return !(command && isRiskyCommand(command))
}
