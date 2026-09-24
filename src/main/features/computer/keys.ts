/**
 * Key-combo parsing and per-platform key codes. Pure, so it can be unit tested.
 *
 * Models write combos in a few dialects — "cmd+c", "Command+Shift+T",
 * xdotool's "ctrl+Return" and "Page_Down", "⌘⇧4" never (we reject that) — so
 * parsing is forgiving about names and strict about structure: one key plus
 * any modifiers, or modifiers alone. Anything unknown is an error naming the
 * accepted keys, never a guess: a wrong guess is a keystroke in someone's app.
 */

export type Modifier = 'cmd' | 'ctrl' | 'alt' | 'shift' | 'fn'

export interface Combo {
  /** In the order they are pressed. */
  modifiers: Modifier[]
  /** Canonical key name, or null for a modifier-only press. */
  key: string | null
}

const MODIFIER_ORDER: Modifier[] = ['ctrl', 'alt', 'shift', 'cmd', 'fn']

const MODIFIER_ALIASES: Record<string, Modifier> = {
  cmd: 'cmd',
  command: 'cmd',
  meta: 'cmd',
  super: 'cmd',
  win: 'cmd',
  windows: 'cmd',
  ctrl: 'ctrl',
  control: 'ctrl',
  ctl: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift',
  fn: 'fn'
}

/** Every non-modifier key, by canonical name. */
const NAMED_KEYS = [
  'return', 'tab', 'space', 'escape', 'backspace', 'delete', 'insert', 'home', 'end', 'pageup', 'pagedown',
  'left', 'right', 'up', 'down', 'minus', 'equal', 'comma', 'period', 'slash', 'semicolon', 'quote', 'grave',
  'bracketleft', 'bracketright', 'backslash', 'kpenter', 'capslock', 'help', 'printscreen', 'menu'
] as const

const KEY_ALIASES: Record<string, string> = {
  enter: 'return',
  ret: 'return',
  esc: 'escape',
  back_space: 'backspace',
  bksp: 'backspace',
  del: 'delete',
  forwarddelete: 'delete',
  forward_delete: 'delete',
  ins: 'insert',
  page_up: 'pageup',
  prior: 'pageup',
  pgup: 'pageup',
  page_down: 'pagedown',
  next: 'pagedown',
  pgdn: 'pagedown',
  arrowleft: 'left',
  arrowright: 'right',
  arrowup: 'up',
  arrowdown: 'down',
  leftarrow: 'left',
  rightarrow: 'right',
  uparrow: 'up',
  downarrow: 'down',
  spacebar: 'space',
  ' ': 'space',
  '-': 'minus',
  '=': 'equal',
  ',': 'comma',
  '.': 'period',
  '/': 'slash',
  ';': 'semicolon',
  "'": 'quote',
  apostrophe: 'quote',
  '`': 'grave',
  backtick: 'grave',
  '[': 'bracketleft',
  ']': 'bracketright',
  '\\': 'backslash',
  kp_enter: 'kpenter',
  caps_lock: 'capslock',
  print: 'printscreen',
  print_screen: 'printscreen',
  apps: 'menu'
}

function canonicalKey(raw: string): string | null {
  const name = raw.toLowerCase()
  if (/^[a-z0-9]$/.test(name)) return name
  if (/^f([1-9]|1[0-9]|20)$/.test(name)) return name
  if ((NAMED_KEYS as readonly string[]).includes(name)) return name
  return KEY_ALIASES[name] ?? KEY_ALIASES[raw] ?? null
}

/** Parses "cmd+shift+t", "Return", "ctrl+alt+Delete", "shift" or "cmd++". Throws on anything else. */
export function parseCombo(input: string): Combo {
  const text = input.trim()
  if (!text) throw new Error('keys is empty. Pass a key or combo such as "Return" or "cmd+c".')
  if (/\s/.test(text.replace(/\s*\+\s*/g, '+'))) {
    throw new Error(`"${input}" has more than one combo. Send one key or combo per call.`)
  }

  // "+" is both the separator and a key; a trailing "++" (or a lone "+") is the key.
  let body = text.replace(/\s*\+\s*/g, '+')
  let plus = false
  if (body === '+') {
    body = ''
    plus = true
  } else if (body.endsWith('++')) {
    body = body.slice(0, -2)
    plus = true
  }

  const parts = body ? body.split('+') : []
  if (parts.some((p) => p === '')) throw new Error(`"${input}" is not a valid combo. Write it like "cmd+shift+t".`)

  const modifiers = new Set<Modifier>()
  let key: string | null = null
  for (const part of parts) {
    const lower = part.toLowerCase()
    const modifier = MODIFIER_ALIASES[lower]
    if (modifier) {
      modifiers.add(modifier)
      continue
    }
    if (key !== null || plus) throw new Error(`"${input}" names more than one key. Use one key plus modifiers.`)
    if (lower === 'plus') {
      plus = true
      continue
    }
    const canonical = canonicalKey(part)
    if (!canonical) {
      throw new Error(
        `Unknown key "${part}". Use letters, digits, F1–F20, or one of: ${NAMED_KEYS.join(', ')}; modifiers: cmd, ctrl, alt/option, shift, fn.`
      )
    }
    key = canonical
  }
  // "+" is shift+"=" on the layouts these key codes describe.
  if (plus) {
    if (key !== null) throw new Error(`"${input}" names more than one key. Use one key plus modifiers.`)
    key = 'equal'
    modifiers.add('shift')
  }
  if (key === null && modifiers.size === 0) throw new Error(`"${input}" has no key in it.`)
  return { modifiers: MODIFIER_ORDER.filter((m) => modifiers.has(m)), key }
}

export function formatCombo(combo: Combo): string {
  return [...combo.modifiers, ...(combo.key ? [combo.key] : [])].join('+')
}

/* ------------------------------------------------------------- key codes */

/** macOS virtual key codes (ANSI layout; the position, not the character). */
export const MAC_KEYCODES: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23, equal: 24, '9': 25, '7': 26, minus: 27, '8': 28, '0': 29,
  bracketright: 30, o: 31, u: 32, bracketleft: 33, i: 34, p: 35, return: 36, l: 37, j: 38, quote: 39, k: 40,
  semicolon: 41, backslash: 42, comma: 43, slash: 44, n: 45, m: 46, period: 47, tab: 48, space: 49, grave: 50,
  backspace: 51, escape: 53, capslock: 57, kpenter: 76, help: 114, home: 115, pageup: 116, delete: 117, end: 119,
  pagedown: 121, left: 123, right: 124, down: 125, up: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
  f13: 105, f14: 107, f15: 113, f16: 106, f17: 64, f18: 79, f19: 80, f20: 90
}

export const MAC_MODIFIERS: Record<Modifier, { code: number; flag: number }> = {
  cmd: { code: 55, flag: 0x100000 },
  shift: { code: 56, flag: 0x20000 },
  alt: { code: 58, flag: 0x80000 },
  ctrl: { code: 59, flag: 0x40000 },
  fn: { code: 63, flag: 0x800000 }
}

/** Windows virtual-key codes; `ext` keys need KEYEVENTF_EXTENDEDKEY. */
export function windowsKey(key: string): { vk: number; ext: boolean } | null {
  if (/^[a-z]$/.test(key)) return { vk: key.toUpperCase().charCodeAt(0), ext: false }
  if (/^[0-9]$/.test(key)) return { vk: key.charCodeAt(0), ext: false }
  const f = /^f(\d+)$/.exec(key)
  if (f) return { vk: 0x6f + Number(f[1]), ext: false }
  const table: Record<string, [number, boolean]> = {
    return: [0x0d, false], kpenter: [0x0d, true], tab: [0x09, false], space: [0x20, false], escape: [0x1b, false],
    backspace: [0x08, false], delete: [0x2e, true], insert: [0x2d, true], home: [0x24, true], end: [0x23, true],
    pageup: [0x21, true], pagedown: [0x22, true], left: [0x25, true], up: [0x26, true], right: [0x27, true],
    down: [0x28, true], semicolon: [0xba, false], equal: [0xbb, false], comma: [0xbc, false], minus: [0xbd, false],
    period: [0xbe, false], slash: [0xbf, false], grave: [0xc0, false], bracketleft: [0xdb, false],
    backslash: [0xdc, false], bracketright: [0xdd, false], quote: [0xde, false], capslock: [0x14, false],
    printscreen: [0x2c, true], menu: [0x5d, true], help: [0x2f, false]
  }
  const entry = table[key]
  return entry ? { vk: entry[0], ext: entry[1] } : null
}

export const WINDOWS_MODIFIERS: Record<Exclude<Modifier, 'fn'>, { vk: number; ext: boolean }> = {
  ctrl: { vk: 0x11, ext: false },
  alt: { vk: 0x12, ext: false },
  shift: { vk: 0x10, ext: false },
  cmd: { vk: 0x5b, ext: true }
}

/** X11 keysym names as xdotool expects them. */
export function xdotoolKey(key: string): string {
  const table: Record<string, string> = {
    return: 'Return', tab: 'Tab', space: 'space', escape: 'Escape', backspace: 'BackSpace', delete: 'Delete',
    insert: 'Insert', home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next', left: 'Left', right: 'Right',
    up: 'Up', down: 'Down', minus: 'minus', equal: 'equal', comma: 'comma', period: 'period', slash: 'slash',
    semicolon: 'semicolon', quote: 'apostrophe', grave: 'grave', bracketleft: 'bracketleft',
    bracketright: 'bracketright', backslash: 'backslash', kpenter: 'KP_Enter', capslock: 'Caps_Lock', help: 'Help',
    printscreen: 'Print', menu: 'Menu'
  }
  if (table[key]) return table[key]
  if (/^f\d+$/.test(key)) return key.toUpperCase()
  return key
}

export const XDOTOOL_MODIFIERS: Record<Exclude<Modifier, 'fn'>, string> = {
  ctrl: 'ctrl',
  alt: 'alt',
  shift: 'shift',
  cmd: 'super'
}

/* ---------------------------------------------------------------- danger */

type Platform = 'darwin' | 'win32' | 'linux'

const has = (combo: Combo, ...mods: Modifier[]): boolean =>
  mods.length === combo.modifiers.length && mods.every((m) => combo.modifiers.includes(m))

/**
 * Combos that quit, force-quit, log out, lock, or delete — the ones that
 * "Approve for me" should still stop and ask about. Like the shell deny-list,
 * this catches plausible mistakes; it is not a sandbox.
 */
export function dangerousCombo(combo: Combo, platform: Platform): string | null {
  const key = combo.key
  if (platform === 'darwin') {
    if (key === 'q' && has(combo, 'cmd')) return 'quits the frontmost app'
    if (key === 'q' && has(combo, 'cmd', 'alt')) return 'quits the frontmost app and discards its windows'
    if (key === 'q' && (has(combo, 'cmd', 'shift') || has(combo, 'cmd', 'shift', 'alt'))) return 'logs you out'
    if (key === 'q' && has(combo, 'cmd', 'ctrl')) return 'locks the screen'
    if (key === 'escape' && has(combo, 'cmd', 'alt')) return 'opens Force Quit'
    if (key === 'w' && has(combo, 'cmd', 'alt')) return 'closes every window of the app'
    if ((key === 'backspace' || key === 'delete') && combo.modifiers.includes('cmd')) {
      return combo.modifiers.includes('shift') ? 'empties the Trash' : 'deletes the selection (moves files to the Trash in Finder)'
    }
    return null
  }
  if (key === 'f4' && has(combo, 'alt')) return 'closes the frontmost app'
  if (key === 'delete' && has(combo, 'ctrl', 'alt')) return 'opens the security screen'
  if (key === 'delete' && has(combo, 'shift')) return 'permanently deletes the selection'
  if (key === 'escape' && has(combo, 'ctrl', 'shift')) return 'opens Task Manager'
  if (key === 'l' && has(combo, 'cmd')) return 'locks the screen'
  if (key === 'r' && has(combo, 'cmd')) return 'opens the Run dialog'
  if (key === 'x' && has(combo, 'cmd')) return 'opens the power menu'
  if (platform === 'linux') {
    if (key === 'backspace' && has(combo, 'ctrl', 'alt')) return 'kills the X server'
    if (key && /^f\d+$/.test(key) && has(combo, 'ctrl', 'alt')) return 'switches to a text console'
  }
  return null
}
