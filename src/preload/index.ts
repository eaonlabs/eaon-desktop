import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  Chat,
  DownloadedModel,
  LocalServerStatus,
  McpServer,
  McpServerStatus,
  IndexStatus,
  McpTool,
  ModelDetail,
  ModelDownloadProgress,
  ModelSearchResult,
  PullRequestsResult,
  SystemInfo,
  Project,
  Provider,
  Settings,
  StreamEvent,
  StreamRequest,
  UpdateStatus,
  Workspace
} from '@shared/types'
import type { ModelEdit, ModelsRefresh } from '@shared/providers'
import { providerAuthApi } from './features/providerAuth'
import { pluginsApi } from './features/plugins'
import { schedulerApi } from './features/scheduler'
import { computerUseApi } from './features/computerUse'
import { browserBridgeApi } from './features/browserBridge'
import { eaonCodeApi } from './features/eaonCode'
import { discordApi } from './features/discordPresence'
import { modelLibraryApi } from './features/modelLibrary'
import { libraryApi } from './features/library'
import { terminalsApi } from './features/terminals'
import { workersApi } from './features/workers'
import { channelsApi } from './features/channels'
import { agentBrowserApi } from './features/agentBrowser'
import { emailApi } from './features/email'
import { tradingApi } from './features/trading'
import { voiceApi } from './features/voice'

/** Subscribes to a main-process event; returns the unsubscribe. */
function on<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  /**
   * Exposed as a value rather than an IPC call because the renderer needs it
   * before first paint: the header layout reserves space on the left for macOS
   * traffic lights and on the right for the Windows caption buttons, and a
   * round-trip would mean a visible reflow.
   */
  platform: process.platform as 'darwin' | 'win32' | 'linux',
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
    patch: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('settings:patch', patch),
    /** Another window changed the settings; carries the whole new object. */
    onChanged: (handler: (settings: Settings) => void): (() => void) => on('settings:changed', handler)
  },
  workspaces: {
    get: (): Promise<Workspace[]> => ipcRenderer.invoke('workspaces:get'),
    save: (value: Workspace[]): Promise<Workspace[]> => ipcRenderer.invoke('workspaces:save', value),
    onChanged: (handler: (workspaces: Workspace[]) => void): (() => void) => on('workspaces:changed', handler)
  },
  projects: {
    get: (): Promise<Project[]> => ipcRenderer.invoke('projects:get'),
    save: (value: Project[]): Promise<Project[]> => ipcRenderer.invoke('projects:save', value),
    onChanged: (handler: (projects: Project[]) => void): (() => void) => on('projects:changed', handler)
  },
  chats: {
    get: (): Promise<Chat[]> => ipcRenderer.invoke('chats:get'),
    /**
     * Saves the chats this window changed and the ones it deleted; main merges
     * them into the one list every window shares and tells the other windows.
     */
    apply: (upserts: Chat[], removed: string[]): Promise<void> => ipcRenderer.invoke('chats:apply', upserts, removed),
    /** Another window (or a scheduled run) changed these chats. */
    onChanged: (handler: (change: { upserts: Chat[]; removed: string[] }) => void): (() => void) => on('chats:changed', handler),
    /** Replies being written right now, in any window: not to be marked interrupted on load. */
    activeRuns: (): Promise<string[]> => ipcRenderer.invoke('chat:active-runs')
  },
  window: {
    /** Opens another Eaon window. */
    open: (): Promise<void> => ipcRenderer.invoke('window:new')
  },
  mcp: {
    get: (): Promise<McpServer[]> => ipcRenderer.invoke('mcp:get'),
    save: (value: McpServer[]): Promise<McpServer[]> => ipcRenderer.invoke('mcp:save', value),
    statuses: (): Promise<McpServerStatus[]> => ipcRenderer.invoke('mcp:statuses'),
    tools: (): Promise<McpTool[]> => ipcRenderer.invoke('mcp:tools'),
    sync: (): Promise<void> => ipcRenderer.invoke('mcp:sync'),
    onStatus: (handler: (statuses: McpServerStatus[]) => void): (() => void) => {
      const listener = (_e: unknown, payload: McpServerStatus[]): void => handler(payload)
      ipcRenderer.on('mcp:status', listener)
      return () => ipcRenderer.removeListener('mcp:status', listener)
    }
  },
  localServer: {
    status: (): Promise<LocalServerStatus> => ipcRenderer.invoke('local-server:status'),
    start: (): Promise<LocalServerStatus> => ipcRenderer.invoke('local-server:start'),
    stop: (): Promise<LocalServerStatus> => ipcRenderer.invoke('local-server:stop'),
    onStatus: (handler: (status: LocalServerStatus) => void): (() => void) => {
      const listener = (_e: unknown, payload: LocalServerStatus): void => handler(payload)
      ipcRenderer.on('local-server:status', listener)
      return () => ipcRenderer.removeListener('local-server:status', listener)
    }
  },
  claudeCode: {
    preview: (): Promise<{ path: string; env: Record<string, string> }> =>
      ipcRenderer.invoke('claude-code:preview'),
    apply: (): Promise<{ path: string; env: Record<string, string> }> => ipcRenderer.invoke('claude-code:apply'),
    reset: (): Promise<{ path: string }> => ipcRenderer.invoke('claude-code:reset')
  },
  system: {
    info: (): Promise<SystemInfo> => ipcRenderer.invoke('system:info')
  },
  github: {
    pullRequests: (): Promise<PullRequestsResult> => ipcRenderer.invoke('github:pull-requests')
  },
  codeIndex: {
    status: (cwd: string | null): Promise<IndexStatus> => ipcRenderer.invoke('index:status', cwd),
    build: (cwd: string, force = false): Promise<IndexStatus> => ipcRenderer.invoke('index:build', cwd, force),
    cancel: (): Promise<void> => ipcRenderer.invoke('index:cancel'),
    clear: (cwd: string): Promise<void> => ipcRenderer.invoke('index:clear', cwd),
    embeddingModels: (): Promise<{
      models: { providerId: string; modelId: string; label: string; dimensions: number }[]
      state: string
    }> => ipcRenderer.invoke('index:embedding-models'),
    onStatus: (handler: (status: IndexStatus) => void): (() => void) => {
      const listener = (_e: unknown, payload: IndexStatus): void => handler(payload)
      ipcRenderer.on('index:status', listener)
      return () => ipcRenderer.removeListener('index:status', listener)
    }
  },
  providers: {
    list: (): Promise<Provider[]> => ipcRenderer.invoke('providers:list'),
    update: (id: string, patch: Partial<Pick<Provider, 'baseUrl' | 'enabled' | 'name' | 'kind'>>): Promise<Provider[]> =>
      ipcRenderer.invoke('providers:update', id, patch),
    remove: (id: string): Promise<Provider[]> => ipcRenderer.invoke('providers:remove', id),
    refreshModels: (id: string) => ipcRenderer.invoke('providers:refresh-models', id),
    /** Re-reads models.dev and, when usable, the provider's own listing; says what changed. */
    refresh: (id: string): Promise<ModelsRefresh> => ipcRenderer.invoke('providers:refresh', id),
    /** Remove, restore, add or rename a model; returns the updated providers. */
    editModels: (id: string, edit: ModelEdit): Promise<Provider[]> => ipcRenderer.invoke('providers:edit-models', id, edit),
    test: (id: string): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('providers:test', id),
    /** Fired when a background refresh (local runtimes) changed some provider's model list. */
    onChanged: (handler: () => void): (() => void) => {
      const listener = (): void => handler()
      ipcRenderer.on('providers:changed', listener)
      return () => ipcRenderer.removeListener('providers:changed', listener)
    }
  },
  keys: {
    set: (id: string, key: string): Promise<Provider[]> => ipcRenderer.invoke('keys:set', id, key),
    clear: (id: string): Promise<Provider[]> => ipcRenderer.invoke('keys:clear', id),
    hint: (id: string): Promise<string | null> => ipcRenderer.invoke('keys:hint', id),
    reveal: (id: string): Promise<string | null> => ipcRenderer.invoke('keys:reveal', id),
    getFallbacks: (id: string): Promise<string[]> => ipcRenderer.invoke('keys:get-fallbacks', id),
    setFallbacks: (id: string, keys: string[]): Promise<Provider[]> =>
      ipcRenderer.invoke('keys:set-fallbacks', id, keys)
  },
  chat: {
    stream: (request: StreamRequest): Promise<void> => ipcRenderer.invoke('chat:stream', request),
    cancel: (messageId: string): Promise<void> => ipcRenderer.invoke('chat:cancel', messageId),
    pauseGoal: (messageId: string): Promise<void> => ipcRenderer.invoke('chat:pause-goal', messageId),
    approve: (requestId: string, approved: boolean): Promise<void> =>
      ipcRenderer.invoke('chat:approve', requestId, approved),
    onEvent: (handler: (event: StreamEvent) => void): (() => void) => {
      const listener = (_e: unknown, payload: StreamEvent): void => handler(payload)
      ipcRenderer.on('chat:event', listener)
      return () => ipcRenderer.removeListener('chat:event', listener)
    }
  },
  plugins: {
    /** Empty token disconnects. Returns the refreshed server statuses. */
    connect: (pluginId: string, token: string): Promise<McpServerStatus[]> =>
      ipcRenderer.invoke('plugins:connect', pluginId, token),
    /** Ids of catalog plugins that hold a token — never the tokens. */
    connected: (): Promise<string[]> => ipcRenderer.invoke('plugins:connected')
  },
  app: {
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:open-external', url),
    showItem: (path: string): Promise<void> => ipcRenderer.invoke('app:show-item', path),
    version: (): Promise<string> => ipcRenderer.invoke('app:version'),
    /** Records a renderer error in crashes.log (main/crashGuard.ts). */
    reportError: (report: { message: string; stack?: string; source?: string }): void => ipcRenderer.send('app:report-error', report),
    /** Background mode for scheduled tasks; see main/background.ts. */
    background: (): Promise<{ supported: boolean; enabled: boolean }> => ipcRenderer.invoke('background:get'),
    setBackground: (enabled: boolean): Promise<{ supported: boolean; enabled: boolean }> =>
      ipcRenderer.invoke('background:set', enabled),
    openFiles: (options: { properties?: string[] }): Promise<string[]> =>
      ipcRenderer.invoke('dialog:open-files', options),
    /** Absolute path of a file dropped onto the window (File.path was removed in Electron 32). */
    pathForFile: (file: File): string => webUtils.getPathForFile(file),
    onMenu: (handler: (command: string) => void): (() => void) => {
      const channels = [
        'menu:settings',
        'menu:new-chat',
        'menu:new-temp-chat',
        'menu:archive-chat',
        'menu:toggle-sidebar',
        'menu:toggle-panel'
      ]
      const listeners = channels.map((channel) => {
        const listener = (): void => handler(channel.replace('menu:', ''))
        ipcRenderer.on(channel, listener)
        return () => ipcRenderer.removeListener(channel, listener)
      })
      return () => listeners.forEach((off) => off())
    }
  },
  updater: {
    status: (): Promise<UpdateStatus> => ipcRenderer.invoke('updater:status'),
    check: (): Promise<void> => ipcRenderer.invoke('updater:check'),
    install: (): Promise<void> => ipcRenderer.invoke('updater:install'),
    onStatus: (handler: (status: UpdateStatus) => void): (() => void) => {
      const listener = (_e: unknown, payload: UpdateStatus): void => handler(payload)
      ipcRenderer.on('updater:status', listener)
      return () => ipcRenderer.removeListener('updater:status', listener)
    }
  },
  models: {
    search: (query: string, sort: 'downloads' | 'newest'): Promise<ModelSearchResult[]> =>
      ipcRenderer.invoke('models:search', query, sort),
    detail: (repoId: string): Promise<ModelDetail> => ipcRenderer.invoke('models:detail', repoId),
    downloaded: (): Promise<DownloadedModel[]> => ipcRenderer.invoke('models:downloaded'),
    download: (repoId: string, filename: string): Promise<DownloadedModel> =>
      ipcRenderer.invoke('models:download', repoId, filename),
    delete: (repoId: string, filename: string): Promise<void> => ipcRenderer.invoke('models:delete', repoId, filename),
    onDownloadProgress: (handler: (progress: ModelDownloadProgress) => void): (() => void) => {
      const listener = (_e: unknown, payload: ModelDownloadProgress): void => handler(payload)
      ipcRenderer.on('models:download-progress', listener)
      return () => ipcRenderer.removeListener('models:download-progress', listener)
    }
  }
}

/**
 * Each feature's bridge lives in its own file under ./features, so features
 * can grow their IPC surface without every one of them editing this object.
 */
const fullApi = {
  ...api,
  providerAuth: providerAuthApi,
  pluginAuth: pluginsApi,
  scheduler: schedulerApi,
  computerUse: computerUseApi,
  browserBridge: browserBridgeApi,
  eaonCode: eaonCodeApi,
  discord: discordApi,
  modelLibrary: modelLibraryApi,
  library: libraryApi,
  terminals: terminalsApi,
  workers: workersApi,
  channels: channelsApi,
  agentBrowser: agentBrowserApi,
  email: emailApi,
  trading: tradingApi,
  voice: voiceApi
}

contextBridge.exposeInMainWorld('api', fullApi)

export type Api = typeof fullApi
