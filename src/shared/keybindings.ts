/**
 * Eaon's keyboard shortcuts as data: which commands have a key, what each
 * one's key is out of the box, and the rules for changing it. The menu in the
 * main process, the window's key handler, the browser panel and the Shortcuts
 * page all read a command's key from here (`effectiveBinding`), so a key
 * changed in Settings changes it everywhere.
 *
 * A binding is stored as the Shortcuts page writes it: macOS glyphs, where ⌘
 * is the platform's command key (Ctrl off a Mac), so one default works on
 * every platform: "⇧⌘A", "⌘,". Bindings recorded by name ("Ctrl+Shift+C")
 * are read too.
 */

/**
 * Who listens for a command's key: the app menu (an accelerator, so main has
 * to rebuild the menu when it changes), the window's key handler (App.tsx),
 * both, or one panel's own (the browser, the chat, the project's terminal).
 */
export type BindingScope = 'menu' | 'window' | 'both' | 'panel'

export interface BindableShortcut {
  id: string
  label: string
  /** Which list of the Shortcuts page it belongs to. */
  section: 'app' | 'chat'
  /** The key it has out of the box, in glyphs. */
  default: string
  scope: BindingScope
}

/** Every command whose key can be changed. The order is the page's order. */
export const BINDABLE: readonly BindableShortcut[] = [
  { id: 'command-palette', label: 'Open the command palette', section: 'app', default: '⇧⌘K', scope: 'window' },
  { id: 'new-chat', label: 'New chat', section: 'app', default: '⌘N', scope: 'menu' },
  { id: 'new-window', label: 'New window', section: 'app', default: '⌥⌘N', scope: 'menu' },
  { id: 'archive-chat', label: 'Archive the open chat', section: 'app', default: '⇧⌘A', scope: 'menu' },
  { id: 'tab-chat', label: 'Go to Chat', section: 'app', default: '⌘1', scope: 'window' },
  { id: 'tab-workers', label: 'Go to Workers', section: 'app', default: '⌘2', scope: 'window' },
  { id: 'tab-ade', label: 'Go to the ADE', section: 'app', default: '⌘3', scope: 'window' },
  { id: 'toggle-sidebar', label: 'Show or hide the sidebar', section: 'app', default: '⌘B', scope: 'both' },
  { id: 'toggle-browser', label: 'Show or hide the browser panel (Chat and the ADE)', section: 'app', default: '⇧⌘B', scope: 'menu' },
  { id: 'annotate-page-element', label: 'Point at a page element in the browser (Design Mode)', section: 'app', default: '⇧⌘C', scope: 'panel' },
  { id: 'focus-browser-address-bar', label: 'Go to the browser’s address bar', section: 'app', default: '⌘L', scope: 'panel' },
  { id: 'plugins', label: 'Open Plugins', section: 'app', default: '⇧⌘P', scope: 'window' },
  { id: 'settings', label: 'Open Settings', section: 'app', default: '⌘,', scope: 'both' },
  { id: 'find-chat', label: 'Find in the conversation', section: 'chat', default: '⌘F', scope: 'panel' },
  { id: 'find-project', label: 'Find in the project (a project’s chats)', section: 'chat', default: '⇧⌘F', scope: 'panel' },
  { id: 'toggle-terminal', label: 'Show or hide the terminal (a project’s chats)', section: 'chat', default: '⌘J', scope: 'panel' }
]

export const bindable = (id: string): BindableShortcut | undefined => BINDABLE.find((entry) => entry.id === id)

/** What a key press is, whether from the page or from the main process. */
export interface KeyLike {
  key: string
  meta: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  /** The physical key ("KeyA"): what a key typed with Option or Shift is matched by. */
  code?: string
  /** Windows reports AltGr as Ctrl+Alt; a chord typed with it is text, not a shortcut. */
  altGraph?: boolean
}

export interface Chord {
  meta: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  /** One lower-case character, or a name: "enter", "arrowup". */
  key: string
}

const NAMED: Record<string, string> = { '↑': 'arrowup', '↓': 'arrowdown', '←': 'arrowleft', '→': 'arrowright', '↩': 'enter', '⌫': 'backspace', '⇥': 'tab', Space: ' ', Enter: 'enter', Esc: 'escape' }
const MODIFIER_GLYPHS = '⌃⌥⇧⌘'

/** A binding as the modifiers and the key it asks for on this platform, or null when it can't be read. */
export function parseBinding(binding: string | null | undefined, mac: boolean): Chord | null {
  if (typeof binding !== 'string' || !binding) return null
  const want = { meta: false, ctrl: false, alt: false, shift: false }
  let key: string
  if (binding.includes('+') && binding.length > 1) {
    const parts = binding.split('+')
    key = parts.pop() || '+'
    for (const part of parts) {
      const name = part.toLowerCase()
      if (name === 'ctrl') want.ctrl = true
      else if (name === 'alt') want.alt = true
      else if (name === 'shift') want.shift = true
      else if (name === 'win' || name === 'super' || name === 'cmd') want.meta = true
      else return null
    }
  } else {
    let rest = binding
    while (rest.length > 1 && MODIFIER_GLYPHS.includes(rest[0])) {
      const glyph = rest[0]
      if (glyph === '⌃') want.ctrl = true
      else if (glyph === '⌥') want.alt = true
      else if (glyph === '⇧') want.shift = true
      else if (mac) want.meta = true
      else want.ctrl = true
      rest = rest.slice(1)
    }
    key = rest
  }
  key = NAMED[key] ?? key.toLowerCase()
  if (!key || (key.length > 1 && !Object.values(NAMED).includes(key))) return null
  return { ...want, key }
}

/** The physical keys that make the characters a binding can use, so Option and Shift don't change which key it is. */
const CODE_KEYS: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backslash: '\\',
  Backquote: '`'
}

function codeKey(code: string | undefined): string | null {
  if (!code) return null
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  return CODE_KEYS[code] ?? null
}

/**
 * Which key a press was: what it typed when that is a letter or a digit,
 * otherwise (⌥A types å, ⇧1 types !) the key it is on the keyboard.
 */
export function pressedKey(event: Pick<KeyLike, 'key' | 'code'>): string {
  if (/^[a-z0-9]$/i.test(event.key)) return event.key.toLowerCase()
  return codeKey(event.code) ?? (NAMED[event.key] ?? event.key.toLowerCase())
}

/** Whether a key press is `binding`: the same modifiers, and the same key. */
export function matchesChord(binding: string | null | undefined, event: KeyLike, mac: boolean): boolean {
  const want = parseBinding(binding, mac)
  if (!want) return false
  if (!mac && event.altGraph) return false
  return event.meta === want.meta && event.ctrl === want.ctrl && event.alt === want.alt && event.shift === want.shift && pressedKey(event) === want.key
}

/** The same chord however it was written: "⇧⌘A" and "Ctrl+Shift+A" are one on Windows. */
export function canonicalBinding(binding: string | null | undefined, mac: boolean): string | null {
  const chord = parseBinding(binding, mac)
  if (!chord) return null
  return `${chord.meta ? 'meta+' : ''}${chord.ctrl ? 'ctrl+' : ''}${chord.alt ? 'alt+' : ''}${chord.shift ? 'shift+' : ''}${chord.key}`
}

/** The map `settings.shortcuts` holds: a key per command id, null for a command left without one. */
export type ShortcutSettings = Record<string, string | null | undefined> | null | undefined

/**
 * The key a command has now: the one saved for it, or its default. A saved
 * null is a command with no key; a saved value that can't be read is ignored.
 */
export function effectiveBinding(id: string, saved: ShortcutSettings, mac: boolean): string | null {
  const standard = bindable(id)?.default ?? null
  if (!saved || !(id in saved)) return standard
  const value = saved[id]
  if (value === null) return null
  return typeof value === 'string' && parseBinding(value, mac) ? value : standard
}

/** Every bindable command's key now, by id. */
export function effectiveBindings(saved: ShortcutSettings, mac: boolean): Record<string, string | null> {
  return Object.fromEntries(BINDABLE.map((entry) => [entry.id, effectiveBinding(entry.id, saved, mac)]))
}

/** Whether a command's key is its default. */
export const isDefaultBinding = (id: string, saved: ShortcutSettings, mac: boolean): boolean =>
  canonicalBinding(effectiveBinding(id, saved, mac), mac) === canonicalBinding(bindable(id)?.default, mac)

/** Writes a chord in the glyphs the settings keep, ⌘ for the command key. */
export function bindingText(chord: { alt: boolean; shift: boolean; key: string }): string {
  const key = chord.key === ' ' ? 'Space' : chord.key.length === 1 ? chord.key.toUpperCase() : (Object.entries(NAMED).find(([, name]) => name === chord.key)?.[0] ?? chord.key)
  return `${chord.alt ? '⌥' : ''}${chord.shift ? '⇧' : ''}⌘${key}`
}

/** How a binding is written on this platform: ⇧⌘A on a Mac, Ctrl+Shift+A elsewhere. */
export function formatBinding(binding: string | null | undefined, mac: boolean): string {
  const chord = parseBinding(binding, mac)
  if (!chord) return ''
  const glyph: Record<string, string> = { arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', enter: '↩', backspace: '⌫', tab: '⇥', escape: 'Esc', ' ': 'Space' }
  const name: Record<string, string> = { arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', enter: 'Enter', backspace: 'Backspace', tab: 'Tab', escape: 'Esc', ' ': 'Space' }
  if (mac) {
    const key = chord.key.length === 1 ? chord.key.toUpperCase() : (glyph[chord.key] ?? chord.key)
    return `${chord.ctrl ? '⌃' : ''}${chord.alt ? '⌥' : ''}${chord.shift ? '⇧' : ''}${chord.meta ? '⌘' : ''}${key}`
  }
  const key = chord.key.length === 1 ? chord.key.toUpperCase() : (name[chord.key] ?? chord.key)
  return [chord.ctrl && 'Ctrl', chord.meta && 'Win', chord.alt && 'Alt', chord.shift && 'Shift', key].filter(Boolean).join('+')
}

/** The app menu's accelerator for a binding, or null for a command left without a key. */
export function toAccelerator(binding: string | null | undefined, mac: boolean): string | null {
  const chord = parseBinding(binding, mac)
  if (!chord) return null
  const key = chord.key.length === 1 ? chord.key.toUpperCase() : ({ arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', enter: 'Enter', backspace: 'Backspace', tab: 'Tab', escape: 'Escape', ' ': 'Space' } as Record<string, string>)[chord.key]
  if (!key) return null
  const modifiers = [chord.ctrl && 'Ctrl', chord.meta && (mac ? 'Cmd' : 'Super'), chord.alt && 'Alt', chord.shift && 'Shift'].filter(Boolean) as string[]
  return [...modifiers, key].join('+')
}

/* ------------------------------------------------------------- recording */

/**
 * Keys that mean something else already: the editing keys of every text
 * field, the system's and the window's own, and the ones Eaon's editor and
 * browser take. They can't be given to a command, because the command would
 * either never run or take the key from what it does. Written with ⌘ as the
 * command key, as bindings are.
 */
const RESERVED: { binding: string; reason: string; mac?: boolean }[] = [
  { binding: '⌘Q', reason: 'quits Eaon' },
  { binding: '⌘W', reason: 'closes the window' },
  { binding: '⌘C', reason: 'copies' },
  { binding: '⌘V', reason: 'pastes' },
  { binding: '⌘X', reason: 'cuts' },
  { binding: '⌘A', reason: 'selects all' },
  { binding: '⌘Z', reason: 'undoes' },
  { binding: '⇧⌘Z', reason: 'redoes' },
  { binding: '⌘R', reason: 'reloads the window' },
  { binding: '⌘P', reason: 'opens a file by name in a project’s chat' },
  { binding: '⌘S', reason: 'saves a file in the editor' },
  { binding: '⌘K', reason: 'asks the agent about the selection in the editor' },
  { binding: '⌘T', reason: 'opens a new tab in the browser' },
  { binding: '⌘[', reason: 'goes back in the browser' },
  { binding: '⌘]', reason: 'goes forward in the browser' },
  { binding: '⌘0', reason: 'resets the zoom' },
  { binding: '⌘=', reason: 'zooms in' },
  { binding: '⌘-', reason: 'zooms out' },
  { binding: '⌘H', reason: 'hides Eaon', mac: true },
  { binding: '⌘M', reason: 'minimizes the window', mac: true },
  { binding: '⌘`', reason: 'switches between Eaon’s windows', mac: true }
]

/** Why a chord can't be given to a command, or null when it can. */
export function reservedReason(binding: string, mac: boolean): string | null {
  const wanted = canonicalBinding(binding, mac)
  if (!wanted) return null
  for (const entry of RESERVED) {
    if (entry.mac && !mac) continue
    if (canonicalBinding(entry.binding, mac) === wanted) return entry.reason
  }
  return null
}

export type Recorded = { ok: true; binding: string } | { ok: false; waiting: true } | { ok: false; error: string }

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift', 'AltGraph', 'OS', 'CapsLock'])

/**
 * The binding a key press makes while a command is being given a new key. A
 * modifier on its own is still waiting for the key; a chord with no command
 * key (⌘ on a Mac, Ctrl elsewhere) is refused, because a bare letter would
 * stop that letter being typed, and Ctrl on a Mac belongs to text fields and
 * terminals (⌃A and ⌃E move the cursor).
 */
export function recordBinding(event: KeyLike, mac: boolean): Recorded {
  if (MODIFIER_KEYS.has(event.key)) return { ok: false, waiting: true }
  if (!mac && event.altGraph) return { ok: false, error: 'AltGr types characters. Hold Ctrl on its own with the key.' }
  const command = mac ? event.meta && !event.ctrl : event.ctrl && !event.meta
  if (!command) return { ok: false, error: mac ? 'Hold ⌘ with the key. Without it the key would stop typing its letter.' : 'Hold Ctrl with the key. Without it the key would stop typing its letter.' }
  const key = pressedKey(event)
  if (!/^[a-z0-9,./;'[\]\-=\\`]$/.test(key)) return { ok: false, error: 'Use a letter, a number or one of , . / ; \' [ ] - = \\ ` with it.' }
  const binding = bindingText({ alt: event.alt, shift: event.shift, key })
  const reason = reservedReason(binding, mac)
  if (reason) return { ok: false, error: `${formatBinding(binding, mac)} ${reason}, so it can’t be used here.` }
  return { ok: true, binding }
}

/**
 * The other commands that already have `binding`. A command is its own
 * conflict-free: its current key is never reported against itself.
 */
export function conflictsFor(id: string, binding: string | null | undefined, saved: ShortcutSettings, mac: boolean): BindableShortcut[] {
  const wanted = canonicalBinding(binding, mac)
  if (!wanted) return []
  return BINDABLE.filter((entry) => entry.id !== id && canonicalBinding(effectiveBinding(entry.id, saved, mac), mac) === wanted)
}

/**
 * Off a Mac a terminal keeps Ctrl chords for the shell (^C, ^D, ^W…). The
 * ones that belong to the app anyway pass through: those with Shift (a
 * terminal can't tell Ctrl+Shift+P from Ctrl+P), and the number and comma
 * keys. Ctrl+B stays with the shell (readline's back-a-character, tmux's
 * prefix), as it always did. Only commands the window listens for count.
 */
export function isTerminalAppChord(event: KeyLike, saved: ShortcutSettings, mac: boolean): boolean {
  return BINDABLE.some((entry) => {
    if (entry.scope !== 'window' && entry.scope !== 'both') return false
    const binding = effectiveBinding(entry.id, saved, mac)
    const chord = parseBinding(binding, mac)
    if (!chord || !matchesChord(binding, event, mac)) return false
    return chord.shift || /^[0-9,]$/.test(chord.key)
  })
}
