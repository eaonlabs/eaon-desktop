import { app, BrowserWindow, dialog } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '@shared/types'

// electron-updater exposes `autoUpdater` via a lazy getter on its CJS exports,
// which Node's ESM/CJS interop can't statically detect as a named export —
// importing through the default export first is the documented workaround.
const { autoUpdater } = electronUpdater

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

let getWindow: () => BrowserWindow | null = () => null
let status: UpdateStatus = { state: 'idle' }
let interactive = false

function broadcast(next: UpdateStatus): void {
  status = next
  getWindow()?.webContents.send('updater:status', status)
}

export function getUpdateStatus(): UpdateStatus {
  return status
}

/** Wires autoUpdater events once; the app.whenReady handler calls this before the first check. */
export function initUpdater(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => broadcast({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => broadcast({ state: 'available', version: info.version }))
  autoUpdater.on('download-progress', (progress) =>
    broadcast({ state: 'downloading', percent: Math.round(progress.percent) })
  )
  autoUpdater.on('update-downloaded', (info) => broadcast({ state: 'downloaded', version: info.version }))

  autoUpdater.on('update-not-available', () => {
    broadcast({ state: 'not-available' })
    if (interactive) {
      void dialog.showMessageBox({
        type: 'info',
        message: `You're up to date`,
        detail: `Eaon Desktop ${app.getVersion()} is the latest version.`
      })
    }
    interactive = false
  })

  autoUpdater.on('error', (err) => {
    broadcast({ state: 'error', message: err.message })
    if (interactive) {
      void dialog.showMessageBox({ type: 'error', message: 'Update check failed', detail: err.message })
    }
    interactive = false
  })

  if (!app.isPackaged) return
  // Unpackaged (dev) builds have no update feed, so only a packaged app polls.
  setTimeout(() => void checkForUpdates(), 10_000)
  setInterval(() => void checkForUpdates(), CHECK_INTERVAL_MS)
}

/**
 * `interactive` requests come from the "Check for Updates…" menu item or the
 * Settings button — those get a dialog when there's nothing new. Background
 * polling stays silent; the Settings page reflects `status` live instead.
 */
export async function checkForUpdates(options?: { interactive?: boolean }): Promise<void> {
  if (!app.isPackaged) {
    if (options?.interactive) {
      void dialog.showMessageBox({
        type: 'info',
        message: 'Updates are unavailable in development builds.'
      })
    }
    return
  }
  interactive = Boolean(options?.interactive)
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    broadcast({ state: 'error', message: err instanceof Error ? err.message : String(err) })
    interactive = false
  }
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall()
}
