import { app, shell } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { cp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrowserBridgeStatus, PairingCode } from '@shared/browserBridge'
import { registerToolSource } from '../agent/tools'
import { store } from '../store'
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
    bundledExtensionVersion: manifestVersion(bundledExtensionDir())
  }
}

/** Starts, stops or moves the server to match settings. */
function apply(): Promise<void> {
  applying = applying.then(async () => {
    if (!bridge) return
    const { enabled, port } = store.getSettings().browserExtension
    if (!enabled) await bridge.stop()
    else if (!bridge.listening || bridge.boundPort !== port) await bridge.start(port)
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
      onChange: () => ctx.send('browser-bridge:status', status())
    })
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
  }
}

/** For tests: the live bridge after register(). */
export const __bridgeForTests = (): BrowserBridge | null => bridge
