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
  openExternal: async () => {},
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
export const Notification = { isSupported: () => false }
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
export default { app, safeStorage, shell, nativeTheme, ipcMain, BrowserWindow, Notification, systemPreferences, screen, nativeImage, desktopCapturer, globalShortcut }
