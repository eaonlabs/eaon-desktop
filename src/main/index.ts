import { app, BrowserWindow, ipcMain, shell, nativeTheme, dialog, Menu } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Chat, McpServer, Project, Provider, Settings, StreamEvent, StreamRequest, ThemePalette, UpdateStatus, Workspace } from '@shared/types'
import { store } from './store'
import { secrets } from './secrets'
import {
  cancelStream,
  listProviders,
  refreshModels,
  removeProvider,
  resolveApproval,
  runStream,
  testProvider,
  updateProvider
} from './providers'
import { getStatuses, getTools, setMcpStatusListener, shutdownMcp, syncMcpServers } from './mcp'
import { MCP_CATALOG } from '@shared/mcpCatalog'
import { getLocalServerStatus, setLocalServerListener, startLocalServer, stopLocalServer } from './localServer'
import { applyClaudeCodeConfig, buildClaudeCodeEnv, getClaudeCodeConfigPath, resetClaudeCodeConfig } from './claudeCode'
import { getSystemInfo } from './system'
import { checkForUpdates, getUpdateStatus, initUpdater, quitAndInstall } from './updater'
import { listPullRequests } from './github'
import { buildIndex, cancelIndexing, clearIndex, getIndexStatus, setIndexStatusListener } from './codeIndex'
import { describeEmbeddingState, EMBEDDING_MODELS } from './embeddings'
import { deleteDownloadedModel, downloadModel, getDownloadedModels, getModelDetail, searchModels } from './modelHub'

const here = join(fileURLToPath(import.meta.url), '..')
app.setName('Eaon')
let mainWindow: BrowserWindow | null = null
let capturing = false

const isMac = process.platform === 'darwin'

/** The palette actually in effect, resolving `system` against the OS setting. */
function activePalette(settings: Settings): ThemePalette {
  const resolved =
    settings.appearance.mode === 'system'
      ? nativeTheme.shouldUseDarkColors
        ? 'dark'
        : 'light'
      : settings.appearance.mode
  return resolved === 'light' ? settings.appearance.light : settings.appearance.dark
}

/** True when the active theme asks for a translucent sidebar on a platform that has one. */
function wantsVibrancy(settings: Settings): boolean {
  return isMac && activePalette(settings).translucentSidebar
}

/**
 * Windows draws its caption buttons over the page instead of giving us a
 * traffic-light gap, so the overlay has to be told what to paint behind them.
 * There is no vibrancy on Windows, so the theme's own background is the honest
 * answer; the symbols flip with the palette so they stay legible.
 */
function titleBarOverlayFor(settings: Settings): { color: string; symbolColor: string; height: number } {
  const palette = activePalette(settings)
  const dark =
    settings.appearance.mode === 'system'
      ? nativeTheme.shouldUseDarkColors
      : settings.appearance.mode === 'dark'
  return {
    color: palette.background,
    symbolColor: dark ? '#e6e6e6' : '#1a1a1a',
    // Matches --titlebar-h + --sidebar-gap, the height every header row in the
    // app is offset to (see app.css).
    height: 44
  }
}

/**
 * Keeps the native window appearance in step with the in-app theme.
 *
 * The vibrancy material follows the *app's* appearance, so `themeSource` has to
 * be updated too — otherwise a light app theme on a dark-mode Mac renders a dark
 * material behind the sidebar. Vibrancy is also re-applied here because it is
 * otherwise fixed at window-creation time and would go stale on a theme switch.
 */
function applyWindowAppearance(settings: Settings): void {
  nativeTheme.themeSource = settings.appearance.mode
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (isMac) {
    mainWindow.setVibrancy(wantsVibrancy(settings) ? 'sidebar' : null)
    return
  }
  // Windows: repaint the caption-button strip to match the new theme.
  if (process.platform === 'win32') mainWindow.setTitleBarOverlay(titleBarOverlayFor(settings))
}

function createWindow(): void {
  const settings = store.getSettings()
  const vibrant = wantsVibrancy(settings)

  mainWindow = new BrowserWindow({
    width: process.env['EAON_CAPTURE'] ? 1270 : 1280,
    height: process.env['EAON_CAPTURE'] ? 797 : 820,
    minWidth: 720,
    minHeight: 520,
    show: false,
    // macOS hides the title bar but keeps the traffic lights, which we position
    // inside the sidebar panel. Windows has no equivalent, so it gets the
    // Window Controls Overlay instead: the caption buttons are drawn over the
    // page at the top *right*, which is why the header padding flips sides in
    // the renderer (see --window-controls-left/right in tokens.css).
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset' as const,
          // The sidebar is a floating panel inset by --sidebar-gap (8px) with a
          // 36px titlebar row as its first child. These coordinates centre the
          // buttons in that row *inside* the panel rather than on the gutter
          // above it.
          trafficLightPosition: { x: 20, y: 20 }
        }
      : {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: titleBarOverlayFor(settings)
        }),
    // An opaque backgroundColor paints behind the whole window, which blocks
    // vibrancy the same way an opaque CSS ancestor would — see app.css. Fully
    // transparent (not just theme-colored) so the vibrancy view can show.
    backgroundColor: vibrant ? '#00000000' : activePalette(settings).background,
    ...(vibrant ? { vibrancy: 'sidebar' as const, visualEffectState: 'active' as const } : {}),
    webPreferences: {
      preload: join(here, '../preload/index.mjs'),
      sandbox: false,
      webviewTag: true,
      spellcheck: true,
      // Offscreen painting keeps capturePage in sync with the DOM when the
      // window is not frontmost; only used by the screenshot harness.
      ...(process.env['EAON_CAPTURE'] ? { offscreen: true } : {})
    }
  })

  if (process.env['EAON_CAPTURE']) {
    mainWindow.webContents.on('console-message', (_e, level, message, line, source) =>
      console.log(`[renderer:${level}] ${message} (${source}:${line})`)
    )
  }

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    const captureDir = process.env['EAON_CAPTURE']
    if (captureDir && mainWindow && !capturing) {
      capturing = true
      void import('./capture').then(({ runCapture }) => runCapture(mainWindow!, captureDir).then(() => app.quit()))
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer) mainWindow.loadURL(devServer)
  else mainWindow.loadFile(join(here, '../renderer/index.html'))
}

function buildMenu(): void {
  const send = (channel: string, ...args: unknown[]): void => {
    BrowserWindow.getFocusedWindow()?.webContents.send(channel, ...args)
  }
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: () => void checkForUpdates({ interactive: true }) },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: () => send('menu:settings') },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Chat', accelerator: 'Cmd+N', click: () => send('menu:new-chat') },
        { label: 'New Temporary Chat', accelerator: 'Shift+Cmd+N', click: () => send('menu:new-temp-chat') },
        { type: 'separator' },
        { label: 'Archive Chat', accelerator: 'Shift+Cmd+A', click: () => send('menu:archive-chat') }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'Cmd+B', click: () => send('menu:toggle-sidebar') },
        { label: 'Toggle Browser Panel', accelerator: 'Shift+Cmd+B', click: () => send('menu:toggle-panel') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * Providers emit many tiny deltas — often several per frame. Forwarding each
 * one as its own IPC message cost a renderer re-render per token; batching a
 * frame's worth into one message delivers the same text at the same rate for a
 * fraction of the work.
 */
function frameBatched(send: (event: StreamEvent) => void): {
  emit: (event: StreamEvent) => void
  flush: () => void
} {
  let queue: StreamEvent[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (queue.length === 0) return
    const batch = queue
    queue = []
    for (const event of batch) send(event)
  }

  return {
    emit(event) {
      if (event.type === 'delta' || event.type === 'reasoning') {
        const last = queue[queue.length - 1]
        if (last && last.type === event.type && last.messageId === event.messageId) last.text += event.text
        else queue.push({ ...event })
        if (!timer) timer = setTimeout(flush, 16)
        return
      }
      // done/error/approval-request must never overtake the text before them.
      flush()
      send(event)
    },
    flush
  }
}

function registerIpc(): void {
  ipcMain.handle('settings:get', (): Settings => store.getSettings())
  ipcMain.handle('settings:patch', (_e, patch: Partial<Settings>): Settings => {
    const next = store.patchSettings(patch)
    if (patch.appearance) applyWindowAppearance(next)
    return next
  })

  ipcMain.handle('workspaces:get', (): Workspace[] => store.getWorkspaces())
  ipcMain.handle('workspaces:save', (_e, value: Workspace[]) => store.saveWorkspaces(value))
  ipcMain.handle('projects:get', (): Project[] => store.getProjects())
  ipcMain.handle('projects:save', (_e, value: Project[]) => store.saveProjects(value))
  ipcMain.handle('chats:get', (): Chat[] => store.getChats())
  ipcMain.handle('chats:save', (_e, value: Chat[]) => store.saveChats(value))
  ipcMain.handle('mcp:get', (): McpServer[] => store.getMcpServers())
  ipcMain.handle('mcp:save', (_e, value: McpServer[]) => {
    const saved = store.saveMcpServers(value)
    // Reconnect in the background so toggling a server takes effect immediately
    // without blocking the settings UI on an npx download.
    void syncMcpServers()
    return saved
  })
  ipcMain.handle('mcp:statuses', () => getStatuses())
  ipcMain.handle('mcp:tools', () => getTools())
  ipcMain.handle('mcp:sync', () => syncMcpServers())

  /**
   * Connecting a catalog plugin: the token goes into the encrypted vault and an
   * MCP server row is written for it, so from here on it is an ordinary server
   * — the tool loop, smart routing and status reporting all treat it the same.
   * An empty token disconnects, clearing both.
   */
  ipcMain.handle('plugins:connect', async (_e, pluginId: string, token: string) => {
    const entry = MCP_CATALOG.find((c) => c.id === pluginId)
    if (!entry) throw new Error(`Unknown plugin "${pluginId}"`)

    const servers = store.getMcpServers().filter((server) => server.pluginId !== pluginId)
    if (token) {
      secrets.set(`plugin:${pluginId}`, token)
      servers.push({
        id: `plugin-${pluginId}`,
        name: entry.displayName,
        transport: 'http',
        command: '',
        args: [],
        env: {},
        url: entry.endpoint,
        enabled: true,
        official: true,
        pluginId
      })
    } else {
      secrets.set(`plugin:${pluginId}`, '')
    }
    store.saveMcpServers(servers)
    await syncMcpServers()
    return getStatuses()
  })

  /** Which catalog plugins hold a token — never the tokens themselves. */
  ipcMain.handle('plugins:connected', (): string[] =>
    MCP_CATALOG.filter((entry) => secrets.has(`plugin:${entry.id}`)).map((entry) => entry.id)
  )

  ipcMain.handle('local-server:status', () => getLocalServerStatus())
  ipcMain.handle('local-server:start', () => startLocalServer())
  ipcMain.handle('local-server:stop', () => stopLocalServer())

  ipcMain.handle('claude-code:preview', () => ({
    path: getClaudeCodeConfigPath(),
    env: buildClaudeCodeEnv()
  }))
  ipcMain.handle('claude-code:apply', () => applyClaudeCodeConfig())
  ipcMain.handle('claude-code:reset', () => resetClaudeCodeConfig())

  ipcMain.handle('system:info', () => getSystemInfo())
  ipcMain.handle('github:pull-requests', () => listPullRequests())

  ipcMain.handle('index:status', (_e, cwd: string | null) => getIndexStatus(cwd))
  ipcMain.handle('index:build', (_e, cwd: string, force: boolean) => buildIndex(cwd, force))
  ipcMain.handle('index:cancel', () => cancelIndexing())
  ipcMain.handle('index:clear', (_e, cwd: string) => clearIndex(cwd))
  ipcMain.handle('index:embedding-models', () => ({
    models: EMBEDDING_MODELS,
    state: describeEmbeddingState()
  }))

  ipcMain.handle('models:search', (_e, query: string, sort: 'downloads' | 'newest') => searchModels(query, sort))
  ipcMain.handle('models:detail', (_e, repoId: string) => getModelDetail(repoId))
  ipcMain.handle('models:downloaded', () => getDownloadedModels())
  ipcMain.handle('models:delete', (_e, repoId: string, filename: string) => deleteDownloadedModel(repoId, filename))
  ipcMain.handle('models:download', (event, repoId: string, filename: string) =>
    downloadModel(repoId, filename, (progress) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('models:download-progress', { repoId, filename, ...progress })
      }
    })
  )

  ipcMain.handle('providers:list', (): Provider[] => listProviders())
  ipcMain.handle('providers:update', (_e, id: string, patch: Partial<Provider>) => updateProvider(id, patch))
  ipcMain.handle('providers:remove', (_e, id: string) => removeProvider(id))
  ipcMain.handle('providers:refresh-models', (_e, id: string) => refreshModels(id))
  ipcMain.handle('providers:test', (_e, id: string) => testProvider(id))

  ipcMain.handle('keys:set', (_e, id: string, key: string) => {
    secrets.set(id, key)
    return listProviders()
  })
  ipcMain.handle('keys:clear', (_e, id: string) => {
    secrets.clear(id)
    return listProviders()
  })
  ipcMain.handle('keys:hint', (_e, id: string) => secrets.hint(id))
  // Decrypts on demand for the user's own reveal/copy click — never held in
  // renderer state; `keys:hint` above stays the default, ambient-safe signal.
  ipcMain.handle('keys:reveal', (_e, id: string) => secrets.get(id) ?? null)
  ipcMain.handle('keys:get-fallbacks', (_e, id: string) => secrets.getFallbacks(id))
  ipcMain.handle('keys:set-fallbacks', (_e, id: string, keys: string[]) => {
    secrets.setFallbacks(id, keys)
    return listProviders()
  })

  ipcMain.handle('chat:stream', async (event, request: StreamRequest) => {
    const batch = frameBatched((payload) => {
      if (!event.sender.isDestroyed()) event.sender.send('chat:event', payload)
    })
    try {
      await runStream(request, batch.emit)
    } finally {
      batch.flush()
    }
  })
  ipcMain.handle('chat:cancel', (_e, messageId: string) => cancelStream(messageId))
  ipcMain.handle('chat:approve', (_e, requestId: string, approved: boolean) => resolveApproval(requestId, approved))

  ipcMain.handle('app:open-external', (_e, url: string) => shell.openExternal(url))
  ipcMain.handle('app:show-item', (_e, path: string) => shell.showItemInFolder(path))
  ipcMain.handle('app:version', () => app.getVersion())

  ipcMain.handle('updater:status', (): UpdateStatus => getUpdateStatus())
  ipcMain.handle('updater:check', () => checkForUpdates())
  ipcMain.handle('updater:install', () => quitAndInstall())
  ipcMain.handle('dialog:open-files', async (_e, options: Electron.OpenDialogOptions) => {
    if (!mainWindow) return []
    const result = await dialog.showOpenDialog(mainWindow, options)
    return result.canceled ? [] : result.filePaths
  })
}

app.whenReady().then(() => {
  // A packaged app gets its icon from the .icns baked into the bundle at
  // build time (see electron-builder.yml) — this only matters for `npm run
  // dev`, which would otherwise show the generic Electron icon in the Dock.
  // `app.getAppPath()` resolves to `out/main` (not the project root) when
  // launched as `electron out/main/index.js` rather than `electron .`, so
  // this goes up from `here` the same way the preload path below does.
  if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock?.setIcon(join(here, '../../resources/icon.png'))
  }
  store.migrateWorkspaces()
  if (process.env['EAON_CAPTURE']) {
    // Start every capture run from the same baseline.
    store.patchSettings({ appearance: { ...store.getSettings().appearance, mode: 'dark' } })
    store.saveChats([])
    store.saveProjects([])
  }
  const settings = store.getSettings()
  // Must be set before createWindow: the vibrancy view is built with whatever
  // appearance is active at creation time. applyWindowAppearance() keeps it in
  // sync afterwards.
  nativeTheme.themeSource = settings.appearance.mode
  registerIpc()
  buildMenu()
  createWindow()
  initUpdater(() => mainWindow)

  setMcpStatusListener((statuses) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mcp:status', statuses)
  })
  setLocalServerListener((status) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('local-server:status', status)
  })
  setIndexStatusListener((status) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('index:status', status)
  })

  // Connect any enabled MCP servers and honour the local server's auto-start
  // preference, both without blocking window creation.
  void syncMcpServers()
  if (settings.localServer.autoStart) void startLocalServer()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Child MCP processes are ours to clean up; leaving them running would orphan
// stdio servers every time the app quits.
app.on('before-quit', () => {
  void store.flushWrites()
  void shutdownMcp()
  void stopLocalServer()
})
