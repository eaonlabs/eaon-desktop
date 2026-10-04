import type { Canvas } from './screen'
import type { Style } from './term'

/**
 * Numbers three rows tall for the desk's balance: each digit is a classic
 * 3×5 pixel glyph drawn with half blocks (two pixels a row), so it reads
 * from across the room and every digit, 8 included, is unmistakable. Only
 * digits and the separators a balance needs.
 */
const GLYPHS: Record<string, [string, string, string]> = {
  '0': ['█▀█', '█ █', '▀▀▀'],
  '1': ['▄█ ', ' █ ', '▀▀▀'],
  '2': ['▀▀█', '█▀▀', '▀▀▀'],
  '3': ['▀▀█', '▀▀█', '▀▀▀'],
  '4': ['█ █', '▀▀█', '  ▀'],
  '5': ['█▀▀', '▀▀█', '▀▀▀'],
  '6': ['█▀▀', '█▀█', '▀▀▀'],
  '7': ['▀▀█', '  █', '  ▀'],
  '8': ['█▀█', '█▀█', '▀▀▀'],
  '9': ['█▀█', '▀▀█', '▀▀▀'],
  ',': [' ', ' ', '█'],
  '.': [' ', ' ', '▀'],
  '-': ['   ', '▀▀▀', '   '],
  ' ': [' ', ' ', ' ']
}

export const BIG_ROWS = 3

/** Columns `text` takes in the big font. */
export function bigWidth(text: string): number {
  let w = 0
  for (const ch of text) w += (GLYPHS[ch]?.[0].length ?? 0) + (GLYPHS[ch] ? 1 : 0)
  return Math.max(0, w - 1)
}

/** Draws `text` three rows tall from (x, y); characters the font lacks are skipped. Returns the width. */
export function drawBig(c: Canvas, x: number, y: number, text: string, style: Style): number {
  let col = x
  for (const ch of text) {
    const glyph = GLYPHS[ch]
    if (!glyph) continue
    glyph.forEach((row, i) => c.text(col, y + i, row, style))
    col += glyph[0].length + 1
  }
  return Math.max(0, col - x - 1)
}
