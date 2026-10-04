import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { cp, lstat, mkdir, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import type { ChatMessage, Settings, StreamEvent } from '@shared/types'
import {
  MAX_GOAL_CHARS,
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
  type WorkerTrading,
  type WorkerHeartbeat,
  type WorkerAsk,
  type WorkerMail,
  type WorkerMood,
  type WorkerSendOptions,
  type WorkerThread,
  type RoomPost,
  type WorkerHandoff,
  type WorkerRoom,
  type WorkerTemplate
} from '@shared/workers'
import type { GuestAccess } from '@shared/channels'
import { summariseReply } from '../scheduler/transcript'
import type { TradingVenue } from '../trading/access'
import { isOpen, nextOpen } from '../trading/marketHours'
import { guestCap } from './guests'
import { workerPersona } from './prompt'
import { buildTurnMessage, CHECK_IN_NOTE, runWorkerTurn, type RunAgent, type TurnOutcome } from './runner'

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
  getSettings: () => Settings
  loadWorkers: () => unknown
  saveWorkers: (workers: Worker[]) => void
  loadThread: (id: string) => unknown
  saveThread: (thread: WorkerThread) => void
  deleteThread: (id: string) => void | Promise<void>
  /** The whole list, on every metadata change (never per token). */
  onChange?: (workers: Worker[]) => void
  onEvent?: (workerId: string, event: StreamEvent) => void
  /** A message was added to, or replaced whole in, a thread. */
  onMessage?: (workerId: string, message: ChatMessage) => void
  /** A turn the user started (mail or "Wake now") ended. */
  notify?: (worker: Worker, outcome: { ok: boolean; text: string }) => void
  /** A worker reached out on its own (notify_user) or asked the user something (ask_user). */
  reachOut?: (worker: Worker, message: { title: string; body: string }) => void
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
  controller: AbortController
  messageId: string
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
}

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

/** A file-system-safe folder name from a worker's name: "Data Wrangler" → "Data-Wrangler". */
export function workerSlug(name: string): string {
  return (
    name
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/^[.-]+/, '')
      .slice(0, 48) || 'Worker'
  )
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

/** Fills in anything an older or hand-edited file lacks. */
function normalize(raw: Partial<Worker> & { id: string; name: string }, now: number): Worker {
  const heartbeat = raw.heartbeat ?? { nextAt: null, everyMs: null, note: '' }
  return {
    id: raw.id,
    name: raw.name,
    color: typeof raw.color === 'string' ? raw.color : WORKER_COLORS[0],
    personality: str(raw.personality),
    purpose: str(raw.purpose),
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
    createdBy: typeof raw.createdBy === 'string' ? raw.createdBy : null,
    model: raw.model && typeof raw.model.providerId === 'string' && typeof raw.model.modelId === 'string' ? raw.model : null,
    folder: typeof raw.folder === 'string' ? raw.folder : '',
    paused: raw.paused === true,
    access: raw.access === 'read-only' || raw.access === 'autonomous' ? raw.access : 'safe',
    trading: normalizeTrading(raw.trading),
    heartbeat: {
      nextAt: typeof heartbeat.nextAt === 'number' ? heartbeat.nextAt : null,
      everyMs: typeof heartbeat.everyMs === 'number' ? heartbeat.everyMs : null,
      note: typeof heartbeat.note === 'string' ? heartbeat.note : ''
    },
    routines: Array.isArray(raw.routines)
      ? raw.routines.filter((r) => r && typeof r.id === 'string' && typeof r.nextAt === 'number').map((r) => ({ ...r, runs: Array.isArray(r.runs) ? r.runs : [] }))
      : [],
    goal: typeof raw.goal === 'string' ? raw.goal : '',
    notes: typeof raw.notes === 'string' ? raw.notes : '',
    asks: Array.isArray(raw.asks) ? raw.asks.filter((a) => a && typeof a.id === 'string' && typeof a.question === 'string') : [],
    status: raw.status ?? 'asleep',
    activity: typeof raw.activity === 'string' ? raw.activity : '',
    moodHint: raw.moodHint ?? null,
    lastRunAt: typeof raw.lastRunAt === 'number' ? raw.lastRunAt : null,
    lastOutcome: raw.lastOutcome ?? null,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : null,
    inbox: Array.isArray(raw.inbox) ? raw.inbox : [],
    handoffs: Array.isArray(raw.handoffs) ? raw.handoffs.filter((h) => h && typeof h.id === 'string' && typeof h.task === 'string') : [],
    unread: typeof raw.unread === 'number' ? raw.unread : 0,
    runningMessageId: typeof raw.runningMessageId === 'string' ? raw.runningMessageId : null,
    runningRooms: []
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

/** Everything under `path`, in bytes, without following symlinks. */
async function sizeOf(path: string, limit: number): Promise<number> {
  const info = await lstat(path)
  if (!info.isDirectory()) return info.size
  let total = 0
  for (const entry of await readdir(path)) {
    total += await sizeOf(join(path, entry), limit)
    if (total > limit) return total
  }
  return total
}

/** `dir/name`, or `dir/name (2).ext` and so on when that is taken. */
function freePath(dir: string, name: string): string {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let candidate = join(dir, name)
  for (let n = 2; existsSync(candidate); n++) candidate = join(dir, `${stem} (${n})${ext}`)
  return candidate
}

/** Key order made irrelevant, so an approved call matches the retry exactly. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
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
  private grants = new Map<string, { tool: string; input: string; expires: number }[]>()
  private workers: Worker[] = []
  private roomsFile: RoomsFile = { rooms: [], posts: {}, seen: {} }
  /** Per room, how many times workers have woken each other since the user last posted there. */
  private readonly roomChains = new Map<string, number>()
  private readonly threads = new Map<string, WorkerThread>()
  private readonly running = new Map<string, Running>()
  private readonly inflight = new Set<Promise<void>>()
  private readonly observers = new Set<WorkerObserver>()
  /** "Wake now" requests waiting for their turn, by worker id → when asked. */
  private readonly wakes = new Map<string, number>()
  /** Start times of budgeted turns, per worker. */
  private readonly turnLog = new Map<string, number[]>()
  /** When each worker sent mail, for the per-hour cap. */
  private readonly sentLog = new Map<string, number[]>()
  /** When workers created workers, for the per-day cap. */
  private createdLog: number[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private interval: ReturnType<typeof setInterval> | null = null
  private started = false
  private disposed = false
  private readonly now: () => number

  constructor(private readonly deps: WorkersDeps) {
    this.now = deps.now ?? Date.now
  }

  /* --------------------------------------------------------------- lifecycle */

  /** Reads saved workers and repairs any turn a quit or crash cut short. Nothing runs until `start()`. */
  load(): void {
    const now = this.now()
    const raw = this.deps.loadWorkers()
    this.workers = (Array.isArray(raw) ? raw : []).filter(isWorkerLike).map((w) => normalize(w, now))
    for (const worker of this.workers) {
      if (worker.status !== 'working' && !worker.runningMessageId) continue
      const thread = this.thread(worker.id)
      const message = thread.messages.find((m) => m.id === worker.runningMessageId) ?? thread.messages[thread.messages.length - 1]
      if (sealInterrupted(message)) this.deps.saveThread(thread)
      worker.status = worker.paused ? 'paused' : 'idle'
      worker.runningMessageId = null
      worker.lastError = 'Interrupted when Eaon quit'
    }
    this.createdLog = this.workers.filter((w) => w.createdBy !== null).map((w) => w.createdAt)
    this.deps.saveWorkers(this.workers)
    this.roomsFile = normalizeRooms(this.deps.loadRooms?.() ?? null, new Set(this.workers.map((w) => w.id)))
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
   * so a running turn is recorded as interrupted here rather than trusting it
   * to report back before the process goes.
   */
  stop(): void {
    this.started = false
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    if (this.interval) clearInterval(this.interval)
    this.timer = null
    this.interval = null
    for (const [id, run] of this.running) {
      run.controller.abort()
      const worker = this.find(id)
      const thread = this.threads.get(id)
      if (thread) {
        sealInterrupted(thread.messages.find((m) => m.id === run.messageId))
        this.deps.saveThread(thread)
      }
      if (worker) {
        worker.status = worker.paused ? 'paused' : 'idle'
        worker.runningMessageId = null
        worker.runningRooms = []
        worker.lastError = 'Interrupted when Eaon quit'
      }
    }
    this.running.clear()
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

  getThread(id: string): WorkerThread {
    this.require(id)
    return clone(this.thread(id))
  }

  isRunning(id: string): boolean {
    return this.running.has(id)
  }

  /** The guest cap of the turn running now, or null when none runs or no guest wrote. */
  turnCap(id: string): GuestAccess | null {
    return this.running.get(id)?.guestCap ?? null
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
    const model =
      draft.model === undefined
        ? (existing?.model ?? null)
        : draft.model && str(draft.model.providerId) && str(draft.model.modelId)
          ? { providerId: str(draft.model.providerId), modelId: str(draft.model.modelId) }
          : null
    const access =
      draft.access === 'read-only' || draft.access === 'safe' || draft.access === 'autonomous' ? draft.access : (existing?.access ?? 'autonomous')
    const personality = str(draft.personality).slice(0, 600)
    const purpose = str(draft.purpose).slice(0, 2000)
    const trading = draft.trading === undefined ? (existing?.trading ?? null) : draft.trading === null ? null : normalizeTrading(draft.trading, true)

    if (existing) {
      Object.assign(existing, { name, color, personality, purpose, model, access, trading })
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
      folder,
      paused: false,
      access,
      trading,
      heartbeat: { nextAt: null, everyMs: null, note: '' },
      routines: [],
      goal: '',
      notes: '',
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
      handoffs: [],
      unread: 0,
      runningMessageId: null
    }
    this.syncTradingRoutine(worker)
    this.workers.push(worker)
    const thread: WorkerThread = { workerId: worker.id, messages: [], summary: null }
    this.threads.set(worker.id, thread)
    this.deps.saveThread(thread)
    this.commit()
    return clone(worker)
  }

  /** Stops any running turn and forgets the worker. Its folder stays on disk. */
  async remove(id: string): Promise<void> {
    const run = this.running.get(id)
    if (run) {
      run.stoppedByUser = true
      run.controller.abort()
    }
    this.workers = this.workers.filter((w) => w.id !== id)
    this.threads.delete(id)
    this.wakes.delete(id)
    this.turnLog.delete(id)
    this.sentLog.delete(id)
    if (this.roomsFile.rooms.some((r) => r.members.includes(id))) {
      for (const room of this.roomsFile.rooms) room.members = room.members.filter((m) => m !== id)
      this.commitRooms()
    }
    this.commit()
    await this.deps.deleteThread(id)
  }

  /**
   * The user writes to a worker. It reads it as soon as it is free.
   *
   * Colleagues the message @mentions get their own copy, as they would in a
   * group chat: the user addressed them, so they hear it straight away
   * rather than only if this worker decides to pass it on. This worker is
   * told they have it, so it doesn't forward it again. Only the user's own
   * messages route this way; a guest's (channels, `receive`) never reach
   * other workers by naming them.
   */
  send(id: string, text: string, files: string[] = [], options: WorkerSendOptions = {}): void {
    const worker = this.require(id)
    const body = typeof text === 'string' ? text.trim() : ''
    const paths = (Array.isArray(files) ? files : []).filter((f): f is string => typeof f === 'string' && f.length > 0)
    if (!body && paths.length === 0) throw new Error('Write a message first.')
    const at = this.now()
    const goal = options?.goal === true && body.length > 0
    if (goal) worker.goal = body.slice(0, MAX_GOAL_CHARS)
    const mentioned = mentionedWorkers(body, this.workers, worker.id)
    this.deliverMail(worker, {
      id: randomUUID(),
      from: 'user',
      fromName: 'You',
      text: body,
      files: paths,
      at,
      ...(goal ? { goal: true } : {}),
      ...(mentioned.length > 0 ? { mentions: mentioned.map((w) => ({ id: w.id, name: w.name })) } : {})
    })
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
  }

  /**
   * Mail from a chat app (features/channels). The owner's arrives as the
   * user's (`from: 'user'`); anyone else's as a guest's, carrying the cap
   * that holds the turn it lands in.
   */
  receive(id: string, mail: Omit<WorkerMail, 'id' | 'at'>): void {
    const worker = this.require(id)
    if (!mail.text.trim() && mail.files.length === 0) throw new Error('The message is empty.')
    this.deliverMail(worker, { ...mail, id: randomUUID(), at: this.now() })
    this.commit()
    this.tick()
  }

  /** Empties the thread and its summary. Mail, heartbeat and settings stay. */
  clear(id: string): void {
    const worker = this.require(id)
    const run = this.running.get(id)
    if (run) {
      run.stoppedByUser = true
      run.controller.abort()
    }
    const thread = this.thread(id)
    // In place: a turn still winding down holds this object, and must find
    // its message gone rather than write into a thread the user cleared.
    thread.messages.splice(0)
    thread.summary = null
    worker.unread = 0
    this.deps.saveThread(thread)
    this.commit()
  }

  setPaused(id: string, paused: boolean): Worker {
    const worker = this.require(id)
    worker.paused = paused
    if (paused) {
      const run = this.running.get(id)
      if (run) {
        run.stoppedByUser = true
        run.controller.abort()
      }
      worker.status = 'paused'
    } else if (!this.running.has(id)) {
      worker.status = this.restingStatus(worker)
    }
    this.commit()
    if (!paused) this.tick()
    return clone(worker)
  }

  /** "Wake now": a check-in turn the user asked for, as soon as the worker is free. */
  wake(id: string): void {
    const worker = this.require(id)
    if (worker.paused) throw new Error(`${worker.name} is paused. Resume it first.`)
    this.wakes.set(id, this.now())
    if (worker.status === 'asleep') worker.status = 'idle'
    this.commit()
    this.tick()
  }

  /** Aborts the running turn only; heartbeats and mail carry on. */
  stopTurn(id: string): void {
    const run = this.running.get(id)
    if (!run) return
    run.stoppedByUser = true
    run.controller.abort()
  }

  markRead(id: string): void {
    const worker = this.require(id)
    if (worker.unread === 0) return
    worker.unread = 0
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
    options: { shareContext?: boolean; extra?: Partial<WorkerMail> } = {}
  ): Promise<{ recipient: Worker; delivered: string[] }> {
    const sender = this.require(fromId)
    const target = this.lookup(to)
    if (!target) throw new Error(`There is no worker called "${to}". Use list_workers to see your colleagues.`)
    if (target.id === sender.id) throw new Error('That is you — message a colleague instead.')
    const body = text.trim()
    if (!body && files.length === 0) throw new Error('The message is empty.')
    const now = this.now()
    const sent = this.checkSendBudget(sender.id, now)
    const delivered = await this.copyFiles(sender, target, files)

    // The copy took time; either side may have been removed meanwhile.
    const recipient = this.find(target.id)
    const from = this.find(sender.id)
    if (!recipient) throw new Error(`${target.name} was removed while the files were being sent.`)
    this.sentLog.set(sender.id, [...sent, now])
    const context = options.shareContext ? this.threadExcerpt(sender.id, 10, CONTEXT_CHARS) : ''
    this.deliverMail(recipient, {
      id: randomUUID(),
      from: sender.id,
      fromName: from?.name ?? sender.name,
      fromColor: from?.color ?? sender.color,
      text: body,
      files: delivered,
      at: now,
      ...(context ? { context } : {}),
      ...options.extra
    })
    this.commit()
    this.tick()
    return { recipient: clone(recipient), delivered }
  }

  /** Sends left in the hour, or a model-facing error when the cap is reached. */
  private checkSendBudget(id: string, now: number): number[] {
    const sent = (this.sentLog.get(id) ?? []).filter((at) => at > now - HOUR)
    if (sent.length >= MAX_SENDS_PER_HOUR) {
      throw new Error(`You have sent ${MAX_SENDS_PER_HOUR} messages in the last hour. Wait before sending more, and batch what you need into one message.`)
    }
    return sent
  }

  /** Copies files from the sender's folder into `<target>/from-<sender>/`; the paths they landed at. */
  private async copyFiles(sender: Worker, target: Worker, files: string[]): Promise<string[]> {
    const sources = files.map((file) => (isAbsolute(file) ? file : resolve(sender.folder, file)))
    let total = 0
    for (const source of sources) {
      if (!existsSync(source)) throw new Error(`Cannot send ${source}: it does not exist.`)
      total += await sizeOf(source, MAX_TRANSFER_BYTES)
      if (total > MAX_TRANSFER_BYTES) throw new Error('Those files are over 500 MB together. Send a smaller set, or tell your colleague where to find them.')
    }
    const delivered: string[] = []
    if (sources.length > 0) {
      const inboxDir = join(target.folder, `from-${workerSlug(sender.name)}`)
      await mkdir(inboxDir, { recursive: true })
      for (const source of sources) {
        const dest = freePath(inboxDir, basename(source))
        await cp(source, dest, { recursive: true, errorOnExist: true, force: false })
        delivered.push(dest)
      }
    }
    return delivered
  }

  /**
   * The last `count` messages of a worker's thread as plain text — what the
   * user and colleagues told it, what it said, which tools it used — for a
   * colleague to read instead of being told everything again.
   */
  threadExcerpt(id: string, count: number, maxChars = CONTEXT_CHARS): string {
    const worker = this.require(id)
    const thread = this.thread(id)
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

  /* ---------------------------------------------------------------- handoffs */

  /**
   * One worker hands another a task. The recipient gets the task, the
   * sender's recent thread (so it needn't ask what's going on) and any
   * files, and keeps the task open until it reports back with
   * finish_handoff — which sends the result straight to the sender.
   */
  async handOff(fromId: string, to: string, task: string, files: string[] = [], shareContext = true): Promise<{ recipient: Worker; handoff: WorkerHandoff; delivered: string[] }> {
    const sender = this.require(fromId)
    const target = this.lookup(to)
    if (!target) throw new Error(`There is no worker called "${to}". Use list_workers to see your colleagues.`)
    const body = task.trim()
    if (!body) throw new Error('Say what the task is.')
    if (target.handoffs.length >= MAX_OPEN_HANDOFFS) throw new Error(`${target.name} already has ${MAX_OPEN_HANDOFFS} open tasks. Wait for some to finish.`)
    const handoff: WorkerHandoff = { id: `task_${randomUUID().slice(0, 8)}`, fromId: sender.id, fromName: sender.name, task: clip(body, 2000), at: this.now() }
    const { recipient, delivered } = await this.message(fromId, to, body, files, { shareContext, extra: { handoff: { id: handoff.id, task: handoff.task } } })
    const live = this.find(recipient.id)
    if (live) {
      live.handoffs.push(handoff)
      this.commit()
    }
    return { recipient, handoff, delivered }
  }

  /** The recipient reports back on a handed-off task; the result goes to whoever handed it over. */
  async finishHandoff(byId: string, handoffId: string, result: string, files: string[] = [], ok = true): Promise<string> {
    const worker = this.require(byId)
    const handoff = worker.handoffs.find((h) => h.id === handoffId.trim())
    if (!handoff) {
      const open = worker.handoffs.map((h) => `${h.id} (from ${h.fromName})`).join(', ')
      throw new Error(`No open task "${handoffId}".${open ? ` Open tasks: ${open}.` : ' You have no open tasks.'}`)
    }
    const close = (): void => {
      const live = this.find(byId)
      if (live) live.handoffs = live.handoffs.filter((h) => h.id !== handoff.id)
      this.commit()
    }
    const sender = this.find(handoff.fromId)
    if (!sender) {
      close()
      return `Closed ${handoff.id}. ${handoff.fromName} no longer exists, so the result went nowhere.`
    }
    // Sent first: if sending fails (the hourly cap), the task stays open to try again.
    await this.message(byId, sender.id, result.trim() || (ok ? 'Done.' : 'Could not finish it.'), files, {
      extra: { handoffResult: { id: handoff.id, task: handoff.task, ok } }
    })
    close()
    return `Sent the result to ${sender.name} and closed ${handoff.id}.`
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
  async postAsWorker(workerId: string, roomRef: string, text: string, files: string[] = []): Promise<{ room: WorkerRoom; woke: string[] }> {
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
    const run = this.running.get(workerId)
    if (run) run.postedRooms.add(room.id)
    const woke = await this.publish(worker, room, body, files)
    this.sentLog.set(workerId, [...sent, now])
    return { room: clone(room), woke }
  }

  /** Records a worker's post and wakes the colleagues it @mentions. Returns their names. */
  private async publish(worker: Worker, room: WorkerRoom, body: string, files: string[]): Promise<string[]> {
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
        delivered = await this.copyFiles(worker, colleague, files)
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
    if (worker.handoffs.length > 0) lines.push(`Open tasks: ${worker.handoffs.map((h) => `${h.id} from ${h.fromName}: ${clip(h.task, 120)}`).join('; ')}`)
    if (messages > 0) lines.push(`Recent thread:\n${this.threadExcerpt(worker.id, messages, 6000) || '(empty)'}`)
    return lines.filter(Boolean).join('\n')
  }

  /** A worker schedules its own wake-ups. Returns a sentence for the tool result. */
  /** The engine's clock (a test's fake one, or Date.now). */
  clock(): number {
    return this.now()
  }

  setHeartbeat(id: string, input: { inMinutes?: number; everyMinutes?: number; at?: number; note?: string; stop?: boolean }): string {
    const worker = this.require(id)
    const run = this.running.get(id)
    if (run) run.heartbeatSet = true
    if (input.stop) {
      worker.heartbeat = { nextAt: null, everyMs: null, note: '' }
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
    worker.heartbeat = { nextAt: now + first, everyMs: every, note: str(input.note).slice(0, 300) }
    if (worker.status === 'asleep') worker.status = 'idle'
    this.commit()
    const adjusted =
      (typeof input.at !== 'number' && typeof input.inMinutes === 'number' && input.inMinutes * 60_000 !== first) ||
      (typeof input.everyMinutes === 'number' && every !== null && input.everyMinutes * 60_000 !== every)
    return `Heartbeat set: next wake-up ${relativeTime(now + first, now)}${every ? `, then every ${Math.round(every / 60_000)} min` : ''}.${adjusted ? ' (Adjusted to stay between 1 minute and 7 days.)' : ''}`
  }

  /** The one-line status on the worker's card, and optionally a mood for the next half hour. */
  setStatus(id: string, activity: string, mood?: string): void {
    const worker = this.require(id)
    const run = this.running.get(id)
    if (run) run.activitySet = true
    worker.activity = str(activity).replace(/\s+/g, ' ').slice(0, 140)
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

  removeRoutine(id: string, name: string): string {
    const worker = this.require(id)
    const before = worker.routines.length
    worker.routines = worker.routines.filter((r) => r.name.toLowerCase() !== str(name).toLowerCase())
    if (worker.routines.length === before) throw new Error(`No routine called "${name}".`)
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
  ask(id: string, input: { question: string; options?: string[]; approve?: WorkerAsk['approve'] }): WorkerAsk {
    const worker = this.require(id)
    const question = str(input.question).slice(0, 800)
    if (!question) throw new Error('Ask a question.')
    if (worker.asks.length >= 10) throw new Error('You already have 10 questions waiting. Wait for answers before asking more.')
    const ask: WorkerAsk = {
      id: randomUUID(),
      question,
      options: (input.options ?? []).map(str).filter(Boolean).slice(0, 4),
      approve: input.approve ?? null,
      at: this.now()
    }
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
        grants.push({ tool: toolName(ask.approve.tool), input: stableJson(ask.approve.input), expires: this.now() + DAY })
        this.grants.set(id, grants)
      }
      text = `${answer.approved ? 'Approved' : 'Declined'}: ${ask.approve.summary}${answer.text ? ` — ${answer.text}` : ''}${
        answer.approved ? ' You may now make exactly that call once.' : ''
      }`
    } else {
      text = str(answer.text) || '(no answer)'
    }
    this.deliverMail(worker, { id: randomUUID(), from: 'user', fromName: 'You', text: `[Answer to "${ask.question.slice(0, 120)}"] ${text}`, files: [], at: this.now() })
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
    const key = stableJson(input)
    const name = toolName(tool)
    const index = grants.findIndex((g) => toolName(g.tool) === name && g.input === key && g.expires > this.now())
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

  /** Starts every turn that is due, within the concurrency limit. Safe to call any time. */
  tick(): void {
    if (!this.started) return
    const now = this.now()
    const concurrency = this.deps.concurrency ?? WORKER_CONCURRENCY
    const due = this.workers
      .filter((w) => !w.paused && !this.running.has(w.id) && this.isDue(w, now))
      .sort((a, b) => this.waitingSince(a, now) - this.waitingSince(b, now))
    let changed = false
    for (const worker of due) {
      if (this.running.size >= concurrency) break
      const priority = worker.inbox.some((m) => m.from === 'user') || this.wakes.has(worker.id)
      if (!priority && this.overBudget(worker.id, now)) {
        const note = `Resting — woke ${this.deps.maxTurnsPerHour ?? MAX_TURNS_PER_HOUR} times in the last hour`
        if (worker.activity !== note) {
          worker.activity = note
          changed = true
        }
        continue
      }
      this.begin(worker, priority)
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

  private thread(id: string): WorkerThread {
    let thread = this.threads.get(id)
    if (!thread) {
      const raw = this.deps.loadThread(id) as Partial<WorkerThread> | null
      thread = {
        workerId: id,
        messages: Array.isArray(raw?.messages) ? raw!.messages : [],
        summary: raw?.summary && typeof raw.summary.text === 'string' ? raw.summary : null
      }
      this.threads.set(id, thread)
    }
    return thread
  }

  private commit(): void {
    this.deps.saveWorkers(this.workers)
    this.deps.onChange?.(clone(this.workers))
    this.arm()
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.started) return
    const now = this.now()
    const slotFree = this.running.size < (this.deps.concurrency ?? WORKER_CONCURRENCY)
    let soonest = Infinity
    for (const w of this.workers) {
      const next = this.nextWake(w)
      if (w.paused || this.running.has(w.id) || next === null) continue
      // Due but unable to start — every slot is busy, or it is resting past
      // its hourly cap. `finish()` ticks when a slot frees and the interval
      // re-checks the cap; arming a 0 ms timer for it here would have tick()
      // skip it and re-arm straight away, spinning the main process for as
      // long as it stays blocked.
      if (next <= now && (!slotFree || this.overBudget(w.id, now))) continue
      soonest = Math.min(soonest, next)
    }
    if (soonest === Infinity) return
    const delay = Math.min(Math.max(soonest - now, 0), MAX_DELAY)
    this.timer = setTimeout(() => {
      this.timer = null
      this.tick()
    }, delay)
    this.timer.unref?.()
  }

  /** The soonest timed wake-up — the heartbeat or any routine — or null. */
  private nextWake(worker: Worker): number | null {
    let next = worker.heartbeat.nextAt ?? Infinity
    for (const routine of worker.routines) next = Math.min(next, routine.nextAt)
    return next === Infinity ? null : next
  }

  private isDue(worker: Worker, now: number): boolean {
    const next = this.nextWake(worker)
    return worker.inbox.length > 0 || this.wakes.has(worker.id) || (next !== null && next <= now)
  }

  private waitingSince(worker: Worker, now: number): number {
    let since = Infinity
    if (worker.inbox.length > 0) since = Math.min(since, worker.inbox[0].at)
    const wake = this.wakes.get(worker.id)
    if (wake !== undefined) since = Math.min(since, wake)
    const next = this.nextWake(worker)
    if (next !== null && next <= now) since = Math.min(since, next)
    return since
  }

  private overBudget(id: string, now: number): boolean {
    const log = (this.turnLog.get(id) ?? []).filter((at) => at > now - HOUR)
    this.turnLog.set(id, log)
    return log.length >= (this.deps.maxTurnsPerHour ?? MAX_TURNS_PER_HOUR)
  }

  private restingStatus(worker: Worker): Worker['status'] {
    if (worker.paused) return 'paused'
    return this.nextWake(worker) !== null || worker.inbox.length > 0 || this.wakes.has(worker.id) ? 'idle' : 'asleep'
  }

  private deliverMail(worker: Worker, mail: WorkerMail): void {
    worker.inbox.push(mail)
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

  private begin(worker: Worker, priority: boolean): void {
    const now = this.now()
    const thread = this.thread(worker.id)
    const mail = worker.inbox.splice(0)
    const woke = this.wakes.has(worker.id)
    this.wakes.delete(worker.id)
    const heartbeatDue = worker.heartbeat.nextAt !== null && worker.heartbeat.nextAt <= now
    const fired = heartbeatDue ? { ...worker.heartbeat } : null
    const note = woke ? CHECK_IN_NOTE : heartbeatDue ? worker.heartbeat.note : null
    const routines = worker.routines.filter((r) => r.nextAt <= now)
    if (!priority) this.turnLog.set(worker.id, [...(this.turnLog.get(worker.id) ?? []), now])
    const cap = guestCap(mail, worker.access)

    const user = buildTurnMessage(mail, note, now, routines, cap)
    const assistant: ChatMessage = { id: randomUUID(), role: 'assistant', parts: [], createdAt: now + 1 }
    thread.messages.push(user, assistant)

    const run: Running = {
      controller: new AbortController(),
      messageId: assistant.id,
      mail,
      guestCap: cap,
      fired,
      firedRoutines: routines.map((r) => r.id),
      activitySet: false,
      heartbeatSet: false,
      // Not for chat-app mail: the reply goes back to the chat it came from.
      userTriggered: woke || mail.some((m) => m.from === 'user' && !m.channel),
      stoppedByUser: false,
      postedRooms: new Set()
    }
    this.running.set(worker.id, run)
    worker.status = 'working'
    worker.runningMessageId = assistant.id
    worker.runningRooms = [...new Set(mail.flatMap((m) => (m.room ? [m.room.id] : [])))]
    worker.lastRunAt = now
    // The previous turn's line would read as what it is doing now.
    worker.activity = ''
    this.deps.onMessage?.(worker.id, clone(user))
    this.deps.onMessage?.(worker.id, clone(assistant))
    this.deps.saveThread(thread)
    this.commit()
    this.tell((o) => o.turnStarted?.(clone(worker), clone(mail)))

    const snapshot = clone(worker)
    const creator = snapshot.createdBy ? (this.find(snapshot.createdBy)?.name ?? null) : null
    const work: Promise<void> = runWorkerTurn({
      worker: snapshot,
      thread,
      assistant,
      persona: workerPersona(
        snapshot,
        creator,
        snapshot.trading ? (this.deps.tradingVenue?.(snapshot.trading.via) ?? null) : null,
        this.roomsFile.rooms
          .filter((r) => r.members.includes(snapshot.id))
          .map((r) => ({ name: r.name, members: r.members.filter((m) => m !== snapshot.id).map((m) => this.find(m)?.name ?? '').filter(Boolean) }))
      ),
      settings: this.deps.getSettings(),
      signal: run.controller.signal,
      runAgent: this.deps.runAgent,
      allowOnce: (tool, input) => this.allowOnce(snapshot.id, tool, input),
      guestCap: cap,
      stallMs: this.deps.stallMs,
      onEvent: (event) => this.deps.onEvent?.(snapshot.id, event)
    })
      .catch((error): TurnOutcome => ({ text: '', error: errorText(error), cancelled: false }))
      .then((outcome) => this.finish(snapshot.id, run, assistant, outcome))
      .catch((error) => console.error('[workers] failed to record a turn:', error))
      .finally(() => {
        this.inflight.delete(work)
      })
    this.inflight.add(work)
  }

  private finish(id: string, run: Running, assistant: ChatMessage, outcome: TurnOutcome): void {
    // Quitting already recorded the turn as interrupted.
    if (this.disposed) return
    if (this.running.get(id) === run) this.running.delete(id)
    const worker = this.find(id)
    if (!worker) {
      this.tick()
      return
    }
    const now = this.now()
    worker.runningMessageId = null
    worker.runningRooms = []

    // The heartbeat this turn used up: a steady beat carries on from now, a
    // one-off is spent — unless the worker scheduled something itself.
    if (run.fired && !run.heartbeatSet) {
      worker.heartbeat = run.fired.everyMs
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

    if (outcome.error) {
      worker.status = 'failed'
      worker.lastError = outcome.error
      worker.lastOutcome = { at: now, ok: false }
    } else {
      if (outcome.cancelled) {
        if (!run.activitySet && run.stoppedByUser) worker.activity = 'Stopped'
      } else {
        worker.lastOutcome = { at: now, ok: true }
        worker.lastError = null
        if (!run.activitySet) worker.activity = summariseReply(outcome.text)
      }
      worker.status = this.restingStatus(worker)
    }
    if (worker.paused) worker.status = 'paused'

    const thread = this.threads.get(id)
    if (thread && thread.messages.includes(assistant)) {
      // A turn only group-chat posts woke answers in the room, where the user reads it.
      if (!(run.mail.length > 0 && run.mail.every((m) => m.room))) worker.unread += 1
      this.prune(thread)
      this.deps.onMessage?.(id, clone(assistant))
      this.deps.saveThread(thread)
    }
    this.commit()
    if (!outcome.cancelled) this.replyInRooms(worker, run, assistant, outcome)
    this.tell((o) =>
      o.turnEnded?.(clone(worker), { mail: clone(run.mail), reply: clone(assistant), ...(outcome.error ? { error: outcome.error } : {}), cancelled: outcome.cancelled })
    )
    if (run.userTriggered && !outcome.cancelled) {
      this.deps.notify?.(clone(worker), {
        ok: !outcome.error,
        text: outcome.error ?? (summariseReply(outcome.text) || 'Finished.')
      })
    }
    this.tick()
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
   * The thread lasts forever, but what a compaction summary already covers
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

/**
 * A tool's own name, without the namespace some models put in front of it
 * when they name a tool as data: GPT-style models write "functions.email_send"
 * in ask_user's approve_tool, Gemini "default_api.email_send". Compared
 * literally, an approval for "functions.email_send" never matched the real
 * call to email_send, and an approved email was refused (Oct 1 2026).
 */
export function toolName(name: string): string {
  return String(name ?? '')
    .trim()
    .replace(/^(functions|default_api|tools?|api)[.:/]/i, '')
}
