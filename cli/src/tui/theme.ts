import type { Style } from './term'

/**
 * The CLI's palette. A terminal desk: amber for structure (tab bar, panel
 * titles), green and red only for money moving up or down, cyan for
 * symbols and links, and a deep teal for the selected row — the look of the
 * reference screens the user supplied.
 */
export const C = {
  text: '#E6E6E6',
  muted: '#8E8E93',
  faint: '#5C5C61',
  border: '#3A3A3D',
  panelBar: '#1A1A1C',
  amber: '#FFA028',
  amberDeep: '#F5A524',
  green: '#3DDC84',
  red: '#FF5A4F',
  yellow: '#FFD60A',
  cyan: '#5AC8FA',
  blue: '#4D9BFF',
  purple: '#C38BFF',
  teal: '#1E4D5C',
  tealText: '#E8F7FF',
  ink: '#0B0B0C'
}

/** A colour `t` of the way from `a` to `b` (both #RRGGBB). */
export function mix(a: string, b: string, t: number): string {
  const k = Math.max(0, Math.min(1, t))
  const hex = /^#[0-9a-f]{6}$/i
  if (!hex.test(a) || !hex.test(b)) return k < 0.5 ? a : b
  const at = (hex: string, i: number): number => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16)
  const channel = (i: number): string => Math.round(at(a, i) + (at(b, i) - at(a, i)) * k).toString(16).padStart(2, '0')
  return `#${channel(0)}${channel(1)}${channel(2)}`
}

export const S = {
  text: { fg: C.text } as Style,
  bold: { fg: C.text, bold: true } as Style,
  muted: { fg: C.muted } as Style,
  faint: { fg: C.faint } as Style,
  border: { fg: C.border } as Style,
  amber: { fg: C.amber } as Style,
  amberBold: { fg: C.amber, bold: true } as Style,
  green: { fg: C.green } as Style,
  greenBold: { fg: C.green, bold: true } as Style,
  red: { fg: C.red } as Style,
  redBold: { fg: C.red, bold: true } as Style,
  yellow: { fg: C.yellow } as Style,
  cyan: { fg: C.cyan } as Style,
  blue: { fg: C.blue } as Style,
  purple: { fg: C.purple } as Style,
  tab: { fg: C.muted } as Style,
  tabActive: { fg: C.ink, bg: C.amberDeep, bold: true } as Style,
  panelTitle: { fg: C.amber, bg: C.panelBar, bold: true } as Style,
  panelBar: { bg: C.panelBar } as Style,
  selected: { fg: C.tealText, bg: C.teal } as Style,
  selectedBold: { fg: C.tealText, bg: C.teal, bold: true } as Style,
  header: { fg: C.amber, bold: true } as Style,
  key: { fg: C.text, bold: true } as Style,
  status: { fg: C.muted, bg: C.panelBar } as Style
}

/** Green for gains, red for losses, plain for flat. */
export function signStyle(value: number | null | undefined, bold = false): Style {
  if (!value || Math.abs(value) < 1e-9) return bold ? S.bold : S.text
  return value > 0 ? (bold ? S.greenBold : S.green) : bold ? S.redBold : S.red
}

export function withBg(style: Style, bg: string | undefined): Style {
  return bg ? { ...style, bg } : style
}
