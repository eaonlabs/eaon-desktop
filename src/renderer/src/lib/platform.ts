/**
 * The platform the renderer runs on, and the keys and words that change with
 * it. The app grew up on macOS, so ⌘ and "Finder" are easy to leave in by
 * habit; on Windows and Linux the shortcut key is Ctrl and the file manager
 * has another name.
 */

/**
 * The main-process tests import a few renderer modules under plain Node,
 * where there is no window; none of them look at the platform.
 */
export const platform: 'darwin' | 'win32' | 'linux' = typeof window === 'undefined' ? 'darwin' : window.api.platform
export const isMac = platform === 'darwin'
export const isWindows = platform === 'win32'
export const isLinux = platform === 'linux'

/** A DOM or a React keyboard event. */
interface Modifiers {
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  getModifierState?(key: 'AltGraph'): boolean
}

/**
 * Whether the platform's shortcut key is held: ⌘ on macOS, Ctrl elsewhere.
 *
 * Off macOS a chord with Alt never counts. Windows reports AltGr as Ctrl+Alt,
 * and AltGr is how many layouts type everyday characters (@ and € on German,
 * { and } on Polish and Czech), so Ctrl+Alt+anything would otherwise fire app
 * shortcuts mid-sentence. The Windows key is left to the system.
 */
export function modKey(event: Modifiers): boolean {
  if (isMac) return event.metaKey
  if (event.getModifierState?.('AltGraph')) return false
  return event.ctrlKey && !event.altKey && !event.metaKey
}

/** The shortcut key as written before a key: "⌘" as in ⌘K, or "Ctrl+" as in Ctrl+K. */
export const modLabel = isMac ? '⌘' : 'Ctrl+'

const GLYPHS: Record<string, string> = { '⌃': 'Ctrl', '⌥': 'Alt', '⇧': 'Shift', '⌘': 'Ctrl' }
const KEYS: Record<string, string> = { '↩': 'Enter', '⌫': 'Backspace', '⇥': 'Tab', '⎋': 'Esc' }

/**
 * A shortcut as this platform writes it. Bindings are stored the macOS way
 * ("⇧⌘N", the defaults in main/store.ts), where ⌘ means the shortcut key;
 * off macOS that reads "Ctrl+Shift+N". Anything else, such as a binding
 * recorded on Windows as "Ctrl+Shift+N", is shown as it is.
 */
export function shortcutLabel(binding: string): string {
  if (isMac) return binding
  const modifiers = new Set<string>()
  let rest = binding
  while (rest.length > 1 && GLYPHS[rest[0]]) {
    modifiers.add(GLYPHS[rest[0]])
    rest = rest.slice(1)
  }
  if (modifiers.size === 0) return KEYS[binding] ?? binding
  const ordered = ['Ctrl', 'Alt', 'Shift'].filter((name) => modifiers.has(name))
  return [...ordered, KEYS[rest] ?? rest].join('+')
}

/**
 * "Show in Finder" in this platform's words. Linux has no one file manager
 * (Files, Dolphin, Thunar…), so there it names the place instead.
 */
export function revealLabel(verb: 'Show' | 'Reveal' = 'Show'): string {
  if (isMac) return `${verb} in Finder`
  if (isWindows) return `${verb} in File Explorer`
  return 'Show in folder'
}
