import { readFile, stat, writeFile } from 'node:fs/promises'
import { BrowserWindow, dialog } from 'electron'
import { MAX_SETUP_BYTES, SETUP_EXTENSION } from '@shared/workerSetup'
import type { FeatureContext } from '../types'

/**
 * The file dialogs for a worker's setup file (shared/workerSetup.ts). They are
 * this computer's: with the workers on a worker computer, the setup's text
 * travels over the link (workers:export-setup, workers:import-setup) and the
 * file is picked and saved here, where the screen is.
 */
export function registerSetupFileDialogs(ctx: FeatureContext): void {
  const parent = (): BrowserWindow | undefined => ctx.getWindow() ?? BrowserWindow.getFocusedWindow() ?? undefined

  // Saves what Export produced, where the user chooses; null when they cancel.
  ctx.ipcMain.handle('workers:save-setup-file', async (_e, fileName: unknown, text: unknown) => {
    if (typeof text !== 'string' || text.length > MAX_SETUP_BYTES) throw new Error('There is nothing to save.')
    const options = { title: 'Export worker setup', defaultPath: typeof fileName === 'string' && fileName ? fileName : `worker.${SETUP_EXTENSION}`, filters: [{ name: 'Eaon worker setup', extensions: ['json'] }] }
    const window = parent()
    const picked = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
    if (picked.canceled || !picked.filePath) return null
    await writeFile(picked.filePath, text, 'utf8')
    return picked.filePath
  })

  // Picks a setup file and gives its text for the preview; nothing is created until the user confirms it.
  ctx.ipcMain.handle('workers:open-setup-file', async () => {
    const options = { title: 'Choose a worker setup file', properties: ['openFile' as const], filters: [{ name: 'Eaon worker setup', extensions: ['json'] }] }
    const window = parent()
    const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    const file = picked.filePaths[0]
    if (picked.canceled || !file) return null
    if ((await stat(file)).size > MAX_SETUP_BYTES) throw new Error('That file is too big to be a worker’s setup.')
    return { file, text: await readFile(file, 'utf8') }
  })
}
