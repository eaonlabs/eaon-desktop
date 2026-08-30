import { create } from 'zustand'
import type {
  Chat,
  ChatMessage,
  ChatTextPart,
  ChatToolPart,
  DownloadedModel,
  EffortLevel,
  IndexStatus,
  McpServer,
  ModelDownloadProgress,
  ModelInfo,
  Project,
  Provider,
  Settings,
  StreamEvent,
  UpdateStatus,
  Workspace
} from '@shared/types'

export type View = 'chat' | 'plugins' | 'integrations' | 'scheduled' | 'settings' | 'pull-requests' | 'models'

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
  pendingApproval: { requestId: string; messageId: string; tool: string; input: Record<string, unknown> } | null
  /** A suggestion-card prompt waiting to be dropped into the composer, consumed once. */
  composerDraft: string | null
  /** Code-index progress for the Eaon Work project folder. */
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
  send: (text: string) => Promise<void>
  stop: () => void
  respondApproval: (approved: boolean) => void
  setComposerDraft: (text: string | null) => void
  reindex: (force?: boolean) => Promise<void>

  createProject: (name: string) => Project
  deleteProject: (id: string) => void
  setWorkspace: (id: string) => void
  setWorkCwd: (cwd: string) => void

  selectModel: (modelId: string) => void
  downloadModel: (repoId: string, filename: string) => Promise<DownloadedModel>
  setEffort: (effort: EffortLevel) => void
  refreshProviders: () => Promise<void>
  saveMcpServers: (servers: McpServer[]) => Promise<void>

  availableModels: () => ModelInfo[]
  currentModel: () => ModelInfo | null
  activeChat: () => Chat | null
  visibleChats: () => Chat[]
  visibleProjects: () => Project[]
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

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

let saveTimer: ReturnType<typeof setTimeout> | null = null
function persistChats(chats: Chat[]): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void window.api.chats.save(chats), 250)
}

/**
 * True when the active workspace is Eaon Work. Several components gate
 * work-only affordances on this — the plugin tray, the browser panel, the
 * approval chip — and each had its own copy of the lookup, which is how they
 * drift apart. Returns a boolean, so it is safe as a plain selector.
 */
export const useIsWork = (): boolean =>
  useApp((s) => s.workspaces.find((w) => w.id === s.settings?.activeWorkspaceId)?.kind === 'work')

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
  pendingApproval: null,
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
    set({ settings, workspaces, projects, chats, providers, mcpServers, ready: true })

    if (listenersBound) return
    listenersBound = true

    window.api.chat.onEvent((event: StreamEvent) => {
      // Approval requests carry no message content — they open the confirm
      // dialog and the main process blocks on the answer, so they must be
      // handled before the message-indexing path below (which would drop them).
      if (event.type === 'approval-request') {
        set({
          pendingApproval: { requestId: event.requestId, messageId: event.messageId, tool: event.tool, input: event.input }
        })
        return
      }

      const state = get()
      // Index straight to the chat that owns this message instead of rebuilding
      // every chat (and scanning every message) on each streamed token.
      const chatIndex = state.chats.findIndex((c) => c.messages.some((m) => m.id === event.messageId))
      if (chatIndex === -1) return
      const target = state.chats[chatIndex]
      const msgIndex = target.messages.findIndex((m) => m.id === event.messageId)
      if (msgIndex === -1) return

      const message = target.messages[msgIndex]
      let nextMessage = message
      if (event.type === 'delta') nextMessage = appendPart(message, 'text', event.text)
      else if (event.type === 'reasoning') nextMessage = appendPart(message, 'reasoning', event.text)
      else if (event.type === 'error') nextMessage = { ...message, error: event.error }
      else if (event.type === 'tool-call') {
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
            status: event.status
          }
          nextMessage = { ...message, parts }
        }
      }

      const finished = event.type === 'done' || event.type === 'error'
      if (nextMessage === message && !finished) return

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
        messages
      }

      set({ chats, ...(finished ? { streamingMessageId: null } : {}) })
      if (finished) persistChats(chats)
    })

    window.api.codeIndex.onStatus((indexStatus) => set({ indexStatus }))

    void window.api.updater.status().then((updateStatus) => set({ updateStatus }))
    window.api.updater.onStatus((updateStatus) => set({ updateStatus }))

    window.api.models.onDownloadProgress((progress) => {
      const key = `${progress.repoId}::${progress.filename}`
      set((state) => ({ modelDownloads: { ...state.modelDownloads, [key]: progress } }))
    })

    // Pick up an existing index for the work folder, and refresh it in the
    // background so the first codebase_search of the session is not stale.
    const workCwd = workspaces.find((w) => w.kind === 'work')?.cwd ?? null
    if (workCwd) {
      set({ indexStatus: await window.api.codeIndex.status(workCwd) })
      if (settings.codeIndex.autoIndex) void get().reindex()
    }
  },

  async patchSettings(patch) {
    const next = await window.api.settings.patch(patch as Partial<Settings>)
    set({ settings: next })
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
      chats: s.chats.map((c) => (c.id === id ? { ...c, unread: false } : c))
    }))
  },

  deleteChat: (id) => {
    const chats = get().chats.filter((c) => c.id !== id)
    set({ chats, activeChatId: get().activeChatId === id ? null : get().activeChatId })
    persistChats(chats)
  },

  archiveChat: (id) => {
    const chats = get().chats.map((c) => (c.id === id ? { ...c, archived: true } : c))
    set({ chats, activeChatId: get().activeChatId === id ? null : get().activeChatId })
    persistChats(chats)
  },

  restoreChat: (id) => {
    const chats = get().chats.map((c) => (c.id === id ? { ...c, archived: false } : c))
    set({ chats })
    persistChats(chats)
  },

  renameChat: (id, title) => {
    const chats = get().chats.map((c) => (c.id === id ? { ...c, title } : c))
    set({ chats })
    persistChats(chats)
  },

  async send(text) {
    const state = get()
    const settings = state.settings
    if (!settings || !text.trim()) return

    const model = state.currentModel()
    const now = Date.now()
    const userMessage: ChatMessage = {
      id: uid(),
      role: 'user',
      parts: [{ type: 'text', text }],
      createdAt: now
    }
    const assistantMessage: ChatMessage = {
      id: uid(),
      role: 'assistant',
      parts: [],
      createdAt: now + 1,
      model: model?.id
    }

    let chat = state.activeChat()
    let chats: Chat[]
    if (!chat) {
      chat = {
        id: uid(),
        workspaceId: settings.activeWorkspaceId,
        projectId: state.pendingProjectId,
        title: text.trim().split('\n')[0].slice(0, 60),
        messages: [userMessage, assistantMessage],
        createdAt: now,
        updatedAt: now,
        archived: false,
        pinned: false,
        unread: false,
        modelId: model?.id ?? null,
        effort: settings.effort
      }
      chats = [chat, ...state.chats]
    } else {
      const target = chat
      chats = state.chats.map((c) =>
        c.id === target.id
          ? { ...c, messages: [...c.messages, userMessage, assistantMessage], updatedAt: now }
          : c
      )
    }

    set({ chats, activeChatId: chat.id, streamingMessageId: assistantMessage.id, view: 'chat' })
    persistChats(chats)

    if (!model) {
      const failed = chats.map((c) =>
        c.id === chat!.id
          ? {
              ...c,
              messages: c.messages.map((m) =>
                m.id === assistantMessage.id
                  ? { ...m, error: 'No model selected. Add an API key in Settings → Providers to get started.' }
                  : m
              )
            }
          : c
      )
      set({ chats: failed, streamingMessageId: null })
      persistChats(failed)
      return
    }

    // Tool calls travel with the turn that made them, so the agent can see the
    // files it already edited and the commands it already ran. A turn that only
    // called tools and said nothing still has to be kept — dropping it would
    // strand its results.
    const history = (chats.find((c) => c.id === chat!.id)?.messages ?? [])
      .filter((m) => m.id !== assistantMessage.id && m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.parts
          .filter((p): p is ChatTextPart => p.type === 'text')
          .map((p) => p.text)
          .join(''),
        tools: m.parts.filter((p): p is ChatToolPart => p.type === 'tool' && p.output !== null)
      }))
      .filter((m) => m.content.length > 0 || m.tools.length > 0)

    const project = state.projects.find((p) => p.id === chat!.projectId)
    const workspace = state.workspaces.find((w) => w.id === chat!.workspaceId)
    const cwd = workspace?.kind === 'work' ? (workspace.cwd ?? null) : null
    const workInstructions = cwd ? workSystemPrompt(cwd) : ''
    const system = [workInstructions, project?.instructions ?? ''].filter(Boolean).join('\n\n')

    await window.api.chat.stream({
      chatId: chat.id,
      messageId: assistantMessage.id,
      providerId: model.providerId,
      modelId: model.id,
      effort: settings.effort,
      system,
      messages: history,
      cwd
    })
  },

  stop() {
    const id = get().streamingMessageId
    if (id) {
      void window.api.chat.cancel(id)
      set({ streamingMessageId: null })
    }
  },

  respondApproval(approved) {
    const pending = get().pendingApproval
    if (!pending) return
    void window.api.chat.approve(pending.requestId, approved)
    set({ pendingApproval: null })
  },

  setComposerDraft(text) {
    set({ composerDraft: text })
  },

  async reindex(force = false) {
    const cwd = get().workspaces.find((w) => w.kind === 'work')?.cwd
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

  deleteProject(id) {
    const projects = get().projects.filter((p) => p.id !== id)
    set({ projects })
    void window.api.projects.save(projects)
  },

  setWorkspace(id) {
    void get().patchSettings({ activeWorkspaceId: id })
    set({ activeChatId: null })
  },

  setWorkCwd(cwd) {
    const workspaces = get().workspaces.map((w) => (w.kind === 'work' ? { ...w, cwd } : w))
    set({ workspaces, indexStatus: null })
    void window.api.workspaces.save(workspaces)
    // A freshly chosen folder has no index yet, and the agent's search tools
    // are useless until it does — so start building immediately.
    if (get().settings?.codeIndex.autoIndex !== false) void get().reindex()
  },

  selectModel(modelId) {
    const model = get()
      .availableModels()
      .find((m) => m.id === modelId)

    // Effort vocabularies differ between models (Anthropic exposes five levels,
    // OpenAI three, many models none). Carrying a now-invalid level across a
    // model switch would show a setting the request can't honour, so clamp it.
    const efforts = model?.efforts ?? []
    const current = get().settings?.effort
    const effort = efforts.length > 0 && current && !efforts.includes(current) ? efforts[efforts.length - 1] : undefined

    void get().patchSettings({ selectedModelId: modelId, ...(effort ? { effort } : {}) })
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
    return models.find((m) => m.id === selected) ?? models[0]
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

  visibleProjects() {
    const { projects, settings } = get()
    return projects.filter((p) => p.workspaceId === settings?.activeWorkspaceId)
  }
}))

/**
 * Eaon Work's operating instructions. Tool *availability* alone does not make
 * an agent act like one — this is what turns a chat model into something that
 * investigates before editing and verifies afterwards, which is the actual
 * difference between "has tools" and "codes autonomously".
 */
function workSystemPrompt(cwd: string): string {
  return [
    `You are Eaon Work, an agentic coding assistant operating on the project at "${cwd}".`,
    '',
    'Work autonomously. Gather what you need with your own tools instead of asking the user questions you could answer yourself.',
    '',
    'Finding code:',
    '- Start with codebase_search for anything conceptual ("how does auth work?"). It searches meaning, not text.',
    '- Use grep for exact identifiers and strings you already know, find_symbol to jump to a declaration, find_file when you half-remember a filename, and list_dir to get oriented.',
    '- Never guess at file contents. Read a file before editing it.',
    '',
    'Making changes:',
    '- Use edit_file for existing files: `old_text` must match EXACTLY ONCE, so include enough surrounding lines to be unique. Use write_file only for new files or a deliberate full rewrite.',
    '- Make focused edits. Do not reformat or restructure code you were not asked to touch.',
    '- Match the surrounding style, naming and comment density of the file you are editing.',
    '',
    'Verifying:',
    '- After changing code, prove it works: run the test, build, typecheck or lint command the project actually uses (check package.json, Makefile, or similar first).',
    '- If something fails, fix the root cause rather than papering over the symptom. Do not loop on the same failing approach more than about three times — step back and reconsider.',
    '',
    'Reporting:',
    '- Report what you actually did. If a step failed or you skipped something, say so plainly with the evidence.',
    '- Keep the user informed as you go, but do not narrate every tool call.'
  ].join('\n')
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
