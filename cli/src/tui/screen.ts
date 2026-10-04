import { charWidth, sgr, strWidth, styleKey, type Style } from './term'

/**
 * A full-screen renderer: views draw into a grid of cells, and only the
 * cells that changed since the last frame are written to the terminal.
 *
 * Redrawing everything on every keystroke or price tick flickers and, over
 * SSH, crawls. Each frame here is diffed row by row against the previous
 * one; a changed row rewrites only the span between its first and last
 * changed cell, in one write wrapped in synchronized-update markers so
 * terminals that support them never show half a frame.
 */

const CONTINUATION = ''

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

class Grid {
  chars: string[]
  styles: Uint16Array
  constructor(
    readonly w: number,
    readonly h: number
  ) {
    this.chars = new Array<string>(w * h).fill(' ')
    this.styles = new Uint16Array(w * h)
  }
}

/** Styles are interned to small numbers so a cell compares in one step. */
class StyleTable {
  private ids = new Map<string, number>([['', 0]])
  readonly list: (Style | undefined)[] = [undefined]
  id(style: Style | undefined): number {
    const key = styleKey(style)
    let id = this.ids.get(key)
    if (id === undefined) {
      id = this.list.length
      this.list.push(style)
      this.ids.set(key, id)
    }
    return id
  }
}

/**
 * Where a view draws: a rectangle of the screen, clipped to itself. `sub`
 * makes a smaller one with its own origin, so a panel draws at (0, 0)
 * without knowing where it sits.
 */
export class Canvas {
  constructor(
    private readonly grid: Grid,
    private readonly styles: StyleTable,
    readonly rect: Rect,
    private readonly cursorSink: (x: number, y: number) => void
  ) {}

  get w(): number {
    return this.rect.w
  }
  get h(): number {
    return this.rect.h
  }

  sub(x: number, y: number, w: number, h: number): Canvas {
    const nx = Math.max(0, x)
    const ny = Math.max(0, y)
    const nw = Math.max(0, Math.min(w - (nx - x), this.rect.w - nx))
    const nh = Math.max(0, Math.min(h - (ny - y), this.rect.h - ny))
    return new Canvas(this.grid, this.styles, { x: this.rect.x + nx, y: this.rect.y + ny, w: nw, h: nh }, this.cursorSink)
  }

  private put(x: number, y: number, ch: string, styleId: number): void {
    const gx = this.rect.x + x
    const gy = this.rect.y + y
    if (x < 0 || y < 0 || x >= this.rect.w || y >= this.rect.h) return
    const i = gy * this.grid.w + gx
    // Overwriting half of a wide character blanks the other half.
    if (this.grid.chars[i] === CONTINUATION && gx > 0) this.grid.chars[i - 1] = ' '
    if (gx + 1 < this.grid.w && this.grid.chars[i + 1] === CONTINUATION) this.grid.chars[i + 1] = ' '
    this.grid.chars[i] = ch
    this.grid.styles[i] = styleId
  }

  /**
   * Writes `text` from (x, y) on one line, clipped to the canvas and to
   * `maxWidth`. Newlines and control characters are shown as spaces.
   * Returns the columns written.
   */
  text(x: number, y: number, text: string, style?: Style, maxWidth = Infinity): number {
    if (y < 0 || y >= this.rect.h) return 0
    const id = this.styles.id(style)
    const limit = Math.min(this.rect.w, x + maxWidth)
    let col = x
    for (let ch of text) {
      let w = charWidth(ch)
      if (ch === '\t') {
        ch = ' '
        w = 1
      } else if (w === 0) {
        if (ch.charCodeAt(0) < 32) {
          ch = ' '
          w = 1
        } else continue
      }
      if (col + w > limit) break
      if (col >= 0) {
        this.put(col, y, ch, id)
        if (w === 2) this.put(col + 1, y, CONTINUATION, id)
      }
      col += w
    }
    return Math.max(0, col - x)
  }

  /** Text in segments of different styles, one after another. */
  segments(x: number, y: number, segments: { text: string; style?: Style }[], maxWidth = Infinity): number {
    let col = x
    for (const seg of segments) {
      if (col - x >= maxWidth) break
      col += this.text(col, y, seg.text, seg.style, maxWidth - (col - x))
    }
    return col - x
  }

  fill(x: number, y: number, w: number, h: number, style?: Style, ch = ' '): void {
    const id = this.styles.id(style)
    for (let row = Math.max(0, y); row < Math.min(this.rect.h, y + h); row++)
      for (let col = Math.max(0, x); col < Math.min(this.rect.w, x + w); col++) this.put(col, row, ch, id)
  }

  clear(style?: Style): void {
    this.fill(0, 0, this.rect.w, this.rect.h, style)
  }

  /** Restyles cells already drawn, keeping their characters: the mouse selection. */
  paint(x: number, y: number, w: number, patch: Style): void {
    if (y < 0 || y >= this.rect.h) return
    for (let col = Math.max(0, x); col < Math.min(this.rect.w, x + w); col++) {
      const i = (this.rect.y + y) * this.grid.w + this.rect.x + col
      this.grid.styles[i] = this.styles.id({ ...this.styles.list[this.grid.styles[i]], ...patch })
    }
  }

  hline(x: number, y: number, w: number, style?: Style, ch = '─'): void {
    this.fill(x, y, w, 1, style, ch)
  }

  vline(x: number, y: number, h: number, style?: Style, ch = '│'): void {
    this.fill(x, y, 1, h, style, ch)
  }

  /** A box around the whole canvas, `rounded` or square, with an optional title on the top edge. */
  box(style?: Style, options: { rounded?: boolean; title?: string; titleStyle?: Style; heavy?: boolean } = {}): void {
    const { w, h } = this.rect
    if (w < 2 || h < 2) return
    const [tl, tr, bl, br, hz, vt] = options.heavy
      ? ['┏', '┓', '┗', '┛', '━', '┃']
      : options.rounded
        ? ['╭', '╮', '╰', '╯', '─', '│']
        : ['┌', '┐', '└', '┘', '─', '│']
    this.text(0, 0, tl, style)
    this.hline(1, 0, w - 2, style, hz)
    this.text(w - 1, 0, tr, style)
    this.vline(0, 1, h - 2, style, vt)
    this.vline(w - 1, 1, h - 2, style, vt)
    this.text(0, h - 1, bl, style)
    this.hline(1, h - 1, w - 2, style, hz)
    this.text(w - 1, h - 1, br, style)
    if (options.title) this.text(2, 0, ` ${options.title} `, options.titleStyle ?? style, w - 4)
  }

  /** Puts the terminal's cursor here after the frame is drawn (for a text field). */
  setCursor(x: number, y: number): void {
    if (x < 0 || y < 0 || x >= this.rect.w || y >= this.rect.h) return
    this.cursorSink(this.rect.x + x, this.rect.y + y)
  }
}

export interface Output {
  write(data: string): void
  columns?: number
  rows?: number
}

export class Screen {
  private prev: Grid | null = null
  private styles = new StyleTable()
  private cursor: { x: number; y: number } | null = null
  private started = false

  constructor(private readonly out: Output = process.stdout) {}

  get width(): number {
    return Math.max(20, this.out.columns ?? 100)
  }
  get height(): number {
    return Math.max(8, this.out.rows ?? 30)
  }

  start(): void {
    if (this.started) return
    this.started = true
    // Alternate screen, hidden cursor, bracketed paste, focus reporting off.
    this.out.write('\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[2J\x1b[H')
  }

  enableMouse(on: boolean): void {
    // Presses, drags (for selecting text), the wheel, and SGR coordinates (no 223-column limit).
    this.out.write(on ? '\x1b[?1002h\x1b[?1006h' : '\x1b[?1002l\x1b[?1000l\x1b[?1006l')
  }

  /**
   * The text shown between two cells of the last frame, in reading order:
   * whole rows in between, as a terminal selects. Lines lose trailing spaces.
   */
  textBetween(a: { x: number; y: number }, b: { x: number; y: number }): string {
    const grid = this.prev
    if (!grid) return ''
    const [from, to] = a.y < b.y || (a.y === b.y && a.x <= b.x) ? [a, b] : [b, a]
    const lines: string[] = []
    for (let y = Math.max(0, from.y); y <= Math.min(grid.h - 1, to.y); y++) {
      const start = y === from.y ? from.x : 0
      const end = y === to.y ? to.x : grid.w - 1
      let line = ''
      for (let x = Math.max(0, start); x <= Math.min(grid.w - 1, end); x++) {
        const ch = grid.chars[y * grid.w + x]
        if (ch !== CONTINUATION) line += ch
      }
      lines.push(line.replace(/\s+$/, ''))
    }
    return lines.join('\n')
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.out.write('\x1b[?1002l\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[0m\x1b[?25h\x1b[?1049l')
  }

  /** Forgets the last frame, so the next one is written whole (after a resize, or a program that scribbled on the screen). */
  invalidate(): void {
    this.prev = null
  }

  render(draw: (canvas: Canvas) => void): void {
    const w = this.width
    const h = this.height
    // Interned styles only ever grow; start over once the table gets big.
    if (this.styles.list.length > 4000) {
      this.styles = new StyleTable()
      this.prev = null
    }
    const grid = new Grid(w, h)
    this.cursor = null
    const canvas = new Canvas(grid, this.styles, { x: 0, y: 0, w, h }, (x, y) => (this.cursor = { x, y }))
    draw(canvas)
    this.out.write(this.diff(grid))
    this.prev = grid
  }

  /** Renders one frame to plain text (and nothing to the terminal): for snapshots and tests. */
  static snapshot(width: number, height: number, draw: (canvas: Canvas) => void): { text: string; grid: { chars: string[]; styles: (Style | undefined)[] } } {
    const styles = new StyleTable()
    const grid = new Grid(width, height)
    draw(new Canvas(grid, styles, { x: 0, y: 0, w: width, h: height }, () => {}))
    const rows: string[] = []
    for (let y = 0; y < height; y++) rows.push(grid.chars.slice(y * width, (y + 1) * width).join('').replace(/\s+$/, ''))
    return {
      text: rows.join('\n'),
      grid: { chars: grid.chars, styles: Array.from(grid.styles, (id) => styles.list[id]) }
    }
  }

  private diff(next: Grid): string {
    const prev = this.prev && this.prev.w === next.w && this.prev.h === next.h ? this.prev : null
    let out = '\x1b[?2026h'
    if (!prev) out += '\x1b[0m\x1b[2J'
    for (let y = 0; y < next.h; y++) {
      const row = y * next.w
      let first = -1
      let last = -1
      for (let x = 0; x < next.w; x++) {
        const i = row + x
        if (!prev || prev.chars[i] !== next.chars[i] || prev.styles[i] !== next.styles[i]) {
          if (first === -1) first = x
          last = x
        }
      }
      if (first === -1) continue
      // Never start inside a wide character, and finish the one the span ends on.
      while (first > 0 && next.chars[row + first] === CONTINUATION) first--
      if (last + 1 < next.w && next.chars[row + last + 1] === CONTINUATION) last++
      out += `\x1b[${y + 1};${first + 1}H`
      let current = -1
      for (let x = first; x <= last; x++) {
        const i = row + x
        const ch = next.chars[i]
        if (ch === CONTINUATION) continue
        const id = next.styles[i]
        if (id !== current) {
          out += sgr(this.styles.list[id])
          current = id
        }
        out += ch
      }
    }
    out += '\x1b[0m'
    out += this.cursor ? `\x1b[${this.cursor.y + 1};${this.cursor.x + 1}H\x1b[?25h` : '\x1b[?25l'
    out += '\x1b[?2026l'
    return out
  }
}

/** Width of a list of segments, for laying them out before drawing. */
export function segmentsWidth(segments: { text: string }[]): number {
  return segments.reduce((sum, s) => sum + strWidth(s.text), 0)
}
