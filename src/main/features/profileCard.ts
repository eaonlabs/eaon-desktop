import { writeFile } from 'node:fs/promises'
import { clipboard, dialog, nativeImage } from 'electron'
import type { Feature } from './types'

/**
 * Settings → Profile's share card: the picture drawn in the page, put on the
 * clipboard or saved where the user picks. Channels are `profile-card:*`.
 */

const png = (data: unknown): Buffer => {
  if (!(data instanceof Uint8Array) || data.byteLength > 20 * 1024 * 1024) throw new Error('Not a picture.')
  return Buffer.from(data)
}

export const profileCardFeature: Feature = {
  id: 'profile-card',
  register: ({ ipcMain, getWindow }) => {
    ipcMain.handle('profile-card:copy', (_e, data: unknown) => {
      clipboard.writeImage(nativeImage.createFromBuffer(png(data)))
    })
    ipcMain.handle('profile-card:save', async (_e, data: unknown, name: unknown) => {
      const buffer = png(data)
      const win = getWindow()
      const options = { defaultPath: `${String(name || 'eaon-activity').replace(/[^\w.-]+/g, '-')}.png`, filters: [{ name: 'PNG image', extensions: ['png'] }] }
      const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return null
      await writeFile(result.filePath, buffer)
      return result.filePath
    })
  }
}
