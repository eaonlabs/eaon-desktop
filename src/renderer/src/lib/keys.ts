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
  /** The modifiers on Windows and Linux when they differ from a Mac's (⌘F is Ctrl+Shift+F in a terminal, where Ctrl+F is the shell's). */
  otherModifiers?: Modifier[]
}

export const SHORTCUTS: Shortcut[] = [
  { id: 'new-chat', label: 'New chat', modifiers: ['mod'], key: 'N' },
  { id: 'new-window', label: 'New window', modifiers: ['alt', 'mod'], key: 'N' },
  { id: 'archive-chat', label: 'Archive the open chat', modifiers: ['shift', 'mod'], key: 'A' },
  { id: 'tab-chat', label: 'Go to Chat', modifiers: ['mod'], key: '1' },
  { id: 'tab-workers', label: 'Go to Workers', modifiers: ['mod'], key: '2' },
  { id: 'tab-ade', label: 'Go to the ADE', modifiers: ['mod'], key: '3' },
  { id: 'toggle-sidebar', label: 'Show or hide the sidebar', modifiers: ['mod'], key: 'B' },
  { id: 'toggle-browser', label: 'Show or hide the browser panel (Chat and the ADE)', modifiers: ['shift', 'mod'], key: 'B' },
  { id: 'annotate-page-element', label: 'Point at a page element in the browser (Design Mode)', modifiers: ['shift', 'mod'], key: 'C' },
  { id: 'plugins', label: 'Open Plugins', modifiers: ['shift', 'mod'], key: 'P' },
  { id: 'settings', label: 'Open Settings', modifiers: ['mod'], key: ',' }
]

/**
 * In a chat, handled where they act (ChatView's find, chatCode/CodeTools'
 * terminal and project search, the model picker); listed here so the
 * Shortcuts page is complete.
 */
export const CHAT_SHORTCUTS: Shortcut[] = [
  { id: 'find-chat', label: 'Find in the conversation', modifiers: ['mod'], key: 'F' },
  { id: 'find-project', label: 'Find in the project (a project’s chats)', modifiers: ['shift', 'mod'], key: 'F' },
  { id: 'toggle-terminal', label: 'Show or hide the terminal (a project’s chats)', modifiers: ['mod'], key: 'J' },
  { id: 'pick-model', label: 'Pick a model, with the model menu open', modifiers: ['mod'], key: '1–9' }
]

/**
 * In the ADE (the terminals' view), handled where they act: the window-level
 * keys in CodeView (shared/adeKeys.ts says which chord is which) and the
 * terminal's own key handler (code/terminal/registry.ts). They work with a
 * terminal focused too: the terminal lets them through instead of sending
 * them to the shell.
 */
export const ADE_SHORTCUTS: Shortcut[] = [
  { id: 'ade-find', label: 'Find in the focused terminal’s output', modifiers: ['mod'], key: 'F', otherModifiers: ['shift', 'mod'] },
  { id: 'ade-pane-next', label: 'Focus the next terminal', modifiers: ['shift', 'mod'], key: ']' },
  { id: 'ade-pane-prev', label: 'Focus the previous terminal', modifiers: ['shift', 'mod'], key: '[' },
  { id: 'ade-maximize', label: 'Fill the view with the focused terminal, or give the grid back', modifiers: ['shift', 'mod'], key: 'Enter' },
  { id: 'ade-session-n', label: 'Open session 1–9 in the sidebar, counted from the top', modifiers: ['alt', 'mod'], key: '1–9' },
  { id: 'ade-session-next', label: 'Open the next session', modifiers: ['alt', 'mod'], key: '↓' },
  { id: 'ade-session-prev', label: 'Open the previous session', modifiers: ['alt', 'mod'], key: '↑' },
  { id: 'ade-new-session', label: 'New session', modifiers: ['shift', 'mod'], key: 'N' },
  // A file path in a terminal (src/app.ts:42) opens beside the terminals when clicked.
  { id: 'ade-path-external', label: 'Open a file path in a terminal in your editor, not beside the terminals', modifiers: ['mod'], key: 'click' }
]

/** In the message box; listed with the others so the page is complete. */
export const COMPOSER_SHORTCUTS: Shortcut[] = [
  { id: 'send', label: 'Send the message', modifiers: [], key: 'Enter' },
  { id: 'queue', label: 'Queue a follow-up, while a reply is being written', modifiers: [], key: 'Enter' },
  { id: 'newline', label: 'New line', modifiers: ['shift'], key: 'Enter' },
  { id: 'history', label: 'Your earlier messages, from an empty message box', modifiers: [], key: '↑ ↓' },
  { id: 'cancel-edit', label: 'Stop editing a message you sent', modifiers: [], key: 'Esc' }
]

/** How a shortcut is written on this platform: ⇧⌘A on a Mac, Ctrl+Shift+A elsewhere. */
export function formatShortcut(shortcut: Pick<Shortcut, 'modifiers' | 'key' | 'otherModifiers'>, mac: boolean): string {
  const modifiers = !mac && shortcut.otherModifiers ? shortcut.otherModifiers : shortcut.modifiers
  const has = (m: Modifier): boolean => modifiers.includes(m)
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
