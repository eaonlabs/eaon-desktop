/**
 * Turns raw terminal input into key, paste and mouse events.
 *
 * Terminals send keys as bytes and escape sequences that differ by
 * terminal and by modifier; this normalises the common ones (xterm, iTerm2,
 * Terminal.app, kitty's and xterm's extended forms of Shift+Enter) into
 * `{ name, ctrl, meta, shift }`. A lone Esc is ambiguous with the start of a
 * sequence, so it is reported only after a short pause with nothing after it.
 * Bracketed paste arrives as one `paste` event, so a pasted newline never
 * sends a message.
 */

export interface KeyEvent {
  type: 'key'
  /** `a`, `enter`, `up`, `f1`, `backspace`, `escape`, `tab`, `space`… Printable keys are their character. */
  name: string
  /** The text a printable key types; absent for special keys and chords. */
  ch?: string
  ctrl: boolean
  meta: boolean
  shift: boolean
}

export interface PasteEvent {
  type: 'paste'
  text: string
}

export interface MouseEvent {
  type: 'mouse'
  action: 'down' | 'up' | 'wheelup' | 'wheeldown' | 'drag'
  button: number
  x: number
  y: number
}

export type InputEvent = KeyEvent | PasteEvent | MouseEvent

const key = (name: string, mods: Partial<Pick<KeyEvent, 'ctrl' | 'meta' | 'shift'>> = {}, ch?: string): KeyEvent => ({
  type: 'key',
  name,
  ...(ch !== undefined ? { ch } : {}),
  ctrl: mods.ctrl ?? false,
  meta: mods.meta ?? false,
  shift: mods.shift ?? false
})

const CSI_TILDE: Record<string, string> = {
  '1': 'home',
  '2': 'insert',
  '3': 'delete',
  '4': 'end',
  '5': 'pageup',
  '6': 'pagedown',
  '7': 'home',
  '8': 'end',
  '11': 'f1',
  '12': 'f2',
  '13': 'f3',
  '14': 'f4',
  '15': 'f5',
  '17': 'f6',
  '18': 'f7',
  '19': 'f8',
  '20': 'f9',
  '21': 'f10',
  '23': 'f11',
  '24': 'f12'
}

const CSI_LETTER: Record<string, string> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  P: 'f1',
  Q: 'f2',
  R: 'f3',
  S: 'f4',
  Z: 'tab'
}

/** Modifier parameter of an xterm sequence: 1 + (shift | alt<<1 | ctrl<<2). */
function mods(param: string | undefined): Pick<KeyEvent, 'ctrl' | 'meta' | 'shift'> {
  const n = Math.max(0, Number(param ?? 1) - 1)
  return { shift: Boolean(n & 1), meta: Boolean(n & 2), ctrl: Boolean(n & 4) }
}

function codepointKey(code: number, m: Pick<KeyEvent, 'ctrl' | 'meta' | 'shift'>): KeyEvent {
  if (code === 13) return key('enter', m)
  if (code === 9) return key('tab', m)
  if (code === 27) return key('escape', m)
  if (code === 127 || code === 8) return key('backspace', m)
  if (code === 32) return key('space', m, m.ctrl || m.meta ? undefined : ' ')
  const ch = String.fromCodePoint(code)
  return key(ch.toLowerCase(), m, m.ctrl || m.meta ? undefined : ch)
}

/**
 * Parses one complete chunk of input. Returns the events and whatever was
 * left unparsed at the end (an escape sequence cut in half by the read).
 */
export function parseInput(data: string): { events: InputEvent[]; rest: string } {
  const events: InputEvent[] = []
  let i = 0
  while (i < data.length) {
    const c = data[i]

    if (c === '\x1b') {
      const next = data[i + 1]
      if (next === undefined) return { events, rest: data.slice(i) }

      // Bracketed paste.
      if (data.startsWith('\x1b[200~', i)) {
        const end = data.indexOf('\x1b[201~', i + 6)
        if (end === -1) return { events, rest: data.slice(i) }
        events.push({ type: 'paste', text: data.slice(i + 6, end).replace(/\r\n?/g, '\n') })
        i = end + 6
        continue
      }

      if (next === '[') {
        // SGR mouse: ESC [ < b ; x ; y (M|m)
        const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(data.slice(i))
        if (mouse) {
          const b = Number(mouse[1])
          const x = Number(mouse[2]) - 1
          const y = Number(mouse[3]) - 1
          const action: MouseEvent['action'] =
            b & 64 ? (b & 1 ? 'wheeldown' : 'wheelup') : b & 32 ? 'drag' : mouse[4] === 'm' ? 'up' : 'down'
          events.push({ type: 'mouse', action, button: b & 3, x, y })
          i += mouse[0].length
          continue
        }
        const m = /^\x1b\[([\d;:]*)([A-Za-z~^$@])/.exec(data.slice(i))
        if (!m) {
          if (data.length - i < 16 && !/[A-Za-z~]/.test(data.slice(i + 2))) return { events, rest: data.slice(i) }
          events.push(key('escape'))
          i += 1
          continue
        }
        const params = m[1].split(';')
        const final = m[2]
        if (final === '~') {
          // xterm modifyOtherKeys: ESC [ 27 ; mod ; code ~
          if (params[0] === '27' && params[2]) events.push(codepointKey(Number(params[2]), mods(params[1])))
          else {
            const name = CSI_TILDE[params[0]]
            if (name) events.push(key(name, mods(params[1])))
          }
        } else if (final === 'u') {
          // kitty keyboard protocol: ESC [ code ; mod u
          events.push(codepointKey(Number(params[0].split(':')[0]), mods(params[1])))
        } else if (final === 'Z') {
          events.push(key('tab', { shift: true }))
        } else {
          const name = CSI_LETTER[final]
          if (name) events.push(key(name, mods(params.length > 1 ? params[1] : params[0] && params[0] !== '1' ? params[0] : undefined)))
        }
        i += m[0].length
        continue
      }

      if (next === 'O') {
        const third = data[i + 2]
        if (third === undefined) return { events, rest: data.slice(i) }
        const name = CSI_LETTER[third]
        if (name) events.push(key(name))
        i += 3
        continue
      }

      if (next === '\x1b') {
        events.push(key('escape'))
        i += 1
        continue
      }

      // Alt/Option + key (terminals that send Option as Esc+key).
      if (next === '\r') events.push(key('enter', { meta: true }))
      else if (next === '\x7f') events.push(key('backspace', { meta: true }))
      else if (next === 'b') events.push(key('left', { meta: true }))
      else if (next === 'f') events.push(key('right', { meta: true }))
      else events.push(key(next.toLowerCase(), { meta: true, shift: next !== next.toLowerCase() }))
      i += 2
      continue
    }

    const code = c.codePointAt(0)!
    if (code === 13) events.push(key('enter'))
    else if (code === 10) events.push(key('j', { ctrl: true }))
    else if (code === 9) events.push(key('tab'))
    else if (code === 127 || code === 8) events.push(key('backspace'))
    else if (code === 0) events.push(key('space', { ctrl: true }))
    else if (code < 27) events.push(key(String.fromCharCode(code + 96), { ctrl: true }))
    else if (code < 32) events.push(key(String.fromCharCode(code + 64).toLowerCase(), { ctrl: true }))
    else if (c === ' ') events.push(key('space', {}, ' '))
    else {
      const ch = String.fromCodePoint(code)
      events.push(key(ch.length === 1 && ch !== ch.toLowerCase() ? ch.toLowerCase() : ch, { shift: ch !== ch.toLowerCase() }, ch))
      i += ch.length
      continue
    }
    i += 1
  }
  return { events, rest: '' }
}

/**
 * While set, stdin goes here byte for byte instead of being parsed into
 * events: an embedded terminal (Claude Code) gets exactly what was typed —
 * its own escape sequences, pastes and all. The sink returns false for input
 * it leaves to the app.
 */
let rawSink: ((chunk: string) => boolean) | null = null
export function setRawInput(sink: ((chunk: string) => boolean) | null): void {
  rawSink = sink
}

/** Reads stdin in raw mode and hands events to `onEvent` until `stop` is called. */
export function startInput(onEvent: (event: InputEvent) => void, stdin: NodeJS.ReadStream = process.stdin): () => void {
  let pending = ''
  let escTimer: ReturnType<typeof setTimeout> | null = null
  if (stdin.isTTY) stdin.setRawMode(true)
  stdin.setEncoding('utf8')
  stdin.resume()

  const flushEscape = (): void => {
    escTimer = null
    if (!pending) return
    const leftover = pending
    pending = ''
    // A lone Esc, or the start of a sequence that never finished: Esc, then
    // whatever followed it as ordinary keys.
    onEvent(key('escape'))
    if (leftover.length > 1) for (const event of parseInput(leftover.slice(1)).events) onEvent(event)
  }

  const onData = (chunk: string): void => {
    if (rawSink && !pending && rawSink(chunk)) return
    if (escTimer) {
      clearTimeout(escTimer)
      escTimer = null
    }
    const { events, rest } = parseInput(pending + chunk)
    pending = rest
    for (const event of events) onEvent(event)
    // A paste still arriving can be long; only a short tail is an unfinished key.
    if (pending && !pending.startsWith('\x1b[200~')) escTimer = setTimeout(flushEscape, 30)
  }
  stdin.on('data', onData)
  return () => {
    stdin.off('data', onData)
    if (escTimer) clearTimeout(escTimer)
    if (stdin.isTTY) stdin.setRawMode(false)
    stdin.pause()
  }
}

/** "ctrl+c", "shift+tab", "f1", "a": what a binding is written as. */
export function chord(event: KeyEvent): string {
  return `${event.ctrl ? 'ctrl+' : ''}${event.meta ? 'alt+' : ''}${event.shift && event.name.length > 1 ? 'shift+' : ''}${event.name}`
}
