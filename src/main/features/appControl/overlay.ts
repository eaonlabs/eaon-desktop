import { BrowserWindow, screen } from 'electron'

/**
 * The outline that shows the user what an agent just acted on: a ring around
 * the element and a label, drawn for a moment in a see-through window that
 * takes no clicks and no focus. Presentation only; nothing an agent does
 * depends on it, and it is never in the accessibility tree agents read
 * (Eaon is off limits to app control).
 */

let window: BrowserWindow | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null
let onDisplay: number | null = null

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; font: 600 12px -apple-system, "Segoe UI", system-ui, sans-serif; }
  #ring { position: absolute; border: 2px solid #5b8cff; border-radius: 6px; box-shadow: 0 0 0 4px rgba(91, 140, 255, .22), 0 0 18px rgba(91, 140, 255, .45); opacity: 0; transition: opacity .18s ease; pointer-events: none; }
  #label { position: absolute; max-width: 360px; padding: 4px 8px; border-radius: 6px; background: rgba(18, 22, 34, .92); color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: 0; transition: opacity .18s ease; pointer-events: none; }
  .on { opacity: 1 !important; }
  @media (prefers-reduced-motion: reduce) { #ring, #label { transition: none; } }
</style></head><body><div id="ring"></div><div id="label"></div><script>
  window.show = (x, y, w, h, text) => {
    const ring = document.getElementById('ring'), label = document.getElementById('label')
    const pad = 4
    Object.assign(ring.style, { left: (x - pad) + 'px', top: (y - pad) + 'px', width: (w + pad * 2) + 'px', height: (h + pad * 2) + 'px' })
    label.textContent = text
    const below = y + h + pad + 8
    Object.assign(label.style, { left: Math.max(4, x - pad) + 'px', top: (below + 24 < innerHeight ? below : Math.max(4, y - pad - 30)) + 'px' })
    ring.classList.add('on'); label.classList.add('on')
  }
  window.hide = () => { document.getElementById('ring').classList.remove('on'); document.getElementById('label').classList.remove('on') }
</script></body></html>`

function overlayFor(displayId: number, bounds: Electron.Rectangle): BrowserWindow {
  if (window && !window.isDestroyed() && onDisplay === displayId) return window
  window?.destroy()
  window = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    // Off the accessibility tree and out of screenshots of Eaon's own windows.
    type: process.platform === 'darwin' ? 'panel' : 'toolbar',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true }
  })
  window.setIgnoreMouseEvents(true)
  window.setAlwaysOnTop(true, 'screen-saver')
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  window.setContentProtection(true)
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`)
  onDisplay = displayId
  return window
}

/** Outlines `bounds` (screen points) with `label` for about a second and a half. */
export function flashOverlay(bounds: [number, number, number, number], label: string): void {
  const [x, y, w, h] = bounds
  if (!(w > 0 && h > 0)) return
  const display = screen.getDisplayMatching({ x: Math.round(x), y: Math.round(y), width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) })
  const win = overlayFor(display.id, display.bounds)
  const local = [x - display.bounds.x, y - display.bounds.y, w, h].map((n) => Math.round(n))
  const run = (): void => {
    if (win.isDestroyed()) return
    win.showInactive()
    void win.webContents.executeJavaScript(`window.show(${local.join(',')}, ${JSON.stringify(label)})`).catch(() => undefined)
  }
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', run)
  else run()
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    if (!win.isDestroyed()) {
      void win.webContents.executeJavaScript('window.hide()').catch(() => undefined)
      setTimeout(() => {
        if (!win.isDestroyed()) win.hide()
      }, 220)
    }
  }, 1500)
}

export function disposeOverlay(): void {
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = null
  window?.destroy()
  window = null
  onDisplay = null
}
