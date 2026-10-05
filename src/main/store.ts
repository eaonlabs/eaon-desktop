import os from 'node:os'
import type { Chat, DownloadedModel, McpServer, ModelInfo, Project, Settings, Workspace } from '@shared/types'
import type { ModelEditFields, ProviderHealth } from '@shared/providers'
import { backupDocs, flushDocWrites, readDoc, setAside, shapeOf, writeDocAsync, writeDocSync, type DocSpec } from './storeFiles'
import { repairChats, repairMcpServers, repairProjects, repairProviderConfig, repairSettings, repairWorkspaces } from './storeRepair'

/**
 * What `providers.json` keeps per provider: the user's changes, layered over
 * the catalog rather than replacing it (see `providers/index.ts`).
 */
export interface ProviderOverride {
  baseUrl?: string
  enabled?: boolean
  name?: string
  kind?: string
  /** What the provider's own `/models` returned on the last refresh. */
  listed?: ModelInfo[]
  /** Models the user added by id. */
  custom?: ModelInfo[]
  /** Ids the user removed; restorable. */
  hidden?: string[]
  /** Display names the user chose, by model id. */
  labels?: Record<string, string>
  /** Limits and capabilities the user set (Edit model), by model id. */
  edits?: Record<string, ModelEditFields>
  /** Before overlays: the whole list, replaced on every refresh. Read once as `listed`. */
  models?: ModelInfo[]
  /** When `listed` was fetched: the last listing that worked, kept when a later one fails. */
  listedAt?: number
  /** When the latest listing failed, if it did after `listedAt`. */
  listFailedAt?: number
  /** What the last check of the credentials found (see Provider.health). */
  health?: ProviderHealth
}

/**
 * chats.json as last saved. Every window, the scheduler and the migrations go
 * through this copy: the file itself lags behind an async write, and with
 * several windows a change has to land on the latest list, not on whatever a
 * window last loaded.
 */
let chatsCache: Chat[] | null = null

/*
 * Reading and writing go through storeFiles.ts: atomic, flushed writes with
 * the previous save kept, and reads that repair or recover a damaged file
 * rather than handing the app a default it would then save over the user's
 * data. Each of the store's own documents has a repair pass (storeRepair.ts);
 * the `getJson` documents of features are checked for shape only.
 */
/** Tests: drop the in-memory chat list, so the next read comes from disk. */
export function forgetChatsForTests(): void {
  chatsCache = null
}

function writeJson(name: string, value: unknown): void {
  writeDocSync(name, value)
}

function writeJsonAsync(name: string, value: unknown): void {
  writeDocAsync(name, value)
}

function readJson<T>(name: string, fallback: T): T {
  return readDoc(name, shapeOf(fallback))
}

const SETTINGS_DOC: DocSpec<Record<string, unknown>> = {
  fallback: () => ({}),
  repair: (value) => repairSettings(value, defaultSettings as unknown as Record<string, unknown>)
}
const CHATS_DOC: DocSpec<Chat[]> = { fallback: () => [], repair: (value) => repairChats(value), pretty: false }
const PROJECTS_DOC: DocSpec<Project[]> = { fallback: () => [], repair: (value) => repairProjects(value) }
const WORKSPACES_DOC: DocSpec<Workspace[]> = { fallback: () => [], repair: repairWorkspaces }
const PROVIDERS_DOC: DocSpec<Record<string, ProviderOverride>> = {
  fallback: () => ({}),
  repair: (value) => repairProviderConfig(value) as ReturnType<DocSpec<Record<string, ProviderOverride>>['repair']>
}

/**
 * Three workspaces, one per top-bar tab: Chat, Workers and ADE.
 *
 * The ids look scrambled and are kept that way on purpose. The chat workspace
 * has always been `work`, and every chat and project on disk points at it —
 * renaming an id would move that history into the wrong tab. The old agent
 * tab ("Work", id `code`) was folded into Chat when Chat became the agent; see
 * `migrateWorkspaces`. Workers keep their own store (features/workers), so
 * their tab holds no chats.
 */
export const DEFAULT_WORKSPACES: Workspace[] = [
  { id: 'work', name: 'Chat', kind: 'chat', cwd: null },
  { id: 'workers', name: 'Workers', kind: 'workers' },
  { id: 'eaon-code', name: 'ADE', kind: 'code', cwd: null }
]

const CHAT_WORKSPACE_ID = DEFAULT_WORKSPACES[0].id
const WORKERS_WORKSPACE_ID = DEFAULT_WORKSPACES[1].id
const CODE_WORKSPACE_ID = DEFAULT_WORKSPACES[2].id

export const defaultSettings: Settings = {
  general: {
    defaultPermissions: true,
    fullAccess: false,
    fileOpenDestination: 'VS Code',
    language: 'Auto detect',
    showInMenuBar: true,
    bottomPanel: false,
    preventSleep: false,
    suggestedPrompts: true,
    launchAtLogin: false,
    launchMode: 'chat'
  },
  appearance: {
    mode: 'dark',
    light: {
      preset: 'Cobalt',
      accent: '#0A84FF',
      background: '#FFFFFF',
      foreground: '#1A1C1F',
      fontFamily: 'System default',
      fontWeight: 'Regular',
      translucentSidebar: true,
      contrast: 45
    },
    dark: {
      preset: 'Cobalt',
      accent: '#0A84FF',
      background: '#111111',
      foreground: '#FCFCFC',
      fontFamily: 'System default',
      fontWeight: 'Regular',
      translucentSidebar: true,
      contrast: 60
    },
    pointerCursors: false,
    reduceMotion: 'system',
    fontSize: 14,
    fontSmoothing: true,
    appIcon: 'default'
  },
  configuration: {
    configScope: 'User config',
    approvalPolicy: 'On request',
    sandbox: 'Read only',
    webSearch: 'Cached',
    outputDetail: 'Model default',
    reasoningSummary: 'Auto',
    workspaceDependencies: true
  },
  browser: {
    homepage: '',
    importedFromChrome: false,
    dismissedImportBanner: false
  },
  mcp: {
    allowAllToolPermissions: false,
    toolCallTimeoutSeconds: 30,
    smartRouting: true,
    useDedicatedRoutingModel: false,
    routingModelId: null
  },
  localServer: {
    autoStart: false,
    port: 1337,
    defaultModelId: null,
    smallModelId: null,
    token: null
  },
  claudeCode: {
    largeModelId: null,
    mediumModelId: null,
    smallModelId: null,
    env: [],
    enabled: false
  },
  codeIndex: {
    embeddingProviderId: null,
    embeddingModelId: null,
    autoIndex: true,
    // Cursor-style exploration burns rounds quickly — search, read, edit,
    // run tests, react to failures. The old ceiling of 8 cut real work short.
    maxToolRounds: 40
  },
  shortcuts: {
    'new-chat': '⌘N',
    'new-chat-alt': '⇧⌘O',
    'new-temporary-chat': '⇧⌘N',
    'quick-chat': '⌥⌘N',
    'archive-chat': '⇧⌘A',
    'new-standalone-chat': '⌥⌘O',
    'open-side-chat': '⌥⌘S',
    'mark-unread': '⇧⌘U',
    'open-new-window': null,
    'toggle-pin': '⌥⌘P',
    'focus-browser-address-bar': '⌘L',
    'focus-main-chat': null,
    'focus-side-chat': null,
    'toggle-sidebar': '⌘B',
    'open-settings': '⌘,',
    search: '⌘K'
  },
  installedPlugins: [],
  disabledPlugins: [],
  disabledSkills: [],
  activeWorkspaceId: 'work',
  selectedModelId: null,
  selectedProviderId: null,
  favoriteModels: [],
  recentModels: [],
  effort: 'light',
  approvalMode: 'ask',
  planMode: false,
  work: {
    swarm: false,
    goalMaxIterations: 8,
    goalMaxMinutes: 60,
    goalMaxTokens: 2_000_000,
    subagentModelId: null,
    defaultFolder: null
  },
  context: {
    autoCompact: true,
    compactAt: 0.7,
    keepFullToolTurns: 2
  },
  computerUse: {
    enabled: false,
    confirmEachAction: true,
    quality: 'balanced'
  },
  browserExtension: {
    enabled: true,
    port: 47821
  },
  discord: {
    enabled: false,
    showStatus: true,
    showElapsed: true,
    showButton: true
  },
  eaonCode: {
    binaryPath: null,
    lastCwd: null,
    shareKeys: true
  },
  notifications: {
    taskComplete: true
  },
  background: {
    enabled: false
  }
}

/** Recursive merge so settings files written by older versions keep working. */
function merge<T>(base: T, patch: unknown): T {
  // `undefined` means "not included in this patch" — keep the existing value.
  if (patch === undefined) return base
  // An explicit `null` clears the field. Without this, nullable settings could
  // be set but never reset.
  if (patch === null) return null as T
  // `typeof null === 'object'`, so a null base has to be handled before the
  // object checks below. Missing this silently dropped every write to a
  // currently-null field — which is exactly what broke model selection, since
  // `selectedModelId` ships as null.
  if (base === null || base === undefined) return patch as T
  // Arrays replace wholesale rather than merging index by index.
  if (Array.isArray(base) || Array.isArray(patch)) return patch as T
  // A primitive on either side means there is nothing to recurse into.
  if (typeof base !== 'object' || typeof patch !== 'object') return patch as T

  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const current = (base as Record<string, unknown>)[key]
    out[key] = key in (base as object) ? merge(current as never, value) : value
  }
  return out as T
}

/**
 * Top-level settings that features which no longer exist wrote. merge() keeps
 * keys it doesn't know, so without this they would be written back forever.
 */
const REMOVED_SETTINGS = ['pets']

/** Settings with anything of the wrong type or out of range put back to its default; see repairSettings. */
function checkedSettings(settings: Settings): Settings {
  const repaired = repairSettings(structuredClone(settings), defaultSettings as unknown as Record<string, unknown>)
  return repaired && repaired.fixed > 0 ? merge(defaultSettings, repaired.value) : settings
}

/** mcp.json, with the servers a fresh install starts with when there is no file. */
function mcpDoc(defaults: McpServer[]): DocSpec<McpServer[]> {
  return { fallback: () => defaults, repair: repairMcpServers }
}

export const store = {
  getSettings(): Settings {
    const saved = readDoc('settings.json', SETTINGS_DOC)
    for (const key of REMOVED_SETTINGS) delete saved[key]
    return merge(defaultSettings, saved)
  },
  saveSettings(settings: Settings): Settings {
    const checked = checkedSettings(settings)
    writeJson('settings.json', checked)
    return checked
  },
  patchSettings(patch: Partial<Settings>): Settings {
    // Checked before it is saved or sent to every window: a patch that sets a
    // whole section to null, or an unknown option, would otherwise reach the
    // renderers as is.
    const next = checkedSettings(merge(this.getSettings(), patch))
    writeJson('settings.json', next)
    return next
  },

  getWorkspaces(): Workspace[] {
    const saved = readDoc('workspaces.json', WORKSPACES_DOC)
    return saved.length > 0 ? saved : DEFAULT_WORKSPACES.map((w) => ({ ...w }))
  },
  saveWorkspaces(workspaces: Workspace[]): Workspace[] {
    writeJson('workspaces.json', workspaces)
    return workspaces
  },

  /**
   * Brings an install up to the canonical three-workspace layout: Chat,
   * Workers, ADE.
   *
   * Runs against every shape of stored data seen so far — the old free-form
   * workspaces, the single collapsed one written while the agent was hidden,
   * the Chat/Work pair, the Chat/Work/Code trio, and the current layout.
   * Anything pointing at a workspace that no longer exists is re-homed to Chat
   * rather than dropped, so no chat or project disappears from view. That is
   * how the Work tab's history lands in Chat now that Chat is the agent; the
   * folder chosen for Work comes along, since Chat now works in it. The active
   * id is repaired for the same reason: pointing at a missing workspace opens
   * to an empty list with no way out.
   */
  migrateWorkspaces(): void {
    const existing = readDoc('workspaces.json', WORKSPACES_DOC)
    const settings = readDoc('settings.json', SETTINGS_DOC) as Partial<Settings>

    const chat = existing.find((w) => w.kind === 'chat' || (w.kind as string) === undefined)
    const work = existing.find((w) => w.kind === 'work')
    const code = existing.find((w) => w.kind === 'code')
    const chatId = chat?.id ?? CHAT_WORKSPACE_ID
    const codeId = code?.id ?? CODE_WORKSPACE_ID
    // Names are the tab labels, so they are reset rather than carried over —
    // older installs called these "Eaon", "Work" and "Code".
    const workspaces: Workspace[] = [
      { id: chatId, name: 'Chat', kind: 'chat', cwd: chat?.cwd ?? work?.cwd ?? null },
      { id: WORKERS_WORKSPACE_ID, name: 'Workers', kind: 'workers' },
      { id: codeId, name: 'ADE', kind: 'code', cwd: code?.cwd ?? null }
    ]

    const known = new Set(workspaces.map((w) => w.id))
    const active = settings.activeWorkspaceId && known.has(settings.activeWorkspaceId) ? settings.activeWorkspaceId : chatId
    const canonical =
      existing.length === workspaces.length &&
      existing.every((w, i) => w.id === workspaces[i].id && w.kind === workspaces[i].kind && w.name === workspaces[i].name) &&
      settings.activeWorkspaceId === active

    // Checked on every launch, not only when the tabs change: a chat can
    // point at a workspace or a project that is gone (a project deleted in
    // another window while this chat's save was lost, or a projects.json
    // that had to be started over), and such a chat is in no list at all —
    // not under any project, and not in Recents either, which leaves out
    // every chat that has a project.
    const projects = readDoc('projects.json', PROJECTS_DOC)
    const projectIds = new Set(projects.map((p) => p.id))
    const chats = readDoc('chats.json', CHATS_DOC)
    const strayChat = (c: Chat): boolean => !known.has(c.workspaceId) || (c.projectId !== null && !projectIds.has(c.projectId))
    const strayProjects = projects.some((p) => !known.has(p.workspaceId))
    const strayChats = chats.some(strayChat)
    if (canonical && !strayProjects && !strayChats) return

    // Rewrites the user's chats and projects, so a copy of them as they were
    // goes into store/backups first.
    if (strayChats || strayProjects || existing.length > 0) {
      backupDocs('before-workspaces', ['workspaces.json', 'settings.json', 'chats.json', 'projects.json'])
    }
    if (strayChats) {
      chatsCache = chats.map((c) =>
        strayChat(c)
          ? {
              ...c,
              workspaceId: known.has(c.workspaceId) ? c.workspaceId : chatId,
              projectId: c.projectId !== null && projectIds.has(c.projectId) ? c.projectId : null
            }
          : c
      )
      writeJsonAsync('chats.json', chatsCache)
    }
    if (strayProjects) {
      writeJson(
        'projects.json',
        projects.map((p) => (known.has(p.workspaceId) ? p : { ...p, workspaceId: chatId }))
      )
    }
    if (!canonical) writeJson('workspaces.json', workspaces)
    if (settings.activeWorkspaceId !== active) writeJson('settings.json', { ...settings, activeWorkspaceId: active })
  },

  /**
   * Opens the app in the mode chosen under Settings → General → Open on
   * launch. Runs once at startup, after `migrateWorkspaces`; "last" leaves
   * the mode the app was closed in.
   */
  applyLaunchMode(): void {
    const settings = this.getSettings()
    const mode = settings.general.launchMode
    if (!mode || mode === 'last') return
    const kind = mode === 'ade' ? 'code' : mode
    const target = this.getWorkspaces().find((w) => w.kind === kind)
    if (target && target.id !== settings.activeWorkspaceId) this.saveSettings({ ...settings, activeWorkspaceId: target.id })
  },

  getProjects(): Project[] {
    return readDoc('projects.json', PROJECTS_DOC)
  },
  saveProjects(projects: Project[]): Project[] {
    writeJson('projects.json', projects)
    return projects
  },

  /** A copy of the list, safe for the caller to reorder or extend before saving it back. */
  getChats(): Chat[] {
    chatsCache ??= readDoc('chats.json', CHATS_DOC)
    return chatsCache.slice()
  },
  /** Replaces the whole list. Returns nothing: nobody needs the array echoed back. */
  saveChats(chats: Chat[]): void {
    chatsCache = chats
    writeJsonAsync('chats.json', chats)
  },
  /**
   * Applies one window's edits: the chats it changed (replaced in place, or
   * added at the top when new) and the ones it deleted. Windows send only what
   * they changed, so two windows saving at once don't overwrite each other.
   */
  applyChats(upserts: Chat[], removed: string[]): void {
    if (upserts.length === 0 && removed.length === 0) return
    const gone = new Set(removed)
    const incoming = new Map(upserts.map((chat) => [chat.id, chat]))
    const current = this.getChats()
    const next = current.filter((chat) => !gone.has(chat.id)).map((chat) => incoming.get(chat.id) ?? chat)
    const known = new Set(current.map((chat) => chat.id))
    const added = upserts.filter((chat) => !known.has(chat.id) && !gone.has(chat.id))
    this.saveChats([...added, ...next])
  },

  /** Awaits any in-flight async write so quitting cannot drop the last save; also retries a save that failed. */
  flushWrites(): Promise<unknown> {
    return flushDocWrites()
  },

  getMcpServers(): McpServer[] {
    return readDoc('mcp.json', mcpDoc([
      {
        id: 'filesystem',
        name: 'Filesystem',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', os.homedir()],
        env: {},
        url: '',
        enabled: false,
        official: true
      },
      {
        id: 'memory',
        name: 'Memory',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-memory'],
        env: {},
        url: '',
        enabled: false,
        official: true
      }
    ]))
  },
  saveMcpServers(servers: McpServer[]): McpServer[] {
    writeJson('mcp.json', servers)
    return servers
  },

  getProviderConfig(): Record<string, ProviderOverride> {
    return readDoc('providers.json', PROVIDERS_DOC)
  },
  saveProviderConfig(config: Record<string, unknown>): void {
    writeJson('providers.json', config)
  },

  /**
   * A named JSON document in the store folder, for features that keep their
   * own file (scheduled tasks, Code sessions, OAuth metadata) without each one
   * growing this object by another getter/setter pair.
   */
  getJson<T>(name: string, fallback: T): T {
    return readJson<T>(name, fallback)
  },
  setJson(name: string, value: unknown): void {
    writeJson(name, value)
  },
  /** `setJson` for documents that grow without bound (worker threads): off the main thread, newest write wins. */
  setJsonAsync(name: string, value: unknown): void {
    writeJsonAsync(name, value)
  },
  /**
   * For a feature that found records in its file it can't use: keeps a copy
   * of the file as it is, before the feature saves it without them, and
   * tells the user (see storeFiles.ts).
   */
  setAside(name: string, detail: string): void {
    setAside(name, detail)
  },

  getDownloadedModels(): DownloadedModel[] {
    return readJson<DownloadedModel[]>('downloaded-models.json', [])
  },
  saveDownloadedModels(models: DownloadedModel[]): DownloadedModel[] {
    writeJson('downloaded-models.json', models)
    return models
  }
}
