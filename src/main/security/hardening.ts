import { app, session, shell, type IpcMain, type IpcMainEvent, type IpcMainInvokeEvent, type Session, type WebContents } from 'electron'
import { audit } from '../enterprise/audit'

/**
 * The boundary between Eaon's own page, which holds `window.api`, and the
 * web content Eaon shows (the in-app browser, the agents' browsers):
 *
 * - links leave Eaon only as http, https or mailto;
 * - an Eaon window never navigates away from Eaon's page;
 * - IPC answers only Eaon's page, never a frame or a page loaded in its place;
 * - web pages get no microphone, camera, location, notifications or
 *   clipboard reads, and can't hand a URL scheme to the operating system;
 * - <webview> tags are sandboxed and load only web pages.
 */

/** What a link in a chat, a page or a settings screen may hand to the system. */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/**
 * Opens a link in the user's browser or mail app. Anything else is refused:
 * Windows registers handlers for protocols such as ms-msdt: and search-ms:
 * that run or fetch things the moment they open, and a model's reply or a web
 * page should never be one click from starting them.
 */
export async function openExternalLink(url: string): Promise<void> {
  let protocol = ''
  try {
    protocol = new URL(url).protocol
  } catch {
    // Not a URL at all; refused below.
  }
  if (!EXTERNAL_PROTOCOLS.has(protocol)) {
    console.warn(`[links] not opening ${url.slice(0, 200)}: only http, https and mailto links open outside Eaon`)
    return
  }
  await shell.openExternal(url)
}

/**
 * The dev server's origin, in a development build only. A packaged Eaon never
 * takes its page from the environment: ELECTRON_RENDERER_URL would otherwise
 * load any site into a window that has the full preload.
 */
export function devServerUrl(): string | undefined {
  return app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'] || undefined
}

/** True for Eaon's own page: the bundled index.html, or the dev server in development. */
export function isAppUrl(raw: string, rendererFile: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  const dev = devServerUrl()
  if (dev) {
    try {
      if (url.origin === new URL(dev).origin) return true
    } catch {
      // A malformed dev URL matches nothing.
    }
  }
  if (url.protocol !== 'file:') return false
  try {
    return decodeURIComponent(url.pathname) === decodeURIComponent(new URL(rendererFile).pathname)
  } catch {
    return false
  }
}

/** Keeps an Eaon window on Eaon's page; a link it would navigate to opens in the browser instead. */
export function guardAppNavigation(contents: WebContents, rendererFile: string): void {
  const guard = (event: Electron.Event, url: string): void => {
    if (isAppUrl(url, rendererFile)) return
    event.preventDefault()
    void openExternalLink(url)
  }
  contents.on('will-navigate', guard)
  contents.on('will-redirect', guard)
  // A file dropped outside a drop zone would otherwise be opened in the window.
  contents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return
    if (!isAppUrl(event.url, rendererFile) && !/^(about:|data:|blob:)/.test(event.url)) {
      // Subframes of the app page are never expected; the in-app browser is a <webview>, not an iframe.
      event.preventDefault()
    }
  })
}

let refusedSenders = 0

/**
 * Wraps `ipcMain.handle` and `ipcMain.on` so every handler, wherever it is
 * registered, answers only `isTrusted` senders. Must run before anything
 * registers a handler.
 */
export function guardIpc(ipc: IpcMain, isTrusted: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean): void {
  const handle = ipc.handle.bind(ipc)
  const on = ipc.on.bind(ipc)
  const refuse = (channel: string, event: IpcMainEvent | IpcMainInvokeEvent): void => {
    // Logged a handful of times, not once per call: a hostile page would flood it.
    if (refusedSenders++ < 20) {
      audit('ipc.refused', { channel, url: event.senderFrame?.url?.slice(0, 200) ?? null }, { via: 'system', outcome: 'denied' })
    }
  }
  ipc.handle = (channel, listener): void =>
    handle(channel, (event, ...args) => {
      if (!isTrusted(event)) {
        refuse(channel, event)
        throw new Error('Not allowed.')
      }
      return listener(event, ...args)
    })
  ipc.on = ((channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void) =>
    on(channel, (event: IpcMainEvent, ...args: unknown[]) => {
      if (!isTrusted(event)) {
        refuse(channel, event)
        return
      }
      listener(event, ...args)
    })) as IpcMain['on']
}

/** Permissions Eaon's own page uses: dictation and the terminal's paste. */
const APP_PERMISSIONS = new Set(['media', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'notifications'])
/** Permissions a web page in the in-app or agent browser gets without asking. */
const WEB_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock'])

function applySessionPolicy(target: Session, isAppContents: (contents: WebContents) => boolean): void {
  target.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission === 'openExternal') {
      // A page setting location to search-ms:, smb: or an app's scheme would
      // otherwise reach the OS without the link checks above.
      callback(false)
      const url = (details as { externalURL?: string }).externalURL
      if (url?.startsWith('mailto:')) void openExternalLink(url)
      return
    }
    const app = Boolean(contents) && isAppContents(contents) && details.isMainFrame
    if (permission === 'media') {
      // The app dictates; it never films. Web pages get neither.
      const types = (details as { mediaTypes?: string[] }).mediaTypes ?? []
      callback(app && types.every((type) => type === 'audio'))
      return
    }
    callback(app ? APP_PERMISSIONS.has(permission) : WEB_PERMISSIONS.has(permission))
  })
  target.setPermissionCheckHandler((contents, permission) =>
    contents && isAppContents(contents) ? APP_PERMISSIONS.has(permission) : WEB_PERMISSIONS.has(permission)
  )
}

/**
 * Permission rules for every session: the default one (the app and the
 * in-app browser) and each one made later (the agents' and workers'
 * browsers, which are created lazily). Must run before any page loads.
 */
export function installSessionPolicy(isAppContents: (contents: WebContents) => boolean): void {
  applySessionPolicy(session.defaultSession, isAppContents)
  app.on('session-created', (created) => applySessionPolicy(created, isAppContents))
}

/** Pages an in-app browser tab may open. */
const WEBVIEW_PROTOCOLS = new Set(['http:', 'https:', 'about:', 'data:', 'file:'])

/**
 * Every <webview> is a plain, sandboxed web page: no preload, no Node, its
 * own context, web security on. Registered before the first window opens,
 * so no window ever exists without it.
 */
export function guardWebviews(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event, preferences, params) => {
      delete preferences.preload
      preferences.nodeIntegration = false
      preferences.nodeIntegrationInSubFrames = false
      preferences.contextIsolation = true
      preferences.sandbox = true
      preferences.webSecurity = true
      preferences.allowRunningInsecureContent = false
      let protocol = ''
      try {
        protocol = new URL(params.src || 'about:blank').protocol
      } catch {
        // Refused below.
      }
      if (!WEBVIEW_PROTOCOLS.has(protocol)) event.preventDefault()
    })
  })
}
