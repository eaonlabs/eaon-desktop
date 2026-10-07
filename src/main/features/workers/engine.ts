import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import type { ChatMessage, GoalState, Settings, StreamEvent, TokenUsage } from '@shared/types'
import type { EngineId } from '@shared/engines'
import {
  GOAL_CONTINUE_MS,
  MAIN_THREAD,
  MAX_RUNNING_PER_WORKER,
  MAX_THREADS,
  STALE_WAKEUPS,
  threadKey,
  GOAL_MAX_TURNS,
  MAX_GOAL_CHARS,
  MAX_SLEEP_MINUTES,
  MAX_NOTES_CHARS,
  MAX_ROOM_MEMBERS,
  MAX_ROOM_POSTS,
  MAX_ROOMS,
  MAX_ROUTINES,
  MAX_TURNS_PER_HOUR,
  MAX_WORKERS,
  MIN_HEARTBEAT_MS,
  nextRoutineAt,
  WORKER_COLORS,
  WORKER_CONCURRENCY,
  describeWorker,
  mentionedWorkers,
  relativeTime,
  TRADING_ROUTINE_NAME,
  type Worker,
  type WorkerDraft,
  type WorkerRoutine,
  type WorkerAccess,
  type WorkerTrading,
  type WorkerHeartbeat,
  type WorkerAsk,
  type WorkerMail,
  type WorkerMood,
  type WorkerGoalRun,
  type WorkerSendOptions,
  type WorkerThread,
  type RoomPost,
  type WorkerHandoff,
  type WorkerRoom,
  type WorkerTemplate,
  type WorkerThreadInfo,
  type WorkerExecution,
  type ExecutionTrigger,
  type WorkerDelegation
} from '@shared/workers'
import type { GuestAccess } from '@shared/channels'
import type { TurnOrigin } from '../../agent/policy'
import { summariseReply } from '../scheduler/transcript'
import type { TradingVenue } from '../trading/access'
import { isOpen, nextOpen } from '../trading/marketHours'
import { guestCap } from './guests'
import { workerPersona } from './prompt'
import { buildTurnMessage, CHECK_IN_NOTE, RESUME_NOTE, RETRY_NOTE, runWorkerTurn, type RunAgent, type RunEngineTurn, type TurnOutcome } from './runner'
import { ExecutionLog, isEnded } from './executions'
import { delegationRefusal, isOpenDelegation, normalizeDelegations, pruneDelegations } from './delegations'
import { watchFor, type WakeCondition } from './watch'
import { copyTree, sizeOf, transferRefusal, type TransferProgress } from './transfer'
import { approvalKey } from '../../agent/approvalKey'
import { weakerAccess } from '@shared/channels'
import { currentZone } from '../../timezone'

/** How a tool follows a file transfer: its stop button, and a line of progress. */
export interface TransferWatch {
  signal?: AbortSignal
  onProgress?: (progress: TransferProgress) => void
}

/**
 * When worker turns run, and everything that changes a worker.
 *
 * The engine owns the workers and their threads. A worker is due when it has
 * mail, when the user asked it to check in, or when its heartbeat comes due;
 * one timer is armed for the soonest heartbeat and a 30-second tick (plus a
 * resume hook in the service) re-checks everything, because timers alone do
 * not survive sleep. At most `concurrency` turns run at once, oldest-waiting
 * first, and a worker never runs two turns at once — mail that arrives
 * mid-turn waits in its inbox for the next one.
 *
 * Wake-ups the worker caused itself (heartbeats, a colleague's mail) are
 * budgeted per hour so two workers cannot talk each other into a loop that
 * burns tokens all night; the user's own mail and "Wake now" always go
 * through. A heartbeat missed while Eaon was closed runs once on return,
 * never as a burst.
 *
 * Everything outside the process (storage, the renderer, the model) is
 * injected, so tests drive it without Electron.
 */

export interface WorkersDeps {
  runAgent: RunAgent
  /** Runs a turn on an agent engine (Codex) instead of Eaon's own loop. */
  runEngineTurn?: RunEngineTurn
  getSettings: () => Settings
  loadWorkers: () => unknown
  saveWorkers: (workers: Worker[]) => void
  /** A thread's transcript, by `threadKey` (the worker id for its main thread). */
  loadThread: (key: string) => unknown
  saveThread: (thread: WorkerThread) => void
  deleteThread: (key: string) => void | Promise<void>
  /** Run receipts, per worker (executions.ts). */
  loadRuns?: (workerId: string) => unknown
  saveRuns?: (workerId: string, runs: WorkerExecution[]) => void
  deleteRuns?: (workerId: string) => void | Promise<void>
  onExecution?: (execution: WorkerExecution) => void
  /** Delegations between workers, all in one file. */
  loadDelegations?: () => unknown
  saveDelegations?: (delegations: WorkerDelegation[]) => void
  onDelegations?: (delegations: WorkerDelegation[]) => void
  /**
   * The whole list, on every metadata change (never per token). It is the
   * live list, not a copy — copying a big team on every change cost more than
   * saving it — so a listener must serialise or copy what it keeps before it
   * returns (sending it to a window does).
   */
  onChange?: (workers: Worker[]) => void
  onEvent?: (workerId: string, event: StreamEvent, threadId: string) => void
  /** A message was added to, or replaced whole in, a thread. */
  onMessage?: (workerId: string, message: ChatMessage, threadId: string) => void
  /** A turn the user started (mail or "Wake now") ended. */
  notify?: (worker: Worker, outcome: { ok: boolean; text: string }) => void
  /** A worker reached out on its own (notify_user) or asked the user something (ask_user). */
  reachOut?: (worker: Worker, message: { title: string; body: string }) => void
  /** Stops a running turn's goal loop at its next step (agent/loop `pauseGoal`); the user paused the goal. */
  pauseGoal?: (messageId: string) => void
  /** Describes a trading worker's account for its prompt (features/trading/access). */
  tradingVenue?: (via: string) => TradingVenue | null
  /** Group chats: where they are kept, and who is told when they change. */
  loadRooms?: () => unknown
  saveRooms?: (data: RoomsFile) => void
  onRoomsChange?: (rooms: WorkerRoom[]) => void
  onRoomPost?: (roomId: string, post: RoomPost) => void
  now?: () => number
  stallMs?: number
  maxTurnsPerHour?: number
  concurrency?: number
  /** The current IANA time zone (default: the machine's, kept current across a change of zone). */
  zone?: () => string
}

/**
 * Something outside the engine following workers — the chat apps
 * (features/channels) post replies, show typing and forward questions
 * through this. Every call gets clones; a listener that throws is logged
 * and skipped.
 */
export interface WorkerObserver {
  /** A turn began; `mail` is what woke it. */
  turnStarted?: (worker: Worker, mail: WorkerMail[]) => void
  /** A turn ended and was recorded. `reply` is the assistant message it wrote. */
  turnEnded?: (worker: Worker, turn: { mail: WorkerMail[]; reply: ChatMessage; error?: string; cancelled: boolean }) => void
  /** The worker asked the user something (ask_user). */
  asked?: (worker: Worker, ask: WorkerAsk) => void
  /** The worker reached out on its own (notify_user). */
  notified?: (worker: Worker, message: { title: string; body: string }) => void
}

/** What `worker-rooms.json` holds. `seen` is, per room, when each member last caught up. */
export interface RoomsFile {
  rooms: WorkerRoom[]
  posts: Record<string, RoomPost[]>
  seen: Record<string, Record<string, number>>
}

/** A new team: specialists to create (from templates or written out), colleagues to add, and a first message. */
export interface TeamDraft {
  name: string
  roles: (Pick<WorkerTemplate, 'role' | 'purpose' | 'personality'> & { color?: string; name?: string })[]
  /** Existing workers to add to the team's group chat. */
  memberIds?: string[]
  kickoff?: string
  model?: { providerId: string; modelId: string } | null
}

interface Running {
  workerId: string
  /** MAIN_THREAD or a WorkerThreadInfo id. */
  threadId: string
  execution: WorkerExecution
  controller: AbortController
  messageId: string
  /** The turn ran in goal mode, for the worker's goal run. */
  goalTurn: boolean
  /** What woke this turn, for observers. */
  mail: WorkerMail[]
  /** A guest's message is in this turn: the most it may do (see guests.ts). */
  guestCap: GuestAccess | null
  /** The heartbeat this turn used up, if it was due; null when mail alone woke it. */
  fired: WorkerHeartbeat | null
  /** Routines that came due and ran in this turn. */
  firedRoutines: string[]
  /** Set by the worker's own tools during the turn. */
  activitySet: boolean
  heartbeatSet: boolean
  /** The user's mail or "Wake now" started it — worth a notification. */
  userTriggered: boolean
  stoppedByUser: boolean
  /** Rooms the worker posted to itself this turn (post_to_room); its reply isn't posted there again. */
  postedRooms: Set<string>
  /** What the run may do: the worker's access, lowered by a delegating colleague's or a thread's cap. */
  access: WorkerAccess
  /** Who the work in this run came from, for spending (agent/policy TurnOrigin). */
  origin: TurnOrigin
  /** A routine this run is for (its own thread). */
  routineId: string | null
  /** A delegated job this run works on (its own thread). */
  delegationId: string | null
  /** The delegated job this run finished with finish_handoff, if it did. */
  reported: boolean
  /** The run asked the user something (ask_user) and is waiting on the answer. */
  asked: boolean
  /** The user's mail woke it (for the stale wake-up count). */
  fromUser: boolean
}

/** What a thread needs to run. The main thread's live on the Worker itself. */
type Slot = Pick<WorkerThreadInfo, 'inbox' | 'heartbeat' | 'runningMessageId' | 'engineSession'>

/** The key a run is tracked under while it goes. */
const slotKey = (workerId: string, threadId: string): string => `${workerId}#${threadId}`

const TICK_MS = 30_000
/** setTimeout's ceiling; a longer delay overflows and fires at once. */
const MAX_DELAY = 2 ** 31 - 1
const HOUR = 60 * 60_000
const DAY = 24 * HOUR
const MAX_HEARTBEAT_MS = 7 * DAY
/** Summarised messages beyond this many are dropped from the stored thread. */
const THREAD_KEEP = 300
const MAX_SENDS_PER_HOUR = 30
const MAX_CREATED_PER_DAY = 2
const MAX_TRANSFER_BYTES = 500 * 1024 * 1024
const HINT_MS = 30 * 60_000
const MAX_OPEN_HANDOFFS = 20
/** The placeholder thread id a due routine has until its first run makes it a thread. */
const ROUTINE_SLOT = 'routine:'
/** Workers may wake each other this many times in a room before the user posts again. */
export const MAX_ROOM_CHAIN = 8
/** Room context and shared thread excerpts stay small: they go into a prompt. */
const CONTEXT_CHARS = 4000
const POST_CHARS = 8000
/** Moods a worker may pick with set_status. The rest (sleepy, asleep, dead) describe its state and are only derived. */
export const HINT_MOODS: WorkerMood[] = ['neutral', 'happy', 'excited', 'serious', 'curious', 'surprised', 'sad', 'angry']

const clone = <T>(value: T): T => structuredClone(value)
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/**
 * A file-system-safe folder name from a worker's name: "Data Wrangler" →
 * "Data-Wrangler". Safe on Windows too, which refuses a name ending in a dot
 * and reads CON, NUL, COM1 and the like as devices, not folders.
 */
export function workerSlug(name: string): string {
  const slug =
    name
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/^[.-]+/, '')
      .slice(0, 48)
      .replace(/\.+$/, '') || 'Worker'
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(slug) ? `_${slug}` : slug
}

function isWorkerLike(value: unknown): value is Partial<Worker> & { id: string; name: string } {
  const v = value as Partial<Worker> | null
  return Boolean(v && typeof v.id === 'string' && typeof v.name === 'string')
}

/**
 * A worker's trading set-up, cleaned. `strict` is for the editor's draft:
 * a set-up with nowhere to trade is an error there, and dropped on load.
 */
function normalizeTrading(raw: unknown, strict = false): WorkerTrading | null {
  const v = raw as Partial<WorkerTrading> | null | undefined
  if (!v || typeof v !== 'object') return null
  const via = str(v.via)
  if (!via) {
    if (strict) throw new Error('Pick where the worker trades: the trading desk, or a connected broker.')
    return null
  }
  const every = typeof v.everyMinutes === 'number' && Number.isFinite(v.everyMinutes) ? Math.round(v.everyMinutes) : 15
  return {
    via,
    strategy: str(v.strategy).slice(0, 2000),
    everyMinutes: Math.min(Math.max(every, 1), 240),
    autoPlace: v.autoPlace === true
  }
}

/**
 * When a routine next runs after `after`: `nextRoutineAt`, moved to just
 * after the next opening bell for one that only runs while the US market is
 * open — no wake-ups through the night, the weekend or a holiday.
 */
export function routineNextAt(routine: Pick<WorkerRoutine, 'everyMs' | 'daily' | 'marketHours'>, after: number): number {
  const next = nextRoutineAt(routine, after)
  if (!routine.marketHours || isOpen(next)) return next
  return nextOpen(next) + 60_000
}

/** A saved goal run, or null for anything that isn't one. */
function normalizeGoalRun(raw: unknown): WorkerGoalRun | null {
  if (!raw || typeof raw !== 'object') return null
  const g = raw as Partial<WorkerGoalRun>
  if (typeof g.text !== 'string' || !g.text.trim()) return null
  const status = g.status === 'achieved' || g.status === 'blocked' || g.status === 'paused' ? g.status : 'active'
  return {
    text: g.text,
    status,
    iterations: typeof g.iterations === 'number' ? g.iterations : 0,
    startedAt: typeof g.startedAt === 'number' ? g.startedAt : 0,
    turns: typeof g.turns === 'number' ? g.turns : 0,
    nextAt: typeof g.nextAt === 'number' ? g.nextAt : null,
    ...(typeof g.summary === 'string' ? { summary: g.summary } : {}),
    ...(g.pausedByUser === true ? { pausedByUser: true } : {})
  }
}

/**
 * An active goal run with nothing scheduled to pick it up (Eaon quit
 * mid-turn, say) continues shortly after Eaon starts.
 */
function resumeGoalRun(run: WorkerGoalRun | null, heartbeatAt: unknown, now: number): WorkerGoalRun | null {
  if (!run || run.status !== 'active' || typeof run.nextAt === 'number' || typeof heartbeatAt === 'number') return run
  return { ...run, nextAt: now + GOAL_CONTINUE_MS }
}

const STATUSES: Worker['status'][] = ['idle', 'working', 'asleep', 'paused', 'failed']
const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

function normalizeHeartbeat(raw: unknown): WorkerHeartbeat {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<WorkerHeartbeat>
  return { nextAt: finite(v.nextAt), everyMs: finite(v.everyMs), note: typeof v.note === 'string' ? v.note : '' }
}

/** Mail that can still be read; anything without an id, a sender or text is dropped. */
function normalizeInbox(raw: unknown): WorkerMail[] {
  return (Array.isArray(raw) ? raw : []).filter(
    (m): m is WorkerMail => !!m && typeof m.id === 'string' && typeof m.from === 'string' && typeof m.text === 'string'
  ).map((m) => ({ ...m, fromName: typeof m.fromName === 'string' ? m.fromName : 'Someone', files: Array.isArray(m.files) ? m.files.filter((f) => typeof f === 'string') : [], at: finite(m.at) ?? 0 }))
}

const pinned = (raw: unknown): { providerId: string; modelId: string } | null => {
  const v = raw as { providerId?: unknown; modelId?: unknown } | null
  return v && typeof v.providerId === 'string' && typeof v.modelId === 'string' && v.providerId && v.modelId ? { providerId: v.providerId, modelId: v.modelId } : null
}

const session = (raw: unknown): WorkerThreadInfo['engineSession'] => {
  const v = raw as { engine?: unknown; sessionId?: unknown } | null
  return v && v.engine === 'codex' && typeof v.sessionId === 'string' && v.sessionId ? { engine: 'codex', sessionId: v.sessionId } : null
}

function normalizeThreadInfo(raw: unknown, now: number): WorkerThreadInfo | null {
  const v = raw as Partial<WorkerThreadInfo> | null
  if (!v || typeof v.id !== 'string' || !v.id || v.id === MAIN_THREAD) return null
  const kind = v.kind === 'routine' || v.kind === 'delegation' ? v.kind : 'task'
  return {
    id: v.id,
    title: typeof v.title === 'string' && v.title.trim() ? v.title : 'Task',
    kind,
    ...(typeof v.routineId === 'string' ? { routineId: v.routineId } : {}),
    ...(typeof v.delegationId === 'string' ? { delegationId: v.delegationId } : {}),
    createdAt: finite(v.createdAt) ?? now,
    updatedAt: finite(v.updatedAt) ?? now,
    closedAt: finite(v.closedAt),
    model: pinned(v.model),
    accessCap: v.accessCap === 'read-only' || v.accessCap === 'safe' || v.accessCap === 'autonomous' ? v.accessCap : null,
    inbox: normalizeInbox(v.inbox),
    heartbeat: normalizeHeartbeat(v.heartbeat),
    runningMessageId: typeof v.runningMessageId === 'string' ? v.runningMessageId : null,
    engineSession: session(v.engineSession),
    unread: finite(v.unread) ?? 0,
    activity: typeof v.activity === 'string' ? v.activity : '',
    lastOutcome: v.lastOutcome && typeof v.lastOutcome.at === 'number' ? { at: v.lastOutcome.at, ok: v.lastOutcome.ok === true } : null,
    lastError: typeof v.lastError === 'string' ? v.lastError : null
  }
}

/**
 * Fills in anything an older or hand-edited file lacks, and repairs what is
 * malformed rather than refusing the worker: an unknown status becomes idle,
 * unreadable mail is dropped, a broken thread entry is left out. Tasks
 * colleagues had handed this worker before delegations existed come back in
 * `legacyHandoffs`, for load() to turn into delegations.
 */
function normalize(raw: Partial<Worker> & { id: string; name: string; handoffs?: WorkerHandoff[] }, now: number): Worker & { legacyHandoffs?: WorkerHandoff[] } {
  const heartbeat = normalizeHeartbeat(raw.heartbeat)
  const seenThreads = new Set<string>()
  const threads = (Array.isArray(raw.threads) ? raw.threads : [])
    .map((t) => normalizeThreadInfo(t, now))
    .filter((t): t is WorkerThreadInfo => {
      if (!t || seenThreads.has(t.id)) return false
      seenThreads.add(t.id)
      return true
    })
  const legacy = Array.isArray(raw.handoffs) ? raw.handoffs.filter((h) => h && typeof h.id === 'string' && typeof h.task === 'string') : []
  return {
    id: raw.id,
    name: raw.name,
    color: typeof raw.color === 'string' ? raw.color : WORKER_COLORS[0],
    personality: str(raw.personality),
    purpose: str(raw.purpose),
    createdAt: finite(raw.createdAt) ?? now,
    createdBy: typeof raw.createdBy === 'string' ? raw.createdBy : null,
    model: pinned(raw.model),
    engine: raw.engine === 'codex' ? 'codex' : 'native',
    effort: typeof raw.effort === 'string' ? raw.effort : null,
    folder: typeof raw.folder === 'string' ? raw.folder : '',
    paused: raw.paused === true,
    access: raw.access === 'read-only' || raw.access === 'autonomous' ? raw.access : 'safe',
    trading: normalizeTrading(raw.trading),
    heartbeat,
    routines: Array.isArray(raw.routines)
      ? raw.routines
          .filter((r) => r && typeof r.id === 'string' && typeof r.name === 'string' && typeof r.nextAt === 'number' && Number.isFinite(r.nextAt))
          .map((r) => ({ ...r, task: typeof r.task === 'string' ? r.task : '', runs: Array.isArray(r.runs) ? r.runs : [] }))
      : [],
    goal: typeof raw.goal === 'string' ? raw.goal : '',
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    goalRun: resumeGoalRun(normalizeGoalRun(raw.goalRun), heartbeat.nextAt, now),
    asks: Array.isArray(raw.asks) ? raw.asks.filter((a) => a && typeof a.id === 'string' && typeof a.question === 'string') : [],
    status: STATUSES.includes(raw.status as Worker['status']) ? (raw.status as Worker['status']) : 'idle',
    activity: typeof raw.activity === 'string' ? raw.activity : '',
    moodHint: raw.moodHint && typeof raw.moodHint.until === 'number' && typeof raw.moodHint.mood === 'string' ? raw.moodHint : null,
    lastRunAt: finite(raw.lastRunAt),
    lastOutcome: raw.lastOutcome && typeof raw.lastOutcome.at === 'number' ? { at: raw.lastOutcome.at, ok: raw.lastOutcome.ok === true } : null,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
    inbox: normalizeInbox(raw.inbox),
    unread: finite(raw.unread) ?? 0,
    runningMessageId: typeof raw.runningMessageId === 'string' ? raw.runningMessageId : null,
    runningRooms: [],
    engineSession: session(raw.engineSession),
    threads,
    queued: null,
    ...(legacy.length > 0 ? { legacyHandoffs: legacy } : {})
  }
}

/** Tool calls a quit or crash cut off would otherwise spin forever in the transcript. */
function sealInterrupted(message: ChatMessage | undefined): boolean {
  if (!message) return false
  let sealed = false
  for (const part of message.parts) {
    if (part.type === 'tool' && part.status === 'running') {
      part.status = 'error'
      delete part.progress
      sealed = true
    }
  }
  return sealed
}

/** `dir/name`, or `dir/name (2).ext` and so on when that is taken. */
function freePath(dir: string, name: string): string {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let candidate = join(dir, name)
  for (let n = 2; existsSync(candidate); n++) candidate = join(dir, `${stem} (${n})${ext}`)
  return candidate
}

/** The text of a message, tool calls named but not shown — for sharing a thread with a colleague. */
function messageText(message: ChatMessage): string {
  const out: string[] = []
  const tools: string[] = []
  for (const part of message.parts) {
    if (part.type === 'text' && part.text.trim()) out.push(part.text.trim())
    else if (part.type === 'tool') tools.push(part.name)
  }
  if (tools.length) out.push(`[used ${[...new Set(tools)].join(', ')}]`)
  return out.join('\n')
}

/** The answer a turn ended on: the text after its last tool call, without the narration before it. */
export function finalReply(message: ChatMessage): string {
  const parts: string[] = []
  for (let i = message.parts.length - 1; i >= 0; i--) {
    const part = message.parts[i]
    if (part.type === 'tool') break
    if (part.type === 'text') parts.unshift(part.text)
  }
  return parts.join('').trim()
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

function normalizeRooms(raw: unknown, workerIds: Set<string>): RoomsFile {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<RoomsFile>
  const rooms = (Array.isArray(v.rooms) ? v.rooms : [])
    .filter((r): r is WorkerRoom => !!r && typeof r.id === 'string' && typeof r.name === 'string')
    .map((r) => ({
      id: r.id,
      name: r.name,
      members: (Array.isArray(r.members) ? r.members : []).filter((m) => workerIds.has(m)),
      createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
      lastAt: typeof r.lastAt === 'number' ? r.lastAt : 0,
      unread: typeof r.unread === 'number' ? r.unread : 0
    }))
  const posts: Record<string, RoomPost[]> = {}
  const seen: Record<string, Record<string, number>> = {}
  for (const room of rooms) {
    const list = v.posts?.[room.id]
    posts[room.id] = Array.isArray(list) ? list.filter((p) => p && typeof p.id === 'string').slice(-MAX_ROOM_POSTS) : []
    seen[room.id] = v.seen?.[room.id] && typeof v.seen[room.id] === 'object' ? { ...v.seen[room.id] } : {}
  }
  return { rooms, posts, seen }
}

export class WorkersEngine {
  /** One-time approvals from answered `approve` questions, per worker. */
  private grants = new Map<string, { key: string; expires: number }[]>()
  private workers: Worker[] = []
  private roomsFile: RoomsFile = { rooms: [], posts: {}, seen: {} }
  /** Per room, how many times workers have woken each other since the user last posted there. */
  private readonly roomChains = new Map<string, number>()
  /** Transcripts loaded so far, by threadKey. */
  private readonly threads = new Map<string, WorkerThread>()
  /** Runs going now, by slotKey: one per thread at most, several per worker. */
  private readonly running = new Map<string, Running>()
  /** Runs due but waiting for a slot, by slotKey: their queued receipt. */
  private readonly waiting = new Map<string, WorkerExecution>()
  private readonly inflight = new Set<Promise<void>>()
  private readonly observers = new Set<WorkerObserver>()
  /** "Wake now" requests waiting for their turn, by worker id → when asked. */
  private readonly wakes = new Map<string, number>()
  /** Runs cut off by a quit with nothing to undo, to pick up again: slotKey → the interrupted receipt. */
  private readonly resumes = new Map<string, WorkerExecution>()
  /** Retries the user asked for: slotKey → the receipt being retried. */
  private readonly retries = new Map<string, WorkerExecution>()
  /** Start times of budgeted turns, per worker. */
  private readonly turnLog = new Map<string, number[]>()
  /** When each worker sent mail, for the per-hour cap. */
  private readonly sentLog = new Map<string, number[]>()
  /** Per slotKey, what a sleeping thread is waiting on besides the clock (a process, a file); stopped when it wakes. */
  private readonly watches = new Map<string, () => void>()
  /** Per slotKey, self-set wake-ups since the user last wrote in that thread (STALE_WAKEUPS). */
  private readonly unattendedWakes = new Map<string, number>()
  /** When workers created workers, for the per-day cap. */
  private createdLog: number[] = []
  private delegationList: WorkerDelegation[] = []
  private readonly runs: ExecutionLog
  private timer: ReturnType<typeof setTimeout> | null = null
  private interval: ReturnType<typeof setInterval> | null = null
  private started = false
  private disposed = false
  private readonly now: () => number

  constructor(private readonly deps: WorkersDeps) {
    this.now = deps.now ?? Date.now
    this.runs = new ExecutionLog({
      load: (id) => deps.loadRuns?.(id) ?? [],
      save: (id, list) => deps.saveRuns?.(id, list),
      remove: (id) => deps.deleteRuns?.(id),
      onChange: (execution) => deps.onExecution?.(execution),
      now: () => this.now()
    })
  }

  /* --------------------------------------------------------------- lifecycle */

  /**
   * Reads saved workers and repairs whatever a quit or crash cut short: a run
   * still marked running is recorded as interrupted, its transcript's spinning
   * tool calls are sealed, and — when it hadn't changed anything outside the
   * transcript — it is picked up again once the engine starts. A run that may
   * already have acted is left for the user to retry. Nothing runs until
   * `start()`.
   */
  load(): void {
    const now = this.now()
    const raw = this.deps.loadWorkers()
    const seen = new Set<string>()
    const loaded = (Array.isArray(raw) ? raw : [])
      .filter(isWorkerLike)
      .filter((w) => {
        // Two workers with one id would share a thread file; keep the first.
        if (seen.has(w.id)) return false
        seen.add(w.id)
        return true
      })
      .map((w) => normalize(w, now))
    this.workers = loaded.map(({ legacyHandoffs: _legacy, ...worker }) => worker)
    const ids = new Set(this.workers.map((w) => w.id))
    this.delegationList = normalizeDelegations(this.deps.loadDelegations?.() ?? [], ids, now)

    for (const worker of this.workers) {
      const interrupted = new Map(this.runs.recover(worker.id).map((e) => [e.threadId, e]))
      for (const { threadId, slot } of this.slotsOf(worker, true)) {
        const execution = interrupted.get(threadId)
        if (!slot.runningMessageId && !execution) continue
        const thread = this.thread(worker.id, threadId)
        const message = thread.messages.find((m) => m.id === slot.runningMessageId) ?? thread.messages[thread.messages.length - 1]
        if (sealInterrupted(message)) this.deps.saveThread(thread)
        slot.runningMessageId = null
        if (threadId === MAIN_THREAD) worker.lastError = 'Interrupted when Eaon quit'
        else this.info(worker, threadId)!.lastError = 'Interrupted when Eaon quit'
      }
      // Runs a quit or crash cut off are picked up again, once, when nothing
      // ran in their thread since and they hadn't changed anything outside
      // the transcript. One that may already have acted waits for the user's
      // Retry; one from long ago is left alone rather than surprising anyone.
      for (const { threadId } of this.slotsOf(worker, true)) {
        const latest = this.runs.latest(worker.id, threadId)
        if (!latest || latest.state !== 'interrupted' || latest.sideEffects || latest.trigger.kind === 'resume') continue
        if (now - (latest.endedAt ?? 0) > DAY) continue
        this.resumes.set(slotKey(worker.id, threadId), latest)
      }
      if (worker.paused) worker.status = 'paused'
      else if (worker.status === 'working') worker.status = 'idle'
    }

    // Tasks handed over before delegations existed become delegations worked
    // on in the recipient's main thread, where they already were.
    for (const { id, legacyHandoffs } of loaded) {
      for (const handoff of legacyHandoffs ?? []) {
        if (this.delegationList.some((d) => d.id === handoff.id)) continue
        const parent = this.find(handoff.fromId)
        const recipient = this.find(id)!
        this.delegationList.push({
          id: handoff.id,
          parent: { workerId: handoff.fromId, name: parent?.name ?? handoff.fromName, threadId: MAIN_THREAD, executionId: null },
          recipient: { workerId: id, name: recipient.name, threadId: MAIN_THREAD },
          objective: handoff.task,
          context: '',
          files: [],
          requiredOutput: '',
          deadlineAt: null,
          state: parent ? 'running' : 'cancelled',
          result: null,
          resultFiles: [],
          failureReason: parent ? null : `${handoff.fromName} was removed.`,
          createdAt: handoff.at,
          updatedAt: now,
          completedAt: parent ? null : now,
          deliveredAt: null,
          chain: [handoff.fromId]
        })
      }
    }
    this.createdLog = this.workers.filter((w) => w.createdBy !== null).map((w) => w.createdAt)
    this.deps.saveWorkers(this.workers)
    this.commitDelegations()
    this.roomsFile = normalizeRooms(this.deps.loadRooms?.() ?? null, ids)
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.disposed = false
    this.interval = setInterval(() => this.tick(), TICK_MS)
    // Electron keeps the process alive on its own; unref only matters to tests.
    this.interval.unref?.()
    this.tick()
  }

  /**
   * Stops everything, for quitting. Synchronous (it runs from before-quit),
   * so running turns are recorded as interrupted here rather than trusting
   * them to report back before the process goes.
   */
  stop(): void {
    this.started = false
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    if (this.interval) clearInterval(this.interval)
    this.timer = null
    this.interval = null
    for (const run of this.running.values()) {
      run.controller.abort()
      const worker = this.find(run.workerId)
      const thread = this.threads.get(threadKey(run.workerId, run.threadId))
      if (thread) {
        sealInterrupted(thread.messages.find((m) => m.id === run.messageId))
        this.deps.saveThread(thread)
      }
      this.runs.update(run.execution, {
        state: 'interrupted',
        reason: run.execution.sideEffects
          ? 'Eaon quit before it finished. It may already have acted, so it wasn’t restarted on its own.'
          : 'Eaon quit before it finished.'
      })
      if (worker) {
        const slot = this.slot(worker, run.threadId)
        if (slot) slot.runningMessageId = null
        worker.status = worker.paused ? 'paused' : 'idle'
        worker.runningRooms = []
        if (run.threadId === MAIN_THREAD) worker.lastError = 'Interrupted when Eaon quit'
      }
    }
    this.running.clear()
    for (const stop of this.watches.values()) stop()
    this.watches.clear()
    for (const execution of this.waiting.values()) this.runs.update(execution, { state: 'cancelled', reason: 'Eaon quit before it started.' })
    this.waiting.clear()
    for (const worker of this.workers) worker.queued = null
    this.deps.saveWorkers(this.workers)
  }

  /** Resolves once every turn in progress has finished and been recorded. */
  async whenIdle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all([...this.inflight])
  }

  /* ------------------------------------------------------------------ reads */

  list(): Worker[] {
    return clone(this.workers)
  }

  has(id: string): boolean {
    return this.workers.some((w) => w.id === id)
  }

  /** A thread's transcript: the main one by default. */
  getThread(id: string, threadId: string = MAIN_THREAD): WorkerThread {
    const worker = this.require(id)
    if (threadId !== MAIN_THREAD && !this.info(worker, threadId)) throw new Error('That thread no longer exists.')
    return clone(this.thread(id, threadId))
  }

  /** Whether any of the worker's threads — or one given thread — is running a turn. */
  isRunning(id: string, threadId?: string): boolean {
    if (threadId !== undefined) return this.running.has(slotKey(id, threadId))
    return [...this.running.values()].some((r) => r.workerId === id)
  }

  /** The guest cap of the main thread's turn running now, or null when none runs or no guest wrote. */
  turnCap(id: string): GuestAccess | null {
    return this.running.get(slotKey(id, MAIN_THREAD))?.guestCap ?? null
  }

  /** A worker's run receipts, newest last. */
  executions(id: string): WorkerExecution[] {
    this.require(id)
    return clone(this.runs.list(id))
  }

  /** Every delegation still open, and the recent finished ones. */
  delegations(): WorkerDelegation[] {
    return clone(this.delegationList)
  }

  /** Follows turns, questions and reach-outs. Returns the way to stop. */
  observe(observer: WorkerObserver): () => void {
    this.observers.add(observer)
    return () => this.observers.delete(observer)
  }

  /* --------------------------------------------------------------- commands */

  /** Creates a worker, or updates the one `draft.id` names. Throws a user-facing message when the draft is invalid. */
  save(draft: WorkerDraft, createdBy: string | null = null): Worker {
    const name = str(draft.name).replace(/\s+/g, ' ')
    if (!name) throw new Error('Give the worker a name.')
    if (name.length > 40) throw new Error('Keep the name to 40 characters or fewer.')
    const existing = draft.id ? this.find(draft.id) : undefined
    if (draft.id && !existing) throw new Error('That worker no longer exists.')
    if (this.workers.some((w) => w.id !== existing?.id && w.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`There is already a worker called ${name}.`)
    }
    if (!existing && this.workers.length >= MAX_WORKERS) {
      throw new Error(`You can have up to ${MAX_WORKERS} workers. Remove one to make room for another.`)
    }
    const color = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(str(draft.color)) ? str(draft.color) : (existing?.color ?? this.freeColor())
    const engine: EngineId = draft.engine === 'codex' || draft.engine === 'native' ? draft.engine : (existing?.engine ?? 'native')
    let model =
      draft.model === undefined
        ? (existing?.model ?? null)
        : draft.model && str(draft.model.providerId) && str(draft.model.modelId)
          ? { providerId: str(draft.model.providerId), modelId: str(draft.model.modelId) }
          : null
    // A model belongs to an engine: switching engine without picking a model
    // falls back to that engine's default instead of sending one engine's
    // model name to the other.
    if (model && (engine === 'codex') !== (model.providerId === 'codex')) model = null
    const effort = draft.effort === undefined ? (existing?.effort ?? null) : draft.effort
    const access =
      draft.access === 'read-only' || draft.access === 'safe' || draft.access === 'autonomous' ? draft.access : (existing?.access ?? 'autonomous')
    const personality = str(draft.personality).slice(0, 600)
    const purpose = str(draft.purpose).slice(0, 2000)
    const trading = draft.trading === undefined ? (existing?.trading ?? null) : draft.trading === null ? null : normalizeTrading(draft.trading, true)

    if (existing) {
      // Another engine can't continue this one's sessions.
      if (existing.engine !== engine) {
        existing.engineSession = null
        for (const t of existing.threads) t.engineSession = null
      }
      Object.assign(existing, { name, color, personality, purpose, model, engine, effort, access, trading })
      this.syncTradingRoutine(existing)
      this.commit()
      return clone(existing)
    }

    const now = this.now()
    const folder = this.folderFor(name)
    mkdirSync(folder, { recursive: true })
    const worker: Worker = {
      id: randomUUID(),
      name,
      color,
      personality,
      purpose,
      createdAt: now,
      createdBy,
      model,
      engine,
      effort,
      folder,
      paused: false,
      access,
      trading,
      heartbeat: { nextAt: null, everyMs: null, note: '' },
      routines: [],
      goal: '',
      notes: '',
      goalRun: null,
      asks: [],
      // Awake and ready for its first job; `workerMood` lets it doze off after
      // DOZE_AFTER_MS with nothing to do, so a new worker does not greet the
      // user with its eyes shut.
      status: 'idle',
      activity: '',
      moodHint: null,
      lastRunAt: null,
      lastOutcome: null,
      lastError: null,
      inbox: [],
      unread: 0,
      runningMessageId: null,
      engineSession: null,
      threads: [],
      queued: null
    }
    this.syncTradingRoutine(worker)
    this.workers.push(worker)
    const thread: WorkerThread = { workerId: worker.id, messages: [], summary: null }
    this.threads.set(worker.id, thread)
    this.deps.saveThread(thread)
    this.commit()
    return clone(worker)
  }

  /**
   * Stops the worker's runs and forgets it: its threads, receipts and the
   * delegations it was part of (each other side is told). Its folder stays on
   * disk, and nothing of any other worker's is touched.
   */
  async remove(id: string): Promise<void> {
    const worker = this.find(id)
    if (!worker) return
    for (const run of this.running.values()) {
      if (run.workerId !== id) continue
      run.stoppedByUser = true
      run.controller.abort()
    }
    const keys = this.slotsOf(worker, true).map(({ threadId }) => threadId)
    for (const threadId of keys) {
      const key = slotKey(id, threadId)
      this.watches.get(key)?.()
      this.watches.delete(key)
      this.waiting.delete(key)
      this.resumes.delete(key)
      this.retries.delete(key)
      this.unattendedWakes.delete(key)
    }
    for (const delegation of this.delegationList) {
      if (!isOpenDelegation(delegation)) continue
      if (delegation.recipient.workerId === id) this.endDelegation(delegation, 'cancelled', `${worker.name} was removed.`)
      else if (delegation.parent.workerId === id) this.endDelegation(delegation, 'cancelled', `${worker.name}, who asked for it, was removed.`)
    }
    this.workers = this.workers.filter((w) => w.id !== id)
    for (const threadId of keys) this.threads.delete(threadKey(id, threadId))
    this.wakes.delete(id)
    this.turnLog.delete(id)
    this.sentLog.delete(id)
    this.grants.delete(id)
    if (this.roomsFile.rooms.some((r) => r.members.includes(id))) {
      for (const room of this.roomsFile.rooms) room.members = room.members.filter((m) => m !== id)
      this.commitRooms()
    }
    this.commit()
    this.commitDelegations()
    await Promise.all([...keys.map((threadId) => this.deps.deleteThread(threadKey(id, threadId))), this.runs.forget(id)])
  }

  /**
   * The user writes to a worker. It reads it as soon as that thread is free:
   * the main thread by default, another thread by id, or a new task thread
   * (`threadId: 'new'`) that runs beside everything else the worker does.
   *
   * Colleagues the message @mentions get their own copy, as they would in a
   * group chat: the user addressed them, so they hear it straight away
   * rather than only if this worker decides to pass it on. This worker is
   * told they have it, so it doesn't forward it again. Only the user's own
   * messages route this way; a guest's (channels, `receive`) never reach
   * other workers by naming them. Returns the thread it went to.
   */
  send(id: string, text: string, files: string[] = [], options: WorkerSendOptions = {}): { threadId: string } {
    const worker = this.require(id)
    const body = typeof text === 'string' ? text.trim() : ''
    const paths = (Array.isArray(files) ? files : []).filter((f): f is string => typeof f === 'string' && f.length > 0)
    if (!body && paths.length === 0) throw new Error('Write a message first.')
    const at = this.now()
    let threadId = typeof options?.threadId === 'string' && options.threadId ? options.threadId : MAIN_THREAD
    if (threadId === 'new') threadId = this.createThread(id, { title: body || 'New task', kind: 'task' }).id
    else if (threadId !== MAIN_THREAD && !this.info(worker, threadId)) throw new Error('That thread no longer exists.')
    const goal = threadId === MAIN_THREAD && options?.goal === true && body.length > 0
    if (goal) {
      worker.goal = body.slice(0, MAX_GOAL_CHARS)
      worker.goalRun = { text: worker.goal, status: 'active', iterations: 0, startedAt: at, turns: 0, nextAt: null }
    } else if (threadId === MAIN_THREAD && worker.goalRun?.status === 'blocked') {
      // The user answering is what a blocked goal was waiting for.
      const { summary: _summary, ...run } = worker.goalRun
      worker.goalRun = { ...run, status: 'active', nextAt: null }
    }
    const mentioned = mentionedWorkers(body, this.workers, worker.id)
    this.deliverMail(
      worker,
      {
        id: randomUUID(),
        from: 'user',
        fromName: 'You',
        text: body,
        files: paths,
        at,
        ...(goal ? { goal: true } : {}),
        ...(mentioned.length > 0 ? { mentions: mentioned.map((w) => ({ id: w.id, name: w.name })) } : {})
      },
      threadId
    )
    for (const colleague of mentioned) {
      this.deliverMail(colleague, {
        id: randomUUID(),
        from: 'user',
        fromName: 'You',
        text: body,
        files: paths,
        at,
        via: { workerId: worker.id, name: worker.name }
      })
    }
    this.commit()
    this.tick()
    return { threadId }
  }

  /**
   * Mail from a chat app (features/channels). The owner's arrives as the
   * user's (`from: 'user'`); anyone else's as a guest's, carrying the cap
   * that holds the turn it lands in. Always the main thread.
   */
  receive(id: string, mail: Omit<WorkerMail, 'id' | 'at'>): void {
    const worker = this.require(id)
    if (!mail.text.trim() && mail.files.length === 0) throw new Error('The message is empty.')
    this.deliverMail(worker, { ...mail, id: randomUUID(), at: this.now() })
    this.commit()
    this.tick()
  }

  /** Empties a thread's transcript and summary. Mail, wake-ups and settings stay. */
  clear(id: string, threadId: string = MAIN_THREAD): void {
    const worker = this.require(id)
    if (threadId !== MAIN_THREAD && !this.info(worker, threadId)) throw new Error('That thread no longer exists.')
    this.abortRun(id, threadId)
    const thread = this.thread(id, threadId)
    // In place: a turn still winding down holds this object, and must find
    // its message gone rather than write into a thread the user cleared.
    thread.messages.splice(0)
    thread.summary = null
    if (threadId === MAIN_THREAD) worker.unread = worker.threads.reduce((n, t) => n + t.unread, 0)
    else {
      const info = this.info(worker, threadId)!
      worker.unread = Math.max(0, worker.unread - info.unread)
      info.unread = 0
    }
    this.deps.saveThread(thread)
    this.commit()
  }

  /**
   * Starts a thread of its own beside the main one: a task the user wants
   * done on the side, a routine's runs, a colleague's delegated job. Past
   * MAX_THREADS, the oldest finished threads are cleared to make room.
   */
  createThread(
    id: string,
    input: { title: string; kind: WorkerThreadInfo['kind']; routineId?: string; delegationId?: string; model?: WorkerThreadInfo['model']; accessCap?: WorkerAccess | null }
  ): WorkerThreadInfo {
    const worker = this.require(id)
    const now = this.now()
    const info: WorkerThreadInfo = {
      id: randomUUID().slice(0, 12),
      title: clip(str(input.title).replace(/\s+/g, ' ') || 'Task', 80),
      kind: input.kind,
      ...(input.routineId ? { routineId: input.routineId } : {}),
      ...(input.delegationId ? { delegationId: input.delegationId } : {}),
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      model: input.model ?? null,
      accessCap: input.accessCap ?? null,
      inbox: [],
      heartbeat: { nextAt: null, everyMs: null, note: '' },
      runningMessageId: null,
      engineSession: null,
      unread: 0,
      activity: '',
      lastOutcome: null,
      lastError: null
    }
    worker.threads.push(info)
    const thread: WorkerThread = { workerId: id, threadId: info.id, messages: [], summary: null }
    this.threads.set(threadKey(id, info.id), thread)
    this.deps.saveThread(thread)
    this.trimThreads(worker)
    this.commit()
    return clone(info)
  }

  /** Marks a thread finished (it keeps its transcript), or reopens it. A running turn is stopped first. */
  closeThread(id: string, threadId: string, closed = true): void {
    const worker = this.require(id)
    const info = this.info(worker, threadId)
    if (!info) throw new Error('That thread no longer exists.')
    if (closed) {
      this.abortRun(id, threadId)
      info.closedAt = this.now()
      info.heartbeat = { nextAt: null, everyMs: null, note: '' }
      this.dropWaiting(id, threadId, 'The thread was closed.')
    } else {
      info.closedAt = null
    }
    this.commit()
  }

  /** Deletes a thread and its transcript. The main thread can only be cleared. */
  async removeThread(id: string, threadId: string): Promise<void> {
    const worker = this.require(id)
    if (threadId === MAIN_THREAD) throw new Error('The main thread can’t be deleted. Clear it instead.')
    const info = this.info(worker, threadId)
    if (!info) return
    this.abortRun(id, threadId)
    this.dropWaiting(id, threadId, 'The thread was deleted.')
    worker.unread = Math.max(0, worker.unread - info.unread)
    worker.threads = worker.threads.filter((t) => t.id !== threadId)
    for (const routine of worker.routines) if (routine.threadId === threadId) delete routine.threadId
    this.threads.delete(threadKey(id, threadId))
    this.commit()
    await this.deps.deleteThread(threadKey(id, threadId))
  }

  setPaused(id: string, paused: boolean): Worker {
    const worker = this.require(id)
    worker.paused = paused
    if (paused) {
      for (const run of this.running.values()) {
        if (run.workerId !== id) continue
        run.stoppedByUser = true
        run.controller.abort()
      }
      for (const { threadId } of this.slotsOf(worker, true)) this.dropWaiting(id, threadId, `${worker.name} was paused.`)
      worker.status = 'paused'
    } else if (!this.isRunning(id)) {
      worker.status = this.restingStatus(worker)
    }
    this.commit()
    if (!paused) this.tick()
    return clone(worker)
  }

  /** "Wake now": a check-in turn the user asked for, as soon as the main thread is free. */
  wake(id: string): void {
    const worker = this.require(id)
    if (worker.paused) throw new Error(`${worker.name} is paused. Resume it first.`)
    this.wakes.set(id, this.now())
    if (worker.status === 'asleep') worker.status = 'idle'
    this.commit()
    this.tick()
  }

  /** Stops one thread's running turn (the main one by default); the worker's other threads carry on. */
  stopTurn(id: string, threadId: string = MAIN_THREAD): void {
    this.abortRun(id, threadId)
  }

  /**
   * Runs a finished receipt's work again: the same thread is woken with a
   * note saying which run is being retried, so the model sees what happened
   * last time rather than a duplicate of the message that started it.
   */
  retry(id: string, executionId: string): void {
    const worker = this.require(id)
    const execution = this.runs.get(id, executionId)
    if (!execution) throw new Error('That run is no longer in the history.')
    if (!isEnded(execution.state)) throw new Error('That run hasn’t finished yet.')
    if (worker.paused) throw new Error(`${worker.name} is paused. Resume it first.`)
    if (execution.threadId !== MAIN_THREAD && !this.info(worker, execution.threadId)) throw new Error('The thread that run was in no longer exists.')
    const info = this.info(worker, execution.threadId)
    if (info?.closedAt) info.closedAt = null
    this.retries.set(slotKey(id, execution.threadId), execution)
    this.commit()
    this.tick()
  }

  /** Marks a thread (or every thread) as read. */
  markRead(id: string, threadId?: string): void {
    const worker = this.require(id)
    if (threadId === undefined) {
      if (worker.unread === 0 && worker.threads.every((t) => t.unread === 0)) return
      worker.unread = 0
      for (const t of worker.threads) t.unread = 0
    } else if (threadId === MAIN_THREAD) {
      const others = worker.threads.reduce((n, t) => n + t.unread, 0)
      if (worker.unread === others) return
      worker.unread = others
    } else {
      const info = this.info(worker, threadId)
      if (!info || info.unread === 0) return
      worker.unread = Math.max(0, worker.unread - info.unread)
      info.unread = 0
    }
    this.commit()
  }

  /* ------------------------------------------------ used by the worker tools */

  /** Everyone but `selfId`, as the model sees them. */
  colleagues(selfId: string): Worker[] {
    return clone(this.workers.filter((w) => w.id !== selfId))
  }

  /** A worker by id, or by name ignoring case. */
  lookup(nameOrId: string): Worker | undefined {
    const key = nameOrId.trim().toLowerCase()
    return this.workers.find((w) => w.id === nameOrId.trim()) ?? this.workers.find((w) => w.name.toLowerCase() === key)
  }

  /**
   * One worker writes to another. Files are copied into the recipient's
   * folder (`from-<sender>/`), so each worker only ever works in its own
   * folder, and the mail lists where they landed.
   */
  async message(
    fromId: string,
    to: string,
    text: string,
    files: string[] = [],
    options: {
      shareContext?: boolean
      /** The sender's thread whose recent messages to share (shareContext); the main one by default. */
      fromThreadId?: string
      /** Background the sender wrote for the recipient, shared instead of (or as well as) its thread. */
      brief?: string
      extra?: Partial<WorkerMail>
      /** The recipient's thread to deliver to; the main one by default. Returns false when it no longer exists. */
      toThreadId?: (senderAccess: WorkerAccess) => string
      transfer?: TransferWatch
    } = {}
  ): Promise<{ recipient: Worker; delivered: string[]; threadId: string }> {
    const sender = this.require(fromId)
    const target = this.lookup(to)
    if (!target) throw new Error(`There is no worker called "${to}". Use list_workers to see your colleagues.`)
    if (target.id === sender.id) throw new Error('That is you — message a colleague instead.')
    const body = text.trim()
    if (!body && files.length === 0) throw new Error('The message is empty.')
    const now = this.now()
    const sent = this.checkSendBudget(sender.id, now)
    const delivered = await this.copyFiles(sender, target, files, options.transfer)

    // The copy took time; either side may have been removed meanwhile.
    const recipient = this.find(target.id)
    const from = this.find(sender.id)
    if (!recipient) throw new Error(`${target.name} was removed while the files were being sent.`)
    this.sentLog.set(sender.id, [...sent, now])
    const context = options.shareContext ? this.threadExcerpt(sender.id, 10, CONTEXT_CHARS, options.fromThreadId ?? MAIN_THREAD) : ''
    const brief = str(options.brief).slice(0, CONTEXT_CHARS)
    const senderAccess = this.accessOf(sender, options.fromThreadId ?? MAIN_THREAD)
    let threadId = options.toThreadId?.(senderAccess) ?? MAIN_THREAD
    if (threadId !== MAIN_THREAD && !this.info(recipient, threadId)) threadId = MAIN_THREAD
    this.deliverMail(
      recipient,
      {
        id: randomUUID(),
        from: sender.id,
        fromName: from?.name ?? sender.name,
        fromColor: from?.color ?? sender.color,
        text: body,
        files: delivered,
        at: now,
        ...(context ? { context } : {}),
        ...(brief ? { brief } : {}),
        senderAccess,
        ...options.extra
      },
      threadId
    )
    this.commit()
    this.tick()
    return { recipient: clone(recipient), delivered, threadId }
  }

  /** Sends left in the hour, or a model-facing error when the cap is reached. */
  private checkSendBudget(id: string, now: number): number[] {
    const sent = (this.sentLog.get(id) ?? []).filter((at) => at > now - HOUR)
    if (sent.length >= MAX_SENDS_PER_HOUR) {
      throw new Error(`You have sent ${MAX_SENDS_PER_HOUR} messages in the last hour. Wait before sending more, and batch what you need into one message.`)
    }
    return sent
  }

  /**
   * Copies files from the sender into `<target>/from-<sender>/` and returns
   * where they landed. Nothing there is overwritten (a taken name gets a
   * number); credential stores are refused; a big transfer reports progress
   * and can be stopped, and a stopped or failed one leaves nothing behind.
   */
  private async copyFiles(sender: Worker, target: Worker, files: string[], transfer: TransferWatch = {}): Promise<string[]> {
    const sources = files.map((file) => (isAbsolute(file) ? file : resolve(sender.folder, file)))
    let total = 0
    for (const source of sources) {
      if (!existsSync(source)) throw new Error(`Cannot send ${source}: it does not exist.`)
      const refused = await transferRefusal(source)
      if (refused) throw new Error(refused)
      total += await sizeOf(source, MAX_TRANSFER_BYTES)
      if (total > MAX_TRANSFER_BYTES) throw new Error('Those files are over 500 MB together. Send a smaller set, or tell your colleague where to find them.')
    }
    const delivered: string[] = []
    if (sources.length === 0) return delivered
    const inboxDir = join(target.folder, `from-${workerSlug(sender.name)}`)
    await mkdir(inboxDir, { recursive: true })
    let done = 0
    try {
      for (const source of sources) {
        const dest = freePath(inboxDir, basename(source))
        delivered.push(dest)
        await copyTree(source, dest, {
          signal: transfer.signal,
          total,
          onProgress: transfer.onProgress ? (p) => transfer.onProgress!({ ...p, bytes: done + p.bytes }) : undefined
        })
        done += await sizeOf(dest, MAX_TRANSFER_BYTES)
      }
    } catch (error) {
      // All or nothing: the recipient never gets half a delivery.
      await Promise.all(delivered.map((path) => rm(path, { recursive: true, force: true }).catch(() => {})))
      throw error
    }
    return delivered
  }

  /**
   * The last `count` messages of a worker's thread as plain text — what the
   * user and colleagues told it, what it said, which tools it used — for a
   * colleague to read instead of being told everything again.
   */
  threadExcerpt(id: string, count: number, maxChars = CONTEXT_CHARS, threadId: string = MAIN_THREAD): string {
    const worker = this.require(id)
    const thread = this.thread(id, threadId)
    const lines: string[] = []
    for (const message of thread.messages.slice(-Math.max(1, Math.min(count, 40)))) {
      const text = messageText(message)
        // The turn's clock line is noise to anyone else.
        .replace(/^\[[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M\]\n?/, '')
        .trim()
      if (!text) continue
      lines.push(`${message.role === 'user' ? 'Incoming' : worker.name}: ${clip(text, 900)}`)
    }
    if (thread.summary && lines.length < count) lines.unshift(`(Earlier, summarised) ${clip(thread.summary.text, 800)}`)
    const joined = lines.join('\n\n')
    return joined.length > maxChars ? `…${joined.slice(-maxChars)}` : joined
  }

  /* -------------------------------------------------------------- delegations */

  /**
   * One worker delegates a job to another (hand_off). The job becomes a
   * delegation the user can follow, and the colleague works on it in a new
   * thread of its own — not in its main conversation — with the objective,
   * what to send back, a deadline if there is one, the context the parent
   * chose to share, and any files. Its result comes back to the parent's
   * thread as a structured message. Cycles (A → B → A), nesting deeper than
   * MAX_DELEGATION_DEPTH and too many open jobs are refused.
   */
  async handOff(
    fromId: string,
    to: string,
    task: string,
    files: string[] = [],
    options: { shareContext?: boolean; context?: string; requiredOutput?: string; deadlineMinutes?: number; fromThreadId?: string; transfer?: TransferWatch } = {}
  ): Promise<{ recipient: Worker; delegation: WorkerDelegation; delivered: string[] }> {
    const sender = this.require(fromId)
    const target = this.lookup(to)
    if (!target) throw new Error(`There is no worker called "${to}". Use list_workers to see your colleagues.`)
    const objective = task.trim()
    if (!objective) throw new Error('Say what the task is.')
    const fromThreadId = options.fromThreadId ?? MAIN_THREAD
    // The job the parent is itself working on, if it was delegated to it.
    const within = this.delegationOfThread(sender, fromThreadId)
    const chain = [...(within?.chain ?? []), sender.id]
    const refusal = delegationRefusal(this.delegationList, { parentId: sender.id, recipientId: target.id, recipientName: target.name, chain })
    if (refusal) throw new Error(refusal)
    const open = this.delegationList.filter((d) => isOpenDelegation(d) && d.recipient.workerId === target.id).length
    if (open >= MAX_OPEN_HANDOFFS) throw new Error(`${target.name} already has ${MAX_OPEN_HANDOFFS} open tasks. Wait for some to finish.`)
    const now = this.now()
    const minutes = typeof options.deadlineMinutes === 'number' && options.deadlineMinutes > 0 ? Math.min(options.deadlineMinutes, 7 * 24 * 60) : null
    const delegation: WorkerDelegation = {
      id: `task_${randomUUID().slice(0, 8)}`,
      parent: { workerId: sender.id, name: sender.name, threadId: fromThreadId, executionId: this.running.get(slotKey(sender.id, fromThreadId))?.execution.id ?? null },
      recipient: { workerId: target.id, name: target.name, threadId: null },
      objective: clip(objective, 2000),
      context: clip(str(options.context), CONTEXT_CHARS),
      files: [],
      requiredOutput: clip(str(options.requiredOutput), 600),
      deadlineAt: minutes ? now + minutes * 60_000 : null,
      state: 'assigned',
      result: null,
      resultFiles: [],
      failureReason: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      deliveredAt: null,
      chain
    }
    // Listed before the message goes, so the recipient's first run already
    // finds the job it is for; taken back out if sending is refused.
    this.delegationList.push(delegation)
    let sent: Awaited<ReturnType<WorkersEngine['message']>>
    try {
      sent = await this.message(fromId, target.id, objective, files, {
        shareContext: options.shareContext === true,
        fromThreadId,
        transfer: options.transfer,
        brief: delegation.context,
        extra: { handoff: { id: delegation.id, task: delegation.objective, requiredOutput: delegation.requiredOutput, deadlineAt: delegation.deadlineAt } },
        // Created only once the message is sure to go (the send budget and the
        // file copy can still refuse it), so a refused hand-off leaves no thread.
        toThreadId: (senderAccess) => {
          const live = this.find(target.id)
          if (!live) return MAIN_THREAD
          // The job runs no more freely than the worker that delegated it.
          const threadId = this.createThread(live.id, { title: delegation.objective, kind: 'delegation', delegationId: delegation.id, accessCap: senderAccess }).id
          delegation.recipient.threadId = threadId
          return threadId
        }
      })
    } catch (error) {
      this.delegationList = this.delegationList.filter((d) => d !== delegation)
      throw error
    }
    delegation.recipient.threadId = sent.threadId
    delegation.files = sent.delivered
    this.commitDelegations()
    return { recipient: sent.recipient, delegation: clone(delegation), delivered: sent.delivered }
  }

  /**
   * The recipient reports back on a delegated job: the result (and files) go
   * to the thread that delegated it, and the delegation ends as completed or
   * failed. A job can also be found by the thread working on it, so a worker
   * that forgot the id can still report.
   */
  async finishHandoff(byId: string, handoffId: string, result: string, files: string[] = [], ok = true, threadId?: string, transfer?: TransferWatch): Promise<string> {
    const worker = this.require(byId)
    const key = handoffId.trim()
    const mine = this.delegationList.filter((d) => d.recipient.workerId === byId && isOpenDelegation(d))
    const delegation = mine.find((d) => d.id === key) ?? (threadId ? this.delegationOfThread(worker, threadId) : undefined)
    if (!delegation || !isOpenDelegation(delegation)) {
      const open = mine.map((d) => `${d.id} (from ${d.parent.name})`).join(', ')
      throw new Error(`No open task "${handoffId}".${open ? ` Open tasks: ${open}.` : ' You have no open tasks.'}`)
    }
    const parent = this.find(delegation.parent.workerId)
    if (!parent) {
      this.endDelegation(delegation, 'cancelled', `${delegation.parent.name} no longer exists.`)
      return `Closed ${delegation.id}. ${delegation.parent.name} no longer exists, so the result went nowhere.`
    }
    const body = result.trim() || (ok ? 'Done.' : 'Could not finish it.')
    // Sent first: if sending fails (the hourly cap), the job stays open to try again.
    const { delivered } = await this.message(byId, parent.id, body, files, {
      extra: { handoffResult: { id: delegation.id, task: delegation.objective, ok, state: ok ? 'completed' : 'failed' } },
      toThreadId: () => delegation.parent.threadId,
      transfer
    })
    const run = [...this.running.values()].find((r) => r.workerId === byId && r.delegationId === delegation.id)
    if (run) run.reported = true
    this.settleDelegation(delegation, ok ? 'completed' : 'failed', { result: clip(body, 8000), resultFiles: delivered, failureReason: ok ? null : clip(body, 400) })
    return `Sent the result to ${parent.name} and closed ${delegation.id}.`
  }

  /** The delegated job a worker's thread is working on, if it is one. */
  private delegationOfThread(worker: Worker, threadId: string): WorkerDelegation | undefined {
    const info = this.info(worker, threadId)
    if (info?.delegationId) return this.delegationList.find((d) => d.id === info.delegationId)
    // Delegations from before threads were worked on in the main thread.
    if (threadId === MAIN_THREAD) return this.delegationList.find((d) => isOpenDelegation(d) && d.recipient.workerId === worker.id && d.recipient.threadId === MAIN_THREAD)
    return undefined
  }

  /** Moves a delegation to a final state and records why. The other side is not told; see endDelegation. */
  private settleDelegation(
    delegation: WorkerDelegation,
    state: WorkerDelegation['state'],
    fields: Partial<Pick<WorkerDelegation, 'result' | 'resultFiles' | 'failureReason'>> = {}
  ): void {
    const now = this.now()
    Object.assign(delegation, fields, { state, updatedAt: now, ...(isOpenDelegation({ state }) ? {} : { completedAt: now }) })
    this.commitDelegations()
  }

  /**
   * Ends a delegation that didn't finish normally — it failed, was cancelled,
   * or missed its deadline — tells the parent's thread (so it doesn't wait
   * forever), and stops the recipient's work on it.
   */
  private endDelegation(delegation: WorkerDelegation, state: 'failed' | 'cancelled', reason: string): void {
    if (!isOpenDelegation(delegation)) return
    this.settleDelegation(delegation, state, { failureReason: reason })
    const recipient = this.find(delegation.recipient.workerId)
    const threadId = delegation.recipient.threadId
    if (recipient && threadId && threadId !== MAIN_THREAD) {
      this.abortRun(recipient.id, threadId)
      const info = this.info(recipient, threadId)
      if (info && !info.closedAt) {
        info.closedAt = this.now()
        info.heartbeat = { nextAt: null, everyMs: null, note: '' }
        info.activity = state === 'cancelled' ? 'Cancelled' : clip(reason, 140)
        this.dropWaiting(recipient.id, threadId, reason)
      }
    }
    const parent = this.find(delegation.parent.workerId)
    if (parent) {
      const threadIdForParent = delegation.parent.threadId === MAIN_THREAD || this.info(parent, delegation.parent.threadId) ? delegation.parent.threadId : MAIN_THREAD
      this.deliverMail(
        parent,
        {
          id: randomUUID(),
          from: delegation.recipient.workerId,
          fromName: delegation.recipient.name,
          fromColor: recipient?.color,
          text: reason,
          files: [],
          at: this.now(),
          handoffResult: { id: delegation.id, task: delegation.objective, ok: false, state }
        },
        threadIdForParent
      )
    }
    this.commit()
    this.tick()
  }

  private commitDelegations(): void {
    this.delegationList = pruneDelegations(this.delegationList)
    this.deps.saveDelegations?.(this.delegationList)
    this.deps.onDelegations?.(clone(this.delegationList))
  }

  /* -------------------------------------------------------------- group chats */

  rooms(): WorkerRoom[] {
    return clone(this.roomsFile.rooms)
  }

  roomPosts(roomId: string): RoomPost[] {
    this.requireRoom(roomId)
    return clone(this.roomsFile.posts[roomId] ?? [])
  }

  /** Rooms a worker is in, as the model sees them. */
  roomsOf(workerId: string): WorkerRoom[] {
    return clone(this.roomsFile.rooms.filter((r) => r.members.includes(workerId)))
  }

  /** Creates a group chat, or updates the one `draft.id` names. */
  saveRoom(draft: { id?: string; name: string; members: string[] }): WorkerRoom {
    const name = str(draft.name).replace(/\s+/g, ' ').slice(0, 60)
    if (!name) throw new Error('Give the group chat a name.')
    const members = [...new Set((Array.isArray(draft.members) ? draft.members : []).filter((id) => this.has(id)))]
    if (members.length === 0) throw new Error('Add at least one worker.')
    if (members.length > MAX_ROOM_MEMBERS) throw new Error(`A group chat can have up to ${MAX_ROOM_MEMBERS} workers.`)
    const existing = draft.id ? this.roomsFile.rooms.find((r) => r.id === draft.id) : undefined
    if (draft.id && !existing) throw new Error('That group chat no longer exists.')
    if (existing) {
      existing.name = name
      existing.members = members
      this.commitRooms()
      return clone(existing)
    }
    if (this.roomsFile.rooms.length >= MAX_ROOMS) throw new Error(`You can have up to ${MAX_ROOMS} group chats.`)
    const now = this.now()
    const room: WorkerRoom = { id: randomUUID(), name, members, createdAt: now, lastAt: now, unread: 0 }
    this.roomsFile.rooms.push(room)
    this.roomsFile.posts[room.id] = []
    // Members start caught up: nothing before they joined is news.
    this.roomsFile.seen[room.id] = Object.fromEntries(members.map((m) => [m, now]))
    this.commitRooms()
    return clone(room)
  }

  removeRoom(roomId: string): void {
    this.requireRoom(roomId)
    this.roomsFile.rooms = this.roomsFile.rooms.filter((r) => r.id !== roomId)
    delete this.roomsFile.posts[roomId]
    delete this.roomsFile.seen[roomId]
    this.commitRooms()
  }

  markRoomRead(roomId: string): void {
    const room = this.requireRoom(roomId)
    if (room.unread === 0) return
    room.unread = 0
    this.commitRooms()
  }

  /**
   * The user posts in a group chat. Every member hears it — or, when it
   * @mentions some of them, only those — with what was said since each last
   * caught up. Their replies come back to the room.
   */
  postAsUser(roomId: string, text: string, files: string[] = []): RoomPost {
    const room = this.requireRoom(roomId)
    const body = str(text)
    const paths = (Array.isArray(files) ? files : []).filter((f): f is string => typeof f === 'string' && f.length > 0)
    if (!body && paths.length === 0) throw new Error('Write a message first.')
    const members = room.members.map((id) => this.find(id)).filter((w): w is Worker => !!w)
    const mentioned = mentionedWorkers(body, members)
    const post = this.addPost(room, { from: 'user', fromName: 'You', text: body, files: paths, mentions: mentioned.map((w) => w.id) })
    room.unread = 0
    this.roomChains.delete(room.id)
    for (const member of mentioned.length > 0 ? mentioned : members) {
      this.deliverMail(member, {
        id: randomUUID(),
        from: 'user',
        fromName: 'You',
        text: body,
        files: paths,
        at: post.at,
        room: { id: room.id, name: room.name },
        ...this.catchUp(room, member.id, post.id)
      })
    }
    this.commitRooms()
    this.commit()
    this.tick()
    return clone(post)
  }

  /**
   * A worker posts in a group chat it is in. Colleagues it @mentions are woken
   * with the post (and files copied to them); everyone else reads it the next
   * time they are spoken to in the room. That keeps a room from talking
   * itself into a loop.
   */
  async postAsWorker(workerId: string, roomRef: string, text: string, files: string[] = [], threadId: string = MAIN_THREAD, transfer?: TransferWatch): Promise<{ room: WorkerRoom; woke: string[] }> {
    const worker = this.require(workerId)
    const key = roomRef.trim().toLowerCase()
    const room = this.roomsFile.rooms.find((r) => r.members.includes(workerId) && (r.id === roomRef.trim() || r.name.toLowerCase() === key))
    if (!room) {
      const mine = this.roomsOf(workerId).map((r) => `"${r.name}"`)
      throw new Error(`You are not in a group chat called "${roomRef}".${mine.length ? ` Yours: ${mine.join(', ')}.` : ''}`)
    }
    const body = str(text)
    if (!body && files.length === 0) throw new Error('The message is empty.')
    const now = this.now()
    const sent = this.checkSendBudget(workerId, now)
    const run = this.running.get(slotKey(workerId, threadId))
    if (run) run.postedRooms.add(room.id)
    const woke = await this.publish(worker, room, body, files, transfer)
    this.sentLog.set(workerId, [...sent, now])
    return { room: clone(room), woke }
  }

  /** Records a worker's post and wakes the colleagues it @mentions. Returns their names. */
  private async publish(worker: Worker, room: WorkerRoom, body: string, files: string[], transfer?: TransferWatch): Promise<string[]> {
    const members = room.members.filter((id) => id !== worker.id).map((id) => this.find(id)).filter((w): w is Worker => !!w)
    // Workers waking workers in a room stops after a while without the user:
    // the post is still there for everyone to read, it just wakes nobody.
    const chain = this.roomChains.get(room.id) ?? 0
    const mentioned = chain < MAX_ROOM_CHAIN ? mentionedWorkers(body, members) : []
    if (mentioned.length > 0) this.roomChains.set(room.id, chain + 1)
    const post = this.addPost(room, { from: worker.id, fromName: worker.name, fromColor: worker.color, text: clip(body, POST_CHARS), files, mentions: mentioned.map((w) => w.id) })
    room.unread += 1
    this.roomsFile.seen[room.id] = { ...this.roomsFile.seen[room.id], [worker.id]: post.at }
    const woke: string[] = []
    for (const colleague of mentioned) {
      let delivered: string[] = []
      try {
        delivered = await this.copyFiles(worker, colleague, files, transfer)
      } catch {
        delivered = []
      }
      const live = this.find(colleague.id)
      if (!live) continue
      this.deliverMail(live, {
        id: randomUUID(),
        from: worker.id,
        fromName: worker.name,
        fromColor: worker.color,
        text: body,
        files: delivered,
        at: post.at,
        room: { id: room.id, name: room.name },
        ...this.catchUp(room, live.id, post.id)
      })
      woke.push(live.name)
    }
    this.commitRooms()
    this.commit()
    this.tick()
    return woke
  }

  /** Reads a room's recent posts, for read_room. */
  readRoom(workerId: string, roomRef: string, count = 20): string {
    const key = roomRef.trim().toLowerCase()
    const room = this.roomsFile.rooms.find((r) => r.members.includes(workerId) && (r.id === roomRef.trim() || r.name.toLowerCase() === key))
    if (!room) throw new Error(`You are not in a group chat called "${roomRef}".`)
    const posts = (this.roomsFile.posts[room.id] ?? []).slice(-Math.max(1, Math.min(count, 60)))
    const names = room.members.map((id) => this.find(id)?.name).filter(Boolean)
    this.roomsFile.seen[room.id] = { ...this.roomsFile.seen[room.id], [workerId]: this.now() }
    this.commitRooms()
    const lines = posts.map((p) => `${p.from === 'user' ? 'The user' : p.fromName}: ${clip(p.text, 1200)}${p.files.length ? ` [files: ${p.files.join(', ')}]` : ''}`)
    return [`Group chat "${room.name}" — members: you, the user, ${names.filter((n) => n !== this.find(workerId)?.name).join(', ') || 'nobody else'}.`, ...(lines.length ? lines : ['(no posts yet)'])].join('\n')
  }

  /**
   * Creates a team in one go: specialists from templates, plus any existing
   * workers, all in a new group chat — and posts the first message there, so
   * they start on it side by side.
   */
  createTeam(draft: TeamDraft): { room: WorkerRoom; workers: Worker[] } {
    const name = str(draft.name).slice(0, 60) || 'Team'
    const roles = Array.isArray(draft.roles) ? draft.roles.filter((r) => r && str(r.role)) : []
    const existing = (draft.memberIds ?? []).filter((id) => this.has(id))
    if (roles.length + existing.length === 0) throw new Error('Pick at least one specialist for the team.')
    if (roles.length + existing.length > MAX_ROOM_MEMBERS) throw new Error(`A team can have up to ${MAX_ROOM_MEMBERS} workers.`)
    if (this.workers.length + roles.length > MAX_WORKERS) {
      throw new Error(`That would make ${this.workers.length + roles.length} workers; the most is ${MAX_WORKERS}. Remove some, or add existing workers to the team instead.`)
    }
    const created: Worker[] = []
    for (const role of roles) {
      const base = str(role.name) || str(role.role)
      let candidate = base
      for (let n = 2; this.workers.some((w) => w.name.toLowerCase() === candidate.toLowerCase()); n++) candidate = `${base} ${n}`
      created.push(
        this.save({
          name: candidate,
          color: role.color ?? '',
          personality: str(role.personality),
          purpose: `${str(role.purpose)} Part of the "${name}" team.`,
          ...(draft.model !== undefined ? { model: draft.model } : {})
        })
      )
    }
    const room = this.saveRoom({ name, members: [...created.map((w) => w.id), ...existing] })
    if (str(draft.kickoff)) this.postAsUser(room.id, str(draft.kickoff))
    return { room: clone(this.requireRoom(room.id)), workers: created }
  }

  private requireRoom(roomId: string): WorkerRoom {
    const room = this.roomsFile.rooms.find((r) => r.id === roomId)
    if (!room) throw new Error('That group chat no longer exists.')
    return room
  }

  private addPost(room: WorkerRoom, post: Omit<RoomPost, 'id' | 'roomId' | 'at'>): RoomPost {
    const full: RoomPost = { ...post, id: randomUUID(), roomId: room.id, at: Math.max(this.now(), room.lastAt + 1) }
    const list = (this.roomsFile.posts[room.id] ??= [])
    list.push(full)
    if (list.length > MAX_ROOM_POSTS) list.splice(0, list.length - MAX_ROOM_POSTS)
    room.lastAt = full.at
    this.deps.onRoomPost?.(room.id, clone(full))
    return full
  }

  /** What was said in the room since `memberId` last caught up (not by it, not `exceptPostId`); marks it caught up. */
  private catchUp(room: WorkerRoom, memberId: string, exceptPostId: string): { roomContext?: string } {
    const since = this.roomsFile.seen[room.id]?.[memberId] ?? 0
    const missed = (this.roomsFile.posts[room.id] ?? []).filter((p) => p.at > since && p.id !== exceptPostId && p.from !== memberId).slice(-12)
    this.roomsFile.seen[room.id] = { ...this.roomsFile.seen[room.id], [memberId]: this.now() }
    if (missed.length === 0) return {}
    const text = missed.map((p) => `${p.from === 'user' ? 'The user' : p.fromName}: ${clip(p.text, 600)}`).join('\n')
    return { roomContext: text.length > CONTEXT_CHARS ? `…${text.slice(-CONTEXT_CHARS)}` : text }
  }

  private commitRooms(): void {
    this.deps.saveRooms?.(this.roomsFile)
    this.deps.onRoomsChange?.(clone(this.roomsFile.rooms))
  }

  /** What `check_worker` reports: status, schedule, and the latest thing it said. */
  inspect(nameOrId: string, messages = 0): string {
    const worker = this.lookup(nameOrId)
    if (!worker) throw new Error(`There is no worker called "${nameOrId}". Use list_workers to see your colleagues.`)
    const now = this.now()
    const lines = [
      `${worker.name} — ${worker.purpose || 'no stated purpose'}`,
      `Status: ${worker.paused ? 'paused' : worker.status}. ${describeWorker(worker, now)}`,
      worker.activity ? `Status line: ${worker.activity}` : '',
      worker.heartbeat.nextAt !== null
        ? `Heartbeat: ${relativeTime(worker.heartbeat.nextAt, now)}${worker.heartbeat.everyMs ? `, every ${Math.round(worker.heartbeat.everyMs / 60_000)} min` : ''}${worker.heartbeat.note ? ` — "${worker.heartbeat.note}"` : ''}`
        : 'Heartbeat: none scheduled',
      `Unread mail: ${worker.inbox.length}`,
      worker.lastError ? `Last error: ${worker.lastError}` : '',
      `Folder: ${worker.folder}`
    ]
    const thread = this.thread(worker.id)
    for (let i = thread.messages.length - 1; i >= 0; i--) {
      const message = thread.messages[i]
      if (message.role !== 'assistant') continue
      const said = message.parts
        .filter((p) => p.type === 'text')
        .map((p) => (p as { text: string }).text)
        .join('')
        .trim()
      if (!said) continue
      const excerpt = said.length > 1200 ? `…${said.slice(-1200)}` : said
      lines.push(`Latest reply${message.id === worker.runningMessageId ? ' (still writing)' : ''}:\n${excerpt}`)
      break
    }
    const open = this.delegationList.filter((d) => isOpenDelegation(d) && d.recipient.workerId === worker.id)
    if (open.length > 0) lines.push(`Open tasks: ${open.map((d) => `${d.id} from ${d.parent.name} (${d.state}): ${clip(d.objective, 120)}`).join('; ')}`)
    const asked = this.delegationList.filter((d) => isOpenDelegation(d) && d.parent.workerId === worker.id)
    if (asked.length > 0) lines.push(`Waiting on: ${asked.map((d) => `${d.recipient.name} for ${d.id} (${d.state}): ${clip(d.objective, 80)}`).join('; ')}`)
    const busy = worker.threads.filter((t) => t.runningMessageId)
    if (busy.length > 0) lines.push(`Also working on: ${busy.map((t) => `"${t.title}"`).join(', ')}`)
    if (messages > 0) lines.push(`Recent thread:\n${this.threadExcerpt(worker.id, messages, 6000) || '(empty)'}`)
    return lines.filter(Boolean).join('\n')
  }

  /** A worker schedules its own wake-ups. Returns a sentence for the tool result. */
  /** The engine's clock (a test's fake one, or Date.now). */
  clock(): number {
    return this.now()
  }

  /**
   * A worker schedules its own wake-ups. A heartbeat belongs to the thread
   * that set it: a routine's thread wakes in that thread, the main thread in
   * the main one. Returns a sentence for the tool result.
   */
  setHeartbeat(id: string, input: { inMinutes?: number; everyMinutes?: number; at?: number; note?: string; stop?: boolean }, threadId: string = MAIN_THREAD): string {
    const worker = this.require(id)
    const slot = this.slot(worker, threadId) ?? worker
    const run = this.running.get(slotKey(id, threadId))
    if (run) run.heartbeatSet = true
    if (input.stop) {
      slot.heartbeat = { nextAt: null, everyMs: null, note: '' }
      this.commit()
      return 'Heartbeat stopped. You will sleep until someone writes to you.'
    }
    const clamp = (minutes: number): number => Math.min(Math.max(minutes * 60_000, MIN_HEARTBEAT_MS), MAX_HEARTBEAT_MS)
    const now = this.now()
    const every = typeof input.everyMinutes === 'number' && input.everyMinutes > 0 ? clamp(input.everyMinutes) : null
    // in_minutes 0 (or less) means "as soon as possible": the soonest a beat
    // can come round. A worker asked to "do it now" used to hit an error here.
    const first =
      typeof input.at === 'number'
        ? clamp((input.at - now) / 60_000)
        : typeof input.inMinutes === 'number'
          ? clamp(input.inMinutes)
          : every
    if (first === null) {
      throw new Error(
        'Say when: in_minutes (0 = as soon as possible), at (a clock time), every_minutes for a steady beat, or stop: true. To tell the user something now, just say it in your reply.'
      )
    }
    slot.heartbeat = { nextAt: now + first, everyMs: every, note: str(input.note).slice(0, 300) }
    if (worker.status === 'asleep') worker.status = 'idle'
    // A new schedule starts a new count towards STALE_WAKEUPS.
    this.unattendedWakes.delete(slotKey(id, threadId))
    this.commit()
    const adjusted =
      (typeof input.at !== 'number' && typeof input.inMinutes === 'number' && input.inMinutes * 60_000 !== first) ||
      (typeof input.everyMinutes === 'number' && every !== null && input.everyMinutes * 60_000 !== every)
    return `Heartbeat set: next wake-up ${relativeTime(now + first, now)}${every ? `, then every ${Math.round(every / 60_000)} min` : ''}.${adjusted ? ' (Adjusted to stay between 1 minute and 7 days.)' : ''}`
  }

  /**
   * The user pauses, resumes or clears a worker's goal run (the goal banner).
   * Pausing stops a running turn's goal loop at its next step and cancels the
   * continuation it would get; resuming starts it again with a fresh turn
   * budget, straight away.
   */
  setGoal(id: string, status: 'active' | 'paused' | null): void {
    const worker = this.require(id)
    const goal = worker.goalRun
    if (!goal) throw new Error(`${worker.name} has no goal.`)
    const run = this.running.get(slotKey(id, MAIN_THREAD))
    if (status === 'active') {
      const { summary: _summary, pausedByUser: _paused, ...rest } = goal
      worker.goalRun = { ...rest, status: 'active', turns: 0, nextAt: run ? null : this.now() }
    } else {
      if (run) this.deps.pauseGoal?.(run.messageId)
      worker.goalRun = status === 'paused' ? { ...goal, status: 'paused', pausedByUser: true, nextAt: null } : null
    }
    this.commit()
    this.tick()
  }

  /**
   * A worker goes to sleep until a time it picks: waiting for something, or
   * pacing long work. The turn ends once this round's tools finish (the
   * loop sees `TurnState.yielded`), and it wakes with its note as a one-off
   * heartbeat. A goal run resumes then, in goal mode.
   */
  sleep(id: string, minutes: number, note: string, threadId: string = MAIN_THREAD, until: WakeCondition = {}): { until: number; text: string } {
    const worker = this.require(id)
    const slot = this.slot(worker, threadId) ?? worker
    const now = this.now()
    const ms = Math.min(Math.max((Number.isFinite(minutes) ? minutes : 1) * 60_000, MIN_HEARTBEAT_MS), MAX_SLEEP_MINUTES * 60_000)
    const wakeAt = now + ms
    const why = str(note).replace(/\s+/g, ' ').slice(0, 280)
    const run = this.running.get(slotKey(id, threadId))
    if (run) {
      run.heartbeatSet = true
      run.activitySet = true
    }
    slot.heartbeat = { nextAt: wakeAt, everyMs: null, note: why || 'Wake up from your sleep and carry on' }
    const time = new Date(wakeAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    // Woken by the event itself when there is one: the minutes are only the
    // longest it waits. A restart forgets the watch, and the clock wakes it.
    const key = slotKey(id, threadId)
    this.watches.get(key)?.()
    this.watches.delete(key)
    const waitingOn = until.processExits ? `process ${until.processExits} to exit` : until.fileChanges ? `${until.fileChanges} to change` : null
    if (waitingOn) {
      const stop = watchFor(until, (what) => {
        this.watches.delete(key)
        const live = this.find(id)
        const liveSlot = live ? this.slot(live, threadId) : undefined
        if (!liveSlot || liveSlot.heartbeat.nextAt !== wakeAt) return
        liveSlot.heartbeat = { nextAt: this.now(), everyMs: null, note: `${liveSlot.heartbeat.note} — woken because ${what}` }
        this.commit()
        this.tick()
      })
      this.watches.set(key, stop)
    }
    const line = `${waitingOn ? `Waiting for ${waitingOn}, at most until ${time}` : `Sleeping until ${time}`}${why ? ` — ${why}` : ''}`.slice(0, 140)
    const info = this.info(worker, threadId)
    if (info) info.activity = line
    worker.activity = line
    this.commit()
    return {
      until: wakeAt,
      text: waitingOn
        ? `Waiting for ${waitingOn}; you wake as soon as it happens, or at ${time} (${relativeTime(wakeAt, now)}) at the latest. This turn ends now; you'll see your note and what happened.`
        : `Sleeping until ${time} (${relativeTime(wakeAt, now)}). This turn ends now; you wake then and see your note.`
    }
  }

  /** The one-line status on the worker's card, and optionally a mood for the next half hour. */
  setStatus(id: string, activity: string, mood?: string, threadId: string = MAIN_THREAD): void {
    const worker = this.require(id)
    const run = this.running.get(slotKey(id, threadId))
    if (run) run.activitySet = true
    worker.activity = str(activity).replace(/\s+/g, ' ').slice(0, 140)
    const info = this.info(worker, threadId)
    if (info) info.activity = worker.activity
    if (mood && HINT_MOODS.includes(mood as WorkerMood)) worker.moodHint = { mood: mood as WorkerMood, until: this.now() + HINT_MS }
    this.commit()
  }

  /* ------------------------------------------------ autonomy: routines, memory, asks */

  /**
   * A trading worker wakes for its "Trading check" routine every few minutes
   * while the market is open; one that stops trading loses it. Kept in step
   * with the editor rather than left to the worker, so turning trading on is
   * all it takes.
   */
  private syncTradingRoutine(worker: Worker): void {
    const index = worker.routines.findIndex((r) => r.name === TRADING_ROUTINE_NAME)
    if (!worker.trading) {
      if (index !== -1) worker.routines.splice(index, 1)
      return
    }
    const now = this.now()
    const shape = { everyMs: worker.trading.everyMinutes * 60_000, daily: null, marketHours: true }
    const task = 'Look at the market and your positions, then act on your trading strategy. End with one line: what you did and why.'
    if (index === -1) {
      worker.routines.push({ id: randomUUID(), name: TRADING_ROUTINE_NAME, task, ...shape, nextAt: routineNextAt(shape, now), runs: [] })
    } else {
      const routine = worker.routines[index]
      const changed = routine.everyMs !== shape.everyMs || !routine.marketHours
      Object.assign(routine, { task, ...shape, ...(changed ? { nextAt: routineNextAt(shape, now) } : {}) })
    }
    if (worker.status === 'asleep') worker.status = 'idle'
  }

  /** A named, repeating job: every N minutes, or daily at a local clock time ("HH:MM"). */
  addRoutine(id: string, input: { name: string; task: string; everyMinutes?: number; daily?: string; marketHours?: boolean }): string {
    const worker = this.require(id)
    const name = str(input.name).slice(0, 60)
    const task = str(input.task).slice(0, 600)
    if (!name || !task) throw new Error('Give the routine a name and a task.')
    const daily = str(input.daily)
    if (daily && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(daily)) throw new Error('daily must be a 24-hour time like "08:30".')
    const everyMs =
      typeof input.everyMinutes === 'number' && input.everyMinutes > 0
        ? Math.min(Math.max(input.everyMinutes * 60_000, MIN_HEARTBEAT_MS), MAX_HEARTBEAT_MS)
        : null
    if (!daily && !everyMs) throw new Error('Say how often: every_minutes, or daily ("08:30").')
    const existing = worker.routines.find((r) => r.name.toLowerCase() === name.toLowerCase())
    if (!existing && worker.routines.length >= MAX_ROUTINES) {
      throw new Error(`You already have ${MAX_ROUTINES} routines. Remove one you no longer need first.`)
    }
    const now = this.now()
    const shape = { everyMs: daily ? null : everyMs, daily: daily ? daily.padStart(5, '0') : null, marketHours: input.marketHours === true }
    const routine = existing
      ? Object.assign(existing, { task, ...shape, nextAt: routineNextAt(shape, now) })
      : { id: randomUUID(), name, task, ...shape, nextAt: routineNextAt(shape, now), runs: [] }
    if (!existing) worker.routines.push(routine)
    if (worker.status === 'asleep') worker.status = 'idle'
    this.commit()
    const when = `${routine.daily ? `daily at ${routine.daily}` : `every ${Math.round(routine.everyMs! / 60_000)} min`}${routine.marketHours ? ' while the market is open' : ''}`
    return `${existing ? 'Updated' : 'Added'} routine "${name}" (${when}); first run ${relativeTime(routine.nextAt, now)}.`
  }

  /** Stops a routine. Its thread stays to read, closed; a run of it going now is left to finish. */
  removeRoutine(id: string, name: string): string {
    const worker = this.require(id)
    const removed = worker.routines.filter((r) => r.name.toLowerCase() === str(name).toLowerCase())
    if (removed.length === 0) throw new Error(`No routine called "${name}".`)
    worker.routines = worker.routines.filter((r) => !removed.includes(r))
    for (const routine of removed) {
      const info = routine.threadId ? this.info(worker, routine.threadId) : undefined
      if (!info) continue
      this.dropWaiting(id, info.id, 'Its routine was removed.')
      if (!this.running.has(slotKey(id, info.id))) info.closedAt = info.closedAt ?? this.now()
    }
    this.commit()
    return `Removed routine "${name}".`
  }

  /** The worker's own record of what it is working towards and what it has learned. */
  setMemory(id: string, input: { goal?: string; notes?: string; appendNote?: string }): string {
    const worker = this.require(id)
    if (typeof input.goal === 'string') worker.goal = input.goal.trim().slice(0, MAX_GOAL_CHARS)
    if (typeof input.notes === 'string') worker.notes = input.notes.trim().slice(0, MAX_NOTES_CHARS)
    if (typeof input.appendNote === 'string' && input.appendNote.trim()) {
      const line = `- ${input.appendNote.trim().replace(/\s+/g, ' ')}`
      // Oldest lines give way first, so recent learning is never the part lost.
      let notes = worker.notes ? `${worker.notes}\n${line}` : line
      while (notes.length > MAX_NOTES_CHARS && notes.includes('\n')) notes = notes.slice(notes.indexOf('\n') + 1)
      worker.notes = notes.slice(-MAX_NOTES_CHARS)
    }
    this.commit()
    return `Saved. Goal: ${worker.goal ? `${worker.goal.length} chars` : 'none'}; notes: ${worker.notes.length}/${MAX_NOTES_CHARS} chars.`
  }

  /**
   * Puts a question to the user without stopping: it waits on the worker's
   * page (and as a notification) while the worker carries on. An `approve`
   * question asks for one specific action; approving it lets that exact call
   * through once (see allowOnce).
   */
  ask(id: string, input: { question: string; options?: string[]; approve?: WorkerAsk['approve'] }, threadId: string = MAIN_THREAD): WorkerAsk {
    const worker = this.require(id)
    const question = str(input.question).slice(0, 800)
    if (!question) throw new Error('Ask a question.')
    if (worker.asks.length >= 10) throw new Error('You already have 10 questions waiting. Wait for answers before asking more.')
    const ask: WorkerAsk = {
      id: randomUUID(),
      question,
      options: (input.options ?? []).map(str).filter(Boolean).slice(0, 4),
      approve: input.approve ?? null,
      at: this.now(),
      ...(threadId !== MAIN_THREAD ? { threadId } : {})
    }
    const asking = this.running.get(slotKey(id, threadId))
    if (asking) asking.asked = true
    worker.asks.push(ask)
    worker.unread += 1
    this.commit()
    this.deps.reachOut?.(clone(worker), { title: `${worker.name} has a question`, body: question })
    this.tell((o) => o.asked?.(clone(worker), clone(ask)))
    return ask
  }

  /** The user's answer: the question is closed and the answer arrives as mail. */
  answer(id: string, askId: string, answer: { text?: string; approved?: boolean }): void {
    const worker = this.require(id)
    const ask = worker.asks.find((a) => a.id === askId)
    if (!ask) throw new Error('That question was already answered.')
    worker.asks = worker.asks.filter((a) => a.id !== askId)
    let text: string
    if (ask.approve) {
      if (answer.approved) {
        const grants = (this.grants.get(id) ?? []).filter((g) => g.expires > this.now())
        grants.push({ key: approvalKey(ask.approve.tool, ask.approve.input), expires: this.now() + DAY })
        this.grants.set(id, grants)
      }
      text = `${answer.approved ? 'Approved' : 'Declined'}: ${ask.approve.summary}${answer.text ? ` — ${answer.text}` : ''}${
        answer.approved ? ' You may now make exactly that call once.' : ''
      }`
    } else {
      text = str(answer.text) || '(no answer)'
    }
    // The answer goes back to the thread that asked (a delegated job, a side task), if it still exists.
    const back = ask.threadId && this.info(worker, ask.threadId) ? ask.threadId : MAIN_THREAD
    this.deliverMail(worker, { id: randomUUID(), from: 'user', fromName: 'You', text: `[Answer to "${ask.question.slice(0, 120)}"] ${text}`, files: [], at: this.now() }, back)
    this.commit()
    this.tick()
  }

  /**
   * Whether an approved question covers this exact call; using it spends it.
   * Tool names are compared without a namespace (see `toolName`).
   */
  allowOnce(id: string, tool: string, input: Record<string, unknown>): boolean {
    const grants = this.grants.get(id)
    if (!grants) return false
    // One approval is one call: same tool (namespace aside), same arguments (key order aside).
    const key = approvalKey(tool, input)
    const index = grants.findIndex((g) => g.key === key && g.expires > this.now())
    if (index === -1) return false
    grants.splice(index, 1)
    return true
  }

  /** A worker telling the user something on its own — a finished job, a problem it spotted. */
  reachOut(id: string, title: string, body: string): void {
    const worker = this.require(id)
    worker.unread += 1
    this.commit()
    const message = { title: str(title).slice(0, 80) || worker.name, body: str(body).slice(0, 400) }
    this.deps.reachOut?.(clone(worker), message)
    this.tell((o) => o.notified?.(clone(worker), { ...message }))
  }

  /** A worker creates a colleague and hands it its first task. Deliberately hard to do often. */
  createByWorker(creatorId: string, input: { name: string; personality: string; purpose: string; firstTask: string; reason: string; color?: string }): Worker {
    const creator = this.require(creatorId)
    if (!str(input.reason)) throw new Error('Say why no existing colleague can do this (reason).')
    if (!str(input.firstTask)) throw new Error('Give the new worker its first task (first_task).')
    const now = this.now()
    this.createdLog = this.createdLog.filter((at) => at > now - DAY)
    if (this.createdLog.length >= MAX_CREATED_PER_DAY) {
      throw new Error(`Workers have already created ${MAX_CREATED_PER_DAY} workers in the last 24 hours. Hand the job to an existing colleague, or do it yourself.`)
    }
    // A colleague runs on the model and with the access its creator has: a
    // read-only worker cannot mint one that may change things.
    const worker = this.save(
      { name: input.name, personality: input.personality, purpose: input.purpose, color: input.color ?? '', access: creator.access, model: creator.model },
      creator.id
    )
    this.createdLog.push(now)
    const created = this.find(worker.id)!
    this.deliverMail(created, {
      id: randomUUID(),
      from: creator.id,
      fromName: creator.name,
      fromColor: creator.color,
      text: str(input.firstTask),
      files: [],
      at: now
    })
    this.commit()
    this.tick()
    return clone(created)
  }

  /* -------------------------------------------------------------- scheduling */

  /**
   * Starts every run that is due, within the limits: WORKER_CONCURRENCY runs
   * at once across every worker, MAX_RUNNING_PER_WORKER per worker, and each
   * thread one run at a time. A run that is due but has to wait gets a queued
   * receipt saying why, once, and starts as soon as a slot frees — the oldest
   * waiting first. Safe to call any time.
   */
  tick(): void {
    if (!this.started) return
    const now = this.now()
    let changed = this.rezoneRoutines(now)
    changed = this.expireDelegations(now) || changed
    changed = this.skipOverlappingRoutines(now) || changed
    const concurrency = this.deps.concurrency ?? WORKER_CONCURRENCY
    const due = this.workers.filter((w) => !w.paused).flatMap((w) => this.dueSlots(w, now))
    due.sort((a, b) => a.since - b.since)
    const stillWaiting = new Set<string>()
    for (const candidate of due) {
      const { worker, threadId, priority } = candidate
      if (!priority && this.overBudget(worker.id, now)) {
        const note = `Resting — woke ${this.deps.maxTurnsPerHour ?? MAX_TURNS_PER_HOUR} times in the last hour`
        if (worker.activity !== note) {
          worker.activity = note
          changed = true
        }
        continue
      }
      const busy =
        this.running.size >= concurrency
          ? `${concurrency} worker tasks are already running; it starts when one finishes`
          : this.runningFor(worker.id) >= MAX_RUNNING_PER_WORKER
            ? `${worker.name} already has ${MAX_RUNNING_PER_WORKER} tasks running; it starts when one finishes`
            : null
      if (busy) {
        stillWaiting.add(slotKey(worker.id, threadId))
        if (this.markQueued(candidate, busy)) changed = true
        continue
      }
      if (this.begin(worker, threadId, priority)) changed = false
    }
    // Queued runs whose thread is no longer due (paused, cleared, answered) never start.
    for (const [key, execution] of this.waiting) {
      if (stillWaiting.has(key) || this.running.has(key)) continue
      this.waiting.delete(key)
      this.runs.update(execution, { state: 'cancelled', reason: execution.reason ? 'It was no longer needed by the time a slot freed up.' : 'It was no longer needed.' })
    }
    for (const worker of this.workers) {
      const reason = [...this.waiting.values()].find((e) => e.workerId === worker.id)?.reason ?? null
      if (worker.queued !== reason) {
        worker.queued = reason
        changed = true
      }
    }
    if (changed) this.commit()
    else this.arm()
  }

  /* --------------------------------------------------------------- internals */

  private tell(call: (observer: WorkerObserver) => void): void {
    for (const observer of this.observers) {
      try {
        call(observer)
      } catch (error) {
        console.error('[workers] an observer failed:', error)
      }
    }
  }

  /**
   * The loop reports on the goal as the turn goes: each time it sends the
   * worker back to work, when the worker resolves it (goal_complete or
   * goal_blocked), and when it pauses at the turn's limit. A pause the user
   * asked for stays theirs. Reaching or blocking on a goal is worth telling
   * the user about.
   */
  private goalProgress(id: string, goal: GoalState): void {
    const worker = this.find(id)
    const current = worker?.goalRun
    if (!worker || !current) return
    const userPaused = current.pausedByUser === true && current.status === 'paused'
    worker.goalRun = {
      ...current,
      iterations: Math.max(current.iterations, goal.iterations),
      status: userPaused ? 'paused' : goal.status,
      ...(goal.summary ? { summary: goal.summary } : {})
    }
    this.commit()
    if (goal.status === 'achieved') {
      this.deps.reachOut?.(clone(worker), { title: `${worker.name} reached its goal`, body: goal.summary || current.text })
    } else if (goal.status === 'blocked') {
      this.deps.reachOut?.(clone(worker), { title: `${worker.name} needs you for its goal`, body: goal.summary || current.text })
    }
  }

  /** One worker's trading set-up, for the tools that gate orders (features/trading/access). */
  tradingOf(id: string): Worker['trading'] {
    return this.find(id)?.trading ?? null
  }

  private find(id: string): Worker | undefined {
    return this.workers.find((w) => w.id === id)
  }

  private require(id: string): Worker {
    const worker = this.find(id)
    if (!worker) throw new Error('That worker no longer exists.')
    return worker
  }

  /** A thread's info, for any thread but the main one. */
  private info(worker: Worker, threadId: string): WorkerThreadInfo | undefined {
    return threadId === MAIN_THREAD ? undefined : worker.threads.find((t) => t.id === threadId)
  }

  /** Where a thread keeps its inbox, wake-up and running message: the worker itself for the main thread. */
  private slot(worker: Worker, threadId: string): Slot | undefined {
    return threadId === MAIN_THREAD ? worker : this.info(worker, threadId)
  }

  /** The main thread and the other threads that can run (open, or written to since they closed). */
  private slotsOf(worker: Worker, includeClosed = false): { threadId: string; slot: Slot }[] {
    return [
      { threadId: MAIN_THREAD, slot: worker },
      ...worker.threads.filter((t) => includeClosed || !t.closedAt || t.inbox.length > 0).map((t) => ({ threadId: t.id, slot: t }))
    ]
  }

  private runningFor(workerId: string): number {
    let count = 0
    for (const run of this.running.values()) if (run.workerId === workerId) count++
    return count
  }

  private abortRun(workerId: string, threadId: string): void {
    const run = this.running.get(slotKey(workerId, threadId))
    if (!run) return
    run.stoppedByUser = true
    run.controller.abort()
  }

  /** Ends a thread's queued receipt, if it has one. */
  private dropWaiting(workerId: string, threadId: string, reason: string): void {
    const key = slotKey(workerId, threadId)
    const execution = this.waiting.get(key)
    if (!execution) return
    this.waiting.delete(key)
    this.runs.update(execution, { state: 'cancelled', reason })
  }

  /** Past MAX_THREADS, the oldest finished threads go (transcript and all). Open ones are never cleared. */
  private trimThreads(worker: Worker): void {
    const closed = worker.threads
      .filter((t) => t.closedAt !== null && !this.running.has(slotKey(worker.id, t.id)))
      .sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))
    while (worker.threads.length > MAX_THREADS && closed.length > 0) {
      const oldest = closed.shift()!
      worker.threads = worker.threads.filter((t) => t !== oldest)
      worker.unread = Math.max(0, worker.unread - oldest.unread)
      this.threads.delete(threadKey(worker.id, oldest.id))
      void Promise.resolve(this.deps.deleteThread(threadKey(worker.id, oldest.id))).catch((error) => console.error('[workers] could not clear an old thread:', error))
    }
  }

  /**
   * What a worker may do right now in a thread: its own access, lowered by
   * the cap of the thread it is in (a delegated job) and by the run going
   * there (a colleague's or a guest's message in it). What its own messages
   * to colleagues carry as `senderAccess`.
   */
  private accessOf(worker: Worker, threadId: string): WorkerAccess {
    const running = this.running.get(slotKey(worker.id, threadId))
    if (running) return running.access
    const cap = this.info(worker, threadId)?.accessCap
    return cap ? (weakerAccess(worker.access, cap) as WorkerAccess) : worker.access
  }

  /** Who a run's work came from: a guest, a colleague (a delegated job, mail from another worker), or the user. */
  turnOrigin(messageId: string): 'guest' | 'delegated' | null {
    for (const run of this.running.values()) if (run.messageId === messageId) return run.origin === 'user' ? null : run.origin
    return null
  }

  private thread(id: string, threadId: string = MAIN_THREAD): WorkerThread {
    const key = threadKey(id, threadId)
    let thread = this.threads.get(key)
    if (!thread) {
      const raw = this.deps.loadThread(key) as Partial<WorkerThread> | null
      thread = {
        workerId: id,
        ...(threadId === MAIN_THREAD ? {} : { threadId }),
        messages: Array.isArray(raw?.messages) ? raw!.messages.filter((m) => m && typeof m.id === 'string' && Array.isArray(m.parts)) : [],
        summary: raw?.summary && typeof raw.summary.text === 'string' ? raw.summary : null
      }
      this.threads.set(key, thread)
    }
    return thread
  }

  private commit(): void {
    this.deps.saveWorkers(this.workers)
    this.deps.onChange?.(this.workers)
    this.arm()
  }

  /**
   * One timer for the soonest wake-up of anything: heartbeats, routines, goal
   * runs continuing, delegation deadlines. The 30-second tick (and the resume
   * hook in the service) re-checks everything anyway, because timers alone do
   * not survive sleep.
   */
  private arm(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.started) return
    const now = this.now()
    const slotFree = this.running.size < (this.deps.concurrency ?? WORKER_CONCURRENCY)
    let soonest = Infinity
    for (const w of this.workers) {
      if (w.paused) continue
      const blocked = !slotFree || this.runningFor(w.id) >= MAX_RUNNING_PER_WORKER || this.overBudget(w.id, now)
      const wakes = [
        ...this.slotsOf(w)
          .filter(({ threadId }) => !this.running.has(slotKey(w.id, threadId)))
          .map(({ threadId, slot }) => this.nextWake(w, threadId, slot)),
        ...w.routines.filter((r) => !(r.threadId && this.running.has(slotKey(w.id, r.threadId)))).map((r) => r.nextAt)
      ]
      for (const next of wakes) {
        if (next === null) continue
        // Due but unable to start — every slot is busy, or it is resting past
        // its hourly cap. `finish()` ticks when a slot frees and the interval
        // re-checks the cap; arming a 0 ms timer for it here would have tick()
        // skip it and re-arm straight away, spinning the main process for as
        // long as it stays blocked.
        if (next <= now && blocked) continue
        soonest = Math.min(soonest, next)
      }
    }
    for (const d of this.delegationList) if (isOpenDelegation(d) && d.deadlineAt !== null) soonest = Math.min(soonest, Math.max(d.deadlineAt, now))
    if (soonest === Infinity) return
    const delay = Math.min(Math.max(soonest - now, 0), MAX_DELAY)
    this.timer = setTimeout(() => {
      this.timer = null
      this.tick()
    }, delay)
    this.timer.unref?.()
  }

  /** A thread's soonest timed wake-up: its heartbeat, and for the main thread a goal run carrying on. */
  private nextWake(worker: Worker, threadId: string, slot: Slot): number | null {
    let next = slot.heartbeat.nextAt ?? Infinity
    if (threadId === MAIN_THREAD && worker.goalRun?.status === 'active' && typeof worker.goalRun.nextAt === 'number') next = Math.min(next, worker.goalRun.nextAt)
    return next === Infinity ? null : next
  }

  /** The runs a worker has due now, one per thread: mail, wake-ups, routines, resumes and retries. */
  private dueSlots(worker: Worker, now: number): { worker: Worker; threadId: string; since: number; priority: boolean }[] {
    const out: { worker: Worker; threadId: string; since: number; priority: boolean }[] = []
    for (const { threadId, slot } of this.slotsOf(worker)) {
      const key = slotKey(worker.id, threadId)
      if (this.running.has(key)) continue
      const times: number[] = slot.inbox.map((m) => m.at)
      const wake = threadId === MAIN_THREAD ? this.wakes.get(worker.id) : undefined
      if (wake !== undefined) times.push(wake)
      const next = this.nextWake(worker, threadId, slot)
      if (next !== null && next <= now) times.push(next)
      const resume = this.resumes.get(key)
      if (resume) times.push(resume.endedAt ?? now)
      const retry = this.retries.get(key)
      if (retry) times.push(now)
      const routine = worker.routines.find((r) => r.threadId === threadId && r.nextAt <= now)
      if (routine) times.push(routine.nextAt)
      if (times.length === 0) continue
      out.push({ worker, threadId, since: Math.min(...times), priority: slot.inbox.some((m) => m.from === 'user') || wake !== undefined || retry !== undefined })
    }
    // A due routine that has no thread yet gets one when it starts.
    for (const routine of worker.routines) {
      if (routine.nextAt > now || (routine.threadId && this.info(worker, routine.threadId))) continue
      out.push({ worker, threadId: `${ROUTINE_SLOT}${routine.id}`, since: routine.nextAt, priority: false })
    }
    return out
  }

  /** Records that a due run has to wait, once; true when that changed anything. */
  private markQueued(candidate: { worker: Worker; threadId: string }, reason: string): boolean {
    const key = slotKey(candidate.worker.id, candidate.threadId)
    const existing = this.waiting.get(key)
    if (existing) {
      if (existing.reason === reason) return false
      this.runs.update(existing, { reason })
      return true
    }
    const routine = candidate.threadId.startsWith(ROUTINE_SLOT)
      ? candidate.worker.routines.find((r) => r.id === candidate.threadId.slice(ROUTINE_SLOT.length))
      : candidate.worker.routines.find((r) => r.threadId === candidate.threadId && r.nextAt <= this.now())
    const trigger: ExecutionTrigger = routine ? { kind: 'routine', label: `Routine: ${routine.name}`, routineId: routine.id } : { kind: 'mail', label: 'Waiting to start' }
    this.waiting.set(key, this.runs.create({ workerId: candidate.worker.id, threadId: candidate.threadId.startsWith(ROUTINE_SLOT) ? MAIN_THREAD : candidate.threadId, trigger, engine: candidate.worker.engine, reason }))
    return true
  }

  /**
   * A routine that comes due while its previous run is still going is
   * skipped, not stacked (the overlap policy is "skip"): its receipt says so
   * and the next occurrence is scheduled from now.
   */
  private skipOverlappingRoutines(now: number): boolean {
    let changed = false
    for (const worker of this.workers) {
      if (worker.paused) continue
      for (const routine of worker.routines) {
        if (routine.nextAt > now || !routine.threadId || !this.running.has(slotKey(worker.id, routine.threadId))) continue
        this.runs.create({
          workerId: worker.id,
          threadId: routine.threadId,
          trigger: { kind: 'routine', label: `Routine: ${routine.name}`, routineId: routine.id },
          engine: worker.engine,
          state: 'missed',
          reason: 'Skipped: the previous run was still going.'
        })
        routine.nextAt = routineNextAt(routine, now)
        changed = true
      }
    }
    return changed
  }

  /**
   * A daily routine is "at 9:00" where the user is: after the time zone
   * changes (travel, or by hand) its next run is worked out again in the new
   * zone, instead of firing at 6:00 local because it was computed in the old one.
   */
  private rezoneRoutines(now: number): boolean {
    const zone = this.deps.zone ? this.deps.zone() : currentZone()
    let changed = false
    for (const worker of this.workers) {
      for (const routine of worker.routines) {
        if (!routine.daily) continue
        if (routine.zone === zone) continue
        // Stamped on first sight; recomputed only when it really was another zone and hasn't run yet.
        if (routine.zone !== undefined && routine.nextAt > now) routine.nextAt = routineNextAt(routine, now)
        routine.zone = zone
        changed = true
      }
    }
    return changed
  }

  /** Delegations past their deadline fail, and the worker that asked is told. */
  private expireDelegations(now: number): boolean {
    let changed = false
    for (const delegation of this.delegationList) {
      if (!isOpenDelegation(delegation) || delegation.deadlineAt === null || delegation.deadlineAt > now) continue
      const when = new Date(delegation.deadlineAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      this.endDelegation(delegation, 'failed', `${delegation.recipient.name} didn’t finish by the deadline (${when}).`)
      changed = true
    }
    return changed
  }

  private overBudget(id: string, now: number): boolean {
    const log = (this.turnLog.get(id) ?? []).filter((at) => at > now - HOUR)
    this.turnLog.set(id, log)
    return log.length >= (this.deps.maxTurnsPerHour ?? MAX_TURNS_PER_HOUR)
  }

  private restingStatus(worker: Worker): Worker['status'] {
    if (worker.paused) return 'paused'
    const scheduled =
      worker.routines.length > 0 ||
      this.slotsOf(worker).some(({ threadId, slot }) => slot.inbox.length > 0 || this.nextWake(worker, threadId, slot) !== null) ||
      this.wakes.has(worker.id)
    return scheduled ? 'idle' : 'asleep'
  }

  /** Puts mail in a thread's inbox (the main one by default). Writing to a closed thread opens it again. */
  private deliverMail(worker: Worker, mail: WorkerMail, threadId: string = MAIN_THREAD): void {
    const info = this.info(worker, threadId)
    const slot: Slot = info ?? worker
    slot.inbox.push(mail)
    if (info) {
      info.closedAt = null
      info.updatedAt = mail.at
    }
    if (mail.from === 'user') this.unattendedWakes.delete(slotKey(worker.id, info ? threadId : MAIN_THREAD))
    if (worker.status === 'asleep') worker.status = 'idle'
  }

  /** A unique folder for a new worker under `<Work folder>/Workers/`. */
  private folderFor(name: string): string {
    const settings = this.deps.getSettings()
    const root = join(settings.work.defaultFolder || join(homedir(), 'Eaon'), 'Workers')
    const taken = new Set(this.workers.map((w) => w.folder.toLowerCase()))
    const slug = workerSlug(name)
    let folder = join(root, slug)
    for (let n = 2; taken.has(folder.toLowerCase()); n++) folder = join(root, `${slug}-${n}`)
    return folder
  }

  private freeColor(): string {
    const used = new Set(this.workers.map((w) => w.color.toLowerCase()))
    return WORKER_COLORS.find((c) => !used.has(c.toLowerCase())) ?? WORKER_COLORS[this.workers.length % WORKER_COLORS.length]
  }

  /**
   * Starts one thread's run: folds its inbox (and whatever woke it) into one
   * message, records the receipt as running, and runs the turn on the
   * worker's engine. Returns true when it committed.
   */
  private begin(worker: Worker, requested: string, priority: boolean): boolean {
    const now = this.now()
    let threadId = requested
    let routine: WorkerRoutine | undefined
    if (requested.startsWith(ROUTINE_SLOT)) {
      routine = worker.routines.find((r) => r.id === requested.slice(ROUTINE_SLOT.length))
      if (!routine) return false
      // A routine's runs get a thread of their own, so they neither crowd the
      // main conversation nor stop when it does.
      threadId = this.createThread(worker.id, { title: routine.name, kind: 'routine', routineId: routine.id }).id
      routine.threadId = threadId
      const queued = this.waiting.get(slotKey(worker.id, requested))
      if (queued) {
        this.waiting.delete(slotKey(worker.id, requested))
        this.waiting.set(slotKey(worker.id, threadId), queued)
        queued.threadId = threadId
      }
    } else {
      routine = worker.routines.find((r) => r.threadId === threadId && r.nextAt <= now)
    }
    const key = slotKey(worker.id, threadId)
    const isMain = threadId === MAIN_THREAD
    const info = this.info(worker, threadId)
    const slot = this.slot(worker, threadId)
    if (!slot) return false
    // The run takes the slot it was due for. Until it ends the routine's next
    // occurrence is the one after; if that arrives while this run is still
    // going, it is skipped (the overlap policy), not this run's own slot.
    const dueAt = routine ? routine.nextAt : null
    if (routine) routine.nextAt = routineNextAt(routine, now)
    const heartbeatDue = slot.heartbeat.nextAt !== null && slot.heartbeat.nextAt <= now
    const woke = isMain && this.wakes.has(worker.id)
    const resume = this.resumes.get(key)
    const retry = this.retries.get(key)

    // A repeating wake-up the worker set for itself that has gone off again
    // and again with nobody writing in that thread is watching something no
    // one follows any more: stop it rather than run forever (STALE_WAKEUPS).
    if (heartbeatDue && slot.heartbeat.everyMs && slot.inbox.length === 0 && !woke && !resume && !retry && !routine) {
      const count = (this.unattendedWakes.get(key) ?? 0) + 1
      this.unattendedWakes.set(key, count)
      if (count > STALE_WAKEUPS) {
        slot.heartbeat = { nextAt: null, everyMs: null, note: '' }
        this.unattendedWakes.delete(key)
        this.runs.create({
          workerId: worker.id,
          threadId,
          trigger: { kind: 'heartbeat', label: 'Heartbeat' },
          engine: worker.engine,
          state: 'missed',
          reason: `Stopped checking in after ${STALE_WAKEUPS} wake-ups with no word from you.`
        })
        this.dropWaiting(worker.id, threadId, 'Its repeating wake-up was stopped.')
        this.reachOut(worker.id, `${worker.name} stopped checking in`, `It woke ${STALE_WAKEUPS} times on its own with no word from you, so it stopped. Write to it to start again.`)
        return false
      }
    }

    const thread = this.thread(worker.id, threadId)
    const mail = slot.inbox.splice(0)
    this.watches.get(key)?.()
    this.watches.delete(key)
    if (woke) this.wakes.delete(worker.id)
    this.resumes.delete(key)
    this.retries.delete(key)
    const fired = heartbeatDue ? { ...slot.heartbeat } : null
    const note = woke
      ? CHECK_IN_NOTE
      : retry
        ? `${RETRY_NOTE} ("${retry.trigger.label}", which ${retry.state === 'failed' ? `failed${retry.error ? `: ${clip(retry.error, 200)}` : ''}` : retry.state}). Have another go at it${retry.sideEffects ? '; it may already have changed things, so check what was done before repeating anything' : ''}.`
        : resume
          ? RESUME_NOTE
          : heartbeatDue
            ? slot.heartbeat.note
            : null
    if (!priority) this.turnLog.set(worker.id, [...(this.turnLog.get(worker.id) ?? []), now])
    const cap = guestCap(mail, worker.access)
    // What this run may do: the worker's access, lowered by its thread's cap
    // and by the access of any colleague whose message is in it (a guest's
    // cap is handled by `cap`, which also gates tools).
    let access: WorkerAccess = worker.access
    const threadCap = info?.accessCap
    if (threadCap) access = weakerAccess(access, threadCap) as WorkerAccess
    for (const m of mail) if (m.senderAccess) access = weakerAccess(access, m.senderAccess) as WorkerAccess
    const origin: TurnOrigin = cap || mail.some((m) => m.from === 'guest' || m.channel?.cap) ? 'guest' : info?.kind === 'delegation' || mail.some((m) => m.from !== 'user') ? 'delegated' : 'user'
    // An active goal run (the main thread's): this turn works on it in goal
    // mode, and a continuation it was due for is used up.
    const goalRun = isMain && worker.goalRun?.status === 'active' ? worker.goalRun : null
    if (goalRun) worker.goalRun = { ...goalRun, turns: goalRun.turns + 1, nextAt: null }
    const setsGoal = mail.some((m) => m.goal)
    const delegation = info?.delegationId ? this.delegationList.find((d) => d.id === info.delegationId) : undefined

    const waitingOn = this.delegationList
      .filter((d) => isOpenDelegation(d) && d.parent.workerId === worker.id && d.parent.threadId === threadId)
      .map((d) => ({ id: d.id, to: d.recipient.name, objective: d.objective, state: d.state }))
    const user = buildTurnMessage(mail, note, now, routine ? [routine] : [], cap, goalRun && !setsGoal ? goalRun.text : null, {
      delegations: waitingOn,
      asks: worker.asks.map((a) => a.question)
    })
    const assistant: ChatMessage = { id: randomUUID(), role: 'assistant', parts: [], createdAt: now + 1 }
    thread.messages.push(user, assistant)

    // The receipt: the queued one if it waited, else a new one.
    const fromUser = mail.some((m) => m.from === 'user')
    const handoffMail = mail.find((m) => m.handoff)
    const trigger: ExecutionTrigger = retry
      ? { kind: 'retry', label: `Retry: ${retry.trigger.label}` }
      : resume
        ? { kind: 'resume', label: 'Picked up after Eaon quit' }
        : woke
          ? { kind: 'check-in', label: 'Check-in' }
          : routine
            ? { kind: 'routine', label: `Routine: ${routine.name}`, routineId: routine.id }
            : handoffMail
              ? { kind: 'delegation', label: `Task from ${handoffMail.fromName}`, ...(delegation ? { delegationId: delegation.id } : {}) }
              : fromUser
                ? { kind: 'message', label: mail.some((m) => m.channel) ? 'Message from a chat app' : 'Your message' }
                : mail.length > 0
                  ? { kind: 'mail', label: `Message from ${mail[0].fromName}` }
                  : goalRun
                    ? { kind: 'goal', label: 'Working toward its goal' }
                    : { kind: 'heartbeat', label: 'Heartbeat' }
    let reason: string | null = null
    if (routine && dueAt !== null && now - dueAt > 5 * 60_000) {
      // Missed occurrences run once, late, never as a burst.
      const every = routine.everyMs ?? DAY
      const skipped = Math.floor((now - dueAt) / every)
      reason = `Ran ${relativeTime(dueAt, now).replace(' ago', '')} late — Eaon was closed or the computer was asleep${skipped > 0 ? `; ${skipped} earlier run${skipped === 1 ? ' was' : 's were'} skipped` : ''}.`
    }
    let execution = this.waiting.get(key)
    this.waiting.delete(key)
    if (!execution) execution = this.runs.create({ workerId: worker.id, threadId, trigger, engine: worker.engine, retryOf: retry?.id ?? null })
    this.runs.update(execution, { state: 'running', trigger, reason, threadId, messageId: assistant.id, engine: worker.engine, retryOf: retry?.id ?? null })

    const run: Running = {
      workerId: worker.id,
      threadId,
      execution,
      controller: new AbortController(),
      messageId: assistant.id,
      goalTurn: goalRun !== null,
      mail,
      guestCap: cap,
      fired,
      firedRoutines: routine ? [routine.id] : [],
      activitySet: false,
      heartbeatSet: false,
      // Not for chat-app mail: the reply goes back to the chat it came from.
      userTriggered: woke || !!retry || mail.some((m) => m.from === 'user' && !m.channel),
      stoppedByUser: false,
      postedRooms: new Set(),
      access,
      origin,
      routineId: routine?.id ?? null,
      delegationId: delegation?.id ?? null,
      reported: false,
      asked: false,
      fromUser
    }
    this.running.set(key, run)
    slot.runningMessageId = assistant.id
    worker.status = 'working'
    if (isMain) worker.runningRooms = [...new Set(mail.flatMap((m) => (m.room ? [m.room.id] : [])))]
    worker.lastRunAt = now
    // The previous turn's line would read as what it is doing now.
    worker.activity = ''
    if (info) {
      info.activity = ''
      info.updatedAt = now
    }
    if (delegation && (delegation.state === 'assigned' || delegation.state === 'waiting')) this.settleDelegation(delegation, 'running')
    // A colleague's result reached the thread that asked for it.
    for (const m of mail) {
      const result = m.handoffResult && this.delegationList.find((d) => d.id === m.handoffResult!.id)
      if (result && result.deliveredAt === null) {
        result.deliveredAt = now
        this.commitDelegations()
      }
    }
    this.deps.onMessage?.(worker.id, clone(user), threadId)
    this.deps.onMessage?.(worker.id, clone(assistant), threadId)
    this.deps.saveThread(thread)
    this.commit()
    this.tell((o) => o.turnStarted?.(clone(worker), clone(mail)))

    const snapshot = clone(worker)
    // The persona and the turn's policy both read the access it really runs at.
    snapshot.access = access
    const creator = snapshot.createdBy ? (this.find(snapshot.createdBy)?.name ?? null) : null
    const work: Promise<void> = runWorkerTurn({
      worker: snapshot,
      threadId,
      thread,
      assistant,
      model: info?.model ?? snapshot.model,
      engineSession: slot.engineSession,
      persona: workerPersona(
        snapshot,
        creator,
        snapshot.trading ? (this.deps.tradingVenue?.(snapshot.trading.via) ?? null) : null,
        this.roomsFile.rooms
          .filter((r) => r.members.includes(snapshot.id))
          .map((r) => ({ name: r.name, members: r.members.filter((m) => m !== snapshot.id).map((m) => this.find(m)?.name ?? '').filter(Boolean) })),
        info ? { title: info.title, kind: info.kind, ...(delegation ? { delegation } : {}) } : null
      ),
      settings: this.deps.getSettings(),
      signal: run.controller.signal,
      runAgent: this.deps.runAgent,
      runEngineTurn: this.deps.runEngineTurn,
      allowOnce: (tool, input) => this.allowOnce(snapshot.id, tool, input),
      guestCap: cap,
      origin,
      stallMs: this.deps.stallMs,
      goal: goalRun ? { text: goalRun.text, status: 'active', iterations: goalRun.iterations } : null,
      onToolRun: (_name, mutating) => {
        if (mutating && !execution.sideEffects) this.runs.update(execution, { sideEffects: true })
      },
      onEvent: (event) => {
        if (event.type === 'goal' && isMain) this.goalProgress(snapshot.id, event.goal)
        if (event.type === 'usage') this.runs.addUsage(execution, event.usage)
        this.deps.onEvent?.(snapshot.id, event, threadId)
      }
    })
      .catch((error): TurnOutcome => ({ text: '', error: errorText(error), cancelled: false }))
      .then((outcome) => this.finish(run, assistant, outcome))
      .catch((error) => console.error('[workers] failed to record a turn:', error))
      .finally(() => {
        this.inflight.delete(work)
      })
    this.inflight.add(work)
    return true
  }

  private finish(run: Running, assistant: ChatMessage, outcome: TurnOutcome): void {
    // Quitting already recorded the turn as interrupted.
    if (this.disposed) return
    const key = slotKey(run.workerId, run.threadId)
    if (this.running.get(key) === run) this.running.delete(key)
    const now = this.now()
    const execution = run.execution
    const ended = {
      state: outcome.error ? ('failed' as const) : outcome.cancelled ? ('cancelled' as const) : ('completed' as const),
      // Why it ended as it did; a notice from the engine (a fresh session
      // after the old one was lost) is worth showing when nothing else is.
      reason: outcome.cancelled && !outcome.error ? (run.stoppedByUser ? 'Stopped.' : 'Cut short before it finished.') : (execution.reason ?? outcome.notice ?? null),
      billing: outcome.billing === 'plan' ? ('plan' as const) : outcome.billing === 'api-key' ? ('api' as const) : null,
      error: outcome.error ?? null,
      result: outcome.text ? clip(summariseReply(outcome.text) || outcome.text, 300) : null,
      usage: outcome.usage ?? execution.usage,
      providerId: outcome.providerId ?? null,
      modelId: outcome.modelId ?? null,
      sideEffects: execution.sideEffects || outcome.sideEffects === true
    }
    const worker = this.find(run.workerId)
    if (!worker) {
      this.tick()
      return
    }
    const info = this.info(worker, run.threadId)
    const slot = this.slot(worker, run.threadId)
    if (!slot) {
      // The thread was deleted while its turn wound down.
      this.runs.update(execution, { ...ended, state: 'cancelled', reason: 'The thread was deleted.' })
      worker.status = this.isRunning(worker.id) ? 'working' : this.restingStatus(worker)
      this.commit()
      this.tick()
      return
    }
    slot.runningMessageId = null
    if (run.threadId === MAIN_THREAD) worker.runningRooms = []
    if (outcome.sessionId !== undefined) slot.engineSession = outcome.sessionId ? { engine: worker.engine, sessionId: outcome.sessionId } : null

    // The heartbeat this turn used up: a steady beat carries on from now, a
    // one-off is spent — unless the worker scheduled something itself.
    if (run.fired && !run.heartbeatSet) {
      slot.heartbeat = run.fired.everyMs
        ? { ...run.fired, nextAt: now + Math.max(run.fired.everyMs, MIN_HEARTBEAT_MS) }
        : { nextAt: null, everyMs: null, note: '' }
    }

    // Routines that ran come round again; a routine that failed says so in
    // its log and does not retry until its next time — no loops.
    for (const routineId of run.firedRoutines) {
      const routine = worker.routines.find((r) => r.id === routineId)
      if (!routine) continue
      routine.runs = [...routine.runs, { at: now, ok: !outcome.error }].slice(-20)
      routine.nextAt = routineNextAt(routine, now)
    }

    // The goal run after this turn. Unfinished, it carries on by itself in a
    // fresh turn shortly, unless the worker chose its own wake-up (a sleep or
    // a heartbeat), and checks in with the user after GOAL_MAX_TURNS. A
    // failed turn, or the user stopping it, pauses it.
    const goal = worker.goalRun
    if (goal && run.goalTurn) {
      if (outcome.error) {
        worker.goalRun = { ...goal, status: 'paused', summary: 'The last turn failed', nextAt: null }
      } else if (outcome.cancelled && run.stoppedByUser) {
        worker.goalRun = { ...goal, status: 'paused', pausedByUser: true, summary: 'Stopped', nextAt: null }
      } else if (outcome.cancelled) {
        // Cut short some other way (the worker paused, Eaon quitting): pick it up again later.
        if (goal.status === 'active') worker.goalRun = { ...goal, nextAt: now + GOAL_CONTINUE_MS }
      } else if (goal.status === 'active' || (goal.status === 'paused' && !goal.pausedByUser)) {
        const { summary: _summary, ...rest } = goal
        if (goal.turns >= GOAL_MAX_TURNS) {
          worker.goalRun = { ...goal, status: 'paused', summary: `Paused after ${GOAL_MAX_TURNS} turns on it; resume to keep going`, nextAt: null }
          this.deps.reachOut?.(clone(worker), {
            title: `${worker.name} paused its goal`,
            body: `It worked on "${goal.text}" for ${GOAL_MAX_TURNS} turns. Resume the goal to keep going.`
          })
        } else {
          const ownWake = run.heartbeatSet && worker.heartbeat.nextAt !== null
          worker.goalRun = { ...rest, status: 'active', nextAt: ownWake ? null : now + GOAL_CONTINUE_MS }
        }
      }
    }

    // How it went, on the thread and (for the main thread) the worker.
    const summary = outcome.text ? summariseReply(outcome.text) : ''
    if (info) {
      if (outcome.error) {
        info.lastError = outcome.error
        info.lastOutcome = { at: now, ok: false }
      } else if (!outcome.cancelled) {
        info.lastError = null
        info.lastOutcome = { at: now, ok: true }
        if (!run.activitySet) info.activity = summary
      } else if (run.stoppedByUser && !run.activitySet) info.activity = 'Stopped'
      info.updatedAt = now
    }
    if (run.threadId === MAIN_THREAD) {
      if (outcome.error) {
        worker.lastError = outcome.error
        worker.lastOutcome = { at: now, ok: false }
      } else if (outcome.cancelled) {
        if (!run.activitySet && run.stoppedByUser) worker.activity = 'Stopped'
      } else {
        worker.lastOutcome = { at: now, ok: true }
        worker.lastError = null
        if (!run.activitySet) worker.activity = summary
      }
    } else if (!run.activitySet && !outcome.error && !outcome.cancelled && summary) {
      worker.activity = summary
    }
    // The face: working while any thread works; failed only when the main
    // conversation's last turn failed — a routine failing doesn't knock the
    // whole worker out (its receipt and thread say so).
    if (worker.paused) worker.status = 'paused'
    else if (this.isRunning(worker.id)) worker.status = 'working'
    else if (run.threadId === MAIN_THREAD && outcome.error) worker.status = 'failed'
    else if (worker.status === 'failed' && run.threadId !== MAIN_THREAD) worker.status = 'failed'
    else worker.status = this.restingStatus(worker)

    this.runs.update(execution, ended)

    // The delegated job this thread works on, if it is one.
    const delegation = run.delegationId ? this.delegationList.find((d) => d.id === run.delegationId) : undefined
    if (delegation && isOpenDelegation(delegation)) {
      if (outcome.error) this.endDelegation(delegation, 'failed', `${worker.name} hit a problem: ${clip(outcome.error, 300)}`)
      else if (outcome.cancelled && run.stoppedByUser) this.endDelegation(delegation, 'cancelled', `You stopped ${worker.name}’s work on it.`)
      else if (!outcome.cancelled && !run.reported) {
        // Waiting on the user (it asked) or on its own wake-up: not done yet.
        if (slot.heartbeat.nextAt !== null || run.asked || worker.asks.some((a) => a.threadId === run.threadId)) this.settleDelegation(delegation, 'waiting')
        else this.autoReport(worker, delegation, assistant)
      }
    }
    if (info && delegation && !isOpenDelegation(delegation) && !info.closedAt && slot.inbox.length === 0) info.closedAt = now

    const thread = this.threads.get(threadKey(run.workerId, run.threadId))
    if (thread && thread.messages.includes(assistant)) {
      // A turn only group-chat posts woke answers in the room, where the user reads it.
      if (!(run.mail.length > 0 && run.mail.every((m) => m.room))) {
        worker.unread += 1
        if (info) info.unread += 1
      }
      this.prune(thread)
      this.deps.onMessage?.(run.workerId, clone(assistant), run.threadId)
      this.deps.saveThread(thread)
    }
    this.commit()
    if (!outcome.cancelled && run.threadId === MAIN_THREAD) this.replyInRooms(worker, run, assistant, outcome)
    this.tell((o) =>
      o.turnEnded?.(clone(worker), { mail: clone(run.mail), reply: clone(assistant), ...(outcome.error ? { error: outcome.error } : {}), cancelled: outcome.cancelled })
    )
    if (run.userTriggered && !outcome.cancelled) {
      this.deps.notify?.(clone(worker), {
        ok: !outcome.error,
        text: outcome.error ?? (summariseReply(outcome.text) || 'Finished.')
      })
    } else if (run.routineId && outcome.error) {
      const routine = worker.routines.find((r) => r.id === run.routineId)
      this.deps.reachOut?.(clone(worker), { title: `${worker.name}’s routine “${routine?.name ?? 'routine'}” failed`, body: clip(outcome.error, 300) })
    }
    this.tick()
  }

  /**
   * A delegated job's turn ended without finish_handoff and with nothing
   * scheduled to come back to it: its last reply is sent to the worker that
   * asked, so that worker is never left waiting on a colleague that forgot.
   */
  private autoReport(worker: Worker, delegation: WorkerDelegation, assistant: ChatMessage): void {
    const text = finalReply(assistant) || 'Finished, with nothing to report.'
    const parent = this.find(delegation.parent.workerId)
    this.settleDelegation(delegation, 'completed', { result: clip(text, 8000) })
    if (!parent) return
    const threadId = delegation.parent.threadId === MAIN_THREAD || this.info(parent, delegation.parent.threadId) ? delegation.parent.threadId : MAIN_THREAD
    this.deliverMail(
      parent,
      {
        id: randomUUID(),
        from: worker.id,
        fromName: worker.name,
        fromColor: worker.color,
        text: clip(text, POST_CHARS),
        files: [],
        at: this.now(),
        handoffResult: { id: delegation.id, task: delegation.objective, ok: true, state: 'completed' }
      },
      threadId
    )
  }

  /**
   * A turn woken by a group chat answers there: its final reply is posted to
   * each room its mail came from, unless it already posted there itself with
   * post_to_room. A failed turn says so in the room, so the user isn't left
   * waiting on a silent member.
   */
  private replyInRooms(worker: Worker, run: Running, assistant: ChatMessage, outcome: TurnOutcome): void {
    const rooms = new Map<string, string>()
    for (const mail of run.mail) if (mail.room) rooms.set(mail.room.id, mail.room.name)
    for (const roomId of rooms.keys()) {
      if (run.postedRooms.has(roomId)) continue
      const room = this.roomsFile.rooms.find((r) => r.id === roomId && r.members.includes(worker.id))
      if (!room) continue
      const text = outcome.error ? `I hit a problem and couldn’t finish: ${outcome.error}` : finalReply(assistant)
      if (!text) continue
      void this.publish(worker, room, text, []).catch((error) => console.error('[workers] room reply failed:', error))
    }
  }

  /**
   * A thread lasts forever, but what a compaction summary already covers
   * need not: past THREAD_KEEP messages, the oldest summarised ones go. Nothing
   * the model still reads is ever dropped.
   */
  private prune(thread: WorkerThread): void {
    if (thread.messages.length <= THREAD_KEEP || !thread.summary) return
    const cut = thread.messages.findIndex((m) => m.id === thread.summary!.throughMessageId)
    if (cut === -1) return
    const drop = Math.min(thread.messages.length - THREAD_KEEP, cut + 1)
    if (drop > 0) thread.messages.splice(0, drop)
  }
}

/** A tool's own name without a namespace a model put in front of it; see agent/approvalKey. */
export { bareToolName as toolName } from '../../agent/approvalKey'
