import { shell, type BrowserWindow, type WebContents, type WebPreferences } from 'electron'

/**
 * What Eaon hands to the operating system to open, and what its own window
 * may navigate to.
 *
 * `shell.openExternal` opens whatever the OS has a handler for: `file:` runs
 * an app or a script, `smb:` mounts a share, and every installed app's own
 * scheme (`zoommtg:`, `vscode:`) does what that app likes with its URL. A
 * link in a model's reply, a page in the browser panel or a plugin's sign-in
 * metadata must not be able to reach any of that, so only the web and email
 * get out; everything else is refused here, in main, whatever the renderer
 * asked.
 */

const EXTERNAL = new Set(['http:', 'https:', 'mailto:'])

/** The URL normalized, when it is one Eaon may open outside itself; null otherwise. */
export function externalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 8192) return null
  try {
    const url = new URL(raw.trim())
    if (!EXTERNAL.has(url.protocol)) return null
    // A web link needs somewhere to go.
    if (url.protocol !== 'mailto:' && !url.hostname) return null
    return url.href
  } catch {
    return null
  }
}

/** Opens a web or email link in the user's own apps; anything else is refused with a reason. */
export async function openExternalSafely(raw: unknown): Promise<void> {
  const url = externalUrl(raw)
  if (!url) throw new Error('Eaon only opens web and email links.')
  await shell.openExternal(url)
}

/** Whether `target` is the page Eaon's window already shows (its dev server, or its own file). */
export function sameAppPage(current: string, target: string): boolean {
  try {
    const a = new URL(current)
    const b = new URL(target)
    if (a.protocol === 'file:' || b.protocol === 'file:') return a.protocol === b.protocol && a.pathname === b.pathname
    return a.origin === b.origin
  } catch {
    return false
  }
}

/** A `<webview>`'s preferences, made safe whatever the page that created it asked for. */
export function lockWebview(prefs: WebPreferences, params: Record<string, string>): boolean {
  delete prefs.preload
  prefs.nodeIntegration = false
  prefs.nodeIntegrationInSubFrames = false
  prefs.contextIsolation = true
  prefs.sandbox = true
  prefs.webSecurity = true
  const src = params['src'] ?? ''
  return src === '' || src === 'about:blank' || /^https?:\/\//i.test(src)
}

/**
 * Eaon's own window: links that would open a new window go to the user's
 * browser (web and email only), the window itself never navigates away from
 * the app, and the browser panel's `<webview>` gets no Node, no preload and
 * no popups of its own — a page there opens new windows in the user's
 * browser instead.
 */
export function hardenAppWindow(window: BrowserWindow): void {
  const contents = window.webContents
  contents.setWindowOpenHandler(({ url }) => {
    void openExternalSafely(url).catch(() => undefined)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (sameAppPage(contents.getURL(), url)) return
    event.preventDefault()
    void openExternalSafely(url).catch(() => undefined)
  })
  contents.on('will-attach-webview', (event, prefs, params) => {
    if (!lockWebview(prefs, params as unknown as Record<string, string>)) event.preventDefault()
  })
  contents.on('did-attach-webview', (_event, guest: WebContents) => {
    guest.setWindowOpenHandler(({ url }) => {
      void openExternalSafely(url).catch(() => undefined)
      return { action: 'deny' }
    })
  })
}
