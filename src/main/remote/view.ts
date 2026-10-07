import { homedir } from 'node:os'
import type { ChatMessage, ChatToolPart, StreamEvent } from '@shared/types'
import { workerMood, type Worker, type WorkerMail } from '@shared/workers'
import {
  REMOTE_LIMITS,
  type RemoteEvent,
  type RemoteMessage,
  type RemoteModelRef,
  type RemotePart,
  type RemoteWorker
} from '@shared/remote'

/**
 * What a phone is shown of a worker: the Worker and ChatMessage the engine
 * keeps, cut down to the contract in docs/remote-api.md.
 *
 * The cut is a safety measure as much as a tidy-up. A Worker holds its folder,
 * its inbox (with the paths of files colleagues sent), its notes and the full
 * arguments of every tool call; a message holds the model's reasoning and the
 * paths of attachments. None of that is copied across: each field below is
 * picked by name, and text the model wrote has the worker's folder and the
 * home directory scrubbed out of it.
 */

export type ToolPart = Extract<RemotePart, { kind: 'tool' }>

/* ------------------------------------------------------------------ paths */

/** Replaces this worker's folder with "." and the home directory with "~", wherever they appear. */
export type Scrub = ((text: string) => string) & { needles: string[] }

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A path, and the same with forward slashes where the platform uses backslashes. */
function spellings(path: string): string[] {
  // A root ("/") would blank every path in a message.
  if (path.length < 2) return []
  const slashed = path.replace(/\\/g, '/')
  return slashed === path ? [path] : [path, slashed]
}

export function pathScrubber(folder: string, home: string = homedir()): Scrub {
  const rules: [string, string][] = [...spellings(folder).map((n): [string, string] => [n, '.']), ...spellings(home).map((n): [string, string] => [n, '~'])]
  // Longest first: the folder usually sits inside the home directory, and the alternation takes the first that matches.
  rules.sort((a, b) => b[0].length - a[0].length)
  const replacement = new Map(rules)
  const pattern = rules.length > 0 ? new RegExp(rules.map(([needle]) => escapeRegExp(needle)).join('|'), 'g') : null
  const scrub = (text: string): string => (pattern ? text.replace(pattern, (found) => replacement.get(found) ?? found) : text)
  return Object.assign(scrub, { needles: rules.map(([needle]) => needle) })
}

/**
 * The scrub for text that arrives in pieces. A path split across two deltas
 * would get past a plain replace, so the tail of what has arrived is held back
 * while it could still turn out to be the start of a path.
 */
export class StreamScrub {
  private held = ''
  constructor(private readonly scrub: Scrub) {}

  push(text: string): string {
    const buffer = this.held + text
    let keep = 0
    for (const needle of this.scrub.needles) {
      for (let k = Math.min(needle.length - 1, buffer.length); k > keep; k--) {
        if (needle.startsWith(buffer.slice(buffer.length - k))) {
          keep = k
          break
        }
      }
    }
    this.held = buffer.slice(buffer.length - keep)
    return this.scrub(buffer.slice(0, buffer.length - keep))
  }

  /** What is still held, once nothing more will follow. */
  flush(): string {
    const rest = this.scrub(this.held)
    this.held = ''
    return rest
  }
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/* ------------------------------------------------------------------ tools */

const TITLES: Record<string, string> = {
  run_command: 'Ran a command',
  read_file: 'Read a file',
  list_dir: 'Looked in a folder',
  grep: 'Searched the files',
  codebase_search: 'Searched the code',
  find_file: 'Looked for a file',
  find_symbol: 'Looked for a symbol',
  edit_file: 'Edited a file',
  write_file: 'Wrote a file',
  delete_file: 'Deleted a file',
  move_file: 'Moved a file',
  web_search: 'Searched the web',
  web_fetch: 'Read a web page',
  web_browser: 'Used its browser',
  browser: 'Used the browser',
  computer: 'Used the computer',
  load_skill: 'Used a skill',
  use_plugin_tool: 'Used a plugin',
  plugin_tools: 'Looked at plugin tools',
  spawn_agents: 'Started sub-agents',
  update_plan: 'Updated its plan',
  goal_complete: 'Finished its goal',
  goal_blocked: 'Got stuck on its goal',
  schedule: 'Used the schedule',
  list_workers: 'Looked at the team',
  message_worker: 'Messaged a colleague',
  check_worker: 'Checked on a colleague',
  hand_off: 'Handed a task to a colleague',
  finish_handoff: 'Reported back on a task',
  post_to_room: 'Posted in a group chat',
  read_room: 'Read a group chat',
  create_worker: 'Created a worker',
  team: 'Worked with a team',
  set_heartbeat: 'Scheduled a wake-up',
  sleep: 'Went to sleep',
  wait: 'Waited',
  set_status: 'Updated its status',
  set_goal: 'Set its goal',
  update_notes: 'Updated its notes',
  add_routine: 'Added a routine',
  remove_routine: 'Removed a routine',
  ask_user: 'Asked you a question',
  notify_user: 'Told you something',
  email_inbox: 'Checked its email',
  email_read: 'Read an email',
  email_send: 'Sent an email',
  email_reply: 'Replied to an email',
  trading_account: 'Looked at the trading account',
  trading_quote: 'Got a quote',
  trading_history: 'Looked at prices',
  trading_order: 'Placed an order',
  trading_cancel: 'Cancelled an order',
  trading_session: 'Checked the market',
  send_chat_message: 'Posted in a chat',
  generate_image: 'Made an image'
}

export function toolTitle(name: string): string {
  const known = TITLES[name]
  if (known) return known
  // A plugin's own tool: "github__create_issue" → "Used github create issue".
  return clip(`Used ${name.replace(/__+|_+/g, ' ').trim() || 'a tool'}`, 60)
}

/**
 * Arguments worth a line next to the title. Picked by key rather than by
 * dumping the input: what a tool is given may hold what the user typed into a
 * password field or the body of a message.
 */
const DETAIL_KEYS = ['command', 'path', 'file_path', 'url', 'query', 'pattern', 'name', 'to', 'action', 'title', 'question', 'goal', 'activity', 'task', 'prompt', 'symbol', 'subject', 'chat']

export function toolDetail(name: string, input: Record<string, unknown> | undefined, scrub: (text: string) => string): string {
  const args = input && typeof input === 'object' ? input : {}
  const first = (...keys: string[]): string => {
    for (const key of keys) {
      const value = args[key]
      if (typeof value === 'string' && value.trim()) return value
    }
    return ''
  }
  let detail: string
  if (name === 'move_file') detail = [first('from'), first('to')].filter(Boolean).join(' → ')
  // The page it opened, never what it typed there.
  else if (name === 'web_browser') detail = [first('action'), first('url')].filter(Boolean).join(' ')
  else if (name === 'spawn_agents') detail = Array.isArray(args.agents) ? `${args.agents.length} agents` : ''
  else if (name === 'grep' || name === 'codebase_search' || name === 'find_symbol' || name === 'find_file') detail = first('pattern', 'query', 'name', 'path')
  else detail = first(...DETAIL_KEYS)
  return clip(oneLine(scrub(detail)), REMOTE_LIMITS.toolDetail)
}

export function remoteToolPart(part: Pick<ChatToolPart, 'id' | 'name' | 'input' | 'status' | 'output'>, scrub: Scrub): ToolPart {
  const detail = toolDetail(part.name, part.input, scrub)
  const output = part.output ? clip(scrub(part.output).trim(), REMOTE_LIMITS.toolOutput) : ''
  return {
    kind: 'tool',
    id: part.id,
    name: part.name,
    title: toolTitle(part.name),
    ...(detail ? { detail } : {}),
    status: part.status,
    ...(output ? { output } : {})
  }
}

/* ---------------------------------------------------------------- workers */

/** The soonest timed wake-up, as the engine counts it; null for a paused worker, which won't wake. */
export function nextWakeAt(worker: Worker): number | null {
  if (worker.paused) return null
  let next = worker.heartbeat.nextAt ?? Infinity
  for (const routine of worker.routines) next = Math.min(next, routine.nextAt)
  if (worker.goalRun?.status === 'active' && typeof worker.goalRun.nextAt === 'number') next = Math.min(next, worker.goalRun.nextAt)
  return next === Infinity ? null : next
}

export interface WorkerViewOptions {
  now?: number
  /** The name the model picker shows for a pinned model. */
  modelLabel?: (model: RemoteModelRef) => string | undefined
  scrub?: Scrub
}

export function remoteWorker(worker: Worker, options: WorkerViewOptions = {}): RemoteWorker {
  const now = options.now ?? Date.now()
  const scrub = options.scrub ?? pathScrubber(worker.folder)
  const goalRun = worker.goalRun
  return {
    id: worker.id,
    name: worker.name,
    color: worker.color,
    purpose: worker.purpose,
    personality: worker.personality,
    status: worker.status,
    mood: workerMood(worker, now),
    activity: scrub(worker.activity),
    paused: worker.paused,
    access: worker.access,
    model: worker.model
      ? { providerId: worker.model.providerId, modelId: worker.model.modelId, label: options.modelLabel?.(worker.model) ?? worker.model.modelId }
      : null,
    goal: scrub(worker.goal),
    goalRun: goalRun
      ? { text: scrub(goalRun.text), status: goalRun.status, turns: goalRun.turns, ...(goalRun.summary ? { summary: scrub(goalRun.summary) } : {}) }
      : null,
    asks: worker.asks.map((ask) => ({
      id: ask.id,
      question: scrub(ask.question),
      options: ask.options.map(scrub),
      approve: ask.approve ? { tool: ask.approve.tool, summary: scrub(ask.approve.summary) } : null,
      at: ask.at
    })),
    unread: worker.unread,
    lastRunAt: worker.lastRunAt,
    lastOutcome: worker.lastOutcome ? { at: worker.lastOutcome.at, ok: worker.lastOutcome.ok } : null,
    lastError: worker.lastError === null ? null : scrub(worker.lastError),
    nextWakeAt: nextWakeAt(worker),
    routines: worker.routines.map((r) => ({ id: r.id, name: r.name, task: scrub(r.task), everyMs: r.everyMs, daily: r.daily, nextAt: r.nextAt })),
    runningMessageId: worker.runningMessageId,
    createdAt: worker.createdAt
  }
}

/* --------------------------------------------------------------- messages */

/** Several pieces of mail as one text: each from someone else is led by their name. */
function mailText(mail: WorkerMail[], scrub: Scrub): string {
  return mail
    .map((item) => {
      const files = item.files.length
      // The attachments' paths stay behind; the phone only hears that there were some.
      const body = scrub(item.text.trim()) || (files > 0 ? `[${files === 1 ? '1 file' : `${files} files`} attached]` : '')
      return item.from === 'user' || !body ? body : `${item.fromName}: ${body}`
    })
    .filter(Boolean)
    .join('\n\n')
}

export interface MessageViewOptions {
  scrub: Scrub
  runningMessageId: string | null
  /** The note on the turn this reply belongs to, when its own schedule woke it. */
  heartbeat?: string
}

/**
 * A turn's opening message is built for the model: the time, the heartbeat
 * line and each piece of mail in one text. A phone is shown the mail itself,
 * and a turn with no mail (a heartbeat, a routine, "wake now") has no user
 * message to show; its note goes on the reply instead. Null for those, and for
 * system messages.
 */
export function remoteMessage(message: ChatMessage, options: MessageViewOptions): RemoteMessage | null {
  const { scrub } = options
  const streaming = message.id === options.runningMessageId
  if (message.role === 'system') return null

  if (message.role === 'user') {
    const mail = message.mail ?? []
    let text: string
    let from: RemoteMessage['from']
    if (mail.length > 0) {
      text = mailText(mail, scrub)
      const sender = mail.find((m) => m.from !== 'user')
      if (sender) from = { name: sender.fromName, ...(sender.fromColor ? { color: sender.fromColor } : {}) }
    } else if (message.heartbeat !== undefined) {
      return null
    } else {
      text = scrub(message.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join(''))
    }
    return { id: message.id, role: 'user', at: message.createdAt, ...(from ? { from } : {}), parts: [{ kind: 'text', text }], streaming }
  }

  const parts: RemotePart[] = []
  for (const part of message.parts) {
    if (part.type === 'text') {
      if (part.text) parts.push({ kind: 'text', text: scrub(part.text) })
    } else if (part.type === 'tool') {
      parts.push(remoteToolPart(part, scrub))
    }
    // Reasoning is the model's own working and is never sent.
  }
  return {
    id: message.id,
    role: 'assistant',
    at: message.createdAt,
    parts,
    ...(message.error ? { error: scrub(message.error) } : {}),
    ...(options.heartbeat !== undefined ? { heartbeat: scrub(options.heartbeat) } : {}),
    streaming
  }
}

/** A user turn with no mail is a note for the reply that follows, not a message of its own. */
const isMarker = (message: ChatMessage): boolean => message.role === 'user' && (message.mail?.length ?? 0) === 0 && message.heartbeat !== undefined
const isShown = (message: ChatMessage): boolean => message.role !== 'system' && !isMarker(message)

export interface ThreadPage {
  messages: RemoteMessage[]
  hasMore: boolean
}

/**
 * One page of a thread, oldest first, ending just before `before` (the end of
 * the thread when it is null). Paged over what the phone is shown, so `limit`
 * counts its messages; null when `before` isn't in the thread.
 */
export function remoteThreadPage(
  messages: ChatMessage[],
  options: { limit: number; before: string | null; scrub: Scrub; runningMessageId: string | null }
): ThreadPage | null {
  let end = messages.length
  if (options.before !== null) {
    end = messages.findIndex((m) => m.id === options.before)
    if (end === -1) return null
  }
  const page: RemoteMessage[] = []
  let i = end - 1
  for (; i >= 0 && page.length < options.limit; i--) {
    const message = messages[i]
    if (!isShown(message)) continue
    const before = messages[i - 1]
    const view = remoteMessage(message, {
      scrub: options.scrub,
      runningMessageId: options.runningMessageId,
      heartbeat: message.role === 'assistant' && before && isHeartbeatTurn(before) ? before.heartbeat : undefined
    })
    if (view) page.push(view)
  }
  let hasMore = false
  for (; i >= 0; i--) {
    if (isShown(messages[i])) {
      hasMore = true
      break
    }
  }
  return { messages: page.reverse(), hasMore }
}

const isHeartbeatTurn = (message: ChatMessage): boolean => message.role === 'user' && message.heartbeat !== undefined

/* ----------------------------------------------------------------- events */

export interface TranslatorDeps {
  /** The workers as they are right now. */
  list: () => Worker[]
  /** A tool call from a thread, for a result whose call this translator never saw (it started mid-turn). */
  findTool?: (workerId: string, messageId: string, toolId: string) => ChatToolPart | undefined
  modelLabel?: (model: RemoteModelRef) => string | undefined
  now?: () => number
  home?: string
}

const KEEP = 400

/** Drops the oldest entries of a map that outgrew `KEEP` — a turn that never reported its end must not leak. */
function trim<K, V>(map: Map<K, V>): void {
  while (map.size > KEEP) map.delete(map.keys().next().value as K)
}

/**
 * Turns what the workers hub reports into the events a phone is sent. It is
 * stateful where the contract needs it: a tool result is shown with its call's
 * title and detail, text is scrubbed across delta boundaries, and a turn's
 * heartbeat note is carried from its (unshown) opening message to its reply.
 */
export class EventTranslator {
  private readonly scrubs = new Map<string, Scrub>()
  private readonly folders = new Map<string, string>()
  private readonly streams = new Map<string, StreamScrub>()
  private readonly calls = new Map<string, Pick<ChatToolPart, 'name' | 'input'>>()
  /** A turn's note, between its opening message and its reply. */
  private readonly pending = new Map<string, string | undefined>()
  private readonly notes = new Map<string, string>()

  constructor(private readonly deps: TranslatorDeps) {}

  private scrubFor(folder: string): Scrub {
    let scrub = this.scrubs.get(folder)
    if (!scrub) {
      scrub = pathScrubber(folder, this.deps.home)
      this.scrubs.set(folder, scrub)
    }
    return scrub
  }

  private remember(workers: Worker[]): void {
    for (const worker of workers) this.folders.set(worker.id, worker.folder)
  }

  private scrubOf(workerId: string): Scrub {
    let folder = this.folders.get(workerId)
    if (folder === undefined) {
      this.remember(this.deps.list())
      folder = this.folders.get(workerId) ?? ''
    }
    return this.scrubFor(folder)
  }

  /** The whole list, as the stream's opening event and after every change. */
  workers(workers: Worker[]): RemoteEvent {
    this.remember(workers)
    const now = (this.deps.now ?? Date.now)()
    return { event: 'workers', data: { workers: workers.map((w) => remoteWorker(w, { now, modelLabel: this.deps.modelLabel, scrub: this.scrubFor(w.folder) })) } }
  }

  /** A message added or replaced whole; null for the ones a phone isn't shown. */
  message(workerId: string, message: ChatMessage): RemoteEvent | null {
    if (message.role === 'user') this.pending.set(workerId, message.heartbeat)
    const running = this.deps.list().find((w) => w.id === workerId)?.runningMessageId ?? null
    let heartbeat: string | undefined
    if (message.role === 'assistant') {
      if (this.pending.has(workerId)) {
        heartbeat = this.pending.get(workerId)
        this.pending.delete(workerId)
        if (heartbeat !== undefined) this.notes.set(message.id, heartbeat)
        trim(this.notes)
      } else {
        // The same reply again, whole, when its turn ends.
        heartbeat = this.notes.get(message.id)
      }
      if (message.id !== running) this.forget(message.id)
    }
    const view = remoteMessage(message, { scrub: this.scrubOf(workerId), runningMessageId: running, heartbeat })
    return view ? { event: 'message', data: { workerId, message: view } } : null
  }

  private forget(messageId: string): void {
    this.streams.delete(messageId)
    this.notes.delete(messageId)
    for (const key of [...this.calls.keys()]) if (key.startsWith(`${messageId}\u0000`)) this.calls.delete(key)
  }

  private drain(workerId: string, messageId: string): RemoteEvent[] {
    const rest = this.streams.get(messageId)?.flush()
    return rest ? [{ event: 'delta', data: { workerId, messageId, text: rest } }] : []
  }

  /** A stream event from a running turn: zero, one or two events for the phone. */
  stream(workerId: string, event: StreamEvent): RemoteEvent[] {
    switch (event.type) {
      case 'delta': {
        let scrubber = this.streams.get(event.messageId)
        if (!scrubber) {
          scrubber = new StreamScrub(this.scrubOf(workerId))
          this.streams.set(event.messageId, scrubber)
          trim(this.streams)
        }
        const text = scrubber.push(event.text)
        return text ? [{ event: 'delta', data: { workerId, messageId: event.messageId, text } }] : []
      }
      case 'tool-call': {
        this.calls.set(`${event.messageId}\u0000${event.toolId}`, { name: event.name, input: event.input })
        trim(this.calls)
        const part = remoteToolPart({ id: event.toolId, name: event.name, input: event.input, status: 'running', output: null }, this.scrubOf(workerId))
        // Text before the call goes out first, so the tool step lands after it.
        return [...this.drain(workerId, event.messageId), { event: 'tool', data: { workerId, messageId: event.messageId, part } }]
      }
      case 'tool-result': {
        const call = this.calls.get(`${event.messageId}\u0000${event.toolId}`) ?? this.deps.findTool?.(workerId, event.messageId, event.toolId)
        if (!call) return []
        const part = remoteToolPart({ id: event.toolId, name: call.name, input: call.input, status: event.status, output: event.output }, this.scrubOf(workerId))
        return [{ event: 'tool', data: { workerId, messageId: event.messageId, part } }]
      }
      case 'done':
      case 'error':
        return this.drain(workerId, event.messageId)
      default:
        // Reasoning, progress, usage, plans and the rest are not part of the contract.
        return []
    }
  }
}
