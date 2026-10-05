import { app, BrowserWindow, crashReporter, dialog, ipcMain, shell } from 'electron'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { redactSecrets } from './redact'

/**
 * What happens when something in Eaon crashes: it leaves evidence, and the
 * window comes back.
 *
 * - Every crash is a line in `<userData>/logs/crashes.log`: main-process
 *   exceptions and rejections nobody caught, renderer errors (reported over
 *   `app:report-error`), a renderer or helper process that died, a window that
 *   stopped responding. Native crashes also leave a minidump in
 *   `app.getPath('crashDumps')` — kept locally, never uploaded.
 * - A main-process exception is logged instead of Electron's "A JavaScript
 *   error occurred in the main process" dialog: it is almost always one
 *   subsystem's callback, and the rest of the app is fine.
 * - A window whose renderer died is reloaded, a few times at most; after that
 *   the user decides (a renderer that crashes on load would otherwise loop).
 */

const MAX_LOG_BYTES = 1_000_000
const MAX_ENTRY_CHARS = 8_000

export const crashLogPath = (): string => join(app.getPath('userData'), 'logs', 'crashes.log')

const describe = (detail: unknown): string => {
  if (detail instanceof Error) return detail.stack ?? `${detail.name}: ${detail.message}`
  if (typeof detail === 'string') return detail
  try {
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
}

/** Appends one entry to crashes.log, keeping the previous megabyte in crashes.old.log. Never throws. */
export function logCrash(kind: string, detail: unknown): void {
  // A rejection can carry a request's headers, a page URL an OAuth code or
  // key; the log is a plain file that ends up in bug reports.
  const text = redactSecrets(describe(detail).slice(0, MAX_ENTRY_CHARS))
  console.error(`[crash] ${kind}: ${text}`)
  try {
    const path = crashLogPath()
    mkdirSync(join(path, '..'), { recursive: true })
    try {
      if (statSync(path).size > MAX_LOG_BYTES) renameSync(path, join(path, '..', 'crashes.old.log'))
    } catch {
      // No log yet.
    }
    appendFileSync(path, `${new Date().toISOString()} [${kind}] ${text}\n`)
  } catch {
    // Nowhere to write; the console line above is all there is.
  }
}

/** At most `limit` automatic reloads in any `windowMs`. */
export class ReloadBudget {
  private times: number[] = []

  constructor(
    private readonly limit = 3,
    private readonly windowMs = 5 * 60_000
  ) {}

  take(now = Date.now()): boolean {
    this.times = this.times.filter((at) => now - at < this.windowMs)
    if (this.times.length >= this.limit) return false
    this.times.push(now)
    return true
  }
}

let installed = false

export function installCrashGuard(): void {
  if (installed) return
  installed = true
  crashReporter.start({ uploadToServer: false })

  process.on('uncaughtException', (error) => logCrash('main: uncaught exception', error))
  process.on('unhandledRejection', (reason) => logCrash('main: unhandled rejection', reason))

  let quitting = false
  app.on('before-quit', () => (quitting = true))

  const budget = new ReloadBudget()
  app.on('render-process-gone', (_event, contents, details) => {
    if (details.reason === 'clean-exit' || quitting) return
    const kind = contents.getType()
    logCrash(`renderer gone (${kind})`, `${details.reason}, exit code ${details.exitCode}, ${contents.getURL().slice(0, 200)}`)
    // A page in the agent's browser or a <webview> shows its own error; only Eaon's own windows are reloaded
    // ('offscreen' is the same window under the screenshot harness).
    if (kind !== 'window' && kind !== 'offscreen') return
    const window = BrowserWindow.fromWebContents(contents)
    if (!window || window.isDestroyed()) return
    if (budget.take()) {
      contents.reload()
      return
    }
    void dialog
      .showMessageBox(window, {
        type: 'error',
        message: 'Eaon’s window keeps crashing',
        detail: `It crashed several times in the last few minutes, so Eaon stopped reloading it. Details are in ${crashLogPath()}.`,
        buttons: ['Reload', 'Show Crash Log', 'Quit'],
        defaultId: 0,
        cancelId: 0
      })
      .then(({ response }) => {
        if (response === 0 && !window.isDestroyed()) window.webContents.reload()
        if (response === 1) shell.showItemInFolder(crashLogPath())
        if (response === 2) app.quit()
      })
  })

  app.on('child-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit' || quitting) return
    logCrash(`${details.type} process gone`, `${details.reason}, exit code ${details.exitCode}${details.name ? `, ${details.name}` : ''}`)
  })

  app.on('browser-window-created', (_event, window) => {
    let since = 0
    window.on('unresponsive', () => {
      since = Date.now()
      logCrash('window unresponsive', window.webContents.getURL().slice(0, 200))
    })
    window.on('responsive', () => {
      if (since) logCrash('window responsive again', `after ${Math.round((Date.now() - since) / 1000)}s`)
      since = 0
    })
  })

  // The renderer's error boundary and its window error / unhandledrejection listeners.
  ipcMain.on('app:report-error', (_event, report: unknown) => {
    const { message, stack, source } = (report && typeof report === 'object' ? report : {}) as Record<string, unknown>
    if (typeof message !== 'string') return
    const where = typeof source === 'string' ? source.slice(0, 40) : 'renderer'
    logCrash(`renderer: ${where}`, typeof stack === 'string' && stack.includes(message) ? stack : `${message}${typeof stack === 'string' ? `\n${stack}` : ''}`)
  })
}
