import type { SeeThroughStyle } from '@shared/types'

/**
 * The wallpaper's styles (Settings → Appearance → Style): each redraws the
 * picture, or a video's frame, at the display's size. All but Photo and
 * Halftone build it from a grid: the picture is shrunk to one pixel per cell,
 * which averages each cell's colour for free, and every cell is drawn as a
 * character, a dot, a tile or a stroke, on the theme's own ground. Cell sizes
 * are in screen points; `scale` is device pixels per point.
 *
 * How much a cell shows is how far it stands from the ground: brighter cells
 * on a dark theme, darker ones on a light theme, stretched over the picture's
 * own range so a dim or a pale wallpaper still uses every step.
 */

export interface StyleInfo {
  id: SeeThroughStyle
  label: string
  hint: string
  /** How often a video is redrawn in this style: text is dearer to draw than shapes. */
  fps: number
}

export const STYLES: StyleInfo[] = [
  { id: 'photo', label: 'Photo', hint: 'The wallpaper as it is', fps: 30 },
  { id: 'halftone', label: 'Halftone', hint: 'A print-style dot screen over the wallpaper itself', fps: 20 },
  { id: 'ascii', label: 'Characters', hint: 'ASCII art, a character per cell in the cell’s own colour', fps: 12 },
  { id: 'tiles', label: 'Tiles', hint: 'Characters set on tinted tiles, like type on a grid', fps: 12 },
  { id: 'blocks', label: 'Blocks', hint: 'Shaded block characters, from light shade to solid', fps: 12 },
  { id: 'braille', label: 'Braille', hint: 'Fine dots from Braille characters, eight to a cell', fps: 12 },
  { id: 'dither', label: 'Dither', hint: 'Ordered dithering: tiny pixels on or off, in the picture’s colours', fps: 20 },
  { id: 'pixel', label: 'Pixel art', hint: 'Big flat pixels in a reduced palette', fps: 24 },
  { id: 'mosaic', label: 'Mosaic', hint: 'Small rounded tiles with grout between them', fps: 24 },
  { id: 'lego', label: 'Bricks', hint: 'Studded bricks, each one the colour beneath it', fps: 20 },
  { id: 'dots', label: 'Dots', hint: 'Coloured dots that grow with the picture’s light', fps: 24 },
  { id: 'cross', label: 'Cross', hint: 'Plus signs that grow with the picture’s light', fps: 24 },
  { id: 'diagonal', label: 'Diagonal', hint: 'Slanted strokes that thicken with the picture’s light', fps: 24 },
  { id: 'diamond', label: 'Diamond', hint: 'Diamonds that grow with the picture’s light', fps: 24 },
  { id: 'lines', label: 'Lines', hint: 'Engraving-style lines that swell with the picture’s light', fps: 24 }
]

export const styleInfo = (id: SeeThroughStyle): StyleInfo => STYLES.find((s) => s.id === id) ?? STYLES[0]

/** Draws the picture (or the frame) to fill `width` × `height` of a context. */
export type Paint = (ctx: CanvasRenderingContext2D, width: number, height: number) => void

/** The theme's ground under the grid styles. */
const ground = (light: boolean): string => (light ? '#f4f3f1' : '#050505')

const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'

/** The picture, one pixel per cell. */
interface Grid {
  cols: number
  rows: number
  /** A cell's size in device pixels. */
  cw: number
  ch: number
  pixels: Uint8ClampedArray
  /** How far each cell stands from the ground, 0 to 1, stretched over the picture's range. */
  level: Float32Array
}

/** A canvas for shrinking the picture, kept between frames. */
let scratch: HTMLCanvasElement | null = null

function grid(paint: Paint, width: number, height: number, cw: number, ch: number, light: boolean): Grid | null {
  const cols = Math.max(1, Math.ceil(width / cw))
  const rows = Math.max(1, Math.ceil(height / ch))
  scratch ??= document.createElement('canvas')
  scratch.width = cols
  scratch.height = rows
  const sctx = scratch.getContext('2d', { willReadFrequently: true })
  if (!sctx) return null
  sctx.imageSmoothingQuality = 'high'
  paint(sctx, cols, rows)
  const pixels = sctx.getImageData(0, 0, cols, rows).data
  const count = cols * rows
  const lum = new Float32Array(count)
  for (let i = 0; i < count; i++) lum[i] = (0.2126 * pixels[i * 4] + 0.7152 * pixels[i * 4 + 1] + 0.0722 * pixels[i * 4 + 2]) / 255
  // The picture's own range, without its extreme few cells.
  const sorted = Float32Array.from(lum).sort()
  const low = sorted[Math.floor(count * 0.02)] ?? 0
  const high = sorted[Math.floor(count * 0.98)] ?? 1
  const span = Math.max(0.05, high - low)
  const level = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const v = Math.min(1, Math.max(0, (lum[i] - low) / span))
    level[i] = light ? 1 - v : v
  }
  return { cols, rows, cw, ch, pixels, level }
}

/** A cell's colour, pushed away from the ground so it reads as ink. */
function inkOf(g: Grid, i: number, light: boolean, alpha = 1): string {
  const push = (v: number): number => Math.round(light ? v * 0.72 : Math.min(255, v * 1.25 + 18))
  const r = push(g.pixels[i * 4])
  const gr = push(g.pixels[i * 4 + 1])
  const b = push(g.pixels[i * 4 + 2])
  return alpha >= 1 ? `rgb(${r}, ${gr}, ${b})` : `rgba(${r}, ${gr}, ${b}, ${alpha.toFixed(3)})`
}

/** A cell's colour as it is. */
function colourOf(g: Grid, i: number): string {
  return `rgb(${g.pixels[i * 4]}, ${g.pixels[i * 4 + 1]}, ${g.pixels[i * 4 + 2]})`
}

/** Fills the context with the ground, and returns its size in device pixels. */
function begin(ctx: CanvasRenderingContext2D, light: boolean): { w: number; h: number } {
  const { width: w, height: h } = ctx.canvas
  ctx.fillStyle = ground(light)
  ctx.fillRect(0, 0, w, h)
  return { w, h }
}

/** Draws `style` of the picture `paint` paints into the whole of `ctx`. */
export function renderStyle(style: SeeThroughStyle, ctx: CanvasRenderingContext2D, paint: Paint, scale: number, light: boolean): void {
  const draw = DRAW[style] ?? DRAW.photo
  draw(ctx, paint, scale, light)
}

type Draw = (ctx: CanvasRenderingContext2D, paint: Paint, scale: number, light: boolean) => void

const DRAW: Record<SeeThroughStyle, Draw> = {
  photo(ctx, paint) {
    paint(ctx, ctx.canvas.width, ctx.canvas.height)
  },

  /**
   * One dot per cell over the picture, larger where it is darker, so its
   * shapes come through as print does. Light cells get no dot, which keeps
   * the bright parts clean.
   */
  halftone(ctx, paint, scale, light) {
    const { width: w, height: h } = ctx.canvas
    paint(ctx, w, h)
    const cell = Math.max(2, Math.round(5 * scale))
    // The dots follow the picture's darkness whatever the theme.
    const g = grid(paint, w, h, cell, cell, true)
    if (!g) return
    // Softer ink under a light theme, where dark dots compete with dark text.
    ctx.fillStyle = light ? 'rgba(8, 6, 10, 0.34)' : 'rgba(8, 6, 10, 0.62)'
    ctx.beginPath()
    for (let r = 0; r < g.rows; r++) {
      for (let c = 0; c < g.cols; c++) {
        const i = r * g.cols + c
        const p = i * 4
        const darkness = 1 - (0.2126 * g.pixels[p] + 0.7152 * g.pixels[p + 1] + 0.0722 * g.pixels[p + 2]) / 255
        if (darkness < 0.42) continue
        const radius = cell * 0.52 * Math.pow(Math.min(1, (darkness - 0.36) / 0.5), 0.8)
        if (radius < 0.5) continue
        const x = c * cell + cell / 2
        const y = r * cell + cell / 2
        ctx.moveTo(x + radius, y)
        ctx.arc(x, y, radius, 0, Math.PI * 2)
      }
    }
    ctx.fill()
  },

  ascii(ctx, paint, scale, light) {
    text(ctx, paint, scale, light, ' .:-=+*#%@')
  },

  blocks(ctx, paint, scale, light) {
    text(ctx, paint, scale, light, ' ░▒▓█')
  },

  /** Characters on tiles: each tile the cell's colour faded toward the ground, its character in the colour itself. */
  tiles(ctx, paint, scale, light) {
    const { w, h } = begin(ctx, light)
    const size = Math.max(4, Math.round(11 * scale))
    const g = grid(paint, w, h, size, size, light)
    if (!g) return
    const gap = Math.max(1, Math.round(1 * scale))
    const ramp = '.:%SX8@'
    ctx.font = `600 ${Math.round(size * 0.62)}px ${MONO}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (let r = 0; r < g.rows; r++) {
      for (let c = 0; c < g.cols; c++) {
        const i = r * g.cols + c
        const level = g.level[i]
        if (level < 0.12) continue
        const x = c * size
        const y = r * size
        ctx.fillStyle = inkOf(g, i, light, 0.12 + level * 0.38)
        ctx.fillRect(x + gap / 2, y + gap / 2, size - gap, size - gap)
        if (level < 0.3) continue
        ctx.fillStyle = inkOf(g, i, light, 0.55 + level * 0.45)
        ctx.fillText(ramp[Math.min(ramp.length - 1, Math.floor(((level - 0.3) / 0.7) * ramp.length))], x + size / 2, y + size / 2 + 0.5 * scale)
      }
    }
  },

  /** Braille: each character is a 2 × 4 grid of dots, lit where its part of the cell stands out. */
  braille(ctx, paint, scale, light) {
    const { w, h } = begin(ctx, light)
    const cw = Math.max(3, Math.round(6 * scale))
    const ch = Math.max(5, Math.round(12 * scale))
    // The dots themselves: two across and four down each cell.
    const dots = grid(paint, w, h, cw / 2, ch / 4, light)
    const cells = grid(paint, w, h, cw, ch, light)
    if (!dots || !cells) return
    ctx.font = `${Math.round(ch * 0.95)}px ${MONO}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    // Braille's bit for each dot: column 0 rows 0–3, then column 1.
    const BITS = [
      [0x01, 0x08],
      [0x02, 0x10],
      [0x04, 0x20],
      [0x40, 0x80]
    ]
    for (let r = 0; r < cells.rows; r++) {
      for (let c = 0; c < cells.cols; c++) {
        let code = 0
        for (let dy = 0; dy < 4; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const row = r * 4 + dy
            const col = c * 2 + dx
            if (row >= dots.rows || col >= dots.cols) continue
            if (dots.level[row * dots.cols + col] > 0.38) code |= BITS[dy][dx]
          }
        }
        if (code === 0) continue
        const i = r * cells.cols + c
        ctx.fillStyle = inkOf(cells, i, light)
        ctx.fillText(String.fromCharCode(0x2800 + code), c * cw + cw / 2, r * ch + ch / 2)
      }
    }
  },

  /** Ordered (Bayer) dithering: each little pixel is on or off by its light against a fixed pattern, in its own colour. */
  dither(ctx, paint, scale, light) {
    const { w, h } = begin(ctx, light)
    const size = Math.max(2, Math.round(3 * scale))
    const g = grid(paint, w, h, size, size, light)
    if (!g) return
    const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
    const pad = size > 2 ? Math.max(0.5, size * 0.12) : 0
    for (let r = 0; r < g.rows; r++) {
      for (let c = 0; c < g.cols; c++) {
        const i = r * g.cols + c
        const threshold = (BAYER[(r % 4) * 4 + (c % 4)] + 0.5) / 16
        if (g.level[i] <= threshold) continue
        ctx.fillStyle = inkOf(g, i, light)
        ctx.fillRect(c * size + pad, r * size + pad, size - pad * 2, size - pad * 2)
      }
    }
  },

  /** Big pixels, each colour stepped down to a few levels a channel. */
  pixel(ctx, paint, scale, light) {
    const { w, h } = begin(ctx, light)
    const size = Math.max(4, Math.round(9 * scale))
    const g = grid(paint, w, h, size, size, light)
    if (!g) return
    const step = (v: number): number => Math.round(Math.round((v / 255) * 5) * 51)
    for (let r = 0; r < g.rows; r++) {
      for (let c = 0; c < g.cols; c++) {
        const p = (r * g.cols + c) * 4
        ctx.fillStyle = `rgb(${step(g.pixels[p])}, ${step(g.pixels[p + 1])}, ${step(g.pixels[p + 2])})`
        ctx.fillRect(c * size, r * size, size, size)
      }
    }
  },

  /** Rounded tiles with grout between them. */
  mosaic(ctx, paint, scale, light) {
    const { w, h } = begin(ctx, light)
    const size = Math.max(4, Math.round(10 * scale))
    const g = grid(paint, w, h, size, size, light)
    if (!g) return
    const gap = Math.max(1, Math.round(1.5 * scale))
    const radius = Math.max(1, 2 * scale)
    for (let r = 0; r < g.rows; r++) {
      for (let c = 0; c < g.cols; c++) {
        const i = r * g.cols + c
        ctx.fillStyle = colourOf(g, i)
        ctx.beginPath()
        ctx.roundRect(c * size + gap / 2, r * size + gap / 2, size - gap, size - gap, radius)
        ctx.fill()
      }
    }
  },

  /** Bricks seen from above: a flat square and a stud, lit from the top left. */
  lego(ctx, paint, scale, light) {
    const { w, h } = begin(ctx, light)
    const size = Math.max(6, Math.round(13 * scale))
    const g = grid(paint, w, h, size, size, light)
    if (!g) return
    const gap = Math.max(1, Math.round(0.75 * scale))
    const stud = size * 0.31
    for (let r = 0; r < g.rows; r++) {
      for (let c = 0; c < g.cols; c++) {
        const p = (r * g.cols + c) * 4
        const red = g.pixels[p]
        const green = g.pixels[p + 1]
        const blue = g.pixels[p + 2]
        const x = c * size
        const y = r * size
        ctx.fillStyle = `rgb(${red}, ${green}, ${blue})`
        ctx.fillRect(x + gap / 2, y + gap / 2, size - gap, size - gap)
        const cx = x + size / 2
        const cy = y + size / 2
        // The stud's shadow, down and right, then the stud a shade lighter.
        ctx.fillStyle = `rgb(${Math.round(red * 0.62)}, ${Math.round(green * 0.62)}, ${Math.round(blue * 0.62)})`
        ctx.beginPath()
        ctx.arc(cx + size * 0.05, cy + size * 0.06, stud, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = `rgb(${Math.min(255, Math.round(red * 1.12 + 14))}, ${Math.min(255, Math.round(green * 1.12 + 14))}, ${Math.min(255, Math.round(blue * 1.12 + 14))})`
        ctx.beginPath()
        ctx.arc(cx, cy, stud, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  },

  /** Dots in each cell's colour, as large as the cell stands out. */
  dots(ctx, paint, scale, light) {
    shapes(ctx, paint, scale, light, 6, (ctx, x, y, size, level) => {
      const radius = (size / 2) * Math.pow(level, 0.7)
      if (radius < 0.35 * scale) return
      ctx.beginPath()
      ctx.arc(x + size / 2, y + size / 2, radius, 0, Math.PI * 2)
      ctx.fill()
    })
  },

  cross(ctx, paint, scale, light) {
    shapes(ctx, paint, scale, light, 8, (ctx, x, y, size, level) => {
      const arm = (size / 2) * Math.pow(level, 0.8)
      const width = Math.max(0.75 * scale, size * 0.16)
      if (arm < width) return
      const cx = x + size / 2
      const cy = y + size / 2
      ctx.fillRect(cx - arm, cy - width / 2, arm * 2, width)
      ctx.fillRect(cx - width / 2, cy - arm, width, arm * 2)
    })
  },

  diagonal(ctx, paint, scale, light) {
    shapes(ctx, paint, scale, light, 7, (ctx, x, y, size, level) => {
      const width = size * 0.62 * Math.pow(level, 0.9)
      if (width < 0.4 * scale) return
      ctx.lineWidth = width
      ctx.beginPath()
      ctx.moveTo(x, y + size)
      ctx.lineTo(x + size, y)
      ctx.stroke()
    })
  },

  diamond(ctx, paint, scale, light) {
    shapes(ctx, paint, scale, light, 8, (ctx, x, y, size, level) => {
      const half = (size / 2) * Math.pow(level, 0.75)
      if (half < 0.5 * scale) return
      const cx = x + size / 2
      const cy = y + size / 2
      ctx.beginPath()
      ctx.moveTo(cx, cy - half)
      ctx.lineTo(cx + half, cy)
      ctx.lineTo(cx, cy + half)
      ctx.lineTo(cx - half, cy)
      ctx.closePath()
      ctx.fill()
    })
  },

  lines(ctx, paint, scale, light) {
    shapes(ctx, paint, scale, light, 5, (ctx, x, y, size, level) => {
      const thick = size * 0.85 * Math.pow(level, 0.9)
      if (thick < 0.35 * scale) return
      ctx.fillRect(x, y + (size - thick) / 2, size, thick)
    })
  }
}

/** A character per cell from `ramp`, its density by how the cell stands out, in the cell's colour. */
function text(ctx: CanvasRenderingContext2D, paint: Paint, scale: number, light: boolean, ramp: string): void {
  const { w, h } = begin(ctx, light)
  const cw = Math.max(3, Math.round(7 * scale))
  const ch = Math.max(5, Math.round(13 * scale))
  const g = grid(paint, w, h, cw, ch, light)
  if (!g) return
  ctx.font = `${Math.round(ch * 0.92)}px ${MONO}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const last = ramp.length - 1
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      const i = r * g.cols + c
      const char = ramp[Math.round(g.level[i] * last)]
      if (char === ' ') continue
      ctx.fillStyle = inkOf(g, i, light)
      ctx.fillText(char, c * cw + cw / 2, r * ch + ch / 2)
    }
  }
}

/** A shape per square cell of `points`, sized by how the cell stands out, in the cell's colour. */
function shapes(
  ctx: CanvasRenderingContext2D,
  paint: Paint,
  scale: number,
  light: boolean,
  points: number,
  shape: (ctx: CanvasRenderingContext2D, x: number, y: number, size: number, level: number) => void
): void {
  const { w, h } = begin(ctx, light)
  const size = Math.max(3, Math.round(points * scale))
  const g = grid(paint, w, h, size, size, light)
  if (!g) return
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      const i = r * g.cols + c
      const level = g.level[i]
      if (level < 0.06) continue
      const colour = inkOf(g, i, light)
      ctx.fillStyle = colour
      ctx.strokeStyle = colour
      shape(ctx, c * size, r * size, size, level)
    }
  }
}
