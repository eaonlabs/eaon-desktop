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
export const BrowserWindow = { getAllWindows: () => [], getFocusedWindow: () => null }
export const Notification = { isSupported: () => false }
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
export default { app, safeStorage, shell, nativeTheme, ipcMain, BrowserWindow, Notification, systemPreferences, screen, nativeImage }
