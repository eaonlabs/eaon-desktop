import type { ChannelKind, GuestAccess } from './channels'
import type { ChatMessage, StreamEvent } from './types'

/**
 * Eaon Workers: independent agents that live on the user's computer and keep
 * running in the background.
 *
 * A worker has no sessions. It owns one thread that lasts forever — the agent
 * loop compacts it when it grows too big — and it wakes up for three reasons
 * only: the user wrote to it, another worker sent it mail, or a heartbeat it
 * scheduled for itself came due. Everything a worker is told arrives as mail
 * in its inbox and is folded into the next turn, so a message sent while it is
 * busy is never lost or interleaved into the turn in flight.
 *
 * The main process owns workers (`features/workers/`); the renderer only
 * displays them and sends commands, so they keep working with no window open.
 */

/**
 * The faces a worker can make — see `WorkerFace` in the renderer. Only the
 * eyes change; the round body never moves.
 */
export type WorkerMood = 'neutral' | 'happy' | 'serious' | 'angry' | 'asleep' | 'dead'

export type WorkerStatus =
  /** Awake with nothing to do right now. */
  | 'idle'
  /** A turn is running. */
  | 'working'
  /** Nothing scheduled and no mail: it wakes when someone writes to it. */
  | 'asleep'
  /** Stopped by the user; heartbeats and mail wait until it is resumed. */
  | 'paused'
  /** The last turn ended in an error. The next mail or heartbeat tries again. */
  | 'failed'

export interface WorkerHeartbeat {
  /** When the worker next wakes on its own; null when nothing is scheduled. */
  nextAt: number | null
  /** Repeat interval, for a steady beat (watching a training run); null for a one-off. */
  everyMs: number | null
  /** What it meant to do when it wakes, in its own words. */
  note: string
}

/**
 * A named, repeating job a worker set itself: every N minutes, or daily at a
 * clock time. Several can run side by side; the heartbeat stays the one-off
 * "wake me in 10 minutes" slot.
 */
export interface WorkerRoutine {
  id: string
  name: string
  /** What to do each time, in the worker's own words. */
  task: string
  everyMs: number | null
  /** Local clock time, "HH:MM", for a daily routine. */
  daily: string | null
  /** Only while the US stock market is open (9:30–4:00 ET on trading days): skips nights, weekends and holidays. */
  marketHours?: boolean
  nextAt: number
  /** The latest runs, newest last (at most 20). */
  runs: { at: number; ok: boolean }[]
}

/**
 * A question a worker put to the user without stopping work. Answering it
 * sends the answer back as mail. `approve` asks for one specific action the
 * worker may not take alone (spending money, a destructive plugin call…):
 * approving lets exactly that call through once.
 */
export interface WorkerAsk {
  id: string
  question: string
  /** Quick answers offered as buttons; the user can always write their own. */
  options: string[]
  approve: { tool: string; input: Record<string, unknown>; summary: string } | null
  at: number
}

export interface WorkerMail {
  id: string
  /**
   * `'user'`, the id of the worker that sent it, or `'guest'` — someone the
   * user let talk to the worker in a chat app (`channel` says where).
   */
  from: string
  fromName: string
  fromColor?: string
  text: string
  /** Absolute paths, already copied into the recipient's folder. */
  files: string[]
  at: number
  /** Set when it came in through Discord, Telegram or WhatsApp — see shared/channels.ts. */
  channel?: WorkerMailChannel
}

/** Where a chat-app message came from, so the reply goes back there. */
export interface WorkerMailChannel {
  linkId: string
  kind: ChannelKind
  chatId: string
  /** "Direct message", "#general", "Family" — how the worker and the user see it. */
  chatName: string
  isGroup: boolean
  messageId: string
  senderId: string
  /** Guests only: the most this message may make the worker do. */
  cap?: GuestAccess
}

export type WorkerAccess = 'autonomous' | 'safe' | 'read-only'

/** `WorkerTrading.via` for the trading desk's own account (the simulator, Alpaca paper or live). */
export const TRADING_DESK = 'desk'
/** The routine a trading worker wakes for while the market is open; the editor keeps it in step. */
export const TRADING_ROUTINE_NAME = 'Trading check'

/**
 * A worker set up to trade for the user: where, with what strategy, how
 * often, and how freely. The worker trades through the trading desk's tools
 * (`via: 'desk'`, every order through the desk's limits) or through a
 * connected broker plugin's own tools (`via`: that MCP server's id).
 */
export interface WorkerTrading {
  via: string
  strategy: string
  /** How often it looks at the market while it is open, in minutes. */
  everyMinutes: number
  /** Places orders on its own. Off: every order waits for the user's Approve once. */
  autoPlace: boolean
}

export const TRADING_INTERVALS = [5, 15, 30, 60] as const

/**
 * How much a worker may do with nobody watching, as the editor offers it.
 * `autonomous` maps onto the loop's unattended policy of the same name: every
 * tool runs, except calls a tool marks catastrophic (spending money, card
 * numbers and passwords, sudo, erasing disks, force-pushing, destructive
 * plugin actions).
 */
export const WORKER_ACCESS: { id: WorkerAccess; label: string; description: string }[] = [
  {
    id: 'autonomous',
    label: 'Autonomous',
    description:
      'Acts on its own: files, commands, plugins, its own browser and your computer. It never spends money, types card numbers or passwords, uses sudo or force-pushes; it asks you instead.'
  },
  { id: 'safe', label: 'Careful', description: 'Makes ordinary changes on its own; anything risky is refused and reported to you.' },
  { id: 'read-only', label: 'Look only', description: 'Reads, searches and reports; it never changes anything.' }
]

export interface Worker {
  id: string
  name: string
  /** Body colour, any CSS hex colour. */
  color: string
  personality: string
  purpose: string
  createdAt: number
  /** Null when the user created it; otherwise the id of the worker that did. */
  createdBy: string | null
  /** Pinned model; null follows the app's selected model. */
  model: { providerId: string; modelId: string } | null
  /** The worker's own folder. It works here and colleagues' files land here. */
  folder: string
  paused: boolean
  /**
   * 'autonomous' acts alone except for catastrophic actions; 'safe' may make
   * changes, with risky actions refused (nobody is there to approve them);
   * 'read-only' may only look. See WORKER_ACCESS.
   */
  access: WorkerAccess
  /** Set when the user made this worker a trader. */
  trading: WorkerTrading | null
  heartbeat: WorkerHeartbeat
  routines: WorkerRoutine[]
  /**
   * What the worker is working towards and what it has learned, kept by the
   * worker itself (set_goal, update_notes). Part of its prompt on every turn,
   * so they survive the thread being compacted.
   */
  goal: string
  notes: string
  /** Questions waiting on the user, oldest first. */
  asks: WorkerAsk[]
  status: WorkerStatus
  /** One line on what it is doing, kept current by the worker itself. */
  activity: string
  /** A mood the worker chose for itself (set_status), until `until`. */
  moodHint: { mood: WorkerMood; until: number } | null
  lastRunAt: number | null
  /** When the last turn ended, and whether it went well — drives the happy face. */
  lastOutcome: { at: number; ok: boolean } | null
  lastError: string | null
  /** Mail waiting for the next turn, oldest first. */
  inbox: WorkerMail[]
  /** Thread messages that arrived since the user last looked at this worker. */
  unread: number
  /** The assistant message streaming right now; null when not running. */
  runningMessageId: string | null
}

export interface WorkerThread {
  workerId: string
  messages: ChatMessage[]
  /** Compaction summary standing in for every message up to `throughMessageId`. */
  summary: { text: string; throughMessageId: string } | null
}

/** What the create/edit dialog sends. `id` set means update. */
export interface WorkerDraft {
  id?: string
  name: string
  color: string
  personality: string
  purpose: string
  model?: { providerId: string; modelId: string } | null
  access?: WorkerAccess
  /** Undefined keeps what is set; null stops the worker trading. */
  trading?: WorkerTrading | null
}

/** `workers:event` — a stream event from one worker's running turn. */
export interface WorkerStreamEvent {
  workerId: string
  event: StreamEvent
}

/** `workers:message` — a message was added to (or replaced in) a thread, whole. */
export interface WorkerMessageEvent {
  workerId: string
  message: ChatMessage
}

/** Hard ceiling on how many workers can exist at once. */
export const MAX_WORKERS = 16
/** How many worker turns may run at the same time, across all workers. */
export const WORKER_CONCURRENCY = 2
/** At most this many routines per worker. */
export const MAX_ROUTINES = 20
/** Goal and notes are part of every prompt, so they stay short. */
export const MAX_GOAL_CHARS = 600
export const MAX_NOTES_CHARS = 4000
/** A heartbeat can not come round faster than this. */
export const MIN_HEARTBEAT_MS = 60_000
/** A worker that wakes more often than this per hour is slowed down. */
export const MAX_TURNS_PER_HOUR = 60
/** How long the happy face lasts after a turn goes well. */
export const HAPPY_FOR_MS = 10 * 60_000
/** Awake with nothing scheduled for this long, a worker falls asleep. */
export const DOZE_AFTER_MS = 15 * 60_000

export const WORKER_COLORS = [
  '#3E86C6',
  '#5B6CF0',
  '#8E5CE6',
  '#D6509B',
  '#E4574B',
  '#EE8A36',
  '#E7B727',
  '#3FAE6A',
  '#22A7A0',
  '#6B7280'
]

export const WORKER_PERSONALITIES: { label: string; text: string }[] = [
  { label: 'Cheerful', text: 'Warm, upbeat and encouraging. Celebrates progress and keeps things light.' },
  { label: 'Calm', text: 'Unflappable and steady. Speaks plainly and never rushes.' },
  { label: 'Meticulous', text: 'Detail-oriented and careful. Double-checks everything before calling it done.' },
  { label: 'Blunt', text: 'Direct and to the point. No filler, no sugar-coating.' },
  { label: 'Curious', text: 'Inquisitive and thorough. Digs until it understands why.' },
  { label: 'Witty', text: 'Quick and playful, with a dry sense of humour — but the work comes first.' }
]

/**
 * The face to show right now. Derived rather than stored so every view agrees
 * and moods expire on their own: the happy face after a good turn fades, and
 * a worker with nothing to do dozes off.
 */
export function workerMood(worker: Worker, now = Date.now()): WorkerMood {
  if (worker.paused) return 'asleep'
  if (worker.status === 'failed') return 'dead'
  if (worker.moodHint && worker.moodHint.until > now) return worker.moodHint.mood
  if (worker.status === 'working') return 'serious'
  if (worker.lastOutcome?.ok && now - worker.lastOutcome.at < HAPPY_FOR_MS) return 'happy'
  if (worker.status === 'asleep') return 'asleep'
  if (worker.heartbeat.nextAt === null && worker.inbox.length === 0) {
    const since = worker.lastRunAt ?? worker.createdAt
    if (now - since > DOZE_AFTER_MS) return 'asleep'
  }
  return 'neutral'
}

/** "in 4 min", "in 2 h", "now" — for heartbeat and status lines. */
export function relativeTime(at: number, now = Date.now()): string {
  const delta = at - now
  const future = delta >= 0
  const abs = Math.abs(delta)
  const mins = Math.round(abs / 60_000)
  let text: string
  if (abs < 45_000) return future ? 'now' : 'just now'
  if (mins < 60) text = `${mins} min`
  else if (mins < 60 * 36) text = `${Math.round(mins / 60)} h`
  else text = `${Math.round(mins / (60 * 24))} d`
  return future ? `in ${text}` : `${text} ago`
}

/** One line under a worker's name: what it is up to, or when it wakes next. */
/** The routine that comes due soonest, if the worker has any. */
export function nextRoutine(worker: Pick<Worker, 'routines'>): WorkerRoutine | null {
  let soonest: WorkerRoutine | null = null
  for (const routine of worker.routines ?? []) if (!soonest || routine.nextAt < soonest.nextAt) soonest = routine
  return soonest
}

/** When a routine next comes round after `after`: every N ms from then, or the next daily HH:MM. */
export function nextRoutineAt(routine: Pick<WorkerRoutine, 'everyMs' | 'daily'>, after: number): number {
  if (routine.daily) {
    const [hours, minutes] = routine.daily.split(':').map(Number)
    const at = new Date(after)
    at.setHours(hours, minutes, 0, 0)
    if (at.getTime() <= after) at.setDate(at.getDate() + 1)
    return at.getTime()
  }
  return after + Math.max(routine.everyMs ?? 0, MIN_HEARTBEAT_MS)
}

export function describeWorker(worker: Worker, now = Date.now()): string {
  if (worker.paused) return 'Paused'
  if (worker.status === 'working') return worker.activity || 'Working…'
  if (worker.status === 'failed') return worker.lastError ? `Stopped: ${worker.lastError}` : 'Last task failed'
  if (worker.asks?.length) return worker.asks.length === 1 ? 'Has a question for you' : `Has ${worker.asks.length} questions for you`
  if (worker.inbox.length > 0) return `${worker.inbox.length} message${worker.inbox.length === 1 ? '' : 's'} waiting`
  if (worker.heartbeat.nextAt !== null) {
    const every = worker.heartbeat.everyMs ? ` · every ${Math.round(worker.heartbeat.everyMs / 60_000)} min` : ''
    return `Next heartbeat ${relativeTime(worker.heartbeat.nextAt, now)}${every}`
  }
  const routine = nextRoutine(worker)
  if (routine) return `${routine.name} ${relativeTime(routine.nextAt, now)}`
  if (worker.lastRunAt === null) return 'Ready for its first job'
  return worker.activity || 'Asleep — wakes when you message it'
}
