/**
 * Keys as VNC sends them: X11 keysyms. Agents name keys the way people do
 * ("ctrl+shift+t", "enter", "cmd+space"), and type text character by
 * character; this turns both into keysyms. Command on a Mac guest is Super,
 * Option is Alt, which is how Apple's VNC server reads them.
 */

const NAMED: Record<string, number> = {
  enter: 0xff0d,
  return: 0xff0d,
  tab: 0xff09,
  escape: 0xff1b,
  esc: 0xff1b,
  backspace: 0xff08,
  delete: 0xffff,
  del: 0xffff,
  insert: 0xff63,
  home: 0xff50,
  end: 0xff57,
  pageup: 0xff55,
  pagedown: 0xff56,
  left: 0xff51,
  up: 0xff52,
  right: 0xff53,
  down: 0xff54,
  space: 0x20,
  shift: 0xffe1,
  ctrl: 0xffe3,
  control: 0xffe3,
  alt: 0xffe9,
  option: 0xffe9,
  opt: 0xffe9,
  meta: 0xffeb,
  super: 0xffeb,
  cmd: 0xffeb,
  command: 0xffeb,
  win: 0xffeb,
  windows: 0xffeb,
  capslock: 0xffe5,
  printscreen: 0xff61,
  menu: 0xff67
}
for (let n = 1; n <= 24; n++) NAMED[`f${n}`] = 0xffbe + n - 1

const MODIFIERS = new Set([0xffe1, 0xffe3, 0xffe9, 0xffeb])
export const SHIFT = 0xffe1

/**
 * Apple's VNC server (VMs on a Mac) ignores Alt's own keysym and reads Meta as Alt (Option on a
 * Mac guest); QEMU's reads Alt as Alt. Keys go through this before they're sent to a Mac's VM.
 */
export const forAppleVnc = (keysym: number): number => (keysym === 0xffe9 ? 0xffe7 : keysym === 0xffea ? 0xffe8 : keysym)

/** The keysym for one character of text. */
export function charKeysym(char: string): number {
  if (char === '\n' || char === '\r') return 0xff0d
  if (char === '\t') return 0xff09
  const code = char.codePointAt(0) ?? 0x20
  // Latin-1 keysyms are the characters' own codes; everything else is Unicode's, offset.
  return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) ? code : 0x01000000 + code
}

const SHIFTED = new Set('~!@#$%^&*()_+{}|:"<>?')
/** Whether a US keyboard needs Shift for this character; some servers want it held explicitly. */
export const needsShift = (char: string): boolean => (char >= 'A' && char <= 'Z') || SHIFTED.has(char)

/**
 * "ctrl+shift+t" as keysyms, modifiers first, in the order to press them.
 * Throws with the name it didn't know, for the agent to fix.
 */
export function parseCombo(combo: string): number[] {
  const parts = combo
    .split(/\s*\+\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) throw new Error('No key was named.')
  const keys = parts.map((part) => {
    const named = NAMED[part.toLowerCase()]
    if (named !== undefined) return named
    if ([...part].length === 1) return charKeysym(part.length === 1 && parts.length > 1 ? part.toLowerCase() : part)
    throw new Error(`“${part}” isn’t a key this knows. Use names like enter, tab, esc, ctrl, alt, shift, cmd, up, f5, or a single character.`)
  })
  return [...keys.filter((k) => MODIFIERS.has(k)), ...keys.filter((k) => !MODIFIERS.has(k))]
}
