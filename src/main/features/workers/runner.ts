import { randomUUID } from 'node:crypto'
import type { ChatMessage, Settings, StreamEvent, StreamRequest, TokenUsage } from '@shared/types'
import { clampEffort } from '@shared/effort'
import type { Worker, WorkerMail, WorkerRoutine, WorkerThread } from '@shared/workers'
import { CHANNEL_LABEL, type GuestAccess } from '@shared/channels'
import type { RunOptions, RunOutcome } from '../../agent/loop'
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

const EMPTY_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** "[From Nova, a fellow worker] …" — the header each piece of mail gets in the model's copy. */
function mailHeader(mail: WorkerMail): string {
  const channel = mail.channel
  if (channel) {
    const where = `${channel.isGroup ? `in ${channel.chatName}` : 'in a direct message'} on ${CHANNEL_LABEL[channel.kind]}`
    return mail.from === 'user' ? `[From the user, ${where}]` : `[From ${mail.fromName}, ${where} — a guest, not the user]`
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
  guest: GuestAccess | null = null
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
        : `[Heartbeat] You scheduled this wake-up${heartbeatNote ? `: "${heartbeatNote}"` : ''}.`
    )
  }
  for (const routine of routines) lines.push(`[Routine "${routine.name}"] ${routine.task}`)
  for (const item of mail) {
    const files = item.from !== 'user' && item.files.length > 0 ? `\nFiles (copied into your folder): ${item.files.join(', ')}` : ''
    // The mentioned colleagues were sent their own copy (engine.send).
    const names = (item.mentions ?? []).map((m) => m.name)
    const mentions = names.length > 0 ? `\n(${names.join(', ')} ${names.length === 1 ? 'was' : 'were'} @mentioned and got this message too, so there's no need to forward it.)` : ''
    lines.push(`${mailHeader(item)} ${item.text.trim()}${files}${mentions}`)
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
        : {}),
    ...(userFiles.length > 0 ? { attachments: userFiles } : {})
  }
}

/** The note on a turn the user asked for with "Wake now". */
export const CHECK_IN_NOTE = 'The user asked you to check in now'

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
  thread: WorkerThread
  /** The placeholder the reply streams into; already in `thread.messages`. */
  assistant: ChatMessage
  persona: string
  settings: Settings
  signal: AbortSignal
  runAgent: RunAgent
  /** Every event, after it has been applied to the thread. */
  onEvent: (event: StreamEvent) => void
  /** Whether the user approved this exact call ahead of time (an answered ask_user); spends the approval. */
  allowOnce?: (tool: string, input: Record<string, unknown>) => boolean
  /** A guest's message is in this turn: hold it to this level (see guests.ts). */
  guestCap?: GuestAccess | null
  stallMs?: number
}

export interface TurnOutcome {
  text: string
  error?: string
  cancelled: boolean
}

export async function runWorkerTurn(input: TurnInput): Promise<TurnOutcome> {
  const { worker, thread, assistant, settings } = input
  const target = resolveModel(worker, settings, undefined, 'worker')
  if (!target.ok) {
    assistant.error = target.error
    return { text: '', error: target.error, cancelled: false }
  }
  assistant.model = target.modelId

  // The app's level clamped down to what the model takes, as the composer
  // shows it — never bumped to the model's highest, which ran workers at Max.
  const effort = clampEffort(settings.effort, target.model?.efforts) ?? settings.effort
  const request: StreamRequest = {
    chatId: `worker:${worker.id}`,
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
    goal: null,
    workerId: worker.id,
    persona: input.persona
  }

  // A guest's message holds the whole turn to what that guest may do.
  const access = input.guestCap ? guestPolicy(input.guestCap) : worker.access
  const gate = input.guestCap ? guestGate(input.guestCap) : undefined

  // The turn's own signal: the engine's (stop, pause, remove) or the stall watchdog.
  const controller = new AbortController()
  const stop = (): void => controller.abort()
  input.signal.addEventListener('abort', stop, { once: true })
  const stallMs = input.stallMs ?? STALL_MS
  let stalled = false
  // Monotonic, so time the computer spent asleep does not count as silence.
  let lastSign = performance.now()
  let watchdog: ReturnType<typeof setTimeout> | undefined
  const check = (): void => {
    const quiet = performance.now() - lastSign
    if (quiet < stallMs) {
      watchdog = setTimeout(check, stallMs - quiet)
      return
    }
    stalled = true
    controller.abort()
  }

  let outcome: RunOutcome
  try {
    watchdog = setTimeout(check, stallMs)
    outcome = input.signal.aborted
      ? { text: '', usage: EMPTY_USAGE, cancelled: true }
      : await input.runAgent(
          request,
          (event) => {
            lastSign = performance.now()
            applyStreamEvent(thread, event)
            input.onEvent(event)
          },
          {
            signal: controller.signal,
            unattended: access,
            ...(input.allowOnce ? { allowOnce: input.allowOnce } : {}),
            ...(gate ? { toolGate: gate } : {}),
            // Only a tool's own extra confirmation (computer use before each
            // click) reaches this. An autonomous worker was trusted to act;
            // anyone else has nobody to ask, so the answer is no.
            approver: async () => access === 'autonomous'
          }
        )
  } catch (error) {
    outcome = { text: '', usage: EMPTY_USAGE, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(watchdog)
    input.signal.removeEventListener('abort', stop)
  }

  const error =
    outcome.error ??
    (stalled
      ? `No progress for ${Math.round(stallMs / 60_000)} minutes, so the turn was stopped. The model or a tool stopped responding — a dropped connection, or the computer sleeping mid-turn, can do that.`
      : undefined)
  if (error && !assistant.error) assistant.error = error
  const cancelled = !error && (input.signal.aborted || outcome.cancelled === true)
  return { text: outcome.text, ...(error ? { error } : {}), cancelled }
}
