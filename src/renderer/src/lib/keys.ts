/**
 * The app's keyboard shortcuts, one list for the keys that work and the page
 * that shows them. ⌘ on a Mac is Ctrl on Windows and Linux, as in every
 * cross-platform app; the menu's accelerators (main/index.ts, CmdOrCtrl) and
 * App.tsx's GlobalKeys follow the same rule.
 */

export type Modifier = 'mod' | 'shift' | 'alt'

export interface Shortcut {
  id: string
  label: string
  modifiers: Modifier[]
  key: string
}

export const SHORTCUTS: Shortcut[] = [
  { id: 'new-chat', label: 'New chat', modifiers: ['mod'], key: 'N' },
  { id: 'new-window', label: 'New window', modifiers: ['alt', 'mod'], key: 'N' },
  { id: 'archive-chat', label: 'Archive the open chat', modifiers: ['shift', 'mod'], key: 'A' },
  { id: 'tab-chat', label: 'Go to Chat', modifiers: ['mod'], key: '1' },
  { id: 'tab-workers', label: 'Go to Workers', modifiers: ['mod'], key: '2' },
  { id: 'tab-ade', label: 'Go to the ADE', modifiers: ['mod'], key: '3' },
  { id: 'toggle-sidebar', label: 'Show or hide the sidebar', modifiers: ['mod'], key: 'B' },
  { id: 'toggle-browser', label: 'Show or hide the browser panel (Chat)', modifiers: ['shift', 'mod'], key: 'B' },
  { id: 'plugins', label: 'Open Plugins', modifiers: ['shift', 'mod'], key: 'P' },
  { id: 'settings', label: 'Open Settings', modifiers: ['mod'], key: ',' }
]

/** In the message box; listed with the others so the page is complete. */
export const COMPOSER_SHORTCUTS: Shortcut[] = [
  { id: 'send', label: 'Send the message', modifiers: [], key: 'Enter' },
  { id: 'newline', label: 'New line', modifiers: ['shift'], key: 'Enter' }
]

/** How a shortcut is written on this platform: ⇧⌘A on a Mac, Ctrl+Shift+A elsewhere. */
export function formatShortcut(shortcut: Pick<Shortcut, 'modifiers' | 'key'>, mac: boolean): string {
  const has = (m: Modifier): boolean => shortcut.modifiers.includes(m)
  if (mac) {
    // Apple's order: Control, Option, Shift, Command.
    const key = shortcut.key === 'Enter' ? '↩' : shortcut.key
    return `${has('alt') ? '⌥' : ''}${has('shift') ? '⇧' : ''}${has('mod') ? '⌘' : ''}${key}`
  }
  return [has('mod') && 'Ctrl', has('alt') && 'Alt', has('shift') && 'Shift', shortcut.key].filter(Boolean).join('+')
}

/**
 * The platform's command modifier, and only it: ⌘ on a Mac, Ctrl elsewhere.
 * Ctrl on a Mac stays with text fields and terminals (⌃A, ⌃E), and ⊞ on
 * Windows with the system.
 */
export function hasCommandModifier(event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey'>, mac: boolean): boolean {
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

export const isMacPlatform = (): boolean => typeof window !== 'undefined' && window.api?.platform === 'darwin'
