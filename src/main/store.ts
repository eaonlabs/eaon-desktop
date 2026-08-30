import { app } from 'electron'
import os from 'node:os'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Chat, DownloadedModel, McpServer, Project, Settings, Workspace } from '@shared/types'

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

/**
 * Atomic write that does not block the main process.
 *
 * Chat history grows without bound, and a synchronous multi-megabyte write
 * freezes everything the main process drives — IPC, input, painting — for its
 * whole duration. Writes to the same file are chained so a slow one cannot be
 * overtaken by the next, and the output is compact rather than pretty-printed:
 * nothing reads this file by hand, and the indentation roughly doubled both the
 * bytes and the stringify cost.
 */
function writeJsonAsync(name: string, value: unknown): void {
  const dir = ensureDir()
  const target = join(dir, name)
  const tmp = `${target}.tmp`
  const body = JSON.stringify(value)
  const queued = (writeQueues.get(name) ?? Promise.resolve())
    .then(() => writeFile(tmp, body, 'utf8'))
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

export const DEFAULT_WORKSPACES: Workspace[] = [{ id: 'work', name: 'Eaon', kind: 'chat' }]

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
    launchAtLogin: false
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
    dockIcon: 'color',
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
    availableEfforts: ['light', 'medium', 'high', 'extra-high', 'ultra'],
    ultraInPicker: false,
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
  effort: 'light',
  approvalMode: 'ask',
  planMode: false
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

export const store = {
  getSettings(): Settings {
    return merge(defaultSettings, readJson<Partial<Settings>>('settings.json', {}))
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
   * Eaon Work — the coding product — is hidden for now, so there is a single
   * workspace and no switcher in the sidebar.
   *
   * Anything that lived in another workspace (the old free-form ones, or Eaon
   * Work) has its `workspaceId` rewritten to the remaining one rather than being
   * dropped, so no chat or project disappears from view. The active id is forced
   * back for the same reason: an install last left in Eaon Work would otherwise
   * open to an empty list with no control to switch out of it.
   */
  migrateWorkspaces(): void {
    const existing = readJson<Workspace[]>('workspaces.json', [])
    const chatId = existing.find((w) => w.kind !== 'work')?.id ?? DEFAULT_WORKSPACES[0].id
    const settings = readJson<Partial<Settings>>('settings.json', {})
    const canonical = existing.length === 1 && existing[0].id === chatId && existing[0].kind === 'chat'
    if (canonical && settings.activeWorkspaceId === chatId) return

    const chats = readJson<Chat[]>('chats.json', [])
    writeJson(
      'chats.json',
      chats.map((c) => (c.workspaceId === chatId ? c : { ...c, workspaceId: chatId }))
    )
    const projects = readJson<Project[]>('projects.json', [])
    writeJson(
      'projects.json',
      projects.map((p) => (p.workspaceId === chatId ? p : { ...p, workspaceId: chatId }))
    )
    writeJson('workspaces.json', [{ id: chatId, name: 'Eaon', kind: 'chat' }])
    if (settings.activeWorkspaceId !== chatId) writeJson('settings.json', { ...settings, activeWorkspaceId: chatId })
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
  saveChats(chats: Chat[]): Chat[] {
    writeJsonAsync('chats.json', chats)
    return chats
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

  getProviderConfig(): Record<string, { baseUrl?: string; enabled?: boolean; models?: unknown[]; name?: string; kind?: string }> {
    return readJson('providers.json', {})
  },
  saveProviderConfig(config: Record<string, unknown>): void {
    writeJson('providers.json', config)
  },

  getDownloadedModels(): DownloadedModel[] {
    return readJson<DownloadedModel[]>('downloaded-models.json', [])
  },
  saveDownloadedModels(models: DownloadedModel[]): DownloadedModel[] {
    writeJson('downloaded-models.json', models)
    return models
  }
}
