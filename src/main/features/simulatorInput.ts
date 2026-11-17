import type { HardwareButton, SimOrientation, TouchFrame } from '@shared/simulatorPane'

/**
 * What goes over serve-sim's control socket, and the frames that come back
 * from its video stream. serve-sim (github.com/EvanBacon/serve-sim, bundled)
 * runs a small native helper that reads a booted simulator's screen and
 * posts touches, keys and buttons into it through Xcode's own simulator
 * frameworks, so the pane needs nothing but Xcode.
 *
 * Every message is one tag byte and then JSON. Touches are in fractions of
 * the screen in its native portrait frame; keys are USB HID usages.
 */

export const TAG = { touch: 0x03, button: 0x04, key: 0x06, rotate: 0x07, config: 130 } as const

export function message(tag: number, payload: unknown): Buffer {
  return Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(payload))])
}

export interface KeyFrame {
  type: 'down' | 'up'
  usage: number
}

/** The screen's size and how it is turned, which serve-sim sends on connecting and after every turn. */
export function readConfig(data: Buffer): { width?: number; height?: number; orientation?: SimOrientation } | null {
  if (data[0] !== TAG.config) return null
  try {
    return JSON.parse(data.subarray(1).toString('utf8')) as { width?: number; height?: number; orientation?: SimOrientation }
  } catch {
    return null
  }
}

export const touchMessage = (touch: TouchFrame): Buffer => message(TAG.touch, touch)

/** Buttons by what the pane calls them: Home is serve-sim's own, the rest HID usages. */
const BUTTONS: Record<HardwareButton, Record<string, unknown>> = {
  home: { button: 'home' },
  lock: { button: 'power', page: 12, usage: 48 },
  'volume-up': { button: 'volume-up', page: 12, usage: 233 },
  'volume-down': { button: 'volume-down', page: 12, usage: 234 },
  action: { button: 'action', page: 11, usage: 45 }
}

export const buttonMessage = (name: HardwareButton): Buffer => message(TAG.button, BUTTONS[name])

/* --------------------------------------------------------------- keyboard */

const SHIFT = 225
const COMMAND = 227

/** The US keyboard: each character's key, and whether it needs Shift. */
const CHARACTERS = new Map<string, { usage: number; shift: boolean }>()
for (let i = 0; i < 26; i++) {
  CHARACTERS.set(String.fromCharCode(97 + i), { usage: 4 + i, shift: false })
  CHARACTERS.set(String.fromCharCode(65 + i), { usage: 4 + i, shift: true })
}
'1234567890'.split('').forEach((digit, i) => CHARACTERS.set(digit, { usage: 30 + i, shift: false }))
'!@#$%^&*()'.split('').forEach((symbol, i) => CHARACTERS.set(symbol, { usage: 30 + i, shift: true }))
for (const [plain, shifted, usage] of [
  ['-', '_', 45],
  ['=', '+', 46],
  ['[', '{', 47],
  [']', '}', 48],
  ['\\', '|', 49],
  [';', ':', 51],
  ["'", '"', 52],
  ['`', '~', 53],
  [',', '<', 54],
  ['.', '>', 55],
  ['/', '?', 56]
] as const) {
  CHARACTERS.set(plain, { usage, shift: false })
  CHARACTERS.set(shifted, { usage, shift: true })
}
CHARACTERS.set(' ', { usage: 44, shift: false })
CHARACTERS.set('\n', { usage: 40, shift: false })
CHARACTERS.set('\t', { usage: 43, shift: false })

/** Keys by their KeyboardEvent.key name. */
const NAMED: Record<string, number> = {
  Enter: 40,
  Escape: 41,
  Backspace: 42,
  Tab: 43,
  Delete: 76,
  Home: 74,
  End: 77,
  PageUp: 75,
  PageDown: 78,
  ArrowRight: 79,
  ArrowLeft: 80,
  ArrowDown: 81,
  ArrowUp: 82
}

const press = (usage: number, shift: boolean): KeyFrame[] => {
  const tap: KeyFrame[] = [
    { type: 'down', usage },
    { type: 'up', usage }
  ]
  return shift ? [{ type: 'down', usage: SHIFT }, ...tap, { type: 'up', usage: SHIFT }] : tap
}

/** One key press, from a KeyboardEvent's key; null for a key the device has no use for. */
export function keyFrames(key: string, shift = false): KeyFrame[] | null {
  const character = CHARACTERS.get(key)
  if (character) return press(character.usage, character.shift || shift)
  const usage = NAMED[key]
  return usage === undefined ? null : press(usage, shift)
}

/** Text as key presses; null when any of it isn't on a US keyboard (it goes by the pasteboard instead). */
export function textFrames(text: string): KeyFrame[] | null {
  const frames: KeyFrame[] = []
  for (const char of text.replace(/\r\n?/g, '\n')) {
    const character = CHARACTERS.get(char)
    if (!character) return null
    frames.push(...press(character.usage, character.shift))
  }
  return frames
}

/** ⌘V: what pastes on the device once text is on its pasteboard. */
export const pasteFrames: KeyFrame[] = [
  { type: 'down', usage: COMMAND },
  { type: 'down', usage: 25 },
  { type: 'up', usage: 25 },
  { type: 'up', usage: COMMAND }
]

/* ------------------------------------------------------------ the stream */

/**
 * Cuts JPEG frames out of serve-sim's MJPEG stream: each runs from its start
 * marker (FF D8) to its end marker (FF D9), with part headers between them
 * skipped. Inside a frame's compressed data an FF byte is always followed by
 * 00 or a restart marker, so FF D9 there is the real end.
 */
export class JpegFrames {
  private buffer: Buffer = Buffer.alloc(0)

  /** Adds bytes; returns the newest whole frame in them, if any (older ones are dropped, as a viewer would skip them). */
  push(chunk: Buffer): Buffer | null {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    let newest: Buffer | null = null
    for (;;) {
      const start = this.buffer.indexOf(SOI)
      if (start < 0) {
        // Keep a trailing FF: it may be the first half of the next start marker.
        this.buffer = this.buffer.subarray(this.buffer.length && this.buffer[this.buffer.length - 1] === 0xff ? this.buffer.length - 1 : this.buffer.length)
        break
      }
      const end = this.buffer.indexOf(EOI, start + 2)
      if (end < 0) {
        this.buffer = this.buffer.subarray(start)
        break
      }
      newest = Buffer.from(this.buffer.subarray(start, end + 2))
      this.buffer = this.buffer.subarray(end + 2)
    }
    // A stream that never ends a frame doesn't grow without bound.
    if (this.buffer.length > 32 * 1024 * 1024) this.buffer = Buffer.alloc(0)
    return newest
  }
}

const SOI = Buffer.from([0xff, 0xd8])
const EOI = Buffer.from([0xff, 0xd9])

/** A JPEG's size in pixels, from its frame header; null when it has none. */
export function jpegSize(data: Buffer): { width: number; height: number } | null {
  let at = 2
  while (at + 9 < data.length) {
    if (data[at] !== 0xff) return null
    const marker = data[at + 1]
    // Any start-of-frame marker but DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: data.readUInt16BE(at + 5), width: data.readUInt16BE(at + 7) }
    }
    at += 2 + data.readUInt16BE(at + 2)
  }
  return null
}

/**
 * The screen's scale when its device type doesn't say: iPads and the iPhones
 * with an LCD screen are 2×, every other iPhone 3×.
 */
export function guessScale(name: string): number {
  if (/iPad/i.test(name)) return 2
  if (/iPhone (SE|XR|11$|8|7|6)/i.test(name)) return 2
  return 3
}
