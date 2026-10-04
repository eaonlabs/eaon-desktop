import { app, BrowserWindow, dialog } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '@shared/types'
import { updateChannelFor } from './updateChannel'

// electron-updater exposes `autoUpdater` via a lazy getter on its CJS exports,
// which Node's ESM/CJS interop can't statically detect as a named export —
// importing through the default export first is the documented workaround.
const { autoUpdater } = electronUpdater

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

let getWindows: () => BrowserWindow[] = () => []
let status: UpdateStatus = { state: 'idle' }
let interactive = false

function broadcast(next: UpdateStatus): void {
  status = next
  // On macOS the app outlives its windows. A destroyed window throws on
  // `webContents`, which inside electron-updater's event chain aborted the
  // check (and every later one) while no window was open.
  for (const window of getWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('updater:status', status)
  }
}

/**
 * The background poll leaves a check or download in progress alone, and stops
 * once an update is downloaded: it installs on quit regardless, and a later
 * failed check (offline, say) would replace "Restart to update" with an error.
 */
function poll(): void {
  if (status.state === 'checking' || status.state === 'downloading' || status.state === 'downloaded') return
  void checkForUpdates()
}

export function getUpdateStatus(): UpdateStatus {
  return status
}

/** Wires autoUpdater events once; the app.whenReady handler calls this before the first check. */
export function initUpdater(windows: () => BrowserWindow[]): void {
  getWindows = windows
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  const channel = updateChannelFor(app.getVersion())
  if (channel) {
    autoUpdater.channel = channel
    // Setting a channel also allows downgrades; an install should only move forward.
    autoUpdater.allowDowngrade = false
  }

  autoUpdater.on('checking-for-update', () => broadcast({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => {
    broadcast({ state: 'available', version: info.version })
    // The check the user asked about is answered; left set, the next
    // background failure hours later would pop a dialog nobody asked for.
    interactive = false
  })
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
  setTimeout(poll, 10_000)
  setInterval(poll, CHECK_INTERVAL_MS)
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
