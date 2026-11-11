import { BrowserWindow, globalShortcut, screen } from 'electron'
import { cancelRun, isRunning } from '../../agent/loop'

/**
 * Everything that exists only while an agent is driving the computer: the
 * always-on-top "Eaon is using your computer" pill, the emergency-stop
 * shortcut, and getting Eaon's own windows out of the agent's way.
 *
 * A session starts with the first computer action of a turn and ends when
 * that turn stops running — the loop has no end-of-turn hook, so this polls
 * `isRunning`, which is cheap and catches every way a turn can end.
 */

const isMac = process.platform === 'darwin'
export const STOP_ACCELERATOR = isMac ? 'Control+Alt+Command+.' : 'Control+Alt+Shift+.'
export const STOP_LABEL = isMac ? '⌃⌥⌘.' : 'Ctrl+Alt+Shift+.'

const driving = new Set<string>()
let indicator: BrowserWindow | null = null
let poll: ReturnType<typeof setInterval> | null = null
let shortcutHeld = false
let getMain: () => BrowserWindow | null = () => null
/** Every Eaon window; there can be several. */
let getAppWindows: () => BrowserWindow[] = () => {
  const main = getMain()
  return main ? [main] : []
}
let onStopped: (() => void) | null = null
let onTakeBack: (() => void) | null = null
/** Who holds the computer, for the pill; null while runs only look at the screen. */
let controlling: { name: string; waiting: number } | null = null

export function configureSession(options: {
  getWindow: () => BrowserWindow | null
  getWindows?: () => BrowserWindow[]
  onStopped?: () => void
  /** The pill's "Take back control": the user wants the computer for themselves. */
  onTakeBack?: () => void
}): void {
  getMain = options.getWindow
  if (options.getWindows) getAppWindows = options.getWindows
  onStopped = options.onStopped ?? null
  onTakeBack = options.onTakeBack ?? null
}

/**
 * Names who is controlling the computer on the always-on-top pill — seeing
 * the screen and controlling it are different things, and the pill says
 * which. Null means nobody holds the pointer (a run is only looking).
 */
export function setIndicatorOwner(next: { name: string; waiting: number } | null): void {
  if (controlling?.name === next?.name && controlling?.waiting === next?.waiting) return
  controlling = next
  if (indicator && !indicator.isDestroyed()) void indicator.loadURL(indicatorUrl())
}

export function isDriving(): boolean {
  return driving.size > 0
}

export function beginDriving(messageId: string, signal: AbortSignal): void {
  if (driving.has(messageId)) return
  driving.add(messageId)
  signal.addEventListener('abort', () => endDriving(messageId), { once: true })
  if (driving.size > 1) return
  shortcutHeld = globalShortcut.register(STOP_ACCELERATOR, stopAll)
  if (!shortcutHeld) console.warn(`[computer] ${STOP_ACCELERATOR} is taken by another app; stop from the indicator instead.`)
  showIndicator()
  poll = setInterval(() => {
    for (const id of driving) if (!isRunning(id)) endDriving(id)
  }, 500)
}

export function endDriving(messageId: string): void {
  if (!driving.delete(messageId) || driving.size > 0) return
  if (poll) clearInterval(poll)
  poll = null
  if (shortcutHeld) globalShortcut.unregister(STOP_ACCELERATOR)
  shortcutHeld = false
  if (indicator && !indicator.isDestroyed()) indicator.destroy()
  indicator = null
}

/** Emergency stop: cancels every turn that is driving and brings Eaon back into view. */
export function stopAll(): void {
  for (const id of [...driving]) {
    cancelRun(id)
    endDriving(id)
  }
  const main = getMain()
  if (main && !main.isDestroyed()) main.showInactive()
  onStopped?.()
}

export function disposeSession(): void {
  for (const id of [...driving]) endDriving(id)
}

/* -------------------------------------------------------------- indicator */

const INDICATOR_W = 600
const INDICATOR_H = 46

const escapeHtml = (text: string): string => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/** The stop shortcut as separate keys: `⌃⌥⌘.` on a Mac, `Ctrl+Alt+Shift+.` elsewhere. */
const stopKeys = (): string[] => (isMac ? [...STOP_LABEL] : STOP_LABEL.split('+'))

const EYE =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="2.8" fill="currentColor" stroke="none"/></svg>'

function indicatorHtml(): string {
  const text = controlling
    ? `${escapeHtml(controlling.name)} is using your computer${controlling.waiting > 0 ? ` <span class="hint">· ${controlling.waiting} waiting</span>` : ''}`
    : 'Eaon is looking at your screen'
  const takeBack = controlling ? '<a class="quiet" href="https://eaon.invalid/take-back">Take back</a>' : ''
  const keys = stopKeys()
    .map((key) => `<kbd>${escapeHtml(key)}</kbd>`)
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>Eaon</title><style>
:root { color-scheme: dark; --text: #f5f5f7; --muted: rgba(245, 245, 247, 0.55); --accent: #ff6b5f; --accent-soft: rgba(255, 107, 95, 0.16); }
html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; -webkit-user-select: none; cursor: default;
  font: 500 12.5px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }
body { display: flex; align-items: center; justify-content: center; }
.pill { display: flex; align-items: center; gap: 12px; height: 34px; padding: 0 5px 0 5px; border-radius: 999px; white-space: nowrap; color: var(--text);
  background: linear-gradient(180deg, rgba(44, 44, 48, 0.96), rgba(24, 24, 27, 0.96));
  box-shadow: 0 0 0 0.5px rgba(255, 255, 255, 0.16), inset 0 0.5px 0 rgba(255, 255, 255, 0.12), 0 8px 24px rgba(0, 0, 0, 0.38); }
.live { position: relative; display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; color: var(--accent); background: var(--accent-soft); }
.live::after { content: ''; position: absolute; inset: 0; border-radius: 50%; box-shadow: 0 0 0 1px var(--accent); opacity: 0; animation: ping 2.2s ease-out infinite; }
@keyframes ping { 0% { transform: scale(1); opacity: 0.55; } 100% { transform: scale(1.7); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .live::after { animation: none; } }
.label { letter-spacing: 0.005em; }
.hint { color: var(--muted); }
.keys { display: inline-flex; align-items: center; gap: 3px; color: var(--muted); }
kbd { display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 5px; box-sizing: border-box; border-radius: 5px;
  font: 600 11px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; color: rgba(245, 245, 247, 0.78);
  background: rgba(255, 255, 255, 0.08); box-shadow: inset 0 -1px 0 rgba(255, 255, 255, 0.08); }
a { display: inline-flex; align-items: center; height: 26px; padding: 0 13px; border-radius: 999px; background: var(--accent-soft);
  color: var(--accent); font-weight: 600; text-decoration: none; }
a:hover { background: rgba(255, 107, 95, 0.28); }
a.quiet { background: rgba(255, 255, 255, 0.1); color: var(--text); }
a.quiet:hover { background: rgba(255, 255, 255, 0.18); }
</style></head><body><div class="pill" role="status"><span class="live">${EYE}</span><span class="label">${text}</span>
<span class="keys" title="Stop shortcut">${keys}</span>${takeBack}<a href="https://eaon.invalid/stop">Stop</a></div></body></html>`
}

const indicatorUrl = (): string => `data:text/html;charset=utf-8,${encodeURIComponent(indicatorHtml())}`

function showIndicator(): void {
  if (indicator && !indicator.isDestroyed()) return
  const area = screen.getPrimaryDisplay().workArea
  const win = new BrowserWindow({
    width: INDICATOR_W,
    height: INDICATOR_H,
    x: Math.round(area.x + (area.width - INDICATOR_W) / 2),
    y: area.y + 6,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    // Never takes keyboard focus: keystrokes the agent sends must reach the
    // app it is working in, not this pill.
    focusable: false,
    acceptFirstMouse: true,
    alwaysOnTop: true,
    show: false,
    // Static HTML and one link; nothing here needs script.
    webPreferences: { sandbox: true, contextIsolation: true, javascript: false }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    if (url.endsWith('/stop')) stopAll()
    else if (url.endsWith('/take-back')) onTakeBack?.()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.showInactive()
  })
  void win.loadURL(indicatorUrl())
  indicator = win
}

/* ------------------------------------------------------------- step aside */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Runs `fn` with Eaon's own windows invisible and click-through.
 *
 * Eaon's window is usually on screen while the agent works, and it would
 * otherwise be in every screenshot (a transcript of screenshots of itself)
 * and in the way of clicks aimed at the app behind it. Hiding it for the
 * whole turn would move focus and bury the approval prompts; content
 * protection would also blank Eaon in the user's own screen shares and does
 * nothing about clicks. Zero opacity plus ignoring the mouse for the length of
 * one action avoids all three: the agent sees and clicks the screen as if Eaon
 * were not there, and the user gets their window back the moment the action
 * is done — a brief blink per step.
 *
 * Calls that overlap (Settings → Test while an agent action runs) share one
 * hide, undone when the last of them ends. Hiding separately, the second would
 * save the first's zero opacity as the one to restore and leave Eaon invisible.
 */
let hide: { saved: { w: BrowserWindow; opacity: number; passThrough: boolean }[]; settled: Promise<void> } | null = null
let hideDepth = 0

function hideWindows(): NonNullable<typeof hide> {
  const own = new Set(getAppWindows())
  const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isVisible() && !w.webContents.isOffscreen())
  // Mouse pass-through only on windows we own the state of; another
  // feature's window may be deliberately click-through already.
  const saved = windows.map((w) => ({ w, opacity: w.getOpacity(), passThrough: own.has(w) || w === indicator }))
  for (const { w, passThrough } of saved) {
    w.setOpacity(0)
    if (passThrough) w.setIgnoreMouseEvents(true)
  }
  // Give the window server a frame or two to composite the change.
  return { saved, settled: saved.length > 0 ? sleep(90) : Promise.resolve() }
}

export async function withEaonHidden<T>(fn: () => Promise<T>): Promise<T> {
  const current = (hide ??= hideWindows())
  hideDepth++
  try {
    await current.settled
    return await fn()
  } finally {
    if (--hideDepth === 0) {
      hide = null
      for (const { w, opacity, passThrough } of current.saved) {
        if (w.isDestroyed()) continue
        if (passThrough) w.setIgnoreMouseEvents(false)
        w.setOpacity(opacity)
      }
    }
  }
}

/** True when one of Eaon's windows has keyboard focus. */
export function eaonHasFocus(): boolean {
  return BrowserWindow.getFocusedWindow() !== null
}

/**
 * Orders Eaon's window above other apps without activating it, so an
 * approval prompt is visible while the app the agent is using keeps focus.
 * A minimised window stays minimised — the user put it away on purpose.
 */
export function bringEaonForward(): void {
  const main = getMain()
  if (!main || main.isDestroyed() || main.isMinimized() || main.isFocused()) return
  main.showInactive()
}
