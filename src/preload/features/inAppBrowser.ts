import { ipcRenderer } from 'electron'
import type { BrowserKeyAction } from '@shared/browser'

function on<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

/**
 * Renderer bridge for the in-app browser's pages (main/features/inAppBrowser.ts).
 * Exposed as `window.api.inAppBrowser`. Every event names the page by its
 * `<webview>`'s webContentsId.
 */
export const inAppBrowserApi = {
  /** Crops a page to an element (CSS pixels of its viewport) and saves it as a PNG. */
  capture: (request: {
    webContentsId: number
    rect: { x: number; y: number; width: number; height: number }
    viewport: { width: number; height: number }
  }): Promise<{ path: string; thumbnail: string } | null> => ipcRenderer.invoke('in-app-browser:capture', request),
  toggleDevTools: (webContentsId: number): Promise<void> => ipcRenderer.invoke('in-app-browser:devtools', webContentsId),
  /** A page asked for a new window, or "Open Link in New Tab". */
  onOpen: (handler: (event: { webContentsId: number; url: string; background: boolean }) => void): (() => void) => on('in-app-browser:open', handler),
  /** One of the browser's shortcuts, pressed while a page had the keyboard. */
  onKey: (handler: (event: { webContentsId: number; action: BrowserKeyAction }) => void): (() => void) => on('in-app-browser:key', handler),
  /** "Annotate Element" from a page's right-click menu, at that point in the page. */
  onAnnotateAt: (handler: (event: { webContentsId: number; x: number; y: number }) => void): (() => void) => on('in-app-browser:annotate-at', handler)
}
