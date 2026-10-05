import { app, BrowserWindow, ipcMain, shell, nativeTheme, dialog, Menu, Notification, net, protocol, screen } from 'electron'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Chat, McpServer, Project, Provider, Settings, StreamEvent, StreamRequest, ThemePalette, UpdateStatus, Workspace } from '@shared/types'
import { store } from './store'
import { prepareStore } from './migrations'
import { dismissProblem, onStoreHealth, problemFile, storeHealth } from './storeFiles'
import { secrets } from './secrets'
import type { ModelEdit } from '@shared/providers'
import { editModels, listProviders, refreshModels, refreshProviderModels, removeProvider, testProvider, updateProvider } from './providers'
import { refreshLocalProviders } from './providers/localDiscovery'
import { refreshCatalogInBackground } from './providers/modelCatalog'
import { resolveApproval } from './agent/approvals'
import { hardenAppWindow, openExternalSafely } from './externalLinks'
import { catalogRowsPinned, providerKeyId } from './ipcGuards'
import { activeRunIds, cancelRun, pauseGoal, runAgent } from './agent/loop'
import './agent/sources'
import { killBackgroundProcesses } from './localTools'
import { adoptLoginShellPath } from './shellEnv'
import { FEATURES } from './features'
import type { FeatureContext } from './features/types'
import { getStatuses, getTools, setMcpStatusListener, shutdownMcp, syncMcpServers } from './mcp'
import { forgetServer } from './mcpOAuth'
import { getLocalServerStatus, setLocalServerListener, startLocalServer, stopLocalServer } from './localServer'
import { getSystemInfo } from './system'
import { checkForUpdates, getUpdateStatus, initUpdater, quitAndInstall } from './updater'
import { listPullRequests } from './github'
import { buildIndex, cancelIndexing, clearIndex, getIndexStatus, setIndexStatusListener } from './codeIndex'
import { describeEmbeddingState, embeddingModels } from './embeddings'
import { cancelAllDownloads, deleteDownloadedModel, downloadModel, getDownloadedModels, getModelDetail, searchModels } from './modelHub'
import { applyRunAtLogin, backgroundSupported, launchedInBackground, syncTray } from './background'
import { crashLogPath, installCrashGuard } from './crashGuard'
import { applyAppIcon, currentAppIconFile } from './appIcon'

const here = join(fileURLToPath(import.meta.url), '..')
app.setName('Eaon')

/**
 * One Eaon per profile. Two would run every scheduled task twice and write
 * the same JSON store from two processes. A second launch (a double-click
 * while Eaon runs in the background) hands over to the first, which opens
 * its window. The capture harness is exempt; it drives its own profile.
 */
const primaryInstance = Boolean(process.env['EAON_CAPTURE']) || app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()
// Crash logging and recovery, before anything else can throw; see crashGuard.ts.
if (primaryInstance) installCrashGuard()

/**
 * `eaon-file://` serves screenshots and attached images to the renderer. The
 * renderer runs from a dev-server origin in development, where `file://` is
 * blocked, and a custom scheme also lets us refuse anything that is not an
 * image rather than exposing the filesystem.
 */
protocol.registerSchemesAsPrivileged([
  { scheme: 'eaon-file', privileges: { secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }
])
// Media only — images, and videos so the Library and attachments can preview them.
const SERVABLE_IMAGES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.avif', '.mp4', '.m4v', '.mov', '.webm'])
/**
 * Every Eaon window, oldest first. Helper windows (the computer-use pill, the
 * agent's browser) are not in here: they don't run the app's page.
 */
const appWindows = new Set<BrowserWindow>()
/** The Eaon window last in front, for dialogs, notifications and "bring Eaon forward". */
let lastFocused: BrowserWindow | null = null

function openWindows(): BrowserWindow[] {
  return [...appWindows].filter((window) => !window.isDestroyed())
}

/** The window to act on: the focused Eaon window, else the one last in front, else the newest. */
function currentWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && appWindows.has(focused) && !focused.isDestroyed()) return focused
  if (lastFocused && appWindows.has(lastFocused) && !lastFocused.isDestroyed()) return lastFocused
  return openWindows().at(-1) ?? null
}

/**
 * A window's page, if it can still be sent to. While a window closes its
 * webContents is destroyed before the window is, and sending to it then
 * throws "Object has been destroyed" — which a 'destroyed' listener that
 * reports state (Discord presence does) would hit on every close.
 */
function liveContents(window: BrowserWindow): Electron.WebContents | null {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return null
  return window.webContents
}

/** Sends to every window's page; `except` leaves out the page that made the change. */
function broadcast(channel: string, payload?: unknown, except?: Electron.WebContents): void {
  for (const window of appWindows) {
    const contents = liveContents(window)
    if (contents && contents !== except) contents.send(channel, ...(payload === undefined ? [] : [payload]))
  }
}
let capturing = false
/**
 * Settles once the login shell's PATH is adopted. It is looked up while the
 * window loads rather than before creating it; whatever spawns a process
 * waits for it first.
 */
let shellPath: Promise<void> = Promise.resolve()

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
  for (const window of openWindows()) {
    if (isMac) {
      window.setVibrancy(wantsVibrancy(settings) ? 'sidebar' : null)
      pinTrafficLights(window)
    } else if (process.platform === 'win32') {
      // Windows: repaint the caption-button strip to match the new theme.
      window.setTitleBarOverlay(titleBarOverlayFor(settings))
    }
  }
}

/**
 * Where the traffic lights go: centred in the 36px titlebar row at the top of
 * the floating sidebar panel, which is inset 8px from the window. That is the
 * spot macOS 26 and later give a window with a toolbar (19, 19): the buttons
 * are 14pt there, 23pt apart, so they end at x = 19 + 60 = 79. `--traffic-clear`
 * in tokens.css is derived from that; change both together.
 */
const TRAFFIC_LIGHTS = { x: 19, y: 19 }

/**
 * Puts the traffic lights back where they belong. AppKit lays the titlebar
 * out again on its own after some changes, and the buttons sometimes came
 * back at the default top-left corner instead: after leaving full screen, a
 * vibrancy or light/dark switch (including the automatic one at sunset), or a
 * title change. It only happened on some of those, which is why it looked
 * random. Re-asserting the position after each is cheap and harmless.
 */
function pinTrafficLights(window: BrowserWindow): void {
  if (isMac && !window.isDestroyed()) window.setWindowButtonPosition(TRAFFIC_LIGHTS)
}

function createWindow(): BrowserWindow {
  const settings = store.getSettings()
  const vibrant = wantsVibrancy(settings)
  // A second window opens down and to the right of the one in front, as macOS windows cascade.
  const from = currentWindow()?.getBounds()

  const window = new BrowserWindow({
    width: from?.width ?? (process.env['EAON_CAPTURE'] ? 1270 : 1280),
    height: from?.height ?? (process.env['EAON_CAPTURE'] ? 797 : 820),
    ...(from ? { x: from.x + 28, y: from.y + 28 } : {}),
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
          // Inside the floating sidebar panel; see TRAFFIC_LIGHTS.
          trafficLightPosition: TRAFFIC_LIGHTS
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
    // The icon picked in Settings → Appearance; macOS shows it on the Dock instead (appIcon.ts).
    ...(isMac ? {} : { icon: currentAppIconFile(settings.appearance.appIcon) ?? undefined }),
    webPreferences: {
      preload: join(here, '../preload/index.mjs'),
      sandbox: false,
      webviewTag: true,
      spellcheck: true,
      // Offscreen painting keeps capturePage in sync with the DOM when the
      // window is not frontmost; only used by the screenshot harness. Its
      // scale is set rather than left to Electron, whose default became 1x.
      ...(process.env['EAON_CAPTURE'] ? { offscreen: { deviceScaleFactor: screen.getPrimaryDisplay().scaleFactor } } : {})
    }
  })
  appWindows.add(window)
  lastFocused ??= window

  if (process.env['EAON_CAPTURE']) {
    window.webContents.on('console-message', ({ level, message, lineNumber, sourceId }) =>
      console.log(`[renderer:${level}] ${message} (${sourceId}:${lineNumber})`)
    )
  }

  window.on('focus', () => {
    lastFocused = window
    pinTrafficLights(window)
    // Local runtimes change underneath us (a model pulled in a terminal); pick
    // that up when the user comes back to the app.
    void refreshLocalProviders().then((changed) => {
      if (changed) broadcast('providers:changed')
    })
  })
  for (const event of ['leave-full-screen', 'show', 'restore', 'resized'] as const) {
    window.on(event as 'show', () => pinTrafficLights(window))
  }
  window.webContents.on('page-title-updated', () => pinTrafficLights(window))
  window.on('closed', () => {
    appWindows.delete(window)
    if (lastFocused === window) lastFocused = openWindows().at(-1) ?? null
  })

  window.on('ready-to-show', () => {
    window.show()
    const captureDir = process.env['EAON_CAPTURE']
    if (captureDir && !capturing) {
      capturing = true
      void import('./capture').then(({ runCapture }) => runCapture(window, captureDir).then(() => app.quit()))
    }
  })

  // New windows open in the user's browser (web and email links only), the
  // window never navigates away from the app, and the browser panel's
  // <webview> gets no Node and no popups (externalLinks.ts).
  hardenAppWindow(window)

  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer) window.loadURL(devServer)
  else window.loadFile(join(here, '../renderer/index.html'))
  return window
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
        // ⌥⌘N, as in Mail's New Viewer Window: ⌘N is already New Chat.
        { label: 'New Window', accelerator: 'Alt+CmdOrCtrl+N', click: () => void createWindow() },
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
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Show Crash Log',
          click: () => {
            if (existsSync(crashLogPath())) shell.showItemInFolder(crashLogPath())
            else void dialog.showMessageBox({ message: 'No crashes recorded', detail: 'Eaon has not logged a crash on this computer.' })
          }
        }
      ]
    }
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
      // Everything else (done, error, approvals, tool events) must never
      // overtake the text before it.
      flush()
      send(event)
    },
    flush
  }
}

function registerIpc(): void {
  // Saved data repaired at startup, or a save that is failing: every window shows it (storeFiles.ts).
  ipcMain.handle('store:health', () => storeHealth())
  ipcMain.handle('store:dismiss', (_e, id: string) => dismissProblem(String(id)))
  ipcMain.handle('store:reveal', (_e, id: string) => {
    const path = problemFile(String(id))
    if (path) shell.showItemInFolder(path)
  })
  onStoreHealth((health) => broadcast('store:health', health))
  ipcMain.handle('settings:get', (): Settings => store.getSettings())
  // Each window keeps its own copy of these, so a change made in one is sent
  // to the others; see the matching listeners in the renderer's store.
  ipcMain.handle('settings:patch', (e, patch: Partial<Settings>): Settings => {
    const next = store.patchSettings(patch)
    if (patch.appearance) applyWindowAppearance(next)
    if (patch.appearance?.appIcon) applyAppIcon(next.appearance.appIcon, appWindows)
    broadcast('settings:changed', next, e.sender)
    return next
  })

  ipcMain.handle('workspaces:get', (): Workspace[] => store.getWorkspaces())
  ipcMain.handle('workspaces:save', (e, value: Workspace[]) => {
    const saved = store.saveWorkspaces(value)
    broadcast('workspaces:changed', saved, e.sender)
    return saved
  })
  ipcMain.handle('projects:get', (): Project[] => store.getProjects())
  ipcMain.handle('projects:save', (e, value: Project[]) => {
    const saved = store.saveProjects(value)
    broadcast('projects:changed', saved, e.sender)
    return saved
  })
  ipcMain.handle('chats:get', (): Chat[] => store.getChats())
  // Returns nothing: echoing chats back cloned them across IPC again for a reply nobody read.
  ipcMain.handle('chats:apply', (e, upserts: Chat[], removed: string[], checkpoint?: boolean): void => {
    store.applyChats(upserts, removed)
    // A save made while a reply is still streaming is only for the disk: the
    // other windows have the reply live, and this copy lags it by a few tokens.
    if (checkpoint !== true) broadcast('chats:changed', { upserts, removed }, e.sender)
  })
  ipcMain.handle('chat:active-runs', (): string[] => activeRunIds())
  ipcMain.handle('window:new', () => void createWindow())
  ipcMain.handle('mcp:get', (): McpServer[] => store.getMcpServers())
  ipcMain.handle('mcp:save', (_e, raw: McpServer[]) => {
    // Catalog plugins connect only to their vendor's server (ipcGuards.ts).
    const value = catalogRowsPinned(raw)
    // A hand-added server deleted here takes its sign-in with it; left in the
    // vault, its tokens outlived it and a new server that reused the id
    // inherited them. Catalog plugins sign out through plugins:disconnect.
    const kept = new Set(value.map((s) => s.id))
    for (const removed of store.getMcpServers().filter((s) => !kept.has(s.id) && !s.pluginId)) {
      try {
        forgetServer(removed.id)
      } catch (error) {
        console.error(`[mcp] could not forget the sign-in for ${removed.id}:`, error)
      }
    }
    const saved = store.saveMcpServers(value)
    // Reconnect in the background so toggling a server takes effect immediately
    // without blocking the settings UI on an npx download.
    void shellPath.then(() => syncMcpServers())
    return saved
  })
  ipcMain.handle('mcp:statuses', () => getStatuses())
  ipcMain.handle('mcp:tools', () => getTools())
  ipcMain.handle('mcp:sync', () => shellPath.then(() => syncMcpServers()))

  ipcMain.handle('local-server:status', () => getLocalServerStatus())
  ipcMain.handle('local-server:start', () => startLocalServer())
  ipcMain.handle('local-server:stop', () => stopLocalServer())

  ipcMain.handle('system:info', () => getSystemInfo())
  ipcMain.handle('github:pull-requests', () => shellPath.then(() => listPullRequests()))

  ipcMain.handle('index:status', (_e, cwd: string | null) => getIndexStatus(cwd))
  ipcMain.handle('index:build', (_e, cwd: string, force: boolean) => buildIndex(cwd, force))
  ipcMain.handle('index:cancel', () => cancelIndexing())
  ipcMain.handle('index:clear', (_e, cwd: string) => clearIndex(cwd))
  ipcMain.handle('index:embedding-models', () => ({
    models: embeddingModels(),
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
  ipcMain.handle('providers:refresh', (_e, id: string) => refreshProviderModels(id))
  ipcMain.handle('providers:edit-models', (_e, id: string, edit: ModelEdit) => editModels(id, edit))
  ipcMain.handle('providers:test', (_e, id: string) => testProvider(id))

  // Model-provider keys only: the vault's namespaced entries (plugin and
  // chat-app tokens, the payment card, OAuth) are not the renderer's to
  // read back, replace or clear (ipcGuards.ts).
  const providerKey = (id: unknown): string => providerKeyId(id, listProviders().map((p) => p.id))
  ipcMain.handle('keys:set', (_e, id: string, key: string) => {
    if (typeof key !== 'string') throw new Error('A key is text.')
    secrets.set(providerKey(id), key)
    return listProviders()
  })
  ipcMain.handle('keys:clear', (_e, id: string) => {
    secrets.clear(providerKey(id))
    return listProviders()
  })
  ipcMain.handle('keys:hint', (_e, id: string) => secrets.hint(providerKey(id)))
  // Decrypts on demand for the user's own reveal/copy click — never held in
  // renderer state; `keys:hint` above stays the default, ambient-safe signal.
  // Only model-provider keys the user typed in. The vault also holds plugin
  // tokens and OAuth credentials (ids with a `prefix:`), which the renderer
  // has no business reading back.
  ipcMain.handle('keys:reveal', (_e, id: string) =>
    listProviders().some((p) => p.id === id && p.auth !== 'oauth') ? (secrets.get(id) ?? null) : null
  )
  ipcMain.handle('keys:get-fallbacks', (_e, id: string) => secrets.getFallbacks(providerKey(id)))
  ipcMain.handle('keys:set-fallbacks', (_e, id: string, keys: string[]) => {
    if (!Array.isArray(keys) || !keys.every((key) => typeof key === 'string')) throw new Error('Fallback keys are a list of text.')
    secrets.setFallbacks(providerKey(id), keys)
    return listProviders()
  })

  ipcMain.handle('chat:stream', async (event, request: StreamRequest) => {
    // Tools spawn processes; a reply sent in the first moments after launch
    // waits for the login shell's PATH.
    await shellPath
    const sender = event.sender
    // The window that started the run gets every event. The others get the
    // reply as it is written, to show it live if they have that chat open,
    // but not its approval prompts: only the starting window answers those.
    const batch = frameBatched((payload) => {
      if (!sender.isDestroyed()) sender.send('chat:event', payload)
      if (payload.type !== 'approval-request') broadcast('chat:event', payload, sender)
    })
    // The renderer that started a chat run is the only thing that saves it or
    // answers its approvals. It cancels on unload itself; this covers one that
    // died without unloading, whose run would otherwise work on unseen and
    // wait forever on its next approval.
    const abandon = (): void => cancelRun(request.messageId)
    sender.once('destroyed', abandon)
    sender.once('render-process-gone', abandon)
    const started = Date.now()
    try {
      const outcome = await runAgent(request, batch.emit)
      notifyIfAway(request, outcome.error, Date.now() - started)
    } finally {
      sender.removeListener('destroyed', abandon)
      sender.removeListener('render-process-gone', abandon)
      batch.flush()
    }
  })
  ipcMain.handle('chat:cancel', (_e, messageId: string) => cancelRun(messageId))
  ipcMain.handle('chat:pause-goal', (_e, messageId: string) => pauseGoal(messageId))
  ipcMain.handle('chat:approve', (_e, requestId: string, approved: boolean) => resolveApproval(requestId, approved))

  ipcMain.handle('app:open-external', (_e, url: string) => openExternalSafely(url))
  // `~` arrives from the renderer, which has no idea where home is; Work's
  // default folder is displayed as ~/Eaon until the first task creates it.
  ipcMain.handle('app:show-item', (_e, path: string) => shell.showItemInFolder(path.replace(/^~(?=\/|$)/, homedir())))
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('background:get', () => ({ supported: backgroundSupported(), enabled: runsInBackground() }))
  ipcMain.handle('background:set', async (_e, enabled: boolean) => {
    if (!backgroundSupported()) throw new Error('Running in the background is not available on this system.')
    applyRunAtLogin(enabled)
    store.patchSettings({ background: { enabled } })
    await syncTray(enabled, openMainWindow)
    return { supported: true, enabled }
  })

  ipcMain.handle('updater:status', (): UpdateStatus => getUpdateStatus())
  ipcMain.handle('updater:check', () => checkForUpdates())
  ipcMain.handle('updater:install', async () => {
    // Flushed here rather than by holding the quit in before-quit/will-quit,
    // which the updater's own quit-and-relaunch must not wait on.
    await flushPendingWrites()
    flushedBeforeClose = true
    flushedAfterClose = true
    quitAndInstall()
  })
  ipcMain.handle('dialog:open-files', async (e, options: Electron.OpenDialogOptions) => {
    const parent = BrowserWindow.fromWebContents(e.sender) ?? currentWindow()
    if (!parent) return []
    const result = await dialog.showOpenDialog(parent, options)
    return result.canceled ? [] : result.filePaths
  })
}

/**
 * A Work task that ran for a while and finished while the user was in another
 * app gets a system notification — the whole point of handing work to an
 * agent is not having to watch it.
 */
function notifyIfAway(request: StreamRequest, error: string | undefined, elapsedMs: number): void {
  if (request.mode !== 'work' || elapsedMs < 20_000) return
  if (!store.getSettings().notifications.taskComplete || !Notification.isSupported()) return
  if (openWindows().some((window) => window.isFocused())) return
  const notification = new Notification({
    title: error ? 'Task stopped with an error' : 'Task finished',
    body: request.chatTitle || 'Eaon'
  })
  // The window may have been closed since (macOS keeps the app running), and
  // showing a destroyed one throws in the main process.
  notification.on('click', () => openMainWindow())
  notification.show()
}

/** Shared with every feature module; see `features/types.ts`. */
const streamBatch = frameBatched((payload) => broadcast('chat:event', payload))
/**
 * Feature handlers can spawn processes (Eaon Code, plugins, Ollama), so each
 * call waits for the login shell's PATH as the core handlers that spawn do.
 * They are still registered straight away, so an early call from the renderer
 * never finds no handler.
 */
const featureIpc = new Proxy(ipcMain, {
  get(target, prop) {
    if (prop === 'handle') {
      return (channel: string, listener: Parameters<Electron.IpcMain['handle']>[1]): void =>
        target.handle(channel, async (event, ...args) => {
          await shellPath
          return listener(event, ...args)
        })
    }
    const value: unknown = Reflect.get(target, prop)
    return typeof value === 'function' ? value.bind(target) : value
  }
})
const featureContext: FeatureContext = {
  ipcMain: featureIpc,
  getWindow: currentWindow,
  getWindows: openWindows,
  send: (channel, ...args) => {
    for (const window of appWindows) liveContents(window)?.send(channel, ...args)
  },
  emitStream: (event) => streamBatch.emit(event)
}

/** Brings the window in front forward, creating one if there is none (background launch, or closed on Windows). */
function openMainWindow(): void {
  const window = currentWindow()
  if (!window) {
    createWindow()
    return
  }
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

const runsInBackground = (): boolean => backgroundSupported() && store.getSettings().background.enabled

app.on('second-instance', () => {
  if (app.isReady()) openMainWindow()
})

// Workers' own browsers (BetterWright, features/workers/browser.ts) route
// their traffic through a policy proxy; these two keep QUIC and WebRTC from
// going around it. Must be set before ready, which is why they are here and
// not in the lazily-loaded browser module. (betterwright/electron's
// configureElectronNetwork does exactly this.)
app.commandLine.appendSwitch('disable-quic')
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp')

app.whenReady().then(async () => {
  if (!primaryInstance) return
  // A Dock-launched app has almost no PATH, and asking the login shell takes
  // half a second or more (nvm, oh-my-zsh). That used to hold up the window;
  // it now runs while the window loads, and whatever spawns waits for it.
  shellPath = adoptLoginShellPath().catch((error) => console.error('[startup] could not read the login shell PATH:', error))
  protocol.handle('eaon-file', (request) => {
    let path = decodeURIComponent(new URL(request.url).pathname)
    if (process.platform === 'win32') path = path.replace(/^\/([a-zA-Z]:)/, '$1')
    if (!SERVABLE_IMAGES.has(extname(path).toLowerCase())) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(path).toString())
  })
  // The Dock icon picked in Settings → Appearance. In a packaged app the
  // default is the bundle's own icon; a dev run would otherwise show the
  // generic Electron icon, so it always sets one (appIcon.ts).
  applyAppIcon(store.getSettings().appearance.appIcon, appWindows)
  // Migrations due, plus the repairs that run every launch; see migrations.ts.
  prepareStore()
  store.applyLaunchMode()
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
  // Started at login for scheduled tasks: no window until someone asks for one.
  if (!launchedInBackground()) createWindow()
  initUpdater(openWindows)
  // macOS switching light/dark by itself (Auto appearance) lays the titlebar out again too.
  nativeTheme.on('updated', () => openWindows().forEach(pinTrafficLights))
  for (const feature of FEATURES) {
    try {
      await feature.register(featureContext)
    } catch (error) {
      console.error(`[features] ${feature.id} failed to start:`, error)
    }
  }

  setMcpStatusListener((statuses) => broadcast('mcp:status', statuses))
  setLocalServerListener((status) => broadcast('local-server:status', status))
  setIndexStatusListener((status) => broadcast('index:status', status))

  // Connect any enabled MCP servers and honour the local server's auto-start
  // preference, both without blocking window creation. Stdio servers are
  // spawned (npx, uvx), so this waits for the PATH.
  await shellPath
  void syncMcpServers()
  if (settings.localServer.autoStart) void startLocalServer()
  void refreshLocalProviders(true).then((changed) => {
    if (changed) broadcast('providers:changed')
  })
  // Models released since this build, from models.dev; at most once a day.
  void refreshCatalogInBackground().then((changed) => {
    if (changed) broadcast('providers:changed')
  })

  app.on('activate', () => {
    // Only Eaon's own windows count. The computer-use pill is a window too, and
    // with it open a Dock click (or a scheduled task's notification, which
    // raises this event) would otherwise do nothing.
    if (openWindows().length === 0) createWindow()
  })
  if (isMac) app.dock?.setMenu(Menu.buildFromTemplate([{ label: 'New Window', click: () => void createWindow() }]))

  // Refreshes the login entry if the app moved since it was written.
  if (runsInBackground()) {
    try {
      applyRunAtLogin(true)
    } catch (error) {
      console.error('[background] could not update the login entry:', error)
    }
  }
  void syncTray(runsInBackground(), openMainWindow)
})

app.on('window-all-closed', () => {
  // macOS apps outlive their windows. On Windows, background mode keeps Eaon
  // in the notification area so scheduled tasks keep running.
  if (process.platform !== 'darwin' && !runsInBackground()) app.quit()
})

/** Cleanup ran; before-quit fires again after a quit held for pending writes. */
let shutDown = false
/**
 * Pending writes have been waited for before the windows closed, and again
 * after (see will-quit), so the quit re-issued after each wait goes through.
 */
let flushedBeforeClose = false
let flushedAfterClose = false
/** Settles when MCP servers have closed, or after a cap. */
let mcpShutdown: Promise<void> = Promise.resolve()
/** Settles when features' child processes (terminal shells) are reaped, or after a cap. */
let featureShutdown: Promise<void> = Promise.resolve()

/** Waits for the store's pending writes, capped so a stuck disk cannot keep Eaon open. */
function flushPendingWrites(): Promise<void> {
  return Promise.race([store.flushWrites(), new Promise((resolve) => setTimeout(resolve, 3000))]).then(() => undefined)
}

// Child MCP processes are ours to clean up; leaving them running would orphan
// stdio servers every time the app quits.
app.on('before-quit', (event) => {
  // A second instance that handed over never started anything to clean up.
  if (!primaryInstance) return
  if (!shutDown) {
    shutDown = true
    cancelAllDownloads()
    // Held for below: the SDK closes a stdio server by ending its stdin, then
    // SIGTERM after 2 s and SIGKILL after 4 s. Exiting before then orphaned
    // any server that ignores EOF. One that exits on EOF costs no wait.
    mcpShutdown = Promise.race([shutdownMcp(), new Promise((resolve) => setTimeout(resolve, 4500))]).then(
      () => undefined,
      () => undefined
    )
    void stopLocalServer()
    killBackgroundProcesses()
    for (const feature of FEATURES) {
      try {
        feature.dispose?.()
      } catch {
        /* quitting regardless */
      }
    }
    // Terminal shells must be reaped before exit: node-pty reports each exit
    // on a thread-safe function, and one landing during teardown aborts the
    // process (SIGABRT) instead of quitting it.
    featureShutdown = Promise.race([
      Promise.all(FEATURES.map((feature) => feature.shutdown?.().catch(() => undefined))),
      new Promise((resolve) => setTimeout(resolve, 3000))
    ]).then(() => undefined)
  }
  if (flushedBeforeClose) return
  // Chats are saved asynchronously, and Quit right after a reply usually lands
  // while that save is still being written; exiting under it lost the last
  // save. Hold the quit until the writes land.
  event.preventDefault()
  void Promise.all([flushPendingWrites(), mcpShutdown, featureShutdown]).then(() => {
    flushedBeforeClose = true
    app.quit()
  })
})

// Closing the windows makes the renderer send its final save (on pagehide,
// including one still inside its debounce), which arrives after before-quit's
// wait. Once the windows are gone, wait for that one too.
app.on('will-quit', (event) => {
  if (!primaryInstance || flushedAfterClose) return
  event.preventDefault()
  void flushPendingWrites().then(() => {
    flushedAfterClose = true
    // Not app.quit(): once will-quit has been prevented, Electron ignores it
    // and the app sat on with no windows. Cleanup ran in before-quit and the
    // windows are gone, so there is nothing left to do but exit.
    app.exit(0)
  })
})
