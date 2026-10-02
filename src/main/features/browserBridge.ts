import { app, shell } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { cp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrowserAsk, BrowserBridgeStatus, PairingCode } from '@shared/browserBridge'
import { registerToolSource } from '../agent/tools'
import { store } from '../store'
import { LegacyExtensionDetector } from './browser/legacy'
import { BrowserBridge, type PairingRecord } from './browser/server'
import { createBrowserTool } from './browser/tool'
import type { Feature, FeatureContext } from './types'

/**
 * Browser control through the Eaon Chrome extension, which connects to a
 * loopback WebSocket this module serves. The server and its auth live in
 * `browser/server.ts`, the agent's `browser` tool in `browser/tool.ts`; this
 * file is the glue — settings, IPC for the settings page, and where the
 * extension folder lives for "Load unpacked".
 */

const here = join(fileURLToPath(import.meta.url), '..')
const PAIRING_FILE = 'browser-pairing.json'

let bridge: BrowserBridge | null = null
let legacy: LegacyExtensionDetector | null = null
/** Sent from the right-click menu, waiting for the window to pick it up. */
let pendingAsk: BrowserAsk | null = null
/** Settings changes arrive as separate IPC calls; applying them one at a time keeps start/stop from racing. */
let applying: Promise<void> = Promise.resolve()

/** The extension as shipped: inside the app bundle when packaged, the repo folder in development. */
function bundledExtensionDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'extension') : join(here, '../../extension')
}

function manifestVersion(dir: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { version?: string }).version ?? null
  } catch {
    return null
  }
}

/**
 * The folder the user points "Load unpacked" at.
 *
 * In a packaged app that is a copy under userData, not the bundle itself:
 * Chrome's folder picker on macOS will not step inside an .app package, and
 * every app update replaces the bundle, which would pull the folder out from
 * under a loaded extension. The copy is refreshed whenever the shipped version
 * differs, so an update reaches Chrome the next time it reloads the extension.
 * In development the repo folder is used directly, so edits load on reload.
 */
async function unpackedExtensionDir(): Promise<string> {
  const source = bundledExtensionDir()
  if (!app.isPackaged) return source
  const target = join(app.getPath('userData'), 'browser-extension')
  if (!existsSync(target) || manifestVersion(target) !== manifestVersion(source)) {
    await rm(target, { recursive: true, force: true })
    await cp(source, target, {
      recursive: true,
      filter: (path) => !path.endsWith('STORE_LISTING.md') && !path.endsWith('.DS_Store')
    })
  }
  return target
}

function status(): BrowserBridgeStatus {
  const settings = store.getSettings().browserExtension
  const base = bridge?.status()
  return {
    enabled: settings.enabled,
    listening: base?.listening ?? false,
    port: base?.listening ? base.port : settings.port,
    error: settings.enabled ? (base?.error ?? null) : null,
    paired: base?.paired ?? false,
    connected: base?.connected ?? false,
    client: base?.client ?? null,
    paused: base?.paused ?? false,
    agentTab: base?.agentTab ?? null,
    pairing: base?.listening ? base.pairing : null,
    bundledExtensionVersion: manifestVersion(bundledExtensionDir()),
    canSelfUpdate: base?.canSelfUpdate ?? false,
    update: base?.update ?? 'idle',
    legacyExtensionSeenAt: settings.enabled ? (legacy?.seenAt ?? null) : null
  }
}

/**
 * Chromium browsers installed on this Mac, and the address of each one's
 * extensions page, for the "Open extensions page" buttons. Browsers refuse
 * to open their internal pages from a web link, but accept them from `open`.
 */
const BROWSERS = [
  { id: 'chrome', name: 'Chrome', app: 'Google Chrome', page: 'chrome://extensions' },
  { id: 'comet', name: 'Comet', app: 'Comet', page: 'chrome://extensions' },
  { id: 'arc', name: 'Arc', app: 'Arc', page: 'chrome://extensions' },
  { id: 'dia', name: 'Dia', app: 'Dia', page: 'chrome://extensions' },
  { id: 'brave', name: 'Brave', app: 'Brave Browser', page: 'brave://extensions' },
  { id: 'edge', name: 'Edge', app: 'Microsoft Edge', page: 'edge://extensions' },
  { id: 'vivaldi', name: 'Vivaldi', app: 'Vivaldi', page: 'vivaldi://extensions' },
  { id: 'opera', name: 'Opera', app: 'Opera', page: 'opera://extensions' },
  { id: 'chromium', name: 'Chromium', app: 'Chromium', page: 'chrome://extensions' }
] as const

function installedBrowsers(): { id: string; name: string }[] {
  if (process.platform !== 'darwin') return []
  const roots = ['/Applications', join(homedir(), 'Applications')]
  return BROWSERS.filter((b) => roots.some((root) => existsSync(join(root, `${b.app}.app`)))).map(({ id, name }) => ({ id, name }))
}

function openExtensionsPage(id: string): Promise<boolean> {
  const browser = BROWSERS.find((b) => b.id === id)
  if (!browser || process.platform !== 'darwin') return Promise.resolve(false)
  return new Promise((resolve) => execFile('open', ['-a', browser.app, browser.page], (error) => resolve(!error)))
}

/** Brings the main window up with the right-click request waiting for it. */
function deliverAsk(ask: BrowserAsk, ctx: FeatureContext): void {
  pendingAsk = ask
  const win = ctx.getWindow()
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    ctx.send('browser-bridge:ask')
  } else {
    // No window (macOS keeps running without one): the Dock-click path opens
    // one, and the new window collects the request as it starts up.
    app.emit('activate')
  }
}

/** Starts, stops or moves the server to match settings. */
function apply(): Promise<void> {
  applying = applying.then(async () => {
    if (!bridge) return
    const { enabled, port } = store.getSettings().browserExtension
    if (!enabled) await bridge.stop()
    else if (!bridge.listening || bridge.boundPort !== port) await bridge.start(port)
    if (enabled) await legacy?.start()
    else await legacy?.stop()
  })
  return applying
}

export const browserBridgeFeature: Feature = {
  id: 'browser-bridge',
  register: async (ctx: FeatureContext) => {
    bridge = new BrowserBridge({
      appVersion: app.getVersion(),
      store: {
        load: () => store.getJson<PairingRecord | null>(PAIRING_FILE, null),
        save: (record) => store.setJson(PAIRING_FILE, record)
      },
      onChange: () => ctx.send('browser-bridge:status', status()),
      bundledVersion: () => manifestVersion(bundledExtensionDir()),
      onAsk: (ask) => deliverAsk(ask, ctx)
    })
    legacy = new LegacyExtensionDetector(() => ctx.send('browser-bridge:status', status()))
    // An unpacked extension updates by reloading from this folder, so it has
    // to hold the shipped version before the extension is asked to reload.
    if (app.isPackaged) void unpackedExtensionDir().catch((error) => console.error('[browser-bridge] could not refresh the extension folder:', error))
    const { source } = createBrowserTool(bridge)
    registerToolSource(source)

    ctx.ipcMain.handle('browser-bridge:status', (): BrowserBridgeStatus => status())
    ctx.ipcMain.handle('browser-bridge:apply', async (): Promise<BrowserBridgeStatus> => {
      await apply()
      return status()
    })
    ctx.ipcMain.handle('browser-bridge:pairing-code', (_e, fresh?: boolean): PairingCode | null =>
      bridge?.listening ? bridge.pairingCode(fresh === true) : null
    )
    ctx.ipcMain.handle('browser-bridge:unpair', (): BrowserBridgeStatus => {
      bridge?.unpair()
      return status()
    })
    ctx.ipcMain.handle('browser-bridge:extension-path', () => unpackedExtensionDir())
    ctx.ipcMain.handle('browser-bridge:update-extension', async (): Promise<BrowserBridgeStatus> => {
      await unpackedExtensionDir()
      bridge?.requestUpdate()
      return status()
    })
    ctx.ipcMain.handle('browser-bridge:take-ask', (): BrowserAsk | null => {
      const ask = pendingAsk
      pendingAsk = null
      return ask
    })
    ctx.ipcMain.handle('browser-bridge:browsers', () => installedBrowsers())
    ctx.ipcMain.handle('browser-bridge:open-extensions-page', (_e, id: string) => openExtensionsPage(String(id)))
    ctx.ipcMain.handle('browser-bridge:reveal-extension', async (): Promise<string> => {
      const dir = await unpackedExtensionDir()
      // Selecting the manifest opens Finder/Explorer *inside* the folder, which
      // is the folder Chrome's picker wants.
      shell.showItemInFolder(join(dir, 'manifest.json'))
      return dir
    })

    await apply()
  },
  dispose: () => {
    void bridge?.stop()
    void legacy?.stop()
  }
}

/** For tests: the live bridge after register(). */
export const __bridgeForTests = (): BrowserBridge | null => bridge
