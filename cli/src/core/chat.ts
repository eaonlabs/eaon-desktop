import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import type { Chat, ChatMessage, ChatToolPart, StreamEvent, StreamRequest } from '@shared/types'
import { app } from 'electron'
import { cancelRun, pauseGoal, runAgent } from '@main/agent/loop'
import { resolveApproval } from '@main/agent/approvals'
import { toolsFor, type ToolContext } from '@main/agent/tools'
import { store } from '@main/store'
import type { BusNode, PeerMessage } from '../bus/bus'
import { chatStore, type ChatSummary } from './chats'
import { availableModels, chatModel, noModelReason } from './models'
import { fileDiff, type FileDiff } from '../coding/diff'
import { loadInstructions } from '../coding/instructions'
import { readText, snapshotsFor } from '../coding/snapshot'
import { toolMeta, type ToolMeta } from '../coding/tools'

/**
 * The chat side of the CLI: what the desktop's renderer store does for a
 * chat, without a renderer. It builds the same `StreamRequest`, runs the
 * same agent loop in-process, folds stream events into the transcript the
 * same way, and saves chats in the same shape — so a chat looks the same to
 * the model whichever app it was written in.
 *
 * Several chats can run at once (a message from another session gets its
 * own chat and reply while the user keeps typing in theirs). Approvals from
 * any of them queue up for the screen to ask about one at a time.
 */

/** What a tool call left for the screen: its diff, diagnostics, counts. Saved with the chat. */
export type PartMeta = Omit<ToolMeta, 'before' | 'absolute'>
export type CliToolPart = ChatToolPart & { meta?: PartMeta }

/** Every file a turn changed, however it changed it, and how to undo it. */
export interface TurnChanges {
  files: FileDiff[]
  /** Git snapshots of the project before and after the turn (git projects only). */
  snapshot?: { root: string; before: string; after: string }
  /** Hunks were dropped from the saved copy because the change was huge; /diff rebuilds them. */
  truncated?: boolean
}

/** A command the user ran with `!`, shown in the transcript and handed to the model with the next message. */
export interface ShellRun {
  command: string
  output: string
  exitCode: number | null
  running?: boolean
}

export type CliMessage = ChatMessage & { changes?: TurnChanges; shell?: ShellRun }
export type CliChat = Chat & { peerId?: string; baseTree?: { root: string; tree: string } }

export interface PendingApproval {
  requestId: string
  messageId: string
  chatId: string
  tool: string
  input: Record<string, unknown>
  summary?: string
}

export interface SendOptions {
  plan?: boolean
  goal?: boolean
  until?: number
  /** Send into this chat instead of the active one. */
  chatId?: string
  /** A message from another session, shown as theirs. */
  peer?: PeerMessage
  /** Files the user mentioned with @, sent along with the message. */
  attachments?: string[]
  /** Start a new chat without making it the active one (the trading desk's own chat). */
  detached?: boolean
  /** The new chat's title, instead of the start of the message. */
  title?: string
  /** Told the chat's id as soon as it exists. */
  onChat?: (chatId: string) => void
}

/** A running turn: where it started, for showing its changes before it ends. */
interface LiveTurn {
  snaps: Awaited<ReturnType<typeof snapshotsFor>>
  before: string | null
  befores: Map<string, string | null>
  folder: string
  refresh?: ReturnType<typeof setTimeout>
}

/**
 * Whether the approval mode the user has now lets this call through. The
 * loop reads the mode once, when the turn starts; pressing `a` on an
 * approval (or ⇧⇥) mid-turn changes it, and this applies the loop's own rule
 * again with the live setting — "approve for me" still asks for what is
 * risky, "full access" for what can't be undone. Approvals that aren't for a
 * tool call (a tool confirming a step of its own) always ask.
 */
function allowedNow(request: StreamRequest, modeAtStart: string, tool: string, input: Record<string, unknown>): boolean {
  const settings = store.getSettings()
  if (settings.approvalMode === 'ask' || settings.approvalMode === modeAtStart) return false
  try {
    const found = toolsFor({ mode: request.mode, cwd: request.cwd ?? null, depth: 0, readOnly: false, settings, request }).find((t) => t.name === tool)
    if (!found) return false
    const ctx = { request, cwd: request.cwd ?? '', settings, depth: 0, readOnly: false } as unknown as ToolContext
    if (found.catastrophic?.(input, ctx)) return false
    return settings.approvalMode === 'full' || !(found.risky?.(input, ctx) ?? false)
  } catch {
    return false
  }
}

/** Where a chat's agent works: the folder the CLI was started in, unless changed with /cwd. */
let workFolder = process.cwd()

/** The folder chats work in now (other tabs start their tools there too). */
export function workFolderOf(): string {
  return workFolder
}

const uid = (): string => randomUUID()

function appendPart(message: ChatMessage, type: 'text' | 'reasoning', text: string): ChatMessage {
  const parts = message.parts.slice()
  const last = parts[parts.length - 1]
  if (last && last.type === type) parts[parts.length - 1] = { ...last, text: last.text + text }
  else parts.push({ type, text })
  return { ...message, parts }
}

/** Folds one stream event into the chat, as the renderer's applyStreamEvent does. */
export function applyEvent(chat: Chat, event: StreamEvent): Chat {
  if (event.type === 'approval-request') return chat
  if (event.type === 'goal') return { ...chat, goal: event.goal }
  if (event.type === 'compacted') return { ...chat, summary: { text: event.summary, throughMessageId: event.throughMessageId } }
  const index = chat.messages.findIndex((m) => m.id === event.messageId)
  if (index === -1) return chat
  const message = chat.messages[index]
  let next = message
  switch (event.type) {
    case 'delta':
      next = appendPart(message, 'text', event.text)
      break
    case 'reasoning':
      next = appendPart(message, 'reasoning', event.text)
      break
    case 'error':
      next = { ...message, error: event.error }
      break
    case 'usage':
      next = { ...message, usage: event.usage }
      break
    case 'plan':
      next = { ...message, plan: event.plan }
      break
    case 'todos':
      next = { ...message, todos: event.todos }
      break
    case 'tool-call':
      next = { ...message, parts: [...message.parts, { type: 'tool', id: event.toolId, name: event.name, input: event.input, output: null, status: 'running' }] }
      break
    case 'tool-progress':
    case 'subagent':
    case 'tool-result': {
      const at = message.parts.findIndex((p) => p.type === 'tool' && p.id === event.toolId)
      if (at === -1) break
      const parts = message.parts.slice()
      const part = parts[at] as ChatToolPart
      if (event.type === 'tool-progress') parts[at] = { ...part, progress: event.output }
      else if (event.type === 'subagent') {
        const agents = (part.agents ?? []).slice()
        agents[event.run.index] = event.run
        parts[at] = { ...part, agents }
      } else parts[at] = { ...part, output: event.output, status: event.status, progress: undefined, ...(event.images ? { images: event.images } : {}) }
      next = { ...message, parts }
      break
    }
    default:
      break
  }
  if (next === message && event.type !== 'done') return chat
  const messages = chat.messages.slice()
  messages[index] = next
  return { ...chat, messages, ...(event.type === 'done' || event.type === 'error' ? { updatedAt: Date.now() } : {}) }
}

/** Tool calls a crash or quit left "running" are shown as stopped. */
function sealInterrupted(chat: Chat): Chat {
  if (!chat.messages.some((m) => m.parts.some((p) => p.type === 'tool' && p.status === 'running'))) return chat
  return {
    ...chat,
    messages: chat.messages.map((m) => ({
      ...m,
      parts: m.parts.map((p) => (p.type === 'tool' && p.status === 'running' ? { ...p, status: 'error' as const, progress: undefined } : p))
    }))
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((done) => setTimeout(() => done(null), ms))]).catch(() => null)
}

/** The chat with `meta` set on one tool part. */
function withPartMeta(chat: Chat, messageId: string, toolId: string, meta: PartMeta): Chat {
  return {
    ...chat,
    messages: chat.messages.map((m) =>
      m.id === messageId ? { ...m, parts: m.parts.map((p) => (p.type === 'tool' && (p as ChatToolPart).id === toolId ? ({ ...p, meta } as CliToolPart) : p)) } : m
    )
  }
}

/** Saved turns keep at most this many diff lines; a bigger change keeps its stats and is rebuilt by /diff. */
const MAX_SAVED_DIFF_LINES = 4000

function compact(files: FileDiff[]): { files: FileDiff[]; truncated: boolean } {
  const lines = files.reduce((n, f) => n + f.hunks.reduce((h, hunk) => h + hunk.lines.length, 0), 0)
  if (lines <= MAX_SAVED_DIFF_LINES) return { files, truncated: false }
  return { files: files.map((f) => ({ ...f, hunks: [] })), truncated: true }
}

interface RedoEntry {
  messages: ChatMessage[]
  changes: TurnChanges | null
  /** Non-git projects: the files' text after the turn, to put back on redo. */
  afters: Map<string, string | null>
}

export class ChatController extends EventEmitter {
  private chats = new Map<string, Chat>()
  activeId: string | null = null
  /** The assistant message streaming in each running chat. */
  private running = new Map<string, string>()
  approvals: PendingApproval[] = []
  /** Peer messages waiting for their chat to be free. */
  private peerQueue: PeerMessage[] = []
  /** Answer other sessions' messages with the agent without asking. */
  autoReplyToPeers = true
  /** Output files of ! commands, waiting to go out with the chat's next message. */
  private pendingShell = new Map<string, string[]>()
  private shellRuns = new Map<string, ChildProcess>()
  /** Each turn's files as they were before it touched them (non-git undo). In memory only. */
  private befores = new Map<string, Map<string, string | null>>()
  private redo = new Map<string, RedoEntry[]>()
  /** Every file changed since the chat's first turn in this project, for the sidebar. */
  private sessionChanges = new Map<string, FileDiff[]>()
  /** Running turns' starting points, so their changes can be shown before they finish. */
  private live = new Map<string, LiveTurn>()

  constructor(private readonly bus: BusNode | null = null) {
    super()
    this.setMaxListeners(50)
    bus?.onMessage((message) => this.receivePeer(message))
  }

  get cwd(): string {
    return workFolder
  }

  set cwd(folder: string) {
    workFolder = folder
    this.emit('change')
  }

  /* ---------------------------------------------------------- the chats */

  private listed: { at: number; chats: ChatSummary[] } | null = null

  /** Every saved chat, newest first. Cached for a moment: the screen asks on every frame. */
  list(): ChatSummary[] {
    const now = Date.now()
    if (!this.listed || now - this.listed.at > 2000) this.listed = { at: now, chats: chatStore.list() }
    return this.listed.chats
  }

  active(): Chat | null {
    return this.activeId ? (this.chats.get(this.activeId) ?? null) : null
  }

  get(id: string): Chat | null {
    const open = this.chats.get(id)
    if (open) return open
    const loaded = chatStore.load(id)
    if (!loaded) return null
    const sealed = this.running.has(id) ? loaded : sealInterrupted(loaded)
    this.chats.set(id, sealed)
    return sealed
  }

  open(id: string): boolean {
    if (!this.get(id)) return false
    this.activeId = id
    this.emit('change')
    return true
  }

  /** A blank chat; the next message starts it. */
  newChat(): void {
    this.activeId = null
    this.emit('change')
  }

  private put(chat: Chat, persist: boolean): void {
    this.chats.set(chat.id, chat)
    if (persist) {
      chatStore.save(chat)
      this.listed = null
    }
    this.emit('change', chat.id)
  }

  rename(id: string, title: string): void {
    const chat = this.get(id)
    if (chat && title.trim()) this.put({ ...chat, title: title.trim().slice(0, 80) }, true)
  }

  togglePin(id: string): void {
    const chat = this.get(id)
    if (chat) this.put({ ...chat, pinned: !chat.pinned }, true)
  }

  async remove(id: string): Promise<void> {
    this.stop(id)
    this.chats.delete(id)
    if (this.activeId === id) this.activeId = null
    await chatStore.remove(id)
    this.listed = null
    this.emit('change')
  }

  isRunning(chatId: string | null = this.activeId): boolean {
    return chatId !== null && this.running.has(chatId)
  }

  runningCount(): number {
    return this.running.size
  }

  /* ----------------------------------------------------------- sending */

  async send(text: string, options: SendOptions = {}): Promise<void> {
    const body = text.trim()
    if (!body) return
    const settings = store.getSettings()
    const models = availableModels()
    const model = chatModel(settings, models)
    const now = Date.now()
    let chat = options.chatId ? this.get(options.chatId) : this.active()
    if (chat && this.running.has(chat.id)) {
      this.emit('notice', 'This chat is still replying. Wait for it, or press Esc to stop it.')
      return
    }

    // Files mentioned with @, and the output of any ! commands run since the last message.
    const chatKey = chat?.id ?? '(new)'
    const attachments = [...new Set([...(options.attachments ?? []), ...(this.pendingShell.get(chatKey) ?? [])])]
    this.pendingShell.delete(chatKey)
    const userMessage: ChatMessage = {
      id: uid(),
      role: 'user',
      parts: [{ type: 'text', text: options.peer ? `[From ${options.peer.from.name}, another session] ${body}` : body }],
      createdAt: now,
      ...(attachments.length ? { attachments } : {})
    }
    const assistant: ChatMessage = { id: uid(), role: 'assistant', parts: [], createdAt: now + 1, model: model?.id }
    const goal = options.goal ? { text: body, status: 'active' as const, iterations: 0, ...(options.until && options.until > now ? { until: options.until } : {}) } : undefined

    if (!chat) {
      chat = {
        id: uid(),
        workspaceId: 'work',
        projectId: null,
        title: options.title ?? (options.peer ? `↔ ${options.peer.from.name}: ${body}` : body).split('\n')[0].slice(0, 60),
        messages: [],
        createdAt: now,
        updatedAt: now,
        archived: false,
        pinned: false,
        unread: false,
        modelId: model?.id ?? null,
        effort: settings.effort
      }
    }
    chat = { ...chat, messages: [...chat.messages, userMessage, assistant], updatedAt: now, ...(goal ? { goal } : {}) }
    if (!options.chatId && !options.peer && !options.detached) this.activeId = chat.id
    this.put(chat, true)
    options.onChat?.(chat.id)

    if (!model) {
      this.put(applyEvent(chat, { type: 'error', messageId: assistant.id, error: noModelReason(settings) }), true)
      return
    }

    let history = chat.messages.filter((m) => m.id !== assistant.id && m.role !== 'system')
    const summary = chat.summary ?? null
    if (summary) {
      const cut = history.findIndex((m) => m.id === summary.throughMessageId)
      if (cut !== -1) history = history.slice(cut + 1)
    }
    const request: StreamRequest = {
      chatId: chat.id,
      chatTitle: chat.title,
      messageId: assistant.id,
      providerId: model.providerId,
      modelId: model.id,
      effort: settings.effort,
      mode: 'work',
      history,
      summary: summary?.text ?? null,
      projectInstructions: loadInstructions(workFolder).text,
      cwd: workFolder,
      work: { swarm: settings.work.swarm, plan: options.plan ?? settings.planMode },
      goal: chat.goal?.status === 'active' ? chat.goal : null
    }

    const chatId = chat.id
    this.running.set(chatId, assistant.id)
    this.emit('change', chatId)
    // A git project is snapshotted before the turn, so everything it changes can be shown and undone.
    const turnFolder = workFolder
    const snaps = await snapshotsFor(turnFolder).catch(() => null)
    const before = snaps ? await withTimeout(snaps.track(), 20_000) : null
    const befores = new Map<string, string | null>()
    this.befores.set(assistant.id, befores)
    this.live.set(chatId, { snaps, before, befores, folder: turnFolder })
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    const onEvent = (event: StreamEvent): void => {
      if (event.type === 'approval-request') {
        if (allowedNow(request, settings.approvalMode, event.tool, event.input)) {
          resolveApproval(event.requestId, true)
          return
        }
        this.approvals.push({ requestId: event.requestId, messageId: event.messageId, chatId, tool: event.tool, input: event.input, summary: event.summary })
        this.emit('approval')
        this.emit('change', chatId)
        return
      }
      const current = this.chats.get(chatId)
      if (!current) return
      let next = applyEvent(current, event)
      if (event.type === 'tool-result') {
        const meta = toolMeta.get(event.toolId)
        if (meta) {
          toolMeta.delete(event.toolId)
          if (meta.absolute && meta.before !== undefined && !befores.has(meta.absolute)) befores.set(meta.absolute, meta.before)
          const { before: _before, absolute: _absolute, ...shown } = meta
          next = withPartMeta(next, event.messageId, event.toolId, shown)
          if (meta.diff) this.refreshLive(chatId)
        }
      }
      if (next === current) return
      this.chats.set(chatId, next)
      // Text streams in tiny pieces: redraw at most every 30 ms.
      if (event.type === 'delta' || event.type === 'reasoning' || event.type === 'tool-progress') {
        if (!flushTimer) flushTimer = setTimeout(() => ((flushTimer = null), this.emit('change', chatId)), 30)
        return
      }
      const persist = event.type === 'tool-result' || event.type === 'goal' || event.type === 'compacted' || event.type === 'plan'
      if (persist) chatStore.save(next)
      this.emit('change', chatId)
    }

    let outcomeText = ''
    try {
      const outcome = await runAgent(request, onEvent)
      outcomeText = outcome.text
    } catch (error) {
      onEvent({ type: 'error', messageId: assistant.id, error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (flushTimer) clearTimeout(flushTimer)
      clearTimeout(this.live.get(chatId)?.refresh)
      this.live.delete(chatId)
      const changes = await this.turnChanges(snaps, before, befores, turnFolder).catch(() => null)
      this.running.delete(chatId)
      this.approvals = this.approvals.filter((a) => a.messageId !== assistant.id)
      const final = this.chats.get(chatId) as CliChat | undefined
      if (final) {
        let done: CliChat = sealInterrupted({ ...final, updatedAt: Date.now() })
        if (changes) {
          done = { ...done, messages: done.messages.map((m) => (m.id === assistant.id ? ({ ...m, changes } as CliMessage) : m)) }
          if (changes.snapshot && (!done.baseTree || done.baseTree.root !== changes.snapshot.root)) done.baseTree = { root: changes.snapshot.root, tree: changes.snapshot.before }
        }
        this.chats.set(chatId, done)
        chatStore.save(done)
        void this.refreshSessionChanges(chatId)
      }
      this.redo.delete(chatId)
      this.emit('change', chatId)
      this.emit('finished', chatId)
    }

    if (options.peer?.expectReply && this.bus) {
      const reply = outcomeText.trim() || lastText(this.chats.get(chatId), assistant.id) || '(no answer)'
      void this.bus.send(options.peer.from.id, reply, { replyTo: options.peer.id })
    }
    this.drainPeers()
  }

  /* -------------------------------------------------- changes and undo */

  /** What a turn changed: from git snapshots when there are any, else from the edit tools' records. */
  private async turnChanges(snaps: Awaited<ReturnType<typeof snapshotsFor>>, before: string | null, befores: Map<string, string | null>, folder: string): Promise<TurnChanges | null> {
    if (snaps && before) {
      const after = await withTimeout(snaps.track(), 20_000)
      if (!after) return null
      if (after === before) return null
      const files = await snaps.diff(before, after)
      if (files.length === 0) return null
      const { files: kept, truncated } = compact(files)
      return { files: kept, snapshot: { root: snaps.root, before, after }, ...(truncated ? { truncated } : {}) }
    }
    const files: FileDiff[] = []
    for (const [absolute, old] of befores) {
      const now = readText(absolute)
      if (now === old) continue
      files.push(fileDiff(relative(folder, absolute) || absolute, old, now))
    }
    if (files.length === 0) return null
    const { files: kept, truncated } = compact(files)
    return { files: kept, ...(truncated ? { truncated } : {}) }
  }

  private async refreshSessionChanges(chatId: string): Promise<void> {
    const chat = this.get(chatId) as CliChat | null
    if (!chat) return
    const last = [...chat.messages].reverse().find((m) => (m as CliMessage).changes)
    const turn = (last as CliMessage | undefined)?.changes
    if (chat.baseTree && turn?.snapshot && turn.snapshot.root === chat.baseTree.root) {
      const snaps = await snapshotsFor(chat.baseTree.root)
      if (snaps) this.sessionChanges.set(chatId, await snaps.diff(chat.baseTree.tree, turn.snapshot.after))
    } else {
      // Without snapshots: the latest change to each file across the turns.
      const byPath = new Map<string, FileDiff>()
      for (const m of chat.messages) for (const f of (m as CliMessage).changes?.files ?? []) byPath.set(f.path, f)
      this.sessionChanges.set(chatId, [...byPath.values()])
    }
    this.emit('change', chatId)
  }

  /**
   * Every file changed in this chat so far, including what a running turn
   * has changed up to now.
   */
  async currentChanges(chatId: string | null = this.activeId): Promise<FileDiff[]> {
    if (!chatId) return []
    const turn = this.live.get(chatId)
    if (!turn) return this.modifiedFiles(chatId)
    const chat = this.get(chatId) as CliChat | null
    if (turn.snaps && turn.before) {
      const now = await withTimeout(turn.snaps.track(), 20_000)
      if (!now) return this.modifiedFiles(chatId)
      const base = chat?.baseTree?.root === turn.snaps.root ? chat.baseTree.tree : turn.before
      return turn.snaps.diff(base, now)
    }
    const byPath = new Map(this.modifiedFiles(chatId).map((f) => [f.path, f]))
    for (const [absolute, old] of turn.befores) {
      const path = relative(turn.folder, absolute) || absolute
      byPath.set(path, fileDiff(path, old, readText(absolute)))
    }
    return [...byPath.values()].filter((f) => f.additions + f.deletions > 0 || f.status !== 'modified')
  }

  /** What the running turn has changed so far, or null when nothing is running. */
  async runningTurnChanges(chatId: string | null = this.activeId): Promise<FileDiff[] | null> {
    const turn = chatId ? this.live.get(chatId) : undefined
    if (!turn) return null
    if (turn.snaps && turn.before) {
      const now = await withTimeout(turn.snaps.track(), 20_000)
      return now ? turn.snaps.diff(turn.before, now) : []
    }
    const files: FileDiff[] = []
    for (const [absolute, old] of turn.befores) {
      const now = readText(absolute)
      if (now !== old) files.push(fileDiff(relative(turn.folder, absolute) || absolute, old, now))
    }
    return files
  }

  /** Brings the sidebar's changed files up to date shortly after a running turn edits something. */
  private refreshLive(chatId: string): void {
    const turn = this.live.get(chatId)
    if (!turn) return
    clearTimeout(turn.refresh)
    turn.refresh = setTimeout(() => {
      void this.currentChanges(chatId)
        .then((files) => {
          if (!this.live.has(chatId)) return
          this.sessionChanges.set(chatId, files)
          this.emit('change', chatId)
        })
        .catch(() => undefined)
    }, 400)
  }

  /** Files changed in this chat so far (since its first turn here). */
  modifiedFiles(chatId: string | null = this.activeId): FileDiff[] {
    if (!chatId) return []
    if (!this.sessionChanges.has(chatId)) {
      this.sessionChanges.set(chatId, [])
      void this.refreshSessionChanges(chatId)
    }
    return this.sessionChanges.get(chatId) ?? []
  }

  /** The full diff of a turn, rebuilding hunks a huge change left out of the saved copy. */
  async turnDiff(changes: TurnChanges): Promise<FileDiff[]> {
    if (!changes.truncated || !changes.snapshot) return changes.files
    const snaps = await snapshotsFor(changes.snapshot.root)
    return snaps ? snaps.diff(changes.snapshot.before, changes.snapshot.after) : changes.files
  }

  /**
   * Takes back the chat's last turn: its file changes are reverted and its
   * messages removed (kept for /redo). Returns the user's message, to put
   * back in the composer, or an error to show.
   */
  async undo(chatId: string | null = this.activeId): Promise<{ text: string } | { error: string }> {
    if (!chatId) return { error: 'Nothing to undo.' }
    if (this.running.has(chatId)) return { error: 'Stop the reply first (Esc).' }
    const chat = this.get(chatId)
    if (!chat) return { error: 'Nothing to undo.' }
    const at = chat.messages.map((m) => m.role).lastIndexOf('user')
    if (at === -1) return { error: 'Nothing to undo.' }
    const removed = chat.messages.slice(at)
    const assistant = removed.find((m) => m.role === 'assistant') as CliMessage | undefined
    const changes = assistant?.changes ?? null
    const afters = new Map<string, string | null>()
    if (changes?.files.length) {
      if (changes.snapshot) {
        const snaps = await snapshotsFor(changes.snapshot.root)
        if (!snaps) return { error: 'Git is needed to undo these changes.' }
        await snaps.restore(changes.snapshot.before, await this.turnDiff(changes))
      } else {
        const befores = assistant ? this.befores.get(assistant.id) : undefined
        if (!befores) return { error: 'These changes were made before this session started; only git projects can undo them later.' }
        for (const [absolute, old] of befores) {
          afters.set(absolute, readText(absolute))
          if (old === null) rmSync(absolute, { force: true })
          else {
            mkdirSync(dirname(absolute), { recursive: true })
            writeFileSync(absolute, old)
          }
        }
      }
    }
    this.redo.set(chatId, [...(this.redo.get(chatId) ?? []), { messages: removed, changes, afters }])
    this.put({ ...chat, messages: chat.messages.slice(0, at) }, true)
    void this.refreshSessionChanges(chatId)
    const text = removed[0].parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
    return { text }
  }

  canRedo(chatId: string | null = this.activeId): boolean {
    return chatId !== null && (this.redo.get(chatId)?.length ?? 0) > 0
  }

  /** Puts back the last turn /undo took away, files and messages. */
  async redoTurn(chatId: string | null = this.activeId): Promise<{ ok: true } | { error: string }> {
    if (!chatId) return { error: 'Nothing to redo.' }
    const stack = this.redo.get(chatId) ?? []
    const entry = stack.pop()
    const chat = this.get(chatId)
    if (!entry || !chat) return { error: 'Nothing to redo.' }
    if (entry.changes?.snapshot) {
      const snaps = await snapshotsFor(entry.changes.snapshot.root)
      if (snaps) await snaps.restore(entry.changes.snapshot.after, await this.turnDiff(entry.changes))
    } else {
      for (const [absolute, text] of entry.afters) {
        if (text === null) rmSync(absolute, { force: true })
        else {
          mkdirSync(dirname(absolute), { recursive: true })
          writeFileSync(absolute, text)
        }
      }
    }
    this.redo.set(chatId, stack)
    this.put({ ...chat, messages: [...chat.messages, ...entry.messages] }, true)
    void this.refreshSessionChanges(chatId)
    return { ok: true }
  }

  /* --------------------------------------------------------- ! commands */

  /**
   * Runs a command the user typed after `!`, in the work folder, and shows
   * it in the chat. Its output goes to the model with the next message, as
   * an attached file, so the agent sees what the user saw.
   */
  runShell(command: string): void {
    const now = Date.now()
    let chat = this.active()
    if (!chat) {
      chat = {
        id: uid(),
        workspaceId: 'work',
        projectId: null,
        title: `!${command}`.slice(0, 60),
        messages: [],
        createdAt: now,
        updatedAt: now,
        archived: false,
        pinned: false,
        unread: false,
        modelId: null,
        effort: store.getSettings().effort
      }
      this.activeId = chat.id
    }
    const chatId = chat.id
    const message: CliMessage = { id: uid(), role: 'system', parts: [], createdAt: now, shell: { command, output: '', exitCode: null, running: true } }
    this.put({ ...chat, messages: [...chat.messages, message], updatedAt: now }, true)
    let output = ''
    const child = spawn(command, {
      shell: process.platform === 'win32' ? true : process.env.SHELL || '/bin/sh',
      cwd: workFolder,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat' }
    })
    this.shellRuns.set(message.id, child)
    const update = (patch: Partial<ShellRun>): void => {
      const current = this.get(chatId)
      if (!current) return
      this.put(
        { ...current, messages: current.messages.map((m) => (m.id === message.id ? ({ ...m, shell: { ...(m as CliMessage).shell!, ...patch } } as CliMessage) : m)) },
        patch.running === false
      )
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    const collect = (chunk: Buffer): void => {
      output += chunk.toString('utf8')
      if (output.length > 60_000) output = `…
${output.slice(-50_000)}`
      if (!timer) timer = setTimeout(() => ((timer = null), update({ output })), 80)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const kill = setTimeout(() => child.kill('SIGTERM'), 300_000)
    const finish = (code: number | null): void => {
      clearTimeout(kill)
      if (timer) clearTimeout(timer)
      this.shellRuns.delete(message.id)
      update({ output, exitCode: code, running: false })
      // Hand the output to the next message as a file the model reads.
      const dir = join(app.getPath('userData'), 'shell')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `${message.id}.txt`)
      writeFileSync(file, `The user ran this command in ${workFolder}:
$ ${command}
${output.trim()}
(exit code ${code ?? 'none'})
`)
      this.pendingShell.set(chatId, [...(this.pendingShell.get(chatId) ?? []), file])
    }
    child.on('error', (error) => {
      output += String(error.message)
      finish(null)
    })
    child.on('close', (code) => finish(code))
  }

  /** Stops ! commands still running. */
  stopShells(): boolean {
    let any = false
    for (const child of this.shellRuns.values()) {
      child.kill('SIGTERM')
      any = true
    }
    return any
  }

  shellRunning(): boolean {
    return this.shellRuns.size > 0
  }

  stop(chatId: string | null = this.activeId): void {
    if (!chatId) return
    const messageId = this.running.get(chatId)
    if (!messageId) return
    cancelRun(messageId)
    this.approvals = this.approvals.filter((a) => a.messageId !== messageId)
    this.emit('change', chatId)
  }

  pauseGoal(chatId: string | null = this.activeId): void {
    const messageId = chatId ? this.running.get(chatId) : undefined
    if (messageId) pauseGoal(messageId)
  }

  answerApproval(requestId: string, approved: boolean): void {
    resolveApproval(requestId, approved)
    this.approvals = this.approvals.filter((a) => a.requestId !== requestId)
    this.emit('change')
  }

  /** Approves the plan in `messageId` and carries it out, as the desktop's Approve button does. */
  approvePlan(messageId: string, chatId: string | null = this.activeId): void {
    const chat = chatId ? this.get(chatId) : null
    if (!chat) return
    this.put({ ...chat, messages: chat.messages.map((m) => (m.id === messageId && m.plan ? { ...m, plan: { ...m.plan, status: 'approved' as const } } : m)) }, true)
    void this.send('Approved — carry out the plan. Keep the checklist updated as you go.', { plan: false, chatId: chat.id })
  }

  setGoalStatus(status: 'paused' | 'active'): void {
    const chat = this.active()
    if (!chat?.goal) return
    this.put({ ...chat, goal: { ...chat.goal, status } }, true)
  }

  /* ------------------------------------------------- other sessions */

  private peerChats = new Map<string, string>()
  /** When each peer's recent messages were answered, to stop two agents talking in circles. */
  private peerReplies = new Map<string, number[]>()

  /** A chat per peer, so their conversation doesn't land in the middle of the user's. */
  private peerChatId(peer: PeerMessage['from']): string | null {
    const known = this.peerChats.get(peer.id)
    if (known && this.get(known)) return known
    return null
  }

  /** At most 8 automatic answers to one session in 10 minutes; after that the user decides. */
  private mayAutoReply(peerId: string): boolean {
    const now = Date.now()
    const recent = (this.peerReplies.get(peerId) ?? []).filter((at) => now - at < 10 * 60_000)
    if (recent.length >= 8) return false
    recent.push(now)
    this.peerReplies.set(peerId, recent)
    return true
  }

  receivePeer(message: PeerMessage): void {
    // A reply someone is waiting on in a `session_send` is that tool's answer, not new mail.
    if (message.replyTo) {
      this.emit('peer', message)
      return
    }
    this.emit('peer', message)
    if (!this.autoReplyToPeers) {
      this.emit('notice', `${message.from.name}: ${message.text.slice(0, 120)}`)
      return
    }
    this.peerQueue.push(message)
    this.drainPeers()
  }

  private drainPeers(): void {
    for (let i = 0; i < this.peerQueue.length; i++) {
      const message = this.peerQueue[i]
      const existing = this.peerChatId(message.from)
      if (existing && this.running.has(existing)) continue
      this.peerQueue.splice(i, 1)
      i--
      if (!this.mayAutoReply(message.from.id)) {
        this.emit('notice', `${message.from.name} keeps writing; automatic answers paused. Reply with /send ${message.from.name} …`)
        continue
      }
      let chatId = existing
      if (!chatId) {
        const now = Date.now()
        const chat: Chat & { peerId: string } = {
          id: uid(),
          workspaceId: 'work',
          projectId: null,
          title: `↔ ${message.from.name}`,
          messages: [],
          createdAt: now,
          updatedAt: now,
          archived: false,
          pinned: false,
          unread: true,
          modelId: null,
          effort: store.getSettings().effort,
          peerId: message.from.id
        }
        this.put(chat, true)
        this.peerChats.set(message.from.id, chat.id)
        chatId = chat.id
      }
      void this.send(message.text, { chatId, peer: message })
    }
  }
}

function lastText(chat: Chat | undefined, messageId: string): string {
  const message = chat?.messages.find((m) => m.id === messageId)
  return (message?.parts ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join('')
    .trim()
}

/** For a new chat started from a list: nothing in flight, the folder the CLI is in. */
export function resetWorkFolder(folder: string): void {
  workFolder = folder
}
