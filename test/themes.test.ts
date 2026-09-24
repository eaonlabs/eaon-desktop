import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { THEMES, type ThemeTone } from '../src/renderer/src/lib/themes'

/**
 * Every theme's text must stay readable on every surface it sits on, in both
 * appearances. Rather than restate the token formulas here (and drift from
 * them), this evaluates tokens.css itself: a small interpreter for the subset
 * of CSS the tokens use — var(), calc(), clamp(), color-mix(in srgb) and the
 * one relative oklch() colour — fed each theme's four values the way
 * `useTheme()` sets them on :root.
 */

type RGBA = [number, number, number, number]

const css = readFileSync(join(process.cwd(), 'src/renderer/src/styles/tokens.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  ''
)

function block(selector: RegExp): Record<string, string> {
  const match = selector.exec(css)
  if (!match) throw new Error(`no block for ${selector}`)
  const start = css.indexOf('{', match.index) + 1
  let depth = 1
  let end = start
  while (depth > 0) {
    if (css[end] === '{') depth++
    if (css[end] === '}') depth--
    end++
  }
  const body = css.slice(start, end - 1)
  const out: Record<string, string> = {}
  // Split on semicolons that are not inside parentheses.
  let level = 0
  let current = ''
  for (const ch of body) {
    if (ch === '(') level++
    if (ch === ')') level--
    if (ch === ';' && level === 0) {
      const colon = current.indexOf(':')
      const name = current.slice(0, colon).trim()
      if (name.startsWith('--')) out[name] = current.slice(colon + 1).trim().replace(/\s+/g, ' ')
      current = ''
    } else current += ch
  }
  return out
}

const base = block(/^:root \{/m)
const dark = block(/^:root,\s*\[data-theme='dark'\] \{/m)
const light = block(/^\[data-theme='light'\] \{/m)

/* ---------------------------------------------------------------- colour math */

const hex = (value: string): RGBA => {
  let h = value.slice(1)
  if (h.length === 3) h = [...h].map((c) => c + c).join('')
  const n = parseInt(h.slice(0, 6), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1]
}

/** color-mix(in srgb, a p, b q): premultiplied interpolation, as CSS Color 5 specifies. */
function mix(a: RGBA, pa: number | null, b: RGBA, pb: number | null): RGBA {
  if (pa === null && pb === null) pa = pb = 0.5
  else if (pa === null) pa = 1 - pb!
  else if (pb === null) pb = 1 - pa
  const sum = pa + pb!
  const wa = pa / sum
  const wb = pb! / sum
  const alpha = a[3] * wa + b[3] * wb
  const channel = (i: number): number => (alpha === 0 ? 0 : (a[i] * a[3] * wa + b[i] * b[3] * wb) / alpha)
  return [channel(0), channel(1), channel(2), alpha * Math.min(1, sum)]
}

const linear = (c: number): number => {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}
const luminance = ([r, g, b]: RGBA): number => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
const contrast = (a: RGBA, b: RGBA): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
/** Paint a translucent colour over an opaque one. */
const over = (top: RGBA, under: RGBA): RGBA => [
  top[0] * top[3] + under[0] * (1 - top[3]),
  top[1] * top[3] + under[1] * (1 - top[3]),
  top[2] * top[3] + under[2] * (1 - top[3]),
  1
]

function toOklch([r, g, b]: RGBA): [number, number, number] {
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)]
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return [L, Math.hypot(A, B), (Math.atan2(B, A) * 180) / Math.PI]
}

function fromOklch(L: number, C: number, H: number): RGBA {
  const a = C * Math.cos((H * Math.PI) / 180)
  const b = C * Math.sin((H * Math.PI) / 180)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const enc = (x: number): number => {
    const v = Math.min(1, Math.max(0, x))
    return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)
  }
  return [
    enc(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    enc(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    enc(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    1
  ]
}

/* ------------------------------------------------------------ the interpreter */

type Scope = Record<string, string>

/** Splits a function's arguments on top-level commas. */
function args(inner: string): string[] {
  const out: string[] = []
  let level = 0
  let current = ''
  for (const ch of inner) {
    if (ch === '(') level++
    if (ch === ')') level--
    if (ch === ',' && level === 0) {
      out.push(current.trim())
      current = ''
    } else current += ch
  }
  out.push(current.trim())
  return out
}

/** Replaces var(--x) with the resolved text of --x. */
function substitute(value: string, scope: Scope): string {
  let out = value
  for (let guard = 0; out.includes('var(') && guard < 50; guard++) {
    out = out.replace(/var\((--[\w-]+)\)/g, (_, name: string) => {
      if (!(name in scope)) throw new Error(`undefined ${name}`)
      return substitute(scope[name], scope)
    })
  }
  return out
}

/** Numbers, percentages (as fractions) and channel keywords, with + - * / and clamp(). */
function number(expr: string, channels: Record<string, number> = {}): number {
  const tokens = expr.match(/clamp|calc|\d*\.?\d+%?|[a-z]+|[-+*/(),]/g) ?? []
  let i = 0
  const peek = (): string | undefined => tokens[i]
  const next = (): string => tokens[i++]
  const primary = (): number => {
    const t = next()
    if (t === '(') {
      const v = sum()
      next()
      return v
    }
    if (t === 'calc') {
      next()
      const v = sum()
      next()
      return v
    }
    if (t === 'clamp') {
      next()
      const lo = sum()
      next()
      const mid = sum()
      next()
      const hi = sum()
      next()
      return Math.min(hi, Math.max(lo, mid))
    }
    if (t === '-') return -primary()
    if (t in channels) return channels[t]
    if (t.endsWith('%')) return parseFloat(t) / 100
    return parseFloat(t)
  }
  const product = (): number => {
    let v = primary()
    while (peek() === '*' || peek() === '/') v = next() === '*' ? v * primary() : v / primary()
    return v
  }
  const sum = (): number => {
    let v = product()
    while (peek() === '+' || peek() === '-') v = next() === '+' ? v + product() : v - product()
    return v
  }
  return sum()
}

function color(value: string, scope: Scope): RGBA {
  const v = substitute(value, scope).trim()
  if (v === 'transparent') return [0, 0, 0, 0]
  if (v.startsWith('#')) return hex(v)
  const rgba = /^rgba?\(([^)]*)\)$/.exec(v)
  if (rgba) {
    const [r, g, b, a = '1'] = rgba[1].split(',').map((s) => s.trim())
    return [Number(r), Number(g), Number(b), Number(a)]
  }
  if (v.startsWith('color-mix(')) {
    const [, first, second] = args(v.slice('color-mix('.length, -1))
    const part = (text: string): [RGBA, number | null] => {
      const pct = /\s(calc\(.*\)|[\d.]+%)$/.exec(text)
      if (!pct) return [color(text, scope), null]
      return [color(text.slice(0, pct.index), scope), number(pct[1])]
    }
    const [a, pa] = part(first)
    const [b, pb] = part(second)
    return mix(a, pa, b, pb)
  }
  const relative = /^oklch\(\s*from\s+(\S+)\s+([\s\S]+)\)$/.exec(v)
  if (relative) {
    const [L, C, H] = toOklch(color(relative[1], scope))
    // Three channel expressions separated by top-level spaces.
    const parts: string[] = []
    let level = 0
    let current = ''
    for (const ch of relative[2].trim()) {
      if (ch === '(') level++
      if (ch === ')') level--
      if (ch === ' ' && level === 0 && current) {
        parts.push(current)
        current = ''
      } else if (ch !== ' ' || level > 0) current += ch
    }
    parts.push(current)
    const channels = { l: L, c: C, h: H }
    return fromOklch(number(parts[0], channels), number(parts[1], channels), number(parts[2], channels))
  }
  throw new Error(`cannot evaluate colour: ${v}`)
}

function resolve(palette: ThemeTone, tone: 'light' | 'dark'): (name: string) => RGBA {
  // Inline styles from useTheme() win over the stylesheet's defaults.
  const scope: Scope = {
    ...base,
    ...(tone === 'dark' ? dark : light),
    '--bg': palette.background,
    '--fg': palette.foreground,
    '--accent': palette.accent,
    '--contrast': String(palette.contrast),
    '--text-fade': String(palette.textFade ?? 1)
  }
  return (name) => color(`var(${name})`, scope)
}

/* ------------------------------------------------------------------ the checks */

const AA = 4.5

for (const theme of THEMES) {
  for (const tone of ['dark', 'light'] as const) {
    test(`${theme.name} ${tone}: body text and --text-2 meet WCAG AA`, () => {
      const get = resolve(theme[tone], tone)
      const canvas = get('--canvas')
      const sidebar = get('--sidebar')
      // Everywhere either tone is drawn: the page, the sidebar, cards and
      // inputs, menus and modals, and a hovered row. The menu is its
      // translucent fill composited over the canvas it usually floats on.
      const surfaces: Record<string, RGBA> = {
        canvas,
        sidebar,
        'surface-1': get('--surface-1'),
        'surface-2': get('--surface-2'),
        'surface-3': get('--surface-3'),
        menu: over(get('--menu-bg'), canvas),
        'hovered row': over(get('--hover'), sidebar)
      }
      const failures: string[] = []
      for (const text of ['--text', '--text-2'] as const) {
        const ink = get(text)
        for (const [name, surface] of Object.entries(surfaces)) {
          const ratio = contrast(ink, surface)
          if (ratio < AA) failures.push(`${text} on ${name}: ${ratio.toFixed(2)}`)
        }
      }
      // The selected row in a list is labelled in full-strength text.
      const selected = contrast(get('--text'), over(get('--active'), sidebar))
      if (selected < AA) failures.push(`--text on selected row: ${selected.toFixed(2)}`)
      assert.deepEqual(failures, [])
    })

    test(`${theme.name} ${tone}: text on accent fills stays legible`, () => {
      const get = resolve(theme[tone], tone)
      // Held to 3:1 rather than 4.5: Cobalt has always shipped white on
      // #0A84FF (3.6:1), the house style for a filled button, and dark ink on
      // that blue would read as a different app. The pastel accents are where
      // this used to fail outright — white on Dracula purple is 2.4:1.
      const ratio = contrast(get('--on-accent'), get('--accent'))
      assert.ok(ratio >= 3, `--on-accent on --accent is ${ratio.toFixed(2)}`)
    })
  }
}

test('the neutral themes keep their old hard-coded neutrals', () => {
  // Cobalt was the reference the derivations were solved against.
  const cobalt = THEMES.find((t) => t.name === 'Cobalt')!
  const near = (a: RGBA, b: string, tolerance = 3): boolean =>
    a.slice(0, 3).every((c, i) => Math.abs(c - hex(b)[i]) <= tolerance)
  const d = resolve(cobalt.dark, 'dark')
  const l = resolve(cobalt.light, 'light')
  const paint = (c: RGBA, under: string): RGBA => over(c, hex(under))
  assert.ok(near(d('--toggle-off'), '#3a3a3c'))
  assert.ok(near(d('--send-fg'), '#1a1a1a'))
  assert.ok(near(d('--send-bg'), '#b4b4b4'))
  assert.ok(near(d('--code-bg'), '#0d0d0d'))
  assert.ok(near(paint(d('--hover'), '#111111'), '#1f1f1f'))
  assert.ok(near(l('--toggle-off'), '#d8d8dc', 4))
  assert.ok(near(l('--surface-3'), '#ffffff'))
  assert.ok(near(l('--code-bg'), '#f6f6f6'))
  assert.ok(near(paint(l('--border'), '#ffffff'), '#e6e6e6'))
  assert.ok(near(paint(l('--hover'), '#ffffff'), '#f4f4f4'))
  // Mid-tone accents keep white button text; pastels get ink.
  assert.ok(near(d('--on-accent'), '#ffffff'))
  const glacier = THEMES.find((t) => t.name === 'Glacier')!
  assert.ok(luminance(resolve(glacier.dark, 'dark')('--on-accent')) < 0.05)
})
