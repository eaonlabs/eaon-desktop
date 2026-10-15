import { app, BrowserWindow, clipboard, Menu, shell, webContents, type WebContents } from 'electron'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ANNOTATE_SHORTCUT, browserKey, matchesBinding, type BrowserKeyAction } from '@shared/browser'
import { store } from '../store'
import type { Feature } from './types'

/**
 * The in-app browser's pages (`<webview>` in BrowserPanel): what the renderer
 * can't do from inside a page. Crops a picked element for Design Mode and
 * saves it where an agent can open it; opens a page's popups as tabs; gives
 * pages a right-click menu; and hands the browser's shortcuts to the panel
 * when a page has the keyboard, since keys pressed there never reach the
 * window.
 */

const isMac = process.platform === 'darwin'

/** Crops are kept a few days: long enough for an agent to open, short enough not to pile up. */
const KEEP_MS = 3 * 24 * 60 * 60 * 1000

const shotsDir = (): string => join(app.getPath('userData'), 'design-mode')

async function sweep(): Promise<void> {
  const dir = shotsDir()
  const names = await readdir(dir).catch(() => [] as string[])
  const now = Date.now()
  await Promise.all(
    names.map(async (name) => {
      const path = join(dir, name)
      const info = await stat(path).catch(() => null)
      if (info && now - info.mtimeMs > KEEP_MS) await rm(path, { force: true })
    })
  )
}

interface CaptureRequest {
  webContentsId: number
  rect: { x: number; y: number; width: number; height: number }
  viewport: { width: number; height: number }
}

/** A guest page of this app's own `<webview>`s; never another window's contents. */
function guest(id: number): WebContents | null {
  const contents = webContents.fromId(id)
  if (!contents || contents.isDestroyed() || contents.getType() !== 'webview') return null
  return contents
}

export const inAppBrowserFeature: Feature = {
  id: 'in-app-browser',
  register: ({ ipcMain }) => {
    void sweep()

    ipcMain.handle('in-app-browser:capture', async (_e, request: CaptureRequest): Promise<{ path: string; thumbnail: string } | null> => {
      const contents = guest(request.webContentsId)
      if (!contents) return null
      // A little room around the element, kept inside what is on screen.
      const pad = 6
      const x = Math.max(0, Math.floor(request.rect.x - pad))
      const y = Math.max(0, Math.floor(request.rect.y - pad))
      const right = Math.min(request.viewport.width, Math.ceil(request.rect.x + request.rect.width + pad))
      const bottom = Math.min(request.viewport.height, Math.ceil(request.rect.y + request.rect.height + pad))
      if (right - x < 2 || bottom - y < 2) return null
      const image = await contents.capturePage({ x, y, width: right - x, height: bottom - y })
      if (image.isEmpty()) return null
      await mkdir(shotsDir(), { recursive: true })
      const path = join(shotsDir(), `element-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.png`)
      await writeFile(path, image.toPNG())
      const size = image.getSize()
      const thumb = size.width > 360 ? image.resize({ width: 360, quality: 'good' }) : image
      return { path, thumbnail: thumb.toDataURL() }
    })

    ipcMain.handle('in-app-browser:devtools', (_e, webContentsId: number) => {
      const contents = guest(webContentsId)
      if (!contents) return
      if (contents.isDevToolsOpened()) contents.closeDevTools()
      else contents.openDevTools({ mode: 'detach' })
    })

    // The first window was made before features registered.
    for (const contents of webContents.getAllWebContents()) {
      if (contents.getType() === 'window') guardWindow(contents)
    }
    app.on('web-contents-created', (_event, contents) => {
      if (contents.getType() === 'window') guardWindow(contents)
      else if (contents.getType() === 'webview') wirePage(contents)
    })
  }
}

/** Pages get no Node and no preload, whatever the tag asks for. */
function guardWindow(contents: WebContents): void {
  contents.on('will-attach-webview', (_e, preferences) => {
    delete preferences.preload
    preferences.nodeIntegration = false
    preferences.contextIsolation = true
  })
}

function wirePage(contents: WebContents): void {
  const host = (): WebContents | null => {
    const owner = contents.hostWebContents
    return owner && !owner.isDestroyed() ? owner : null
  }
  const tell = (channel: string, payload: Record<string, unknown>): void => host()?.send(channel, { webContentsId: contents.id, ...payload })

  // window.open and target=_blank: a tab beside this one, not a bare window.
  contents.setWindowOpenHandler(({ url, disposition }) => {
    const protocol = safeProtocol(url)
    if (protocol === 'http:' || protocol === 'https:') tell('in-app-browser:open', { url, background: disposition === 'background-tab' })
    else if (protocol === 'mailto:') void shell.openExternal(url)
    return { action: 'deny' }
  })

  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const key = { key: input.key, meta: input.meta, ctrl: input.control, alt: input.alt, shift: input.shift }
    const shortcuts = store.getSettings().shortcuts
    let action: BrowserKeyAction | null = null
    if (matchesBinding(shortcuts['annotate-page-element'] === undefined ? ANNOTATE_SHORTCUT : shortcuts['annotate-page-element'], key, isMac)) action = 'annotate'
    else if (matchesBinding(shortcuts['focus-browser-address-bar'], key, isMac)) action = 'focus-address'
    else action = browserKey(key, isMac)
    if (!action) return
    // Kept from the page and from the app's menu (⌘R would reload Eaon itself).
    event.preventDefault()
    tell('in-app-browser:key', { action })
  })

  contents.on('context-menu', (_event, params) => {
    const template: Electron.MenuItemConstructorOptions[] = []
    if (params.linkURL) {
      template.push(
        { label: 'Open Link in New Tab', click: () => tell('in-app-browser:open', { url: params.linkURL, background: false }) },
        { label: 'Open Link in Default Browser', click: () => void shell.openExternal(params.linkURL) },
        { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' }
      )
    }
    if (params.isEditable) {
      template.push(
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { role: 'selectAll' },
        { type: 'separator' }
      )
    } else if (params.selectionText) {
      template.push({ role: 'copy' }, { type: 'separator' })
    }
    if (!params.linkURL && !params.isEditable && !params.selectionText) {
      template.push(
        { label: 'Back', enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() },
        { label: 'Forward', enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() },
        { label: 'Reload', click: () => contents.reload() },
        { type: 'separator' }
      )
    }
    template.push(
      { label: 'Annotate Element', click: () => tell('in-app-browser:annotate-at', { x: params.x, y: params.y }) },
      { label: 'Inspect Element', click: () => contents.inspectElement(params.x, params.y) }
    )
    const owner = host()
    const window = owner ? BrowserWindow.fromWebContents(owner) : null
    Menu.buildFromTemplate(template).popup(window ? { window } : {})
  })
}

function safeProtocol(url: string): string | null {
  try {
    return new URL(url).protocol
  } catch {
    return null
  }
}
