/**
 * The ADE's keyboard shortcuts: moving between its terminals and sessions
 * without the mouse. Which chord means what is decided here, apart from the
 * window, so it can be tested; the ADE (CodeView) carries the action out, and
 * the terminal's key handler (registry.ts) lets these chords through to it
 * instead of sending them to the shell.
 *
 * Chords are matched by the physical key (`code`) wherever the character
 * changes with the layout or the modifiers: ⌥1 types ¡ on a Mac, and ⇧] types
 * }. ⌘ on a Mac is Ctrl elsewhere.
 */

export type AdeKeyAction =
  /** Focus the next (1) or previous (-1) terminal of the open session, wrapping round. */
  | { do: 'pane'; step: 1 | -1 }
  /** Make the focused terminal fill the view, or give the grid back. */
  | { do: 'maximize' }
  /** Open the nth session in the sidebar (counted from 0). */
  | { do: 'session'; index: number }
  /** Open the next (1) or previous (-1) session in the sidebar. */
  | { do: 'session-step'; step: 1 | -1 }
  | { do: 'new-session' }

export interface KeyLike {
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  getModifierState?(key: 'AltGraph'): boolean
}

/**
 * The shortcut key and nothing else of ⌘, Ctrl, the Windows key: ⌘ on a Mac,
 * Ctrl elsewhere. Windows reports AltGr as Ctrl+Alt, which is how many
 * layouts type everyday characters, so a Ctrl+Alt chord there only counts
 * when it is not AltGr (the browser says which).
 */
function modHeld(e: KeyLike, mac: boolean): boolean {
  if (mac) return e.metaKey && !e.ctrlKey
  return e.ctrlKey && !e.metaKey && !e.getModifierState?.('AltGraph')
}

/** What a key press asks of the ADE, or null when it is none of its shortcuts. */
export function adeKeyAction(e: KeyLike, mac: boolean): AdeKeyAction | null {
  if (!modHeld(e, mac)) return null
  if (e.altKey && !e.shiftKey) {
    const digit = /^Digit([1-9])$/.exec(e.code)
    if (digit) return { do: 'session', index: Number(digit[1]) - 1 }
    if (e.code === 'ArrowDown') return { do: 'session-step', step: 1 }
    if (e.code === 'ArrowUp') return { do: 'session-step', step: -1 }
    return null
  }
  if (e.shiftKey && !e.altKey) {
    if (e.code === 'BracketRight') return { do: 'pane', step: 1 }
    if (e.code === 'BracketLeft') return { do: 'pane', step: -1 }
    if (e.key === 'Enter') return { do: 'maximize' }
    if (e.code === 'KeyN') return { do: 'new-session' }
  }
  return null
}

/** The pane `step` places on from `current` in the grid's order, wrapping round; the first (or last) when `current` is none of them. */
export function paneAfter(ids: readonly string[], current: string | null, step: 1 | -1): string | null {
  if (ids.length === 0) return null
  const at = current === null ? -1 : ids.indexOf(current)
  if (at < 0) return step === 1 ? ids[0] : ids[ids.length - 1]
  return ids[(at + step + ids.length) % ids.length]
}

/** The session `step` places on from `current` in the sidebar's order, wrapping round; the first (or last) when none is open. */
export function sessionAfter<T extends { id: string }>(sessions: readonly T[], current: string | null, step: 1 | -1): T | null {
  const found = paneAfter(
    sessions.map((s) => s.id),
    current,
    step
  )
  return sessions.find((s) => s.id === found) ?? null
}
