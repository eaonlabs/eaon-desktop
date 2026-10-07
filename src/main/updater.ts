import { app, BrowserWindow, dialog } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '@shared/types'
import { updateChannelFor } from './updateChannel'
import { betaDialogText, isOfferable, isPrerelease } from './betaOffer'
import { store } from './store'

// electron-updater exposes `autoUpdater` via a lazy getter on its CJS exports,
// which Node's ESM/CJS interop can't statically detect as a named export —
// importing through the default export first is the documented workaround.
const { autoUpdater } = electronUpdater

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

let getWindows: () => BrowserWindow[] = () => []
let status: UpdateStatus = { state: 'idle' }
let interactive = false
/** A look at the newest prerelease is under way: its checking and result are not the user's business. */
let probing = false
/** The beta this stable build found and would offer; null when there is none (or this isn't a stable build). */
let beta: { version: string } | null = null
let asking = false
const DECLINED_FILE = 'beta-offer.json'

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
  void checkForUpdates().then(() => lookForBeta())
}

/**
 * On a stable build: finds out whether a beta exists, without downloading
 * anything, and asks once per beta whether to try it. The updater itself does
 * the looking (so a release without this platform's update file finds
 * nothing), with prereleases allowed for the length of this one check only —
 * left on, the next background check would install a beta unasked.
 */
async function lookForBeta(): Promise<void> {
  const current = app.getVersion()
  if (probing || isPrerelease(current) || !app.isPackaged) return
  // Only when nothing else is going on: a stable update in hand comes first.
  if (status.state !== 'idle' && status.state !== 'not-available' && status.state !== 'error') return
  probing = true
  try {
    autoUpdater.allowPrerelease = true
    autoUpdater.autoDownload = false
    const result = await autoUpdater.checkForUpdates()
    const found = result?.updateInfo?.version
    beta = result?.isUpdateAvailable && isOfferable(current, found) ? { version: found } : null
  } catch {
    // Offline, or no beta with this platform's files: nothing to offer.
    beta = null
  } finally {
    autoUpdater.allowPrerelease = false
    autoUpdater.autoDownload = true
    probing = false
  }
  for (const window of getWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('updater:beta', beta)
  }
  if (beta && store.getJson<{ declined?: string }>(DECLINED_FILE, {}).declined !== beta.version) await askAboutBeta(true)
}

/** The beta on offer, for Settings; null when none. */
export function betaOffer(): { version: string } | null {
  return beta
}

/**
 * The warning, then — only on a yes — the download of the beta, which installs
 * when Eaon restarts like any update. `remember`: the automatic prompt, which
 * does not ask again for a beta that was turned down (Settings still offers it).
 */
export async function askAboutBeta(remember: boolean): Promise<void> {
  if (!beta || asking) return
  asking = true
  try {
    const text = betaDialogText(beta.version)
    const window = getWindows().find((w) => !w.isDestroyed())
    const options = { type: 'warning' as const, ...text, buttons: ['Not now', 'Update to beta'], defaultId: 0, cancelId: 0, noLink: true }
    const answer = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
    if (answer.response !== 1) {
      if (remember) store.setJson(DECLINED_FILE, { declined: beta.version })
      return
    }
    interactive = false
    try {
      autoUpdater.allowPrerelease = true
      await autoUpdater.checkForUpdates()
    } catch (err) {
      broadcast({ state: 'error', message: err instanceof Error ? err.message : String(err) })
    } finally {
      // The download carries on from what was just found; background checks go back to stable only.
      autoUpdater.allowPrerelease = false
    }
  } finally {
    asking = false
  }
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

  autoUpdater.on('checking-for-update', () => {
    if (!probing) broadcast({ state: 'checking' })
  })
  autoUpdater.on('update-available', (info) => {
    if (probing) return
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
    if (probing) return
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
    if (probing) return
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
