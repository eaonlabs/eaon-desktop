/**
 * Text measurement and colour for the terminal.
 *
 * Every cell is one column wide except East Asian wide characters and most
 * emoji, which take two; combining marks take none. Getting that wrong
 * shifts every column after it, so all layout goes through `strWidth`.
 */

export interface Style {
  fg?: string
  bg?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  inverse?: boolean
}

/* ------------------------------------------------------------------ width */

function isCombining(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0x200b ||
    cp === 0x200c ||
    cp === 0x200d ||
    cp === 0x2060 ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  )
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
}

export function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (isCombining(cp)) return 0
  return isWide(cp) ? 2 : 1
}

export function strWidth(text: string): number {
  let width = 0
  for (const ch of text) width += charWidth(ch)
  return width
}

/** Cuts `text` to `width` columns, ending in `…` when anything was cut. */
export function truncate(text: string, width: number, ellipsis = '…'): string {
  if (width <= 0) return ''
  if (strWidth(text) <= width) return text
  const room = width - strWidth(ellipsis)
  let out = ''
  let used = 0
  for (const ch of text) {
    const w = charWidth(ch)
    if (used + w > room) break
    out += ch
    used += w
  }
  return out + ellipsis
}

export function padEnd(text: string, width: number): string {
  const t = truncate(text, width)
  return t + ' '.repeat(Math.max(0, width - strWidth(t)))
}

export function padStart(text: string, width: number): string {
  const t = truncate(text, width)
  return ' '.repeat(Math.max(0, width - strWidth(t))) + t
}

/**
 * Word-wraps one paragraph to `width` columns. Words longer than a line are
 * broken; runs of spaces are kept inside a line and dropped at a break.
 */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text]
  const lines: string[] = []
  for (const raw of text.split('\n')) {
    if (raw === '') {
      lines.push('')
      continue
    }
    let line = ''
    let lineWidth = 0
    const tokens = raw.match(/\s+|[^\s]+/g) ?? []
    for (const token of tokens) {
      const w = strWidth(token)
      if (/^\s+$/.test(token)) {
        if (lineWidth + w <= width) {
          line += token
          lineWidth += w
        } else {
          lines.push(line)
          line = ''
          lineWidth = 0
        }
        continue
      }
      if (lineWidth + w <= width) {
        line += token
        lineWidth += w
        continue
      }
      if (lineWidth > 0) {
        lines.push(line.replace(/\s+$/, ''))
        line = ''
        lineWidth = 0
      }
      // A word wider than the line: hard-break it.
      for (const ch of token) {
        const cw = charWidth(ch)
        if (lineWidth + cw > width) {
          lines.push(line)
          line = ''
          lineWidth = 0
        }
        line += ch
        lineWidth += cw
      }
    }
    lines.push(line.replace(/\s+$/, ''))
  }
  return lines
}

/* ----------------------------------------------------------------- colour */

export type ColorDepth = 'truecolor' | '256' | 'none'

function detectDepth(): ColorDepth {
  const env = process.env
  if ('NO_COLOR' in env && env.NO_COLOR !== '') return 'none'
  if (env.EAON_COLOR === 'truecolor' || env.EAON_COLOR === '256' || env.EAON_COLOR === 'none') return env.EAON_COLOR
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return 'truecolor'
  const program = env.TERM_PROGRAM ?? ''
  if (['iTerm.app', 'WezTerm', 'ghostty', 'vscode', 'Hyper', 'Tabby', 'WarpTerminal', 'rio'].includes(program)) return 'truecolor'
  if (/kitty|direct|alacritty|foot/.test(env.TERM ?? '')) return 'truecolor'
  if (env.WT_SESSION) return 'truecolor'
  // Apple's Terminal and most others: 256 colours, which every modern terminal has.
  return '256'
}

export const colorDepth: ColorDepth = detectDepth()

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = Number.parseInt(full, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const CUBE = [0, 95, 135, 175, 215, 255]

/** The nearest xterm-256 colour: the 6×6×6 cube or the grey ramp, whichever is closer. */
export function to256(hex: string): number {
  const [r, g, b] = hexToRgb(hex)
  const nearest = (v: number): number => {
    let best = 0
    for (let i = 1; i < CUBE.length; i++) if (Math.abs(CUBE[i] - v) < Math.abs(CUBE[best] - v)) best = i
    return best
  }
  const [ri, gi, bi] = [nearest(r), nearest(g), nearest(b)]
  const cubeDist = (CUBE[ri] - r) ** 2 + (CUBE[gi] - g) ** 2 + (CUBE[bi] - b) ** 2
  const avg = Math.round((r + g + b) / 3)
  const grey = Math.max(0, Math.min(23, Math.round((avg - 8) / 10)))
  const gv = 8 + grey * 10
  const greyDist = (gv - r) ** 2 + (gv - g) ** 2 + (gv - b) ** 2
  return greyDist < cubeDist ? 232 + grey : 16 + 36 * ri + 6 * gi + bi
}

function colorCode(hex: string, background: boolean): string {
  if (colorDepth === 'none') return ''
  if (colorDepth === 'truecolor') {
    const [r, g, b] = hexToRgb(hex)
    return `${background ? 48 : 38};2;${r};${g};${b}`
  }
  return `${background ? 48 : 38};5;${to256(hex)}`
}

/** The SGR sequence for a style, starting from a reset so nothing carries over. */
export function sgr(style: Style | undefined): string {
  const parts = ['0']
  if (style) {
    if (style.bold) parts.push('1')
    if (style.dim) parts.push('2')
    if (style.italic) parts.push('3')
    if (style.underline) parts.push('4')
    if (style.inverse) parts.push('7')
    if (style.fg) {
      const code = colorCode(style.fg, false)
      if (code) parts.push(code)
    }
    if (style.bg) {
      const code = colorCode(style.bg, true)
      if (code) parts.push(code)
    }
  }
  return `\x1b[${parts.join(';')}m`
}

export function styleKey(style: Style | undefined): string {
  if (!style) return ''
  return `${style.fg ?? ''}|${style.bg ?? ''}|${style.bold ? 1 : 0}${style.dim ? 1 : 0}${style.italic ? 1 : 0}${style.underline ? 1 : 0}${style.inverse ? 1 : 0}`
}

/**
 * Program output as plain text: colour and cursor escapes removed, and a
 * line redrawn with carriage returns (progress bars) kept as its last state.
 * The canvas shows a bare ESC as a space, so without this `[41m` and the
 * like would show up in command output.
 */
export function plainOutput(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.includes('\r') ? line.slice(line.lastIndexOf('\r', line.length - 2) + 1).replace(/\r$/, '') : line))
    .join('\n')
}
