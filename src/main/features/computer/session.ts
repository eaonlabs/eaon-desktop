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
let onStopped: (() => void) | null = null

export function configureSession(options: { getWindow: () => BrowserWindow | null; onStopped?: () => void }): void {
  getMain = options.getWindow
  onStopped = options.onStopped ?? null
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

const INDICATOR_W = 440
const INDICATOR_H = 46

function indicatorHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Eaon</title><style>
:root { color-scheme: dark; --pill: rgba(28, 28, 30, 0.94); --text: #f5f5f7; --muted: rgba(245, 245, 247, 0.6);
  --danger: #ff453a; --danger-soft: rgba(255, 69, 58, 0.2); --danger-hover: rgba(255, 69, 58, 0.32); --border: rgba(255, 255, 255, 0.14); }
html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; -webkit-user-select: none; cursor: default;
  font: 500 12.5px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }
body { display: flex; align-items: center; justify-content: center; }
.pill { display: flex; align-items: center; gap: 10px; height: 32px; padding: 0 4px 0 12px; border-radius: 999px;
  background: var(--pill); border: 0.5px solid var(--border); color: var(--text); white-space: nowrap;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.32); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--danger); animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
.hint { color: var(--muted); }
a { display: inline-flex; align-items: center; height: 24px; padding: 0 11px; border-radius: 999px; background: var(--danger-soft);
  color: #ff6961; font-weight: 600; text-decoration: none; }
a:hover { background: var(--danger-hover); }
</style></head><body><div class="pill" role="status"><span class="dot"></span><span>Eaon is using your computer</span>
<span class="hint">${STOP_LABEL} to stop</span><a href="https://eaon.invalid/stop">Stop</a></div></body></html>`
}

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
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.showInactive()
  })
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(indicatorHtml())}`)
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
  const main = getMain()
  const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isVisible() && !w.webContents.isOffscreen())
  // Mouse pass-through only on windows we own the state of; another
  // feature's window may be deliberately click-through already.
  const saved = windows.map((w) => ({ w, opacity: w.getOpacity(), passThrough: w === main || w === indicator }))
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
