import { app } from 'electron'
import os from 'node:os'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Chat, DownloadedModel, McpServer, ModelInfo, Project, Settings, Workspace } from '@shared/types'

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
  /** Before overlays: the whole list, replaced on every refresh. Read once as `listed`. */
  models?: ModelInfo[]
}

const dataDir = () => join(app.getPath('userData'), 'store')

function ensureDir(): string {
  const dir = dataDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/** Write via a temp file + rename so a crash mid-write cannot corrupt the store. */
function writeJson(name: string, value: unknown): void {
  const dir = ensureDir()
  const target = join(dir, name)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, target)
}

const writeQueues = new Map<string, Promise<void>>()
/** The newest value waiting for a file's queued write, which has not started yet. */
const pendingValues = new Map<string, unknown>()

/**
 * Atomic write that does not block the main process.
 *
 * Chat history grows without bound, and a synchronous multi-megabyte write
 * freezes everything the main process drives — IPC, input, painting — for its
 * whole duration. Writes to the same file are chained so a slow one cannot be
 * overtaken by the next, and the output is compact rather than pretty-printed:
 * nothing reads this file by hand, and the indentation roughly doubled both the
 * bytes and the stringify cost.
 *
 * Saves that arrive while a write is still running collapse into one: only the
 * newest is written, and it is only stringified when its turn comes. Each save
 * is the whole file, so the ones in between would be overwritten unread — and
 * every one held its own multi-megabyte string until then.
 */
function writeJsonAsync(name: string, value: unknown): void {
  const alreadyQueued = pendingValues.has(name)
  pendingValues.set(name, value)
  if (alreadyQueued) return
  const dir = ensureDir()
  const target = join(dir, name)
  const tmp = `${target}.tmp`
  const queued = (writeQueues.get(name) ?? Promise.resolve())
    .then(() => {
      const latest = pendingValues.get(name)
      pendingValues.delete(name)
      return writeFile(tmp, JSON.stringify(latest), 'utf8')
    })
    .then(() => rename(tmp, target))
    .catch((error) => console.error(`[store] failed to write ${name}:`, error))
  writeQueues.set(name, queued)
}

function readJson<T>(name: string, fallback: T): T {
  try {
    const file = join(dataDir(), name)
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
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
    fontSmoothing: true
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
    defaultModelId: null
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

export const store = {
  getSettings(): Settings {
    const saved = readJson<Record<string, unknown>>('settings.json', {})
    if (saved && typeof saved === 'object') for (const key of REMOVED_SETTINGS) delete saved[key]
    return merge(defaultSettings, saved)
  },
  saveSettings(settings: Settings): Settings {
    writeJson('settings.json', settings)
    return settings
  },
  patchSettings(patch: Partial<Settings>): Settings {
    const next = merge(this.getSettings(), patch)
    writeJson('settings.json', next)
    return next
  },

  getWorkspaces(): Workspace[] {
    return readJson<Workspace[]>('workspaces.json', DEFAULT_WORKSPACES)
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
    const existing = readJson<Workspace[]>('workspaces.json', [])
    const settings = readJson<Partial<Settings>>('settings.json', {})

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
    if (canonical) return

    const chats = readJson<Chat[]>('chats.json', [])
    if (chats.some((c) => !known.has(c.workspaceId))) {
      writeJson(
        'chats.json',
        chats.map((c) => (known.has(c.workspaceId) ? c : { ...c, workspaceId: chatId }))
      )
    }
    const projects = readJson<Project[]>('projects.json', [])
    if (projects.some((p) => !known.has(p.workspaceId))) {
      writeJson(
        'projects.json',
        projects.map((p) => (known.has(p.workspaceId) ? p : { ...p, workspaceId: chatId }))
      )
    }
    writeJson('workspaces.json', workspaces)
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
    return readJson<Project[]>('projects.json', [])
  },
  saveProjects(projects: Project[]): Project[] {
    writeJson('projects.json', projects)
    return projects
  },

  getChats(): Chat[] {
    return readJson<Chat[]>('chats.json', [])
  },
  /**
   * Returns nothing on purpose: this is what `chats:save` answers the renderer
   * with, and echoing the array back cloned the whole history across IPC a
   * second time on every save, for a reply nobody read.
   */
  saveChats(chats: Chat[]): void {
    writeJsonAsync('chats.json', chats)
  },

  /** Awaits any in-flight async write so quitting cannot drop the last save. */
  flushWrites(): Promise<unknown> {
    return Promise.all([...writeQueues.values()])
  },

  getMcpServers(): McpServer[] {
    return readJson<McpServer[]>('mcp.json', [
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
    ])
  },
  saveMcpServers(servers: McpServer[]): McpServer[] {
    writeJson('mcp.json', servers)
    return servers
  },

  getProviderConfig(): Record<string, ProviderOverride> {
    return readJson('providers.json', {})
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

  getDownloadedModels(): DownloadedModel[] {
    return readJson<DownloadedModel[]>('downloaded-models.json', [])
  },
  saveDownloadedModels(models: DownloadedModel[]): DownloadedModel[] {
    writeJson('downloaded-models.json', models)
    return models
  }
}
