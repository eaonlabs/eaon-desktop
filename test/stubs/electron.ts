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
export const BrowserWindow = { getAllWindows: () => [], getFocusedWindow: () => null }
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
export const screen = {
  getPrimaryDisplay: () => ({ size: { width: 1440, height: 900 }, scaleFactor: 2, workAreaSize: { width: 1440, height: 875 } })
}
export const nativeImage = {
  createFromBuffer: () => ({ getSize: () => ({ width: 1, height: 1 }), resize: () => ({ toJPEG: () => Buffer.alloc(0) }), toJPEG: () => Buffer.alloc(0) })
}
export default { app, safeStorage, shell, nativeTheme, ipcMain, BrowserWindow, Notification, powerMonitor, systemPreferences, screen, nativeImage }
