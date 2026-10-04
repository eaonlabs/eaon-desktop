import type { InputEvent, KeyEvent } from './input'
import type { Canvas } from './screen'
import { charWidth, padEnd, padStart, strWidth, truncate, type Style } from './term'
import { C, mix, S } from './theme'

/* ============================================================ text field */

export type FieldResult = 'submit' | 'changed' | 'cancel' | 'ignored' | 'moved'

/**
 * An editable line (or several): the composer, prompts, form fields.
 * Emacs-style keys work as in a shell (⌃A ⌃E ⌃U ⌃K ⌃W, ⌥←/⌥→ by word).
 * Enter submits; ⇧Enter, ⌥Enter or ⌃J add a line where the terminal can
 * tell them apart. Text is kept as code points so the cursor never lands
 * inside a surrogate pair.
 */
export class TextField {
  private chars: string[] = []
  cursor = 0
  history: string[] = []
  private historyIndex = -1
  private draft = ''
  /** The first visual row shown, for fields taller than their box. */
  private scroll = 0

  constructor(
    public options: { placeholder?: string; multiline?: boolean; mask?: boolean; maxLength?: number } = {}
  ) {}

  get value(): string {
    return this.chars.join('')
  }

  set value(text: string) {
    this.chars = Array.from(text)
    this.cursor = this.chars.length
  }

  clear(): void {
    this.chars = []
    this.cursor = 0
    this.historyIndex = -1
  }

  insert(text: string): void {
    let clean = text.replace(/\r\n?/g, '\n').replace(/\t/g, '  ')
    if (!this.options.multiline) clean = clean.replace(/\n/g, ' ')
    const add = Array.from(clean).filter((ch) => ch === '\n' || ch.codePointAt(0)! >= 32)
    if (this.options.maxLength) add.splice(Math.max(0, this.options.maxLength - this.chars.length))
    this.chars.splice(this.cursor, 0, ...add)
    this.cursor += add.length
  }

  /** The word the cursor is at the end of (no spaces), and where it starts: for @-completion. */
  wordAtCursor(): { start: number; text: string } {
    let start = this.cursor
    while (start > 0 && !/\s/.test(this.chars[start - 1])) start--
    return { start, text: this.chars.slice(start, this.cursor).join('') }
  }

  /** Replaces the text from `start` to the cursor with `text`, leaving the cursor after it. */
  replaceBeforeCursor(start: number, text: string): void {
    const add = Array.from(text)
    this.chars.splice(start, this.cursor - start, ...add)
    this.cursor = start + add.length
  }

  remember(entry: string): void {
    if (entry.trim() && this.history[this.history.length - 1] !== entry) this.history.push(entry)
    if (this.history.length > 200) this.history.shift()
    this.historyIndex = -1
  }

  private wordLeft(): number {
    let i = this.cursor
    while (i > 0 && /\s/.test(this.chars[i - 1])) i--
    while (i > 0 && !/\s/.test(this.chars[i - 1])) i--
    return i
  }

  private wordRight(): number {
    let i = this.cursor
    while (i < this.chars.length && /\s/.test(this.chars[i])) i++
    while (i < this.chars.length && !/\s/.test(this.chars[i])) i++
    return i
  }

  private lineStart(): number {
    let i = this.cursor
    while (i > 0 && this.chars[i - 1] !== '\n') i--
    return i
  }

  private lineEnd(): number {
    let i = this.cursor
    while (i < this.chars.length && this.chars[i] !== '\n') i++
    return i
  }

  private browseHistory(step: -1 | 1): boolean {
    if (this.history.length === 0) return false
    if (this.historyIndex === -1) {
      if (step === 1) return false
      this.draft = this.value
      this.historyIndex = this.history.length - 1
    } else {
      this.historyIndex += step
      if (this.historyIndex >= this.history.length) {
        this.historyIndex = -1
        this.value = this.draft
        return true
      }
      if (this.historyIndex < 0) this.historyIndex = 0
    }
    this.value = this.history[this.historyIndex]
    return true
  }

  handle(event: InputEvent, width = 80): FieldResult {
    if (event.type === 'paste') {
      this.insert(event.text)
      return 'changed'
    }
    if (event.type !== 'key') return 'ignored'
    const e = event
    const n = this.chars.length
    if (e.name === 'enter') {
      if (this.options.multiline && (e.shift || e.meta)) {
        this.insert('\n')
        return 'changed'
      }
      // A line ending in a backslash continues, as in a shell.
      if (this.options.multiline && this.chars[this.cursor - 1] === '\\') {
        this.chars.splice(this.cursor - 1, 1, '\n')
        return 'changed'
      }
      return 'submit'
    }
    if (e.ctrl && e.name === 'j') {
      if (this.options.multiline) {
        this.insert('\n')
        return 'changed'
      }
      return 'submit'
    }
    if (e.name === 'escape') return 'cancel'
    if (e.name === 'backspace') {
      if (this.cursor === 0) return 'ignored'
      const from = e.meta || e.ctrl ? this.wordLeft() : this.cursor - 1
      this.chars.splice(from, this.cursor - from)
      this.cursor = from
      return 'changed'
    }
    if (e.name === 'delete' || (e.ctrl && e.name === 'd' && n > 0)) {
      if (this.cursor >= n) return 'ignored'
      this.chars.splice(this.cursor, 1)
      return 'changed'
    }
    if (e.ctrl && e.name === 'u') {
      const from = this.lineStart()
      this.chars.splice(from, this.cursor - from)
      this.cursor = from
      return 'changed'
    }
    if (e.ctrl && e.name === 'k') {
      this.chars.splice(this.cursor, this.lineEnd() - this.cursor)
      return 'changed'
    }
    if (e.ctrl && e.name === 'w') {
      const from = this.wordLeft()
      this.chars.splice(from, this.cursor - from)
      this.cursor = from
      return 'changed'
    }
    if (e.name === 'left') {
      this.cursor = e.meta || e.ctrl ? this.wordLeft() : Math.max(0, this.cursor - 1)
      return 'moved'
    }
    if (e.name === 'right') {
      this.cursor = e.meta || e.ctrl ? this.wordRight() : Math.min(n, this.cursor + 1)
      return 'moved'
    }
    if (e.name === 'home' || (e.ctrl && e.name === 'a')) {
      this.cursor = this.lineStart()
      return 'moved'
    }
    if (e.name === 'end' || (e.ctrl && e.name === 'e')) {
      this.cursor = this.lineEnd()
      return 'moved'
    }
    if (e.name === 'up' || e.name === 'down') {
      const rows = this.layout(width)
      const at = this.cursorRow(rows)
      const target = at.row + (e.name === 'up' ? -1 : 1)
      if (target < 0 || target >= rows.length) return this.browseHistory(e.name === 'up' ? -1 : 1) ? 'changed' : 'ignored'
      const row = rows[target]
      let col = 0
      let i = row.start
      while (i < row.end && col + charWidth(this.chars[i]) <= at.col) {
        col += charWidth(this.chars[i])
        i++
      }
      this.cursor = i
      return 'moved'
    }
    if (e.ch !== undefined && !e.ctrl && !e.meta) {
      this.insert(e.ch)
      return 'changed'
    }
    return 'ignored'
  }

  /** Visual rows at `width`: hard-wrapped, newline-split, as index ranges into the text. */
  layout(width: number): { start: number; end: number }[] {
    const rows: { start: number; end: number }[] = []
    let start = 0
    let col = 0
    for (let i = 0; i <= this.chars.length; i++) {
      const ch = this.chars[i]
      if (i === this.chars.length || ch === '\n') {
        rows.push({ start, end: i })
        start = i + 1
        col = 0
        continue
      }
      const w = this.options.mask ? 1 : charWidth(ch)
      if (col + w > width) {
        rows.push({ start, end: i })
        start = i
        col = 0
      }
      col += w
    }
    return rows
  }

  private cursorRow(rows: { start: number; end: number }[]): { row: number; col: number } {
    for (let r = rows.length - 1; r >= 0; r--) {
      if (this.cursor >= rows[r].start) {
        let col = 0
        for (let i = rows[r].start; i < this.cursor; i++) col += this.options.mask ? 1 : charWidth(this.chars[i])
        return { row: r, col }
      }
    }
    return { row: 0, col: 0 }
  }

  /** Rows this field needs at `width`, capped at `max`. */
  height(width: number, max = 8): number {
    return Math.max(1, Math.min(max, this.layout(Math.max(1, width - 1)).length))
  }

  /** Draws the field into `c` (its whole area). With `focused`, the terminal cursor goes to the caret. */
  draw(c: Canvas, style: Style = S.text, focused = true): void {
    const width = Math.max(1, c.w - 1)
    if (this.chars.length === 0) {
      if (this.options.placeholder) c.text(0, 0, this.options.placeholder, S.faint, c.w)
      if (focused) c.setCursor(0, 0)
      return
    }
    const rows = this.layout(width)
    const at = this.cursorRow(rows)
    if (at.row < this.scroll) this.scroll = at.row
    if (at.row >= this.scroll + c.h) this.scroll = at.row - c.h + 1
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, rows.length - c.h)))
    for (let r = 0; r < c.h && this.scroll + r < rows.length; r++) {
      const row = rows[this.scroll + r]
      const text = this.chars.slice(row.start, row.end).join('')
      c.text(0, r, this.options.mask ? '•'.repeat(row.end - row.start) : text, style)
    }
    if (focused) c.setCursor(at.col, at.row - this.scroll)
  }
}

/* ================================================================ panels */

/**
 * A panel as on a terminal desk: a box in the border colour with the title
 * on a dark bar across the top, the content inside. Returns the inside.
 */
export function panel(c: Canvas, title: string, options: { right?: { text: string; style?: Style }[]; focused?: boolean } = {}): Canvas {
  c.box(options.focused ? { fg: C.amber } : S.border)
  if (c.h < 3) return c.sub(1, 1, c.w - 2, Math.max(0, c.h - 2))
  c.fill(1, 1, c.w - 2, 1, S.panelBar)
  c.text(2, 1, title.toUpperCase(), S.panelTitle, c.w - 4)
  if (options.right) {
    const width = options.right.reduce((sum, s) => sum + strWidth(s.text), 0)
    c.segments(
      Math.max(2 + strWidth(title) + 2, c.w - 2 - width - 1),
      1,
      // A badge keeps its own background; plain text sits on the bar.
      options.right.map((s) => ({ text: s.text, style: { ...(s.style ?? S.muted), bg: s.style?.bg ?? C.panelBar } }))
    )
  }
  return c.sub(2, 2, c.w - 4, c.h - 3)
}

/** Key hints along a line: `key label · key label`. */
export function keyHints(c: Canvas, x: number, y: number, hints: [string, string][], width = c.w - x, bg?: string): number {
  const segments: { text: string; style: Style }[] = []
  hints.forEach(([k, label], i) => {
    if (i > 0) segments.push({ text: '   ', style: { ...S.faint, bg } })
    segments.push({ text: k, style: { ...S.key, bg } })
    segments.push({ text: ` ${label}`, style: { ...S.muted, bg } })
  })
  return c.segments(x, y, segments, width)
}

/* ================================================================= tables */

export interface Column<T> {
  title: string
  /** Fixed width, or a share of what is left (`flex`). */
  width?: number
  flex?: number
  align?: 'left' | 'right'
  cell: (row: T, index: number) => string | { text: string; style?: Style }
}

/**
 * A table with a header row, a selected row and scrolling that keeps the
 * selection in view. Selected rows use the teal highlight over full width.
 */
export class Table<T> {
  selected = 0
  scroll = 0
  constructor(public columns: Column<T>[]) {}

  move(delta: number, count: number): void {
    if (count === 0) {
      this.selected = 0
      return
    }
    this.selected = Math.max(0, Math.min(count - 1, this.selected + delta))
  }

  widths(total: number): number[] {
    const gaps = this.columns.length - 1
    const fixed = this.columns.reduce((sum, col) => sum + (col.width ?? 0), 0)
    const flexTotal = this.columns.reduce((sum, col) => sum + (col.width === undefined ? (col.flex ?? 1) : 0), 0)
    const room = Math.max(0, total - fixed - gaps * 2)
    return this.columns.map((col) => (col.width !== undefined ? col.width : Math.floor((room * (col.flex ?? 1)) / Math.max(1, flexTotal))))
  }

  draw(c: Canvas, rows: T[], options: { header?: boolean; focused?: boolean; empty?: string; rowStyle?: (row: T) => Style | undefined } = {}): void {
    const header = options.header !== false
    const widths = this.widths(c.w)
    let x = 0
    if (header) {
      this.columns.forEach((col, i) => {
        const text = col.align === 'right' ? padStart(col.title, widths[i]) : truncate(col.title, widths[i])
        c.text(x, 0, text, S.header)
        x += widths[i] + 2
      })
    }
    const top = header ? 1 : 0
    const visible = Math.max(0, c.h - top)
    if (rows.length === 0) {
      if (options.empty) c.text(0, top, options.empty, S.faint, c.w)
      return
    }
    this.selected = Math.max(0, Math.min(this.selected, rows.length - 1))
    if (this.selected < this.scroll) this.scroll = this.selected
    if (this.selected >= this.scroll + visible) this.scroll = this.selected - visible + 1
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, rows.length - visible)))
    for (let r = 0; r < visible && this.scroll + r < rows.length; r++) {
      const index = this.scroll + r
      const row = rows[index]
      const isSelected = options.focused !== false && index === this.selected
      const base = options.rowStyle?.(row)
      if (isSelected) c.fill(0, top + r, c.w, 1, S.selected)
      x = 0
      this.columns.forEach((col, i) => {
        const value = col.cell(row, index)
        const cell = typeof value === 'string' ? { text: value } : value
        const style = isSelected ? { ...(cell.style ?? base ?? S.text), bg: C.teal } : (cell.style ?? base ?? S.text)
        const text = col.align === 'right' ? padStart(cell.text, widths[i]) : truncate(cell.text, widths[i])
        c.text(x, top + r, text, style, widths[i])
        x += widths[i] + 2
      })
    }
    if (rows.length > visible) {
      const pos = `${this.selected + 1}/${rows.length}`
      c.text(c.w - pos.length, c.h - 1, pos, S.faint)
    }
  }
}

/* ================================================================== misc */

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
export function spinner(now = Date.now()): string {
  return SPIN[Math.floor(now / 80) % SPIN.length]
}

/** How often the scanner moves one step. */
export const SCANNER_FRAME_MS = 50

/**
 * The working indicator, as opencode draws it under its prompt: a light
 * that sweeps along a row of eight cells and back, with a fading tail and a
 * little bloom behind the head. It rests a moment at the far end and a
 * little longer at the start, where the tail drains into the head, and the
 * unlit track dims while it rests. Lit cells are ■, the track ⬝; colours are the accent
 * at opencode's alphas, laid over the background.
 */
export function scanner(now = Date.now(), color: string = C.amber, width = 8, background = '#0B0B0C'): { text: string; style: Style }[] {
  const HOLD_END = 9
  // opencode rests 30 frames here; at that length the bar sits still for over a second of every cycle.
  const HOLD_START = 16
  const TRAIL = [1, 0.9, 0.65, 0.65 ** 2, 0.65 ** 3, 0.65 ** 4]
  const total = width + HOLD_END + (width - 1) + HOLD_START
  const f = Math.floor(now / SCANNER_FRAME_MS) % total
  let head = 0
  let forward = true
  let hold = -1
  let holdTotal = 0
  let moved = 0
  let moveTotal = 0
  if (f < width) [head, moved, moveTotal] = [f, f, width]
  else if (f < width + HOLD_END) [head, hold, holdTotal] = [width - 1, f - width, HOLD_END]
  else if (f < width + HOLD_END + width - 1) {
    moved = f - width - HOLD_END
    ;[head, moveTotal, forward] = [width - 2 - moved, width - 1, false]
  } else [head, hold, holdTotal, forward] = [0, f - width - HOLD_END - (width - 1), HOLD_START, false]
  // The track fades to 30% while resting and comes back as the light moves.
  const fade = hold >= 0 ? Math.max(0.3, 1 - (hold / holdTotal) * 0.7) : 0.3 + Math.min(moved / Math.max(1, moveTotal - 1), 1) * 0.7
  const bloom = mix(color, '#FFFFFF', 0.15)
  const out: { text: string; style: Style }[] = []
  for (let i = 0; i < width; i++) {
    const behind = forward ? head - i : i - head
    const index = hold >= 0 ? behind + hold : behind >= 0 && behind < TRAIL.length ? behind : -1
    if (index >= 0 && index < TRAIL.length) out.push({ text: '■', style: { fg: mix(background, index === 1 ? bloom : color, TRAIL[index]) } })
    else out.push({ text: '⬝', style: { fg: mix(background, color, 0.6 * fade) } })
  }
  return out
}

/** "3s", "4m", "2h", "5d" ago. */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

/** "in 4m", "in 2h 05m". */
export function until(at: number, now = Date.now()): string {
  const m = Math.max(0, Math.round((at - now) / 60000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h${String(m % 60).padStart(2, '0')}m`
  return `${Math.round(h / 24)}d`
}

export function clock(at = Date.now(), seconds = true): string {
  return new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) })
}

export function center(c: Canvas, y: number, text: string, style?: Style): void {
  c.text(Math.max(0, Math.floor((c.w - strWidth(text)) / 2)), y, text, style)
}

export { padEnd, padStart, truncate, strWidth }
export type { KeyEvent }
