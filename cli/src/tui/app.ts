import type { BusNode } from '../bus/bus'
import type { ChatController } from '../core/chat'
import type { EngineRole } from '../runtime/engines'
import { startInput, type InputEvent } from './input'
import type { Modal } from './modals'
import type { UpdateStatus } from './update'
import { Canvas, Screen, type Output } from './screen'
import { strWidth, truncate, type Style } from './term'
import { C, S } from './theme'
import { clock, keyHints, SCANNER_FRAME_MS } from './widgets'
import { copyToClipboard } from './clipboard'

/**
 * The full-screen app: a tab bar across the top (Chat, Workers, Trading),
 * the current view, a status bar along the bottom, and dialogs and toasts
 * over all of it.
 *
 * Keys go to the top dialog if there is one, then to the app's own keys
 * (F1–F3 or ⌥1–⌥3 switch tabs, ⌃T cycles them, ⌃C stops or quits), then to
 * the view. A view that has a text field focused says so (`typing`), and
 * then single-letter shortcuts are left to the field.
 */

/** `claude` (Claude Code, opened with /claude) is a screen of its own, not one of the tabs. */
export type Mode = 'chat' | 'workers' | 'trading' | 'claude'
export const MODES: { id: Mode; label: string; key: string }[] = [
  { id: 'chat', label: 'CHAT', key: 'F1' },
  { id: 'workers', label: 'WORKERS', key: 'F2' },
  { id: 'trading', label: 'TRADING', key: 'F3' }
]

export interface StatusSegment {
  text: string
  style?: Style
}

export interface View {
  draw(c: Canvas): void
  /** True when the view used the event. */
  onEvent(event: InputEvent): boolean
  status?(): StatusSegment[]
  hints?(): [string, string][]
  /** A text field has focus: letters type rather than act. */
  typing?(): boolean
  enter?(): void
  leave?(): void
  /** True while something on screen moves (a spinner), so the app redraws ~10 times a second. */
  animating?(): boolean
}

export interface AppDeps {
  chat: ChatController
  bus: BusNode | null
  role: () => EngineRole | null
  /** Where frames go; the terminal unless a test says otherwise. */
  output?: Output
}

interface Toast {
  text: string
  kind: 'info' | 'error' | 'success'
  until: number
}

export class App {
  readonly screen: Screen
  mode: Mode = 'chat'
  views = {} as Record<Mode, View>
  private modals: Modal[] = []
  private toasts: Toast[] = []
  private renderTimer: ReturnType<typeof setTimeout> | null = null
  private tick: ReturnType<typeof setInterval> | null = null
  private stopInput: (() => void) | null = null
  private quitArmedAt = 0
  /** Where each tab sits on the top row, for clicks. */
  private tabSpans: { mode: Mode; from: number; to: number }[] = []
  private peersAt = 0
  private peerCount = 0
  private exited!: () => void
  readonly done = new Promise<void>((resolve) => (this.exited = resolve))
  /** Wheel scrolling and clicks. On by default; the app selects and copies text itself, since the terminal can't while it reports the mouse. */
  mouse = true
  /** Text being selected with the mouse, in screen cells; kept a moment after copying so you see what was copied. */
  private selection: { from: { x: number; y: number }; to: { x: number; y: number }; dragging: boolean; until?: number } | null = null
  /** Draw only when asked (`--snapshot`): nothing is written to the terminal. */
  headless = false
  /** Runs before the app quits (stops engines, closes the bus). */
  onQuit: (() => Promise<void>) | null = null
  /** A newer version on npm, once the background check finds one (tui/update.ts). */
  update: UpdateStatus | null = null
  /** When a key was last pressed, so popups wait until the user pauses. */
  lastInputAt = 0

  /** Puts copied text on the clipboard; replaceable in tests. */
  copy: (text: string) => void = (text) => void copyToClipboard(text)

  constructor(readonly deps: AppDeps) {
    this.screen = new Screen(deps.output)
  }

  get view(): View {
    return this.views[this.mode]
  }

  start(mode: Mode = 'chat'): void {
    this.mode = mode
    this.screen.start()
    if (this.mouse) this.screen.enableMouse(true)
    this.stopInput = startInput((event) => this.handle(event))
    process.stdout.on('resize', this.onResize)
    // A clock in the corner and the animations: a second normally, every scanner step while something moves.
    let last = 0
    this.tick = setInterval(() => {
      const now = Date.now()
      const animating = this.views[this.mode]?.animating?.() || this.modals.length > 0
      if (animating || now - last >= 1000) {
        last = now
        this.invalidate()
      }
    }, SCANNER_FRAME_MS)
    this.view.enter?.()
    this.render()
  }

  private onResize = (): void => {
    this.screen.invalidate()
    this.render()
  }

  setMouse(on: boolean): void {
    this.mouse = on
    this.screen.enableMouse(on)
  }

  /** Leaves the full screen for a moment (an external editor, a password prompt from the OS), then comes back. */
  async suspend<T>(work: () => Promise<T>): Promise<T> {
    this.stopInput?.()
    this.screen.stop()
    try {
      return await work()
    } finally {
      this.screen.start()
      if (this.mouse) this.screen.enableMouse(true)
      this.stopInput = startInput((event) => this.handle(event))
      this.screen.invalidate()
      this.render()
    }
  }

  async quit(): Promise<void> {
    if (this.tick) clearInterval(this.tick)
    this.tick = null
    process.stdout.off('resize', this.onResize)
    this.stopInput?.()
    this.screen.stop()
    try {
      await this.onQuit?.()
    } finally {
      this.exited()
    }
  }

  /** The tab before the current screen, for screens like Claude Code that Esc leaves. */
  previousMode: Mode = 'chat'

  switchMode(mode: Mode): void {
    if (mode === this.mode) return
    this.view.leave?.()
    this.previousMode = this.mode
    this.mode = mode
    this.view.enter?.()
    this.deps.bus?.update({ mode })
    this.invalidate()
  }

  push(modal: Modal): void {
    modal.close = () => this.pop(modal)
    this.modals.push(modal)
    this.invalidate()
  }

  pop(modal?: Modal): void {
    if (modal) this.modals = this.modals.filter((m) => m !== modal)
    else this.modals.pop()
    this.invalidate()
  }

  hasModal(): boolean {
    return this.modals.length > 0
  }

  toast(text: string, kind: Toast['kind'] = 'info', ms = 4500): void {
    this.toasts = [...this.toasts.filter((t) => t.text !== text), { text, kind, until: Date.now() + ms }].slice(-3)
    this.invalidate()
  }

  invalidate(): void {
    if (this.renderTimer || this.headless) return
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null
      this.render()
    }, 8)
  }

  render(): void {
    if (this.headless) return
    this.screen.render((c) => this.draw(c))
  }

  /** Draws everything into `c`: used by the live screen and by `--snapshot`. */
  draw(c: Canvas): void {
    const now = Date.now()
    this.drawTabs(c.sub(0, 0, c.w, 1))
    this.view.draw(c.sub(0, 1, c.w, c.h - 2))
    this.drawStatus(c.sub(0, c.h - 1, c.w, 1))
    // An agent waiting on an approval is only asked in Chat; from any other tab, say so.
    const waiting = this.deps.chat.approvals
    if (waiting.length && this.mode !== 'chat' && !(this.view.typing?.() && this.mode === 'trading')) {
      const text = ` ⚠ An agent is waiting for your approval (${waiting.length}) — F1 to answer `
      c.fill(0, c.h - 2, c.w, 1, { fg: C.ink, bg: C.yellow })
      c.text(1, c.h - 2, text, { fg: C.ink, bg: C.yellow, bold: true })
    }
    for (const modal of this.modals) modal.draw(c)
    this.drawSelection(c, now)
    this.toasts = this.toasts.filter((t) => t.until > now)
    this.toasts.forEach((toast, i) => {
      const text = ` ${toast.text} `
      const width = Math.min(c.w - 4, strWidth(text) + 2)
      const style: Style =
        toast.kind === 'error' ? { fg: '#FFFFFF', bg: '#7A1F1A' } : toast.kind === 'success' ? { fg: C.ink, bg: C.green } : { fg: C.ink, bg: C.amberDeep }
      const y = c.h - 2 - (this.toasts.length - i)
      c.fill(c.w - width - 1, y, width, 1, style)
      c.text(c.w - width, y, truncate(text, width - 1), style)
    })
  }

  private drawSelection(c: Canvas, now: number): void {
    const sel = this.selection
    if (!sel || (sel.from.x === sel.to.x && sel.from.y === sel.to.y)) return
    if (sel.until && sel.until < now) {
      this.selection = null
      return
    }
    const [from, to] = sel.from.y < sel.to.y || (sel.from.y === sel.to.y && sel.from.x <= sel.to.x) ? [sel.from, sel.to] : [sel.to, sel.from]
    for (let y = from.y; y <= to.y; y++) {
      const start = y === from.y ? from.x : 0
      const end = y === to.y ? to.x : c.w - 1
      c.paint(start, y, end - start + 1, { bg: '#264F78', fg: '#FFFFFF' })
    }
  }

  /**
   * Mouse selection: press and drag over any text to select it, release to
   * copy it. A press without a drag is an ordinary click for the screen.
   */
  private select(event: InputEvent): boolean {
    if (event.type !== 'mouse' || event.button !== 0) return false
    const at = { x: event.x, y: event.y }
    if (event.action === 'down') {
      this.selection = { from: at, to: at, dragging: true }
      return false
    }
    const sel = this.selection
    if (!sel?.dragging) return false
    if (event.action === 'drag') {
      sel.to = at
      this.invalidate()
      return true
    }
    if (event.action === 'up') {
      sel.dragging = false
      if (sel.from.x === sel.to.x && sel.from.y === sel.to.y) {
        this.selection = null
        return false
      }
      const text = this.screen.textBetween(sel.from, sel.to)
      if (text.trim()) {
        this.copy(text)
        this.toast(`Copied ${text.length.toLocaleString()} character${text.length === 1 ? '' : 's'}`, 'success', 2000)
      }
      sel.until = Date.now() + 1200
      this.invalidate()
      return true
    }
    return false
  }

  private drawTabs(c: Canvas): void {
    c.fill(0, 0, c.w, 1, { bg: '#0E0E10' })
    let x = 0
    x += c.text(x, 0, ' ◆ EAON ', { fg: C.ink, bg: C.amber, bold: true })
    x += c.text(x, 0, ' BETA ', { fg: C.amber, bg: '#2A2112', bold: true })
    x += 1
    this.tabSpans = []
    for (const mode of MODES) {
      const active = mode.id === this.mode
      const label = ` ${mode.label} `
      const start = x
      x += c.text(x, 0, label, active ? S.tabActive : { fg: C.muted, bg: '#0E0E10' })
      this.tabSpans.push({ mode: mode.id, from: start, to: x })
      x += 1
    }
    x += c.text(x + 1, 0, '⇥ switch', { fg: C.faint, bg: '#0E0E10' }) + 1
    const bus = this.deps.bus
    // The bus is a folder of files; reading it at 10 frames a second is wasted work.
    const now = Date.now()
    if (bus && now - this.peersAt > 2000) {
      this.peersAt = now
      this.peerCount = bus.peers().length
    }
    const peers = { length: this.peerCount }
    const role = this.deps.role()
    const right: { text: string; style: Style }[] = []
    const bg = '#0E0E10'
    if (bus) {
      right.push({ text: bus.self.name, style: { fg: C.cyan, bg } })
      if (role) right.push({ text: role === 'owner' ? ' ◆ engines' : ' ⇄ attached', style: { fg: role === 'owner' ? C.amber : C.muted, bg } })
      right.push({ text: `  ${peers.length} other session${peers.length === 1 ? '' : 's'}`, style: { fg: peers.length ? C.text : C.faint, bg } })
    }
    if (this.update)
      right.push(
        this.update.installed
          ? { text: '  ✓ restart for the update', style: { fg: C.green, bg } }
          : { text: `  ⬆ ${this.update.offer.latest} · /update`, style: { fg: C.amber, bg, bold: true } }
      )
    right.push({ text: `  ${clock()} `, style: { fg: C.text, bg, bold: true } })
    const width = right.reduce((sum, s) => sum + strWidth(s.text), 0)
    if (x + width + 2 <= c.w) c.segments(c.w - width, 0, right)
  }

  private drawStatus(c: Canvas): void {
    c.fill(0, 0, c.w, 1, S.panelBar)
    const status = this.view.status?.() ?? []
    const statusWidth = status.reduce((sum, s) => sum + strWidth(s.text), 0)
    // The view's own hints give way first when the line is short.
    const hints: [string, string][] = [...(this.view.hints?.() ?? []), ['?', 'help'], ['⌃C', 'quit']]
    const widthOf = (list: [string, string][]): number => list.reduce((sum, [k, l], i) => sum + strWidth(k) + 1 + strWidth(l) + (i ? 3 : 0), 0)
    while (hints.length > 2 && widthOf(hints) > c.w - Math.min(statusWidth, Math.floor(c.w * 0.55)) - 4) hints.shift()
    const hintWidth = widthOf(hints)
    const room = Math.max(0, c.w - hintWidth - 3)
    c.segments(1, 0, status.map((s) => ({ text: s.text, style: { ...(s.style ?? S.muted), bg: C.panelBar } })), room - 1)
    if (hintWidth < c.w - 10) keyHints(c, c.w - hintWidth - 1, 0, hints, hintWidth, C.panelBar)
  }

  handle(event: InputEvent): void {
    if (event.type === 'key' || event.type === 'paste') this.lastInputAt = Date.now()
    try {
      this.dispatch(event)
    } catch (error) {
      this.toast(error instanceof Error ? error.message : String(error), 'error')
    }
    this.invalidate()
  }

  private dispatch(event: InputEvent): void {
    if (this.select(event)) return
    const top = this.modals[this.modals.length - 1]
    if (event.type === 'key' && event.ctrl && event.name === 'c' && !top) {
      if (this.view.onEvent(event)) return
      if (Date.now() - this.quitArmedAt < 2000) {
        void this.quit()
        return
      }
      this.quitArmedAt = Date.now()
      this.toast('Press Ctrl+C again to quit')
      return
    }
    if (top) {
      if (event.type === 'key' && event.ctrl && event.name === 'c') return this.pop(top)
      top.onEvent(event)
      return
    }
    if (event.type === 'key') {
      const index = ['f1', 'f2', 'f3'].indexOf(event.name)
      if (index !== -1) return this.switchMode(MODES[index].id)
      if (event.meta && ['1', '2', '3'].includes(event.name)) return this.switchMode(MODES[Number(event.name) - 1].id)
      if (event.ctrl && event.name === 't') {
        const at = MODES.findIndex((m) => m.id === this.mode)
        return this.switchMode(MODES[(at + 1) % MODES.length].id)
      }
      if (event.ctrl && event.name === 'l') {
        this.screen.invalidate()
        return
      }
    }
    // A click on a tab (with the mouse on).
    if (event.type === 'mouse' && event.action === 'down' && event.y === 0) {
      const span = this.tabSpans.find((t) => event.x >= t.from && event.x < t.to)
      if (span) return this.switchMode(span.mode)
    }
    if (this.view.onEvent(event)) return
    // Tab moves to the next tab whenever the screen didn't use it (a completion menu does).
    if (event.type === 'key' && event.name === 'tab' && !event.ctrl && !event.meta) {
      const at = MODES.findIndex((m) => m.id === this.mode)
      return this.switchMode(MODES[(at + (event.shift ? MODES.length - 1 : 1)) % MODES.length].id)
    }
    if (event.type === 'key' && event.ch === '?' && !this.view.typing?.()) this.showHelp?.()
  }

  /** Set by the TUI's startup: opens the help page. */
  showHelp: (() => void) | null = null
}
