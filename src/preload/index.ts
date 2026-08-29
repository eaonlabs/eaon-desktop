import { contextBridge, ipcRenderer } from 'electron'
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
    patch: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('settings:patch', patch)
  },
  workspaces: {
    get: (): Promise<Workspace[]> => ipcRenderer.invoke('workspaces:get'),
    save: (value: Workspace[]): Promise<Workspace[]> => ipcRenderer.invoke('workspaces:save', value)
  },
  projects: {
    get: (): Promise<Project[]> => ipcRenderer.invoke('projects:get'),
    save: (value: Project[]): Promise<Project[]> => ipcRenderer.invoke('projects:save', value)
  },
  chats: {
    get: (): Promise<Chat[]> => ipcRenderer.invoke('chats:get'),
    save: (value: Chat[]): Promise<Chat[]> => ipcRenderer.invoke('chats:save', value)
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
    update: (id: string, patch: Partial<Provider>): Promise<Provider[]> =>
      ipcRenderer.invoke('providers:update', id, patch),
    remove: (id: string): Promise<Provider[]> => ipcRenderer.invoke('providers:remove', id),
    refreshModels: (id: string) => ipcRenderer.invoke('providers:refresh-models', id),
    test: (id: string): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('providers:test', id)
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
    openFiles: (options: { properties?: string[] }): Promise<string[]> =>
      ipcRenderer.invoke('dialog:open-files', options),
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

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
