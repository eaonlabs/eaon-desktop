/**
 * The key held down to dictate into an ADE terminal (Settings → ADE → Speech
 * to text). Stored as a `KeyboardEvent.code`, so it means the same physical
 * key whatever the keyboard layout: "AltRight" is the right Option key on a
 * Mac and the right Alt key elsewhere.
 */

/** Held on its own for this long before the microphone opens, so a quick tap or a shortcut never records. */
export const HOLD_DELAY_MS = 250

export const DEFAULT_HOLD_KEY = 'AltRight'

/** Keys that are modifiers: held alone they type nothing, and pressed with another key they make a shortcut. */
const MODIFIERS = new Set(['AltLeft', 'AltRight', 'ControlLeft', 'ControlRight', 'MetaLeft', 'MetaRight', 'ShiftLeft', 'ShiftRight'])

export const isModifierCode = (code: string): boolean => MODIFIERS.has(code)

/**
 * Whether a key can be the one held to talk. Escape cancels a recording and
 * the keys that type, delete or move the cursor are needed in a terminal,
 * so only modifiers, the function keys and a few spare keys are offered.
 * Caps Lock isn't: macOS sends it as a toggle, not as a key held down.
 */
export function holdKeyAllowed(code: string): boolean {
  if (isModifierCode(code)) return true
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return true
  return ['ScrollLock', 'Pause', 'ContextMenu', 'Insert'].includes(code)
}

/** How a key is named on screen, the way each platform's keyboard labels it. */
export function holdKeyLabel(code: string, mac: boolean): string {
  const side = code.endsWith('Left') ? 'Left ' : code.endsWith('Right') ? 'Right ' : ''
  const base = code.replace(/(Left|Right)$/, '')
  switch (base) {
    case 'Alt':
      return `${side}${mac ? 'Option ⌥' : 'Alt'}`
    case 'Meta':
      return `${side}${mac ? 'Command ⌘' : 'Windows'}`
    case 'Control':
      return `${side}${mac ? 'Control ⌃' : 'Ctrl'}`
    case 'Shift':
      return `${side}Shift ⇧`
    case 'ScrollLock':
      return 'Scroll Lock'
    case 'ContextMenu':
      return 'Menu'
    default:
      return code
  }
}
