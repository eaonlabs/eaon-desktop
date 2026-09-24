/**
 * Just enough of Electron for main-process modules to load under plain Node
 * in tests. userData points at a throwaway folder so nothing touches the real
 * app's store.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userData = process.env.EAON_TEST_USERDATA ?? mkdtempSync(join(tmpdir(), 'eaon-test-'))
process.env.EAON_TEST_USERDATA = userData

export const app = {
  getPath: (name: string) => (name === 'userData' ? userData : join(userData, name)),
  getVersion: () => '0.0.0-test',
  isPackaged: false,
  setName: () => {},
  on: () => {},
  emit: () => false,
  whenReady: () => Promise.resolve()
}

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s: string) => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8')
}

export const shell = {
  trashItem: async (path: string) => {
    const { rm } = await import('node:fs/promises')
    await rm(path, { recursive: true, force: true })
  },
  // Tests that drive a browser sign-in set globalThis.__eaonOpenExternal to
  // play the browser's part.
  openExternal: async (url: string) => {
    const hook = (globalThis as { __eaonOpenExternal?: (url: string) => Promise<void> | void }).__eaonOpenExternal
    await hook?.(url)
  },
  openPath: async () => '',
  showItemInFolder: () => {}
}

export const nativeTheme = { shouldUseDarkColors: true, themeSource: 'system' }
export const ipcMain = { handle: () => {}, on: () => {} }
/** Constructible, because computer use opens its indicator window with `new BrowserWindow`. */
export class BrowserWindow {
  static getAllWindows = (): BrowserWindow[] => []
  static getFocusedWindow = (): BrowserWindow | null => null
  webContents = { on: () => {}, setWindowOpenHandler: () => {}, isOffscreen: () => false }
  setAlwaysOnTop(): void {}
  setVisibleOnAllWorkspaces(): void {}
  once(): void {}
  loadURL(): Promise<void> {
    return Promise.resolve()
  }
  isDestroyed(): boolean {
    return false
  }
  destroy(): void {}
  showInactive(): void {}
}
/**
 * Unsupported by default, as on a headless CI box. The scheduler tests flip
 * `supported` on and read `shown` to check what would have been posted.
 */
export class Notification {
  static supported = false
  static shown: Notification[] = []
  static isSupported(): boolean {
    return Notification.supported
  }
  private handlers = new Map<string, () => void>()
  constructor(public options: { title: string; body?: string }) {}
  on(event: string, handler: () => void): this {
    this.handlers.set(event, handler)
    return this
  }
  show(): void {
    Notification.shown.push(this)
  }
  /** Test helper: what a user's click would do. */
  click(): void {
    this.handlers.get('click')?.()
  }
}
export const powerMonitor = { on: () => {} }
export const systemPreferences = {
  getMediaAccessStatus: () => 'granted',
  isTrustedAccessibilityClient: () => true
}
const primaryDisplay = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  workArea: { x: 0, y: 25, width: 1440, height: 875 },
  size: { width: 1440, height: 900 },
  scaleFactor: 2,
  workAreaSize: { width: 1440, height: 875 }
}
export const screen = {
  getPrimaryDisplay: () => primaryDisplay,
  getAllDisplays: () => [primaryDisplay],
  dipToScreenPoint: (p: { x: number; y: number }) => p,
  screenToDipPoint: (p: { x: number; y: number }) => p
}
export const desktopCapturer = { getSources: async () => [] }
export const globalShortcut = { register: () => true, unregister: () => {}, isRegistered: () => false }
export const nativeImage = {
  createFromBuffer: () => ({ getSize: () => ({ width: 1, height: 1 }), resize: () => ({ toJPEG: () => Buffer.alloc(0) }), toJPEG: () => Buffer.alloc(0) })
}
export default { app, safeStorage, shell, nativeTheme, ipcMain, BrowserWindow, Notification, powerMonitor, systemPreferences, screen, nativeImage, desktopCapturer, globalShortcut }
