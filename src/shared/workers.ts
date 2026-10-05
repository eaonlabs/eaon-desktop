import type { ChannelKind, GuestAccess } from './channels'
import type { ChatMessage, EffortLevel, GoalState, StreamEvent, TokenUsage } from './types'
import type { EngineId } from './engines'

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
/**
 * A face's expression. Most are derived from what the worker is doing
 * (workerMood); a worker can also pick one for a while with set_status
 * (HINT_MOODS in the engine).
 */
export type WorkerMood =
  | 'neutral'
  | 'happy'
  | 'excited'
  | 'serious'
  | 'curious'
  | 'surprised'
  | 'sad'
  | 'angry'
  | 'sleepy'
  | 'asleep'
  | 'dead'

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
  /** The latest runs, newest last (at most 20). Each run's full receipt is in the worker's executions. */
  runs: { at: number; ok: boolean }[]
  /** The thread its runs go in, made on its first run. */
  threadId?: string
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
  /** The user made this message the worker's goal (Goal in the composer's + menu). */
  goal?: boolean
  /** Colleagues the user @mentioned in it, who were each sent their own copy. */
  mentions?: { id: string; name: string }[]
  /** On a mentioned colleague's copy: the worker the user was writing to. */
  via?: { workerId: string; name: string }
  /** Posted in a group chat this worker is in; replies go back to the room. */
  room?: { id: string; name: string }
  /** What was said in the room since this worker last saw it, oldest first. */
  roomContext?: string
  /** The sender's recent thread, shared so the recipient needn't ask (message_worker / hand_off share_context). */
  context?: string
  /** Background the sender wrote for the recipient (hand_off context): only what it chose to share. */
  brief?: string
  /**
   * The most the sender itself was allowed to do when it wrote this (its
   * access, lowered by whoever handed it the job). The turn this lands in
   * runs at the weaker of that and the recipient's own access, so a look-only
   * worker can't get an autonomous colleague to make changes for it.
   */
  senderAccess?: WorkerAccess
  /** A task delegated to this worker; it reports back with finish_handoff. */
  handoff?: { id: string; task: string; requiredOutput?: string; deadlineAt?: number | null }
  /** A colleague finished (or failed, or dropped) a task this worker delegated. */
  handoffResult?: { id: string; task: string; ok: boolean; state?: DelegationState }
}

/**
 * A task one worker handed another before delegations existed (2026.6.1 and
 * earlier). Only read when migrating `workers.json`; see WorkerDelegation.
 */
export interface WorkerHandoff {
  id: string
  fromId: string
  fromName: string
  task: string
  at: number
}

/* ------------------------------------------------------------------ threads */

/** The thread every worker has: its ongoing conversation with the user. */
export const MAIN_THREAD = 'main'

/**
 * A conversation a worker has besides its main one. Each thread has its own
 * transcript, inbox, wake-up and running turn, so a routine, a task the user
 * started on the side, or a job a colleague delegated runs, fails and stops
 * on its own without touching the others. What the worker knows for good
 * (goal, notes, purpose) is shared by all of its threads; transcripts are not.
 *
 * The main thread's own fields (inbox, heartbeat, the running message) live
 * on the Worker itself, as they always have.
 */
export interface WorkerThreadInfo {
  id: string
  title: string
  /** `task`: the user started it. `routine`: one routine's runs. `delegation`: a colleague's job. */
  kind: 'task' | 'routine' | 'delegation'
  routineId?: string
  delegationId?: string
  createdAt: number
  updatedAt: number
  /** Finished: kept to read, takes no more wake-ups until someone writes to it. */
  closedAt: number | null
  /** Overrides the worker's model for this thread only. */
  model: { providerId: string; modelId: string } | null
  /**
   * The most this thread may do: a delegated job runs no more freely than the
   * worker that delegated it. Null for threads the user or the worker
   * started, which have the worker's own access.
   */
  accessCap: WorkerAccess | null
  inbox: WorkerMail[]
  heartbeat: WorkerHeartbeat
  /** The assistant message streaming right now; null when not running. */
  runningMessageId: string | null
  /** The engine session this thread continues, for workers on an agent engine (Codex). */
  engineSession: { engine: EngineId; sessionId: string } | null
  unread: number
  activity: string
  lastOutcome: { at: number; ok: boolean } | null
  lastError: string | null
}

/** The key a thread is stored and streamed under: the worker id for its main thread. */
export function threadKey(workerId: string, threadId: string = MAIN_THREAD): string {
  return threadId === MAIN_THREAD ? workerId : `${workerId}#${threadId}`
}

/* --------------------------------------------------------------- executions */

/**
 * Where one run of a worker stands. A run is queued when it is due but can't
 * start yet (every slot busy), running while its turn is going, and ends in
 * one of the rest. `interrupted` is a run Eaon quitting or crashing cut off;
 * `missed` an occurrence of a routine that didn't run (the previous run was
 * still going, or Eaon was closed through it).
 */
export type ExecutionState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'missed'

export type ExecutionTriggerKind = 'message' | 'mail' | 'heartbeat' | 'routine' | 'check-in' | 'goal' | 'delegation' | 'resume' | 'retry'

export interface ExecutionTrigger {
  kind: ExecutionTriggerKind
  /** "Your message", "Routine: Daily research", "Task from Nova". */
  label: string
  routineId?: string
  delegationId?: string
}

/**
 * A receipt for one run of a worker: what woke it, which thread it ran in,
 * how it went, how long it took and what it cost. Kept per worker (the most
 * recent MAX_EXECUTIONS) apart from the transcript, so a routine's history
 * reads "Daily research · Oct 4 · Completed · 3 min · 24k tokens" and opens
 * the message it wrote.
 */
export interface WorkerExecution {
  id: string
  workerId: string
  threadId: string
  trigger: ExecutionTrigger
  state: ExecutionState
  /** Why it is queued, or why it ended the way it did, in plain words. */
  reason: string | null
  queuedAt: number
  startedAt: number | null
  endedAt: number | null
  /** The reply it wrote in its thread. */
  messageId: string | null
  engine: EngineId
  providerId: string | null
  modelId: string | null
  usage: TokenUsage | null
  /**
   * Something that changes things outside the transcript ran (a command, a
   * file write, a click, a message sent). A run like that is never replayed
   * by itself after a crash: it may already have acted.
   */
  sideEffects: boolean
  /** The reply's last lines, short. */
  result: string | null
  error: string | null
  /** The run this one retries. */
  retryOf: string | null
}

/** Receipts kept per worker; older ones are dropped. */
export const MAX_EXECUTIONS = 200

/** `workers:execution` — a run was queued, started or ended. */
export interface WorkerExecutionEvent {
  workerId: string
  execution: WorkerExecution
}

/* -------------------------------------------------------------- delegations */

export type DelegationState = 'assigned' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'

/**
 * A job one worker delegated to another (hand_off), tracked as an object of
 * its own rather than as messages: the colleague works on it in a thread of
 * its own, the parent hears back with a structured result, and the user can
 * see "Nova delegated 'reproduce the login bug' to Vega · Vega completed it".
 * Only the context the parent wrote is shared, never its whole transcript.
 */
export interface WorkerDelegation {
  id: string
  parent: { workerId: string; name: string; threadId: string; executionId: string | null }
  recipient: { workerId: string; name: string; threadId: string | null }
  objective: string
  /** What the parent chose to tell the recipient: background, constraints. */
  context: string
  files: string[]
  /** What the parent wants back. */
  requiredOutput: string
  deadlineAt: number | null
  state: DelegationState
  result: string | null
  resultFiles: string[]
  failureReason: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
  /** When the parent's thread took the result into a run. */
  deliveredAt: number | null
  /** Workers from the first delegation down to this one's parent, to refuse cycles. */
  chain: string[]
}

/** How deep delegations may nest (A → B → C → D), and how many may be open at once. */
export const MAX_DELEGATION_DEPTH = 3
export const MAX_OPEN_DELEGATIONS = 32

export const DELEGATION_LABEL: Record<DelegationState, string> = {
  assigned: 'Assigned',
  running: 'Working on it',
  waiting: 'Waiting',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled'
}

/** `workers:delegations` — the open and recent delegations, whole. */
export type WorkerDelegationsEvent = WorkerDelegation[]

/**
 * A group chat: the user and several workers in one shared conversation.
 * The user's posts reach every member (or only the ones @mentioned); a
 * worker's post wakes only the colleagues it @mentions, so a room can't
 * talk itself into a loop. Each member also gets what was said since it
 * last looked, so nobody has to copy context between bots.
 */
export interface WorkerRoom {
  id: string
  name: string
  /** Worker ids. */
  members: string[]
  createdAt: number
  lastAt: number
  /** Posts since the user last opened the room. */
  unread: number
}

export interface RoomPost {
  id: string
  roomId: string
  /** 'user', or the id of the worker that posted. */
  from: string
  fromName: string
  fromColor?: string
  text: string
  files: string[]
  at: number
  /** Worker ids the post @mentioned. */
  mentions?: string[]
}

/** `workers:room-post` — a post was added to a room. */
export interface RoomPostEvent {
  roomId: string
  post: RoomPost
}

/** What the New team dialog sends: specialists to create, existing workers to add, and the first message to them. */
export interface TeamDraftInput {
  name: string
  roles: { role: string; purpose: string; personality: string; color?: string; name?: string }[]
  memberIds?: string[]
  kickoff?: string
}

/** A specialist the New team dialog (and the chat agent's team tool) can create. */
export interface WorkerTemplate {
  id: string
  role: string
  purpose: string
  personality: string
  color: string
}

export const WORKER_TEMPLATES: WorkerTemplate[] = [
  {
    id: 'researcher',
    role: 'Researcher',
    purpose: 'Finds and checks information: searches the web, reads sources and docs, and reports findings with links, clearly separating facts from guesses.',
    personality: 'Inquisitive and thorough. Digs until it understands why.',
    color: '#3E86C6'
  },
  {
    id: 'writer',
    role: 'Writer',
    purpose: 'Turns notes and findings into clear writing: drafts, edits and polishes documents, posts, emails and docs in the requested voice.',
    personality: 'Warm and precise. Cuts filler and keeps the reader in mind.',
    color: '#D6509B'
  },
  {
    id: 'coder',
    role: 'Coder',
    purpose: 'Writes and changes code: implements features, fixes bugs, runs the tests and explains what changed.',
    personality: 'Methodical and pragmatic. Tests before calling anything done.',
    color: '#5B6CF0'
  },
  {
    id: 'bug-reproducer',
    role: 'Bug Reproducer',
    purpose: 'Reproduces reported bugs: works out exact steps, environment and expected vs actual behaviour, writes a minimal repro, and hands it to whoever fixes it.',
    personality: 'Meticulous and skeptical. Trusts only what it can make happen again.',
    color: '#E4574B'
  },
  {
    id: 'reviewer',
    role: 'Reviewer',
    purpose: 'Reviews work from colleagues: checks code, writing and plans for mistakes, gaps and risks, and gives specific, actionable feedback.',
    personality: 'Blunt but fair. Points at the problem and the fix.',
    color: '#EE8A36'
  },
  {
    id: 'analyst',
    role: 'Data Analyst',
    purpose: 'Works with data: cleans files, runs analyses, makes charts and summarises what the numbers say and how sure it is.',
    personality: 'Calm and numerate. Shows its working.',
    color: '#22A7A0'
  },
  {
    id: 'designer',
    role: 'Designer',
    purpose: 'Designs interfaces and visuals: layouts, mockups, copy for UI, and critiques of existing screens.',
    personality: 'Curious and opinionated about craft, open to other views.',
    color: '#8E5CE6'
  },
  {
    id: 'planner',
    role: 'Project Lead',
    purpose: 'Breaks a goal into tasks, hands them to the right colleagues, follows up, and pulls the results together for the user.',
    personality: 'Steady and organised. Keeps everyone moving and the user informed.',
    color: '#3FAE6A'
  }
]

/** What the composer sends with a message, besides its text and files. */
/**
 * A worker's goal run. `iterations` counts the times it was sent back to
 * work within turns, `turns` the turns spent on it. `pausedByUser` tells a
 * pause the user asked for (which waits for them) from a turn's own limit
 * (after which the worker simply carries on in its next turn).
 */
export interface WorkerGoalRun extends GoalState {
  startedAt: number
  turns: number
  pausedByUser?: boolean
  /**
   * When it next continues on its own, after a turn that left it unfinished.
   * Null while a turn is on it, and when the worker chose its own wake-up
   * (sleep or a heartbeat): that turn runs in goal mode too.
   */
  nextAt?: number | null
}

export interface WorkerSendOptions {
  /** Make this message the worker's goal, replacing the one it had. */
  goal?: boolean
  /** Which thread it is for; the main thread when absent. `'new'` starts a task thread. */
  threadId?: string
}

/**
 * The colleagues `text` @mentions by name, ignoring case, in the order they
 * first appear. A name counts only as a whole word after the @ ("@Nova",
 * "@nova," but not "@Novak"), and longer names are tried first, so "@Nova
 * Prime" is Nova Prime even when there is also a Nova. `selfId` is never
 * returned: mentioning the worker being written to changes nothing.
 */
export function mentionedWorkers<T extends Pick<Worker, 'id' | 'name'>>(text: string, workers: T[], selfId: string | null = null): T[] {
  const lower = text.toLowerCase()
  const byLength = [...workers].sort((a, b) => b.name.length - a.name.length)
  const found: { worker: T; at: number }[] = []
  const taken: [number, number][] = []
  for (const worker of byLength) {
    const needle = `@${worker.name.toLowerCase()}`
    let from = 0
    for (;;) {
      const at = lower.indexOf(needle, from)
      if (at === -1) break
      from = at + 1
      const end = at + needle.length
      const before = at === 0 ? '' : lower[at - 1]
      const after = lower[end] ?? ''
      if (before && /[\w@]/.test(before)) continue
      if (after && /[\w-]/.test(after)) continue
      if (taken.some(([s, e]) => at < e && end > s)) continue
      taken.push([at, end])
      if (!found.some((f) => f.worker.id === worker.id)) found.push({ worker, at })
      break
    }
  }
  return found
    .filter((f) => f.worker.id !== selfId)
    .sort((a, b) => a.at - b.at)
    .map((f) => f.worker)
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
  /** Pinned model; null follows the app's selected model. On an agent engine, the engine's model id (providerId is the engine). */
  model: { providerId: string; modelId: string } | null
  /**
   * What runs its turns: Eaon's own agent loop on any provider (`native`), or
   * an installed agent engine such as Codex, with that engine's own models.
   */
  engine: EngineId
  /** Reasoning effort for its turns; null follows the app's setting. */
  effort: EffortLevel | null
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
  /**
   * A goal the user set from the composer (Goal), which the worker works on
   * until it is done: its turns run in goal mode, and a turn that ends with
   * the goal unfinished is followed by another on its own. Null when there is
   * none; `goal` above is the worker's memory of it either way.
   */
  goalRun: WorkerGoalRun | null
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
  /** Mail waiting for the main thread's next turn, oldest first. */
  inbox: WorkerMail[]
  /** Thread messages that arrived since the user last looked at this worker, across all its threads. */
  unread: number
  /** The main thread's assistant message streaming right now; null when not running. */
  runningMessageId: string | null
  /** Group chats the running turns were woken by, so a room can show who is answering it. */
  runningRooms?: string[]
  /** The main thread's engine session, for a worker on an agent engine. */
  engineSession: { engine: EngineId; sessionId: string } | null
  /** Its other threads: tasks, routines, delegated jobs. */
  threads: WorkerThreadInfo[]
  /**
   * Set while a run is due but can't start yet, saying why ("4 workers are
   * already working"), so a waiting worker never just looks idle.
   */
  queued: string | null
}

export interface WorkerThread {
  workerId: string
  /** MAIN_THREAD, or a WorkerThreadInfo id. */
  threadId?: string
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
  engine?: EngineId
  /** Undefined keeps what is set; null follows the app. */
  effort?: EffortLevel | null
  access?: WorkerAccess
  /** Undefined keeps what is set; null stops the worker trading. */
  trading?: WorkerTrading | null
}

/** `workers:event` — a stream event from one worker's running turn. */
export interface WorkerStreamEvent {
  workerId: string
  /** Absent for the main thread. */
  threadId?: string
  event: StreamEvent
}

/** `workers:message` — a message was added to (or replaced in) a thread, whole. */
export interface WorkerMessageEvent {
  workerId: string
  /** Absent for the main thread. */
  threadId?: string
  message: ChatMessage
}

/** Hard ceiling on how many workers can exist at once. */
export const MAX_WORKERS = 16
/**
 * How many worker runs may go at the same time, across all workers and their
 * threads — a team of specialists works side by side. A run that is due when
 * every slot is busy is queued, and says so. Computer use still acts for one
 * run at a time (it has one pointer; see features/computer).
 */
export const WORKER_CONCURRENCY = 4
/** How many of those one worker may hold at once, so its routines can't starve its colleagues. */
export const MAX_RUNNING_PER_WORKER = 2
/** Threads a worker keeps besides its main one; the oldest finished ones are cleared past this. */
export const MAX_THREADS = 60
/**
 * A repeating wake-up the worker set for itself stops after firing this many
 * times with no word from the user in that thread — it was watching something
 * nobody is following any more — and the user is told once.
 */
export const STALE_WAKEUPS = 48
/** Group chats, and how many members one can have. */
export const MAX_ROOMS = 20
export const MAX_ROOM_MEMBERS = 8
/** Posts kept per room; older ones are dropped from the saved file. */
export const MAX_ROOM_POSTS = 500
/** At most this many routines per worker. */
export const MAX_ROUTINES = 20
/** Goal and notes are part of every prompt, so they stay short. */
export const MAX_GOAL_CHARS = 600
/**
 * A goal run continues on its own this soon after a turn that left it
 * unfinished (unless the worker chose to sleep longer), and pauses to check
 * in with the user after this many turns.
 */
export const GOAL_CONTINUE_MS = 60_000
export const GOAL_MAX_TURNS = 30
/** The longest a worker may sleep in one go (sleep tool). */
export const MAX_SLEEP_MINUTES = 24 * 60
export const MAX_NOTES_CHARS = 4000
/** A heartbeat can not come round faster than this. */
export const MIN_HEARTBEAT_MS = 60_000
/** A worker that wakes more often than this per hour is slowed down. */
export const MAX_TURNS_PER_HOUR = 60
/** How long the happy face lasts after a turn goes well. */
export const HAPPY_FOR_MS = 10 * 60_000
/** Awake with nothing scheduled for this long, a worker falls asleep. */
export const DOZE_AFTER_MS = 15 * 60_000
/** Idle this long with nothing scheduled and its eyes start to droop, before dozing off at DOZE_AFTER_MS. */
export const SLEEPY_AFTER_MS = 5 * 60_000

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
  // Waiting on the user's answer: an inquisitive look rather than a blank one.
  if (worker.asks.length > 0) return 'curious'
  if (worker.lastOutcome && now - worker.lastOutcome.at < HAPPY_FOR_MS) return worker.lastOutcome.ok ? 'happy' : 'sad'
  if (worker.status === 'asleep') return 'asleep'
  if (worker.heartbeat.nextAt === null && worker.inbox.length === 0) {
    const since = worker.lastRunAt ?? worker.createdAt
    if (now - since > DOZE_AFTER_MS) return 'asleep'
    if (now - since > SLEEPY_AFTER_MS) return 'sleepy'
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

/** How many of a worker's threads (main included) are running a turn right now. */
export function runningThreads(worker: Pick<Worker, 'runningMessageId' | 'threads'>): number {
  return (worker.runningMessageId ? 1 : 0) + (worker.threads ?? []).filter((t) => t.runningMessageId).length
}

export function describeWorker(worker: Worker, now = Date.now()): string {
  if (worker.paused) return 'Paused'
  const running = runningThreads(worker)
  if (worker.status === 'working' || running > 0) {
    const line = worker.activity || 'Working…'
    return running > 1 ? `${line} · ${running} tasks running` : line
  }
  if (worker.queued) return `Queued — ${worker.queued}`
  if (worker.status === 'failed') return worker.lastError ? `Stopped: ${worker.lastError}` : 'Last task failed'
  if (worker.asks?.length) return worker.asks.length === 1 ? 'Has a question for you' : `Has ${worker.asks.length} questions for you`
  const waiting = worker.inbox.length + (worker.threads ?? []).reduce((n, t) => n + t.inbox.length, 0)
  if (waiting > 0) return `${waiting} message${waiting === 1 ? '' : 's'} waiting`
  const beats = [worker.heartbeat, ...(worker.threads ?? []).filter((t) => !t.closedAt).map((t) => t.heartbeat)].filter((h) => h.nextAt !== null)
  const beat = beats.sort((a, b) => a.nextAt! - b.nextAt!)[0]
  if (beat) {
    const every = beat.everyMs ? ` · every ${Math.round(beat.everyMs / 60_000)} min` : ''
    return `Next heartbeat ${relativeTime(beat.nextAt!, now)}${every}`
  }
  const routine = nextRoutine(worker)
  if (routine) return `${routine.name} ${relativeTime(routine.nextAt, now)}`
  if (worker.lastRunAt === null) return 'Ready for its first job'
  return worker.activity || 'Asleep — wakes when you message it'
}
