/**
 * The in-app browser and its Design Mode, shared by main (screenshots, keys
 * pressed inside a page) and the renderer (the panel, the picker, the tray).
 */

/** Where a picked element comes from in the project's source, when the page says. */
export interface SourceLocation {
  file: string
  line?: number
  column?: number
  /** Read from a stack trace rather than a build plugin: the line may be off. */
  approximate?: boolean
}

/** What the picker reads off a page element when it is clicked in Design Mode. */
export interface PickedElement {
  url: string
  title: string
  /** A CSS selector that finds this element on the page. */
  selector: string
  /** `button.btn.primary`, for labels. */
  label: string
  /** React/Vue/Svelte components from the element outwards, nearest first. */
  components: string[]
  source: SourceLocation | null
  /** The element's markup, trimmed. */
  html: string
  /** The parent's opening tag, for where the element sits. */
  parentTag: string
  text: string
  /** Computed styles that differ from the defaults, as `property: value`. */
  styles: Record<string, string>
  /** In the page's CSS pixels, relative to its viewport. */
  rect: { x: number; y: number; width: number; height: number }
  viewport: { width: number; height: number }
}

/** One element picked in Design Mode, with what the user wants done about it. */
export interface DesignNote {
  id: string
  element: PickedElement
  /** A crop of the element, saved as a PNG for the agent to open. */
  screenshot: string | null
  /** The same crop as a data URL, for the tray's thumbnail. */
  thumbnail: string | null
  note: string
  createdAt: number
}

/** What a key pressed inside a page in the browser asks the panel to do. */
export type BrowserKeyAction =
  | 'annotate'
  | 'focus-address'
  | 'reload'
  | 'new-tab'
  | 'close-tab'
  | 'back'
  | 'forward'
  | 'devtools'
  | 'find'

/** The default for "Annotate page element", in the shortcuts page's glyphs. */
export const ANNOTATE_SHORTCUT = '⇧⌘C'

export interface KeyLike {
  key: string
  meta: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
}

/**
 * Whether a key press matches a binding as the shortcuts page stores it:
 * macOS glyphs ("⇧⌘C") or names ("Ctrl+Shift+C"). ⌘ in a glyph binding is
 * the platform's command key, Ctrl off a Mac, so a default written once
 * works everywhere.
 */
export function matchesBinding(binding: string | null | undefined, event: KeyLike, mac: boolean): boolean {
  if (!binding) return false
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
    }
  } else {
    let rest = binding
    while (rest.length > 1 && '⌃⌥⇧⌘'.includes(rest[0])) {
      const glyph = rest[0]
      if (glyph === '⌃') want.ctrl = true
      if (glyph === '⌥') want.alt = true
      if (glyph === '⇧') want.shift = true
      if (glyph === '⌘') {
        if (mac) want.meta = true
        else want.ctrl = true
      }
      rest = rest.slice(1)
    }
    key = rest
  }
  const named: Record<string, string> = { '↑': 'ArrowUp', '↓': 'ArrowDown', '←': 'ArrowLeft', '→': 'ArrowRight', '↩': 'Enter', '⌫': 'Backspace', '⇥': 'Tab', Space: ' ' }
  key = named[key] ?? key
  return (
    event.key.toLowerCase() === key.toLowerCase() &&
    event.meta === want.meta &&
    event.ctrl === want.ctrl &&
    event.alt === want.alt &&
    event.shift === want.shift
  )
}

/**
 * The browser's own keys, pressed anywhere in the panel or inside a page:
 * the address bar, tabs, history, DevTools. Bindings from Settings → Shortcuts
 * (annotate, the address bar) are checked first by the caller.
 */
export function browserKey(event: KeyLike, mac: boolean): BrowserKeyAction | null {
  const mod = mac ? event.meta && !event.ctrl : event.ctrl && !event.meta
  if (!mod) return null
  const key = event.key.toLowerCase()
  if (event.alt) return key === 'i' && !event.shift ? 'devtools' : null
  if (event.shift) return null
  switch (key) {
    case 'r':
      return 'reload'
    case 't':
      return 'new-tab'
    case 'w':
      return 'close-tab'
    case '[':
      return 'back'
    case ']':
      return 'forward'
    case 'f':
      return 'find'
    default:
      return null
  }
}
