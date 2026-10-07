import { app, BrowserWindow, dialog } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '@shared/types'
import { store } from './store'
import { isPrerelease, updateChannelFor } from './updateChannel'
import { UpdateController } from './updates'

// electron-updater exposes `autoUpdater` via a lazy getter on its CJS exports,
// which Node's ESM/CJS interop can't statically detect as a named export —
// importing through the default export first is the documented workaround.
const { autoUpdater } = electronUpdater

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

let getWindows: () => BrowserWindow[] = () => []
let controller: UpdateController | null = null

function broadcast(channel: string, status: UpdateStatus): void {
  // On macOS the app outlives its windows. A destroyed window throws on
  // `webContents`, which inside electron-updater's event chain aborted the
  // check (and every later one) while no window was open.
  for (const window of getWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, status)
  }
}

/**
 * The background poll leaves a check or download in progress alone, and stops
 * once an update is downloaded: it is ready to install regardless, and a later
 * failed check (offline, say) would replace "Restart to update" with an error.
 * Beta updates are looked for after the stable check, and only when asked for.
 */
async function poll(): Promise<void> {
  const state = controller?.stable.state
  if (state === 'checking' || state === 'downloading' || state === 'downloaded') return
  await checkForUpdates()
  await checkForBetaUpdates()
}

export function getUpdateStatus(): UpdateStatus {
  return controller?.stable ?? { state: 'idle' }
}

export function getBetaStatus(): UpdateStatus {
  return controller?.beta ?? { state: 'idle' }
}

/** Wires autoUpdater events once; the app.whenReady handler calls this before the first check. */
export function initUpdater(windows: () => BrowserWindow[]): void {
  getWindows = windows
  autoUpdater.autoDownload = true
  // A .deb (and any Linux install that isn't an AppImage) updates through
  // pkexec or sudo, which asks for a password. Installed on quit, that prompt
  // turned up after Eaon's window had gone, with nothing saying what it was
  // for. "Restart to update" still installs it while the window is open. An
  // AppImage replaces its own file and asks nothing, so it keeps installing on quit.
  autoUpdater.autoInstallOnAppQuit = process.platform !== 'linux' || Boolean(process.env['APPIMAGE'])
  const channel = updateChannelFor(app.getVersion())
  if (channel) {
    autoUpdater.channel = channel
    // Setting a channel also allows downgrades; an install should only move forward.
    autoUpdater.allowDowngrade = false
  }

  controller = new UpdateController({
    updater: autoUpdater,
    version: app.getVersion(),
    betaEnabled: () => store.getSettings().updates.beta,
    publishStable: (status) => broadcast('updater:status', status),
    publishBeta: (status) => broadcast('updater:beta-status', status),
    interactiveResult: (result) => {
      void dialog.showMessageBox(
        result.kind === 'up-to-date'
          ? { type: 'info', message: `You're up to date`, detail: `Eaon Desktop ${app.getVersion()} is the latest version.` }
          : { type: 'error', message: 'Update check failed', detail: result.message }
      )
    }
  })
  controller.attach()

  if (!app.isPackaged) return
  // Unpackaged (dev) builds have no update feed, so only a packaged app polls.
  setTimeout(() => void poll(), 10_000)
  setInterval(() => void poll(), CHECK_INTERVAL_MS)
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
    } else {
      // The Settings button: without this it did nothing at all in a dev build.
      broadcast('updater:status', { state: 'error', message: 'Updates are unavailable in development builds.' })
    }
    return
  }
  await controller?.checkStable(options)
}

/** Looks for a newer beta (only if the user turned beta updates on). It says so; it does not download. */
export async function checkForBetaUpdates(): Promise<void> {
  if (!app.isPackaged) return
  await controller?.checkBeta()
}

/** The Download button on an available beta. */
export async function downloadBetaUpdate(): Promise<void> {
  await controller?.downloadBeta()
}

/** Beta updates were turned on or off: look now, or forget what was found. */
export async function betaOptionChanged(): Promise<void> {
  if (store.getSettings().updates.beta) await checkForBetaUpdates()
  else controller?.clearBeta()
}

/**
 * Back to the stable release: for someone on a beta who wants out. Points the
 * updater at the latest stable release (not prereleases) and allows the move
 * to an older version, which an update never does otherwise; the download
 * installs when Eaon restarts, like any update. Refused on a stable build,
 * which has nowhere older to go and must never be moved backwards.
 */
export async function switchToStable(): Promise<void> {
  if (!isPrerelease(app.getVersion())) throw new Error('This isn’t a beta build, so there is no stable version to go back to.')
  if (!app.isPackaged) throw new Error('Updates are unavailable in development builds.')
  await controller?.switchToStable()
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall()
}
