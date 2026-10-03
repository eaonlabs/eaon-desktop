import { create } from 'zustand'
import type {
  Chat,
  ChatMessage,
  ChatToolPart,
  DownloadedModel,
  EffortLevel,
  IndexStatus,
  McpServer,
  MessageFeedback,
  ModelDownloadProgress,
  ModelInfo,
  Project,
  Provider,
  Settings,
  StreamEvent,
  StreamRequest,
  UpdateStatus,
  Workspace
} from '@shared/types'
import { mergeRunChat } from '@shared/scheduler'
import { lastTurnFailed } from './chatStatus'
import { chatChanges } from './chatSync'
import { forkedChat, retryPlan, withFeedback } from './chatEdits'
import { migrateLegacySchedules } from '../components/scheduled/legacy'

export type View = 'chat' | 'plugins' | 'integrations' | 'scheduled' | 'settings' | 'pull-requests' | 'models' | 'library' | 'trading'

interface NavEntry {
  view: View
  activeChatId: string | null
}

const uid = (): string => Math.random().toString(36).slice(2, 11) + Date.now().toString(36)

interface AppState {
  ready: boolean
  settings: Settings | null
  workspaces: Workspace[]
  projects: Project[]
  chats: Chat[]
  providers: Provider[]
  mcpServers: McpServer[]

  view: View
  settingsPage: string
  pluginsTab: 'plugins' | 'skills'
  /** Repo id showing in the Models detail view, or null for the list. Lives here
   * (rather than local component state) so re-clicking "Models" in the sidebar
   * while already viewing a model's variants returns to the list. */
  modelsRepo: string | null
  activeChatId: string | null
  pendingProjectId: string | null
  navPast: NavEntry[]
  navFuture: NavEntry[]
  sidebarOpen: boolean
  browserOpen: boolean
  streamingMessageId: string | null
  /** The chat `streamingMessageId` belongs to. */
  streamingChatId: string | null
  /** The approval being asked now; `approvalQueue` holds any that arrived while it was open. */
  pendingApproval: PendingApproval | null
  approvalQueue: PendingApproval[]
  /** A suggestion-card prompt waiting to be dropped into the composer, consumed once. */
  composerDraft: string | null
  /** Code-index progress for the chat agent's project folder. */
  indexStatus: IndexStatus | null
  /** In-flight Hugging Face model downloads, keyed by `repoId::filename`. Lives
   * here (not local to the Models page) so the header's Downloads panel can
   * show progress no matter which view is open. */
  modelDownloads: Record<string, ModelDownloadProgress>
  /** App auto-updater state — mirrors the main process, see `updater.ts`. */
  updateStatus: UpdateStatus

  init: () => Promise<void>
  patchSettings: (patch: DeepPartial<Settings>) => Promise<void>
  setView: (view: View) => void
  setSettingsPage: (page: string) => void
  setPluginsTab: (tab: 'plugins' | 'skills') => void
  setModelsRepo: (repoId: string | null) => void
  goBack: () => void
  goForward: () => void
  canGoBack: () => boolean
  canGoForward: () => boolean
  toggleSidebar: () => void
  toggleBrowser: (open?: boolean) => void

  newChat: (projectId?: string | null) => void
  openChat: (id: string) => void
  deleteChat: (id: string) => void
  archiveChat: (id: string) => void
  restoreChat: (id: string) => void
  renameChat: (id: string, title: string) => void
  togglePin: (id: string) => void
  send: (text: string, options?: SendOptions) => Promise<void>
  stop: () => void
  /** Plan mode: the user accepted the plan in `messageId`; run it with plan mode off. */
  approvePlan: (messageId: string) => void
  /** A reply's thumbs and emoji, from its action bar. */
  setMessageFeedback: (messageId: string, feedback: MessageFeedback) => void
  /** Asks the last question again, in place of its reply. */
  retryReply: (messageId: string) => void
  /** Opens a copy of the active chat up to `messageId`, to go another way from there. */
  forkChat: (messageId: string) => void
  /** Clears or pauses the active chat's goal. */
  setGoalStatus: (status: 'paused' | 'active' | null) => void
  respondApproval: (approved: boolean) => void
  setComposerDraft: (text: string | null) => void
  reindex: (force?: boolean) => Promise<void>

  createProject: (name: string) => Project
  updateProject: (id: string, patch: Partial<Pick<Project, 'name' | 'instructions'>>) => void
  /** Deletes the project; its chats stay, moved back to Recents. */
  deleteProject: (id: string) => void
  setWorkspace: (id: string) => void
  /** The chat agent's folder; null goes back to the default (~/Eaon). */
  setWorkCwd: (cwd: string | null) => void

  selectModel: (modelId: string, providerId?: string) => void
  /** Stars or unstars a model; starred models head the model menu. */
  toggleFavorite: (modelId: string, providerId: string) => void
  downloadModel: (repoId: string, filename: string) => Promise<DownloadedModel>
  setEffort: (effort: EffortLevel) => void
  refreshProviders: () => Promise<void>
  saveMcpServers: (servers: McpServer[]) => Promise<void>

  availableModels: () => ModelInfo[]
  currentModel: () => ModelInfo | null
  activeChat: () => Chat | null
  visibleChats: () => Chat[]
  /** The sidebar's view of `visibleChats()`, which keeps its identity while only message content changes. */
  chatList: () => ChatListItem[]
  visibleProjects: () => Project[]
}

export interface PendingApproval {
  requestId: string
  messageId: string
  tool: string
  input: Record<string, unknown>
  summary?: string
}

/** What the sidebar shows for a chat. */
export interface ChatListItem {
  id: string
  title: string
  pinned: boolean
  failed: boolean
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

export interface SendOptions {
  /** Files to attach, as absolute paths. */
  attachments?: string[]
  /** Goal mode: this message is a goal the agent keeps pursuing until it is done. */
  goal?: boolean
  /** With `goal`: keep working until this time (a timestamp) rather than the usual limits. */
  until?: number | null
  /** Overrides the plan-mode setting for this one turn (approving a plan runs it with plan mode off). */
  plan?: boolean
}

export type WorkspaceKind = 'chat' | 'work' | 'code' | 'workers'

/**
 * `init()` runs from an effect, and StrictMode invokes effects twice in dev.
 * Binding the stream listener twice meant every token was applied twice — the
 * second handler read the already-updated state and appended the same text
 * again — so replies came out doubled and every render ran twice.
 */
let listenersBound = false

/** Identity caches for the derived selectors below — see `availableModels`. */
let modelsCache: { providers: Provider[]; models: ModelInfo[] } | null = null
let chatsCache: { chats: Chat[]; workspaceId: string | undefined; visible: Chat[] } | null = null

let listCache: { visible: Chat[]; items: ChatListItem[] } | null = null
const listItems = new WeakMap<Chat, ChatListItem>()

let saveTimer: ReturnType<typeof setTimeout> | null = null
/**
 * Each chat as main last has it: what this window saved, or what another
 * window (or a scheduled run) sent over. A chat whose object differs from
 * this is one this window changed, and only those are saved, so two windows
 * never overwrite each other's chats with stale copies.
 */
let synced = new Map<string, Chat>()

/**
 * Debounced save of the chats this window changed. It saves what the store
 * holds when the timer fires, not an array handed in earlier — a snapshot from
 * before the last change (a pin written straight to disk, say) would quietly
 * undo it.
 */
function persistChats(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(saveChatsNow, 250)
}
function saveChatsNow(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  const chats = useApp.getState().chats
  const { upserts, removed } = chatChanges(synced, chats)
  synced = new Map(chats.map((chat) => [chat.id, chat]))
  if (upserts.length > 0 || removed.length > 0) void window.api.chats.apply(upserts, removed)
}

/**
 * Takes in chats another window changed. The chat this window is writing a
 * reply into is left alone: this window's copy is the one being written, and
 * it is saved when the reply ends.
 */
function receiveChats(change: { upserts: Chat[]; removed: string[] }): void {
  const { getState: get, setState: set } = useApp
  const mine = get().streamingChatId
  const upserts = change.upserts.filter((chat) => chat.id !== mine)
  const removed = new Set(change.removed.filter((id) => id !== mine))
  for (const chat of upserts) synced.set(chat.id, chat)
  for (const id of removed) synced.delete(id)
  set((state) => {
    const incoming = new Map(upserts.map((chat) => [chat.id, chat]))
    const known = new Set(state.chats.map((chat) => chat.id))
    const added = upserts.filter((chat) => !known.has(chat.id))
    const chats = [...added, ...state.chats.filter((chat) => !removed.has(chat.id)).map((chat) => incoming.get(chat.id) ?? chat)]
    return { chats, ...(state.activeChatId && removed.has(state.activeChatId) ? { activeChatId: null } : {}) }
  })
}

const IDLE = { streamingMessageId: null, streamingChatId: null }

/**
 * The approval state without `messageId`'s requests. Main answers them itself
 * when a run stops or ends, so a prompt left open would only be asking about
 * something that can no longer happen.
 */
function withoutApprovals(state: AppState, messageId: string): Partial<AppState> {
  const all = state.pendingApproval ? [state.pendingApproval, ...state.approvalQueue] : state.approvalQueue
  if (!all.some((a) => a.messageId === messageId)) return {}
  const rest = all.filter((a) => a.messageId !== messageId)
  return { pendingApproval: rest[0] ?? null, approvalQueue: rest.slice(1) }
}

/**
 * Which chat each streaming message was found in, so a batch of tokens goes
 * straight to it instead of scanning every message of every chat.
 */
const streamTargets = new Map<string, string>()

function locateMessage(chats: Chat[], messageId: string): { chatIndex: number; msgIndex: number } | null {
  // A streaming message is nearly always its chat's last, so search from the end.
  const indexIn = (chat: Chat): number => {
    for (let i = chat.messages.length - 1; i >= 0; i--) if (chat.messages[i].id === messageId) return i
    return -1
  }
  const known = streamTargets.get(messageId)
  if (known !== undefined) {
    const chatIndex = chats.findIndex((c) => c.id === known)
    const msgIndex = chatIndex === -1 ? -1 : indexIn(chats[chatIndex])
    if (msgIndex !== -1) return { chatIndex, msgIndex }
  }
  for (let chatIndex = 0; chatIndex < chats.length; chatIndex++) {
    const msgIndex = indexIn(chats[chatIndex])
    if (msgIndex === -1) continue
    streamTargets.set(messageId, chats[chatIndex].id)
    return { chatIndex, msgIndex }
  }
  return null
}

function hasRunningTool(message: ChatMessage): boolean {
  return message.parts.some((part) => part.type === 'tool' && part.status === 'running')
}

/**
 * Marks tool calls left "running" as stopped, for runs that ended without
 * reporting back — the window closed mid-run, or the app died. Otherwise the
 * transcript shows a spinner (and runs its animation) forever. `output` stays
 * null, which the next request's history already reports to the model as an
 * interrupted call. `only` limits it to one message.
 */
function sealInterrupted(chats: Chat[], only?: string): Chat[] {
  const affected = (m: ChatMessage): boolean => (!only || m.id === only) && hasRunningTool(m)
  if (!chats.some((c) => c.messages.some(affected))) return chats
  return chats.map((chat) =>
    chat.messages.some(affected)
      ? {
          ...chat,
          messages: chat.messages.map((m) =>
            affected(m)
              ? {
                  ...m,
                  parts: m.parts.map((p) =>
                    p.type === 'tool' && p.status === 'running' ? { ...p, status: 'error' as const, progress: undefined } : p
                  )
                }
              : m
          )
        }
      : chat
  )
}

/** Applies one event from a running turn — the renderer's own, or a scheduled task's — to its message. */
function applyStreamEvent(event: StreamEvent): void {
  const { getState: get, setState: set } = useApp
  // Approval requests carry no message content — they open the confirm
  // dialog and the main process blocks on the answer, so they must be
  // handled before the message-indexing path below (which would drop them).
  if (event.type === 'approval-request') {
    const request: PendingApproval = { requestId: event.requestId, messageId: event.messageId, tool: event.tool, input: event.input, summary: event.summary }
    // Several can be waiting at once: swarm sub-agents run in parallel and
    // each may stop to ask. Replacing the open one left it unanswered, and
    // its sub-agent — so the whole turn — waiting forever.
    set((s) => (s.pendingApproval ? { approvalQueue: [...s.approvalQueue, request] } : { pendingApproval: request }))
    return
  }

  const state = get()
  const finished = event.type === 'done' || event.type === 'error'
  // A headless run (a scheduled task) streams into a chat the renderer did
  // not start, so only clear the streaming marker for the run it owns.
  const ownsStream = state.streamingMessageId === event.messageId
  const found = locateMessage(state.chats, event.messageId)
  if (finished) streamTargets.delete(event.messageId)
  if (!found) {
    // The chat is gone (deleted mid-run), but the run still has to release
    // the stop button and any prompt it left open.
    if (finished) set((s) => ({ ...(ownsStream ? IDLE : {}), ...withoutApprovals(s, event.messageId) }))
    return
  }
  const { chatIndex, msgIndex } = found
  const target = state.chats[chatIndex]

  const message = target.messages[msgIndex]
  let nextMessage = message
  let nextChat: Partial<Chat> | null = null
  if (event.type === 'delta') nextMessage = appendPart(message, 'text', event.text)
  else if (event.type === 'reasoning') nextMessage = appendPart(message, 'reasoning', event.text)
  else if (event.type === 'error') nextMessage = { ...message, error: event.error }
  else if (event.type === 'usage') nextMessage = { ...message, usage: event.usage }
  else if (event.type === 'plan') nextMessage = { ...message, plan: event.plan }
  else if (event.type === 'todos') nextMessage = { ...message, todos: event.todos }
  else if (event.type === 'goal') nextChat = { goal: event.goal }
  else if (event.type === 'compacted') nextChat = { summary: { text: event.summary, throughMessageId: event.throughMessageId } }
  else if (event.type === 'tool-progress' || event.type === 'subagent') {
    const partIndex = message.parts.findIndex((p) => p.type === 'tool' && p.id === event.toolId)
    if (partIndex !== -1) {
      const parts = message.parts.slice()
      const part = parts[partIndex] as ChatToolPart
      if (event.type === 'tool-progress') {
        parts[partIndex] = { ...part, progress: event.output }
      } else {
        const agents = (part.agents ?? []).slice()
        agents[event.run.index] = event.run
        parts[partIndex] = { ...part, agents }
      }
      nextMessage = { ...message, parts }
    }
  } else if (event.type === 'tool-call') {
    nextMessage = {
      ...message,
      parts: [
        ...message.parts,
        { type: 'tool', id: event.toolId, name: event.name, input: event.input, output: null, status: 'running' }
      ]
    }
  } else if (event.type === 'tool-result') {
    // Land the result on the call it belongs to. A tool part is only ever
    // written once, so replacing it in place keeps every other part's
    // identity for React.memo.
    const partIndex = message.parts.findIndex((p) => p.type === 'tool' && p.id === event.toolId)
    if (partIndex !== -1) {
      const parts = message.parts.slice()
      parts[partIndex] = {
        ...(parts[partIndex] as ChatToolPart),
        output: event.output,
        status: event.status,
        progress: undefined,
        ...(event.images ? { images: event.images } : {})
      }
      nextMessage = { ...message, parts }
    }
  }

  if (nextMessage === message && !finished && !nextChat) return

  // Copy only the two arrays on the path to the changed message; every other
  // chat and message keeps its identity, so React.memo can skip those rows.
  const messages = target.messages.slice()
  messages[msgIndex] = nextMessage
  const chats = state.chats.slice()
  chats[chatIndex] = {
    ...target,
    // `updatedAt` only moves when the turn ends — bumping it per token
    // reshuffled the sidebar's sort on every single token.
    ...(finished ? { updatedAt: Date.now() } : {}),
    ...(nextChat ?? {}),
    messages
  }

  set({ chats, ...(finished ? { ...(ownsStream ? IDLE : {}), ...withoutApprovals(state, event.messageId) } : {}) })
  // Another window's reply (or a scheduled run's) is shown as it comes, but
  // saved by whoever is writing it; here it only becomes the synced copy.
  if (!ownsStream) synced.set(target.id, chats[chatIndex])
  else if (finished || nextChat) persistChats()
}

/**
 * True when the active tab is the agent chat — Chat, which absorbed the old
 * Work tab (a `work` workspace only survives in an install mid-migration).
 * Several components gate agent affordances on this — the goal banner, the
 * checklist, the browser panel — and each had its own copy of the lookup,
 * which is how they drift apart. Returns a boolean, so it is safe as a plain
 * selector.
 */
export const useIsWork = (): boolean =>
  useApp((s) => isAgentKind(s.workspaces.find((w) => w.id === s.settings?.activeWorkspaceId)?.kind))

export const isAgentKind = (kind: WorkspaceKind | undefined): boolean => kind === 'chat' || kind === 'work'

/** The workspace chat turns run in: its folder is where the agent works. */
export const agentWorkspace = (workspaces: Workspace[]): Workspace | undefined =>
  workspaces.find((w) => w.kind === 'chat') ?? workspaces.find((w) => w.kind === 'work')

/** Which top-bar tab is active: Chat, Workers or ADE (`code`). */
export const useWorkspaceKind = (): WorkspaceKind =>
  useApp((s) => s.workspaces.find((w) => w.id === s.settings?.activeWorkspaceId)?.kind ?? 'chat')

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  settings: null,
  workspaces: [],
  projects: [],
  chats: [],
  providers: [],
  mcpServers: [],

  view: 'chat',
  settingsPage: 'general',
  pluginsTab: 'plugins',
  modelsRepo: null,
  activeChatId: null,
  pendingProjectId: null,
  navPast: [],
  navFuture: [],
  sidebarOpen: true,
  browserOpen: false,
  streamingMessageId: null,
  streamingChatId: null,
  pendingApproval: null,
  approvalQueue: [],
  composerDraft: null,
  indexStatus: null,
  modelDownloads: {},
  updateStatus: { state: 'idle' },

  async init() {
    const [settings, workspaces, projects, chats, providers, mcpServers] = await Promise.all([
      window.api.settings.get(),
      window.api.workspaces.get(),
      window.api.projects.get(),
      window.api.chats.get(),
      window.api.providers.list(),
      window.api.mcp.get()
    ])
    // Nothing is running for this renderer yet, so a call still marked
    // running was cut off by a crash or a quit (see sealInterrupted) unless
    // another window is writing that reply right now.
    const live = new Set(await window.api.chats.activeRuns())
    const sealed = chats.map((chat) => (chat.messages.some((m) => live.has(m.id)) ? chat : sealInterrupted([chat])[0]))
    synced = new Map(chats.map((chat) => [chat.id, chat]))
    set({ settings, workspaces, projects, chats: sealed, providers, mcpServers, ready: true })

    if (listenersBound) return
    listenersBound = true

    window.api.chat.onEvent(applyStreamEvent)

    // Other windows: each keeps its own copy of these, and main passes on
    // what the others change. The open tab stays this window's own.
    window.api.chats.onChanged(receiveChats)
    window.api.projects.onChanged((projects) => set({ projects }))
    window.api.workspaces.onChanged((workspaces) => set({ workspaces }))
    window.api.settings.onChanged((next) =>
      set((state) => ({ settings: { ...next, activeWorkspaceId: state.settings?.activeWorkspaceId ?? next.activeWorkspaceId } }))
    )

    // Closing the window or reloading ends this renderer, and with it the only
    // copy of the reply in flight, the pending debounced save and any approval
    // prompt the run is parked on. Main writes nothing of a chat run itself, so
    // stop it — nothing could show, approve or save what it does from here —
    // and save what has arrived so far.
    window.addEventListener('pagehide', () => {
      const streaming = get().streamingMessageId
      if (streaming) {
        void window.api.chat.cancel(streaming)
        set((s) => ({ chats: sealInterrupted(s.chats, streaming), ...IDLE, ...withoutApprovals(s, streaming) }))
      }
      if (saveTimer || streaming) saveChatsNow()
    })

    // Scheduled tasks (features/scheduler): main starts those runs, so their
    // chats arrive whole — at the start, and again when the run ends — and
    // are inserted, or merged into the copy already here. Main writes
    // chats.json itself only while no renderer has said it is ready.
    window.api.scheduler.onChat((incoming) => {
      const current = get().chats
      const index = current.findIndex((c) => c.id === incoming.id)
      const chats = index === -1 ? [incoming, ...current] : current.map((c, i) => (i === index ? mergeRunChat(c, incoming) : c))
      set({ chats })
      persistChats()
    })
    window.api.scheduler.onOpenChat((chatId) => revealChat(chatId))
    void window.api.scheduler.ready().then(() => migrateLegacySchedules())

    window.api.codeIndex.onStatus((indexStatus) => set({ indexStatus }))
    window.api.providers.onChanged(() => void get().refreshProviders())

    void window.api.updater.status().then((updateStatus) => set({ updateStatus }))
    window.api.updater.onStatus((updateStatus) => set({ updateStatus }))

    window.api.models.onDownloadProgress((progress) => {
      const key = `${progress.repoId}::${progress.filename}`
      set((state) => ({ modelDownloads: { ...state.modelDownloads, [key]: progress } }))
    })

    // Pick up an existing index for the work folder, and refresh it in the
    // background so the first codebase_search of the session is not stale.
    const workCwd = agentWorkspace(workspaces)?.cwd ?? null
    if (workCwd) {
      set({ indexStatus: await window.api.codeIndex.status(workCwd) })
      if (settings.codeIndex.autoIndex) void get().reindex()
    }
  },

  async patchSettings(patch) {
    const next = await window.api.settings.patch(patch as Partial<Settings>)
    // Main's activeWorkspaceId is whichever window switched tabs last; this
    // window keeps showing its own tab unless this patch is the switch.
    const own = get().settings?.activeWorkspaceId
    set({ settings: 'activeWorkspaceId' in patch || !own ? next : { ...next, activeWorkspaceId: own } })
  },

  setView: (view) => {
    const current = { view: get().view, activeChatId: get().activeChatId }
    if (current.view === view) return
    set((s) => ({ navPast: [...s.navPast, current], navFuture: [], view }))
  },
  setSettingsPage: (settingsPage) => {
    const current = { view: get().view, activeChatId: get().activeChatId }
    set((s) => ({
      navPast: current.view === 'settings' ? s.navPast : [...s.navPast, current],
      navFuture: current.view === 'settings' ? s.navFuture : [],
      settingsPage,
      view: 'settings'
    }))
  },
  setPluginsTab: (pluginsTab) => set({ pluginsTab }),
  setModelsRepo: (modelsRepo) => set({ modelsRepo }),

  goBack: () => {
    const { navPast } = get()
    if (navPast.length === 0) return
    const current = { view: get().view, activeChatId: get().activeChatId }
    const previous = navPast[navPast.length - 1]
    set((s) => ({
      navPast: s.navPast.slice(0, -1),
      navFuture: [current, ...s.navFuture],
      view: previous.view,
      activeChatId: previous.activeChatId
    }))
  },
  goForward: () => {
    const { navFuture } = get()
    if (navFuture.length === 0) return
    const current = { view: get().view, activeChatId: get().activeChatId }
    const next = navFuture[0]
    set((s) => ({
      navFuture: s.navFuture.slice(1),
      navPast: [...s.navPast, current],
      view: next.view,
      activeChatId: next.activeChatId
    }))
  },
  canGoBack: () => get().navPast.length > 0,
  canGoForward: () => get().navFuture.length > 0,

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleBrowser: (open) => set((s) => ({ browserOpen: open ?? !s.browserOpen })),

  newChat: (projectId = null) => {
    const current = { view: get().view, activeChatId: get().activeChatId }
    set((s) => ({
      navPast: [...s.navPast, current],
      navFuture: [],
      activeChatId: null,
      view: 'chat',
      pendingProjectId: projectId
    }))
  },

  openChat: (id) => {
    const current = { view: get().view, activeChatId: get().activeChatId }
    set((s) => ({
      navPast: [...s.navPast, current],
      navFuture: [],
      activeChatId: id,
      view: 'chat',
      // Only when there is something to clear: a new array re-sorts the sidebar.
      ...(s.chats.some((c) => c.id === id && c.unread) ? { chats: s.chats.map((c) => (c.id === id ? { ...c, unread: false } : c)) } : {})
    }))
  },

  // Deleting or archiving a chat whose reply is still streaming stops it. The
  // run otherwise kept going with nowhere to write, and — for a deleted chat —
  // its end never found the message, so every composer stayed on "Stop".
  deleteChat: (id) => {
    if (get().streamingChatId === id) get().stop()
    const chats = get().chats.filter((c) => c.id !== id)
    set({ chats, activeChatId: get().activeChatId === id ? null : get().activeChatId })
    persistChats()
  },

  archiveChat: (id) => {
    if (get().streamingChatId === id) get().stop()
    const chats = get().chats.map((c) => (c.id === id ? { ...c, archived: true } : c))
    set({ chats, activeChatId: get().activeChatId === id ? null : get().activeChatId })
    persistChats()
  },

  restoreChat: (id) => {
    set((s) => ({ chats: s.chats.map((c) => (c.id === id ? { ...c, archived: false } : c)) }))
    persistChats()
  },

  renameChat: (id, title) => {
    set((s) => ({ chats: s.chats.map((c) => (c.id === id ? { ...c, title } : c)) }))
    persistChats()
  },

  togglePin: (id) => {
    set((s) => ({ chats: s.chats.map((c) => (c.id === id ? { ...c, pinned: !c.pinned } : c)) }))
    persistChats()
  },

  async send(text, options = {}) {
    const state = get()
    const settings = state.settings
    if (!settings || (!text.trim() && !options.attachments?.length)) return
    // One reply streams at a time: the stop button, the streaming marker and
    // the approval prompt all follow a single message. A second send would
    // orphan the first — still running, with nothing left to stop it.
    if (state.streamingMessageId) return

    const model = state.currentModel()
    const now = Date.now()
    const userMessage: ChatMessage = {
      id: uid(),
      role: 'user',
      parts: [{ type: 'text', text }],
      createdAt: now,
      ...(options.attachments?.length ? { attachments: options.attachments } : {})
    }
    const assistantMessage: ChatMessage = {
      id: uid(),
      role: 'assistant',
      parts: [],
      createdAt: now + 1,
      model: model?.id
    }
    const goal = options.goal
      ? { text: text.trim(), status: 'active' as const, iterations: 0, ...(options.until && options.until > now ? { until: options.until } : {}) }
      : undefined

    let chat = state.activeChat()
    let chats: Chat[]
    if (!chat) {
      chat = {
        id: uid(),
        workspaceId: settings.activeWorkspaceId,
        projectId: state.pendingProjectId,
        title: (text.trim() || options.attachments?.[0]?.split(/[\\/]/).pop() || 'New chat').split('\n')[0].slice(0, 60),
        messages: [userMessage, assistantMessage],
        createdAt: now,
        updatedAt: now,
        archived: false,
        pinned: false,
        unread: false,
        modelId: model?.id ?? null,
        effort: settings.effort,
        ...(goal ? { goal } : {})
      }
      chats = [chat, ...state.chats]
    } else {
      const target = chat
      chats = state.chats.map((c) =>
        c.id === target.id
          ? { ...c, messages: [...c.messages, userMessage, assistantMessage], updatedAt: now, ...(goal ? { goal } : {}) }
          : c
      )
    }

    set({ chats, activeChatId: chat.id, streamingMessageId: assistantMessage.id, streamingChatId: chat.id, view: 'chat' })
    // Saved straight away rather than debounced: other windows need the new
    // messages before the reply's first words reach them.
    saveChatsNow()

    if (!model) {
      const failed = chats.map((c) =>
        c.id === chat!.id
          ? {
              ...c,
              messages: c.messages.map((m) =>
                m.id === assistantMessage.id
                  ? { ...m, error: 'No model selected. Add an API key in Settings → Model providers to get started.' }
                  : m
              )
            }
          : c
      )
      set({ chats: failed, ...IDLE })
      persistChats()
      return
    }

    // The main process decides what of this to resend — it trims old tool
    // output and drops stale screenshots — so the stored transcript goes over
    // as-is. Everything a compaction summary already covers is left out.
    const current = chats.find((c) => c.id === chat!.id)!
    let history = current.messages.filter((m) => m.id !== assistantMessage.id && m.role !== 'system')
    const summary = current.summary ?? null
    if (summary) {
      const cut = history.findIndex((m) => m.id === summary.throughMessageId)
      if (cut !== -1) history = history.slice(cut + 1)
    }

    const project = state.projects.find((p) => p.id === current.projectId)
    const workspace = state.workspaces.find((w) => w.id === current.workspaceId)
    // Chat is the agent: every chat turn gets the full tool set. The old
    // web-search-only mode is still what scheduled "chat" tasks and the Local
    // API Server use, but nothing in the UI sends it any more.
    const mode = isAgentKind(workspace?.kind) ? 'work' : 'chat'

    const request: StreamRequest = {
      chatId: current.id,
      chatTitle: current.title,
      messageId: assistantMessage.id,
      providerId: model.providerId,
      modelId: model.id,
      effort: settings.effort,
      mode,
      history,
      summary: summary?.text ?? null,
      projectInstructions: project?.instructions ?? '',
      cwd: mode === 'work' ? (workspace?.cwd ?? null) : null,
      work: {
        swarm: settings.work.swarm,
        plan: options.plan ?? settings.planMode
      },
      goal: current.goal?.status === 'active' ? current.goal : null
    }
    try {
      await window.api.chat.stream(request)
    } catch (error) {
      // The run never started, or main failed before its loop could report
      // back. Without this the reply sat on "Thinking" with Stop showing.
      if (get().streamingMessageId !== assistantMessage.id) return
      const reason = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error)
      applyStreamEvent({ type: 'error', messageId: assistantMessage.id, error: reason })
    }
  },

  stop() {
    const id = get().streamingMessageId
    if (!id) return
    void window.api.chat.cancel(id)
    set((s) => ({ ...IDLE, ...withoutApprovals(s, id) }))
  },

  setMessageFeedback(messageId, feedback) {
    const chat = get().activeChat()
    if (!chat) return
    const next = withFeedback(chat, messageId, feedback)
    if (next === chat) return
    set({ chats: get().chats.map((c) => (c.id === chat.id ? next : c)) })
    persistChats()
  },

  retryReply(messageId) {
    const chat = get().activeChat()
    if (!chat || get().streamingMessageId) return
    const plan = retryPlan(chat, messageId)
    if (!plan) return
    set({ chats: get().chats.map((c) => (c.id === chat.id ? { ...c, messages: plan.messages } : c)) })
    void get().send(plan.text, plan.attachments ? { attachments: plan.attachments } : {})
  },

  forkChat(messageId) {
    const chat = get().activeChat()
    if (!chat) return
    const fork = forkedChat(chat, messageId, uid(), Date.now())
    if (!fork) return
    set((s) => ({ chats: [fork, ...s.chats], activeChatId: fork.id, view: 'chat' }))
    persistChats()
  },

  approvePlan(messageId) {
    const chat = get().activeChat()
    if (!chat) return
    const chats = get().chats.map((c) =>
      c.id === chat.id
        ? {
            ...c,
            messages: c.messages.map((m) =>
              m.id === messageId && m.plan ? { ...m, plan: { ...m.plan, status: 'approved' as const } } : m
            )
          }
        : c
    )
    set({ chats })
    persistChats()
    // Plan mode stays on for the next task; this one runs with it off.
    void get().send('Approved — carry out the plan. Keep the checklist updated as you go.', { plan: false })
  },

  setGoalStatus(status) {
    const chat = get().activeChat()
    if (!chat) return
    // A goal pursued right now lives in the main process too; pausing only
    // here would be overwritten by the loop's next "still working" event.
    const streaming = get().streamingMessageId
    if (status !== 'active' && streaming && chat.messages.some((m) => m.id === streaming)) void window.api.chat.pauseGoal(streaming)
    const chats = get().chats.map((c) =>
      c.id === chat.id ? { ...c, goal: status && c.goal ? { ...c.goal, status, ...(status === 'active' ? { summary: undefined } : {}) } : null } : c
    )
    set({ chats })
    persistChats()
  },

  respondApproval(approved) {
    const pending = get().pendingApproval
    if (!pending) return
    void window.api.chat.approve(pending.requestId, approved)
    set((s) => ({ pendingApproval: s.approvalQueue[0] ?? null, approvalQueue: s.approvalQueue.slice(1) }))
  },

  setComposerDraft(text) {
    set({ composerDraft: text })
  },

  async reindex(force = false) {
    const cwd = agentWorkspace(get().workspaces)?.cwd
    if (!cwd) return
    set({ indexStatus: await window.api.codeIndex.build(cwd, force) })
  },

  createProject(name) {
    const settings = get().settings
    const project: Project = {
      id: uid(),
      workspaceId: settings?.activeWorkspaceId ?? 'work',
      name,
      instructions: '',
      createdAt: Date.now()
    }
    const projects = [...get().projects, project]
    set({ projects })
    void window.api.projects.save(projects)
    return project
  },

  updateProject(id, patch) {
    const projects = get().projects.map((p) => (p.id === id ? { ...p, ...patch } : p))
    set({ projects })
    void window.api.projects.save(projects)
  },

  deleteProject(id) {
    const projects = get().projects.filter((p) => p.id !== id)
    const orphaned = get().chats.some((c) => c.projectId === id)
    set({
      projects,
      ...(orphaned ? { chats: get().chats.map((c) => (c.projectId === id ? { ...c, projectId: null } : c)) } : {}),
      ...(get().pendingProjectId === id ? { pendingProjectId: null } : {})
    })
    void window.api.projects.save(projects)
    if (orphaned) persistChats()
  },

  setWorkspace(id) {
    void get().patchSettings({ activeWorkspaceId: id })
    set({ activeChatId: null })
  },

  setWorkCwd(cwd) {
    const target = agentWorkspace(get().workspaces)
    const workspaces = get().workspaces.map((w) => (w === target ? { ...w, cwd } : w))
    set({ workspaces, indexStatus: null })
    void window.api.workspaces.save(workspaces)
    // A freshly chosen folder has no index yet, and the agent's search tools
    // are useless until it does — so start building immediately.
    if (cwd && get().settings?.codeIndex.autoIndex !== false) void get().reindex()
  },

  selectModel(modelId, providerId) {
    const model = get()
      .availableModels()
      .find((m) => m.id === modelId && (!providerId || m.providerId === providerId))
    // The effort stays as chosen: each request clamps it to what the model
    // takes (shared/effort.ts), so switching to a model without Max and back
    // does not quietly lose the Max the user picked.
    void get().patchSettings({ selectedModelId: modelId, selectedProviderId: model?.providerId ?? providerId ?? null })
  },

  toggleFavorite(modelId, providerId) {
    const key = `${providerId}:${modelId}`
    const current = get().settings?.favoriteModels ?? []
    void get().patchSettings({ favoriteModels: current.includes(key) ? current.filter((k) => k !== key) : [...current, key] })
  },

  setEffort(effort) {
    void get().patchSettings({ effort })
  },

  async refreshProviders() {
    set({ providers: await window.api.providers.list() })
  },

  async downloadModel(repoId, filename) {
    const key = `${repoId}::${filename}`
    try {
      return await window.api.models.download(repoId, filename)
    } finally {
      // The main process's last progress event and this promise settling can
      // race; clearing here (rather than relying on a 'done' event) guarantees
      // the entry disappears from the Downloads panel exactly when the button
      // that started it stops waiting, whether it succeeded or failed.
      set((state) => {
        const next = { ...state.modelDownloads }
        delete next[key]
        return { modelDownloads: next }
      })
    }
  },

  async saveMcpServers(servers) {
    set({ mcpServers: servers })
    await window.api.mcp.save(servers)
  },

  availableModels() {
    const providers = get().providers
    // Cached on the providers array's identity. These derived selectors run on
    // every store change — including every batch of streamed tokens — and
    // returning a stable array also lets subscribers bail out on reference
    // equality instead of walking the list.
    if (modelsCache && modelsCache.providers === providers) return modelsCache.models
    const models = providers.filter((p) => p.enabled && (p.hasKey || p.local)).flatMap((p) => p.models)
    modelsCache = { providers, models }
    return models
  },

  currentModel() {
    const state = get()
    const models = state.availableModels()
    if (models.length === 0) return null
    const selected = state.settings?.selectedModelId
    const provider = state.settings?.selectedProviderId
    return (
      models.find((m) => m.id === selected && m.providerId === provider) ??
      models.find((m) => m.id === selected) ??
      models[0]
    )
  },

  activeChat() {
    const { chats, activeChatId } = get()
    return chats.find((c) => c.id === activeChatId) ?? null
  },

  visibleChats() {
    const { chats, settings } = get()
    const workspaceId = settings?.activeWorkspaceId
    if (chatsCache && chatsCache.chats === chats && chatsCache.workspaceId === workspaceId) return chatsCache.visible
    const visible = chats
      .filter((c) => !c.archived && c.workspaceId === workspaceId)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
    chatsCache = { chats, workspaceId, visible }
    return visible
  },

  chatList() {
    const visible = get().visibleChats()
    if (listCache && listCache.visible === visible) return listCache.items
    // `visibleChats()` changes identity on every batch of streamed tokens,
    // since the streaming chat is a new object each time. The sidebar only
    // shows a title, a pin and an error mark, so an item is rebuilt only for a
    // chat object it has not seen, reused if nothing it shows changed, and the
    // previous array is returned when every item is the same — the sidebar
    // then does not re-render at all while a reply streams.
    const previous = listCache?.items ?? []
    const items = visible.map((chat, index) => {
      const cached = listItems.get(chat)
      if (cached) return cached
      const failed = lastTurnFailed(chat.messages)
      const before = previous[index]
      const item =
        before && before.id === chat.id && before.title === chat.title && before.pinned === chat.pinned && before.failed === failed
          ? before
          : { id: chat.id, title: chat.title, pinned: chat.pinned, failed }
      listItems.set(chat, item)
      return item
    })
    const unchanged = items.length === previous.length && items.every((item, index) => item === previous[index])
    listCache = { visible, items: unchanged ? previous : items }
    return listCache.items
  },

  visibleProjects() {
    const { projects, settings } = get()
    return projects.filter((p) => p.workspaceId === settings?.activeWorkspaceId)
  }
}))

/**
 * Opens a chat in whichever tab it belongs to (added for scheduled tasks). The
 * sidebar only lists the active workspace's chats, and a scheduled run's chat
 * can be a Chat or a Work chat whatever tab is showing — a notification click
 * or a run-history row has to land on it either way.
 */
export function revealChat(chatId: string): void {
  const state = useApp.getState()
  const chat = state.chats.find((c) => c.id === chatId)
  if (!chat) return
  const active = state.settings?.activeWorkspaceId
  if (active && chat.workspaceId !== active && state.workspaces.some((w) => w.id === chat.workspaceId)) {
    void state.patchSettings({ activeWorkspaceId: chat.workspaceId })
  }
  state.openChat(chatId)
}

function appendPart(message: ChatMessage, type: 'text' | 'reasoning', text: string): ChatMessage {
  const parts = [...message.parts]
  const last = parts[parts.length - 1]
  // Only coalesce into a text part of the same kind — a tool call sitting at the
  // end must stay its own part, and separates the text either side of it.
  if (last && last.type !== 'tool' && last.type === type) {
    parts[parts.length - 1] = { ...last, text: last.text + text }
  } else {
    parts.push({ type, text })
  }
  return { ...message, parts }
}

export function messageText(message: ChatMessage, type: 'text' | 'reasoning' = 'text'): string {
  const parts = message.parts
  // Streaming coalesces consecutive same-type parts, so a message usually holds
  // a single part — return it directly rather than allocating two arrays and a
  // join for every call on a growing reply.
  if (parts.length === 1) return parts[0].type === type ? parts[0].text : ''
  let out = ''
  for (const part of parts) if (part.type !== 'tool' && part.type === type) out += part.text
  return out
}
