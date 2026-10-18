import type { Canvas } from './screen'
import { mix } from './theme'

/**
 * The welcome screen's art, in the dot-matrix look of the Eaon website: a field of
 * faint square dots that glimmer, with a band of light sweeping across, and
 * Eaon Desktop's mark turning in 3D in front of it, drawn in the same dots.
 *
 * The mark is the app icon (resources/icon.png): a dark rounded tile with the
 * white "e" disc printed on it, as a thick slab spinning about the vertical
 * axis. Every dot is a ray cast at the slab and shaded by a point light, so
 * the face and the edge each catch the light as it turns. The "e" is printed
 * on both faces, reading the right way round on each.
 *
 * A dot is "■ ": two columns by one row, which makes the grid square on a
 * terminal's tall cells. Both the field and the mark sit on even columns, so
 * the mark's dots fall on the field's grid.
 */

/* ------------------------------------------------------------- the shape */

// The tile: a rounded square from -1 to 1; y grows downward, as on screen.
const CORNER = 0.54
const THICKNESS = 0.3
// The "e" (resources/brand/eaon-symbol.svg): a disc with two slots cut in
// from the right, their inner ends rounded. Drawn a little larger, and with
// wider slots, than on the icon: at a couple of dozen dots across, the
// icon's proportions close the slots up.
const E_RADIUS = 0.66
const SLOT_MID = 0.37
const SLOT_HALF = 0.17
const SLOT_END = 0.02

const len = (x: number, y: number): number => Math.hypot(x, y)

function roundBox(x: number, y: number): number {
  const qx = Math.abs(x) - (1 - CORNER)
  const qy = Math.abs(y) - (1 - CORNER)
  return len(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - CORNER
}

/** Whether (x, y) on a face is the white "e". */
function isE(x: number, y: number): boolean {
  const u = x / E_RADIUS
  const v = y / E_RADIUS
  if (u * u + v * v > 1) return false
  for (const mid of [-SLOT_MID, SLOT_MID]) {
    if (Math.abs(v - mid) > SLOT_HALF) continue
    if (u >= SLOT_END || len(u - SLOT_END, v - mid) <= SLOT_HALF) return false
  }
  return true
}

/* ------------------------------------------------------------ rendering */

/** A lit dot: brightness 0–1. */
type Dot = number

// A point light close in front, up and to the left: near enough that brightness falls off across the face.
const LIGHT = [-1.3, -1.5, 2.4]
const STEPS = 140
const LEVELS = 20
// How much light each part gives back: the tile is near black, the "e" white.
const TILE = 0.6
const EDGE = 0.75
const PRINT = 1.2

/** The dots across for a logo `rows` tall: the silhouette is widest face-on. */
export function logoColumns(rows: number): number {
  return Math.round(rows * 1.12)
}

/** Width in terminal columns of a logo `rows` tall. */
export function logoWidth(rows: number): number {
  return logoColumns(rows) * 2 - 1
}

function frame(theta: number, rows: number): (Dot | null)[][] {
  const cols = logoColumns(rows)
  const half = 1.18
  const step = (2 * half) / rows
  const cos = Math.abs(Math.cos(theta)) < 1e-4 ? 1e-4 : Math.cos(theta)
  const sin = Math.sin(theta)
  const out: (Dot | null)[][] = []
  for (let j = 0; j < rows; j++) {
    const y = -half + (j + 0.5) * step
    const row: (Dot | null)[] = []
    for (let i = 0; i < cols; i++) {
      const x = (i - (cols - 1) / 2) * step
      // Where the ray (going into the screen) is inside the slab |z| ≤ T/2, in the object's own x.
      const za = (-THICKNESS / 2 - sin * x) / cos
      const zb = (THICKNESS / 2 - sin * x) / cos
      const zIn = Math.max(za, zb)
      const zOut = Math.min(za, zb)
      const xIn = cos * x - sin * zIn
      const xOut = cos * x - sin * zOut
      let normal: [number, number, number] | null = null
      let z = zIn
      let albedo = EDGE
      if (Math.abs(xIn) <= 1.02 && roundBox(xIn, y) <= 0) {
        // A face: the front reads the "e" as it is, the back mirrored, so it reads right from behind too.
        const side = Math.sign(sin * x + cos * zIn) || 1
        normal = [0, 0, side]
        albedo = isE(side > 0 ? xIn : -xIn, y) ? PRINT : TILE
      } else {
        // Past the face's edge: the rim, where the ray first meets it.
        const n = Math.max(1, Math.ceil(Math.abs(xOut - xIn) / 0.008))
        for (let k = 1; k <= n; k++) {
          const xo = xIn + ((xOut - xIn) * k) / n
          if (Math.abs(xo) > 1.02 || roundBox(xo, y) > 0) continue
          const e = 0.004
          const gx = roundBox(xo + e, y) - roundBox(xo - e, y)
          const gy = roundBox(xo, y + e) - roundBox(xo, y - e)
          const g = len(gx, gy) || 1
          normal = [gx / g, gy / g, 0]
          z = zIn + ((zOut - zIn) * k) / n
          break
        }
      }
      if (!normal) {
        row.push(null)
        continue
      }
      // Into the world, then a point light from the upper left and a highlight.
      const [nx, ny, nz] = normal
      const wx = cos * nx + sin * nz
      const wz = -sin * nx + cos * nz
      const lx = LIGHT[0] - x
      const ly = LIGHT[1] - y
      const lz = LIGHT[2] - z
      const ll = Math.hypot(lx, ly, lz)
      const diffuse = Math.max(0, (wx * lx + ny * ly + wz * lz) / ll) / (1 + 0.05 * ll * ll)
      const hx = lx / ll
      const hy = ly / ll
      const hz = lz / ll + 1
      const hl = Math.hypot(hx, hy, hz)
      const spec = Math.max(0, (wx * hx + ny * hy + wz * hz) / hl) ** 24
      // A little grain, fixed to the screen, like the website's dots.
      const grain = (((Math.sin(i * 12.9898 + j * 78.233) * 43758.5453) % 1) + 1) % 1
      // Enough light all round that the turned-away face still stands out from the field.
      const b = Math.min(1, albedo * (0.3 + 1.1 * diffuse) + 0.35 * spec + grain * 0.06)
      row.push(Math.round(b * LEVELS) / LEVELS)
    }
    out.push(row)
  }
  return out
}

const frames = new Map<string, (Dot | null)[][]>()

/**
 * The logo at `now`: one turn every seven seconds, slowing as either face
 * comes round so the "e" can be read, and hurrying past the edge. Frames
 * are kept once made.
 */
function frameAt(rows: number, now: number): (Dot | null)[][] {
  const index = Math.floor(((now % 7000) / 7000) * STEPS)
  const key = `${rows}:${index}`
  let found = frames.get(key)
  if (!found) {
    if (frames.size > STEPS * 3) frames.clear()
    const u = (index / STEPS) * Math.PI * 2
    found = frame(u - 0.3 * Math.sin(2 * u), rows)
    frames.set(key, found)
  }
  return found
}

// The website's dots: near-black to white, never tinted.
const DOT_DARK = '#161618'
const DOT_LIGHT = '#F4F4F5'

/** Draws the turning logo with its top-left corner at (x, y). */
export function drawSpinningLogo(c: Canvas, x: number, y: number, rows: number, now = Date.now()): void {
  frameAt(rows, now).forEach((row, j) => {
    row.forEach((dot, i) => {
      if (dot === null) return
      c.text(x + i * 2, y + j, '■', { fg: mix(DOT_DARK, DOT_LIGHT, dot ** 1.15) })
    })
  })
}

/* ------------------------------------------------------------- the field */

/** A stable value in [0, 1) for a dot, so the field doesn't crawl from frame to frame. */
const hash = (a: number, b: number): number => {
  const h = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453
  return h - Math.floor(h)
}

/** The band crosses the field in this long, then the field rests until the next pass. */
const SWEEP_MS = 3200
const SWEEP_EVERY_MS = 7000
/** The band's width, and the fading trail it leaves, in dots. */
const BAND = 5
const TRAIL = 9

/** How lit the band leaves column `i` of `cols` at `now`: 0 away from it. */
function band(i: number, cols: number, now: number): number {
  const t = now % SWEEP_EVERY_MS
  if (t > SWEEP_MS + 1200) return 0
  // From just off the left edge to past the right, the trail included.
  const head = -BAND + ((cols + BAND + TRAIL) * t) / SWEEP_MS
  const d = head - i
  if (d < 0) return 0
  if (d <= BAND) return 1
  return Math.max(0, 1 - (d - BAND) / TRAIL) ** 2
}

export interface FieldOptions {
  /** Cells kept clear: the text over the field. */
  skip?: (x: number, y: number) => boolean
  /** Where the logo turns: the field fades out toward its middle, so the mark stands clear of it. */
  quiet?: { x: number; y: number; w: number; h: number }
}

/** Fills `c` with the field at `now`; the logo is drawn after, over it. */
export function drawDotField(c: Canvas, now = Date.now(), { skip, quiet }: FieldOptions = {}): void {
  const cols = Math.ceil(c.w / 2)
  for (let j = 0; j < c.h; j++) {
    for (let i = 0; i < cols; i++) {
      const x = i * 2
      if (skip?.(x, j)) continue
      const seed = hash(i, j)
      // Most dots sit just above the background; a few are brighter, and each glimmers on its own slow beat.
      const base = 0.025 + 0.08 * seed ** 3
      const glimmer = Math.max(0, Math.sin(now / (900 + seed * 1400) + seed * 40)) ** 8 * 0.12 * hash(j, i)
      // The band lights its dots unevenly, as the website's does.
      const lit = band(i, cols, now) * (0.24 + 0.24 * hash(i + 7, j + 3))
      let b = base + glimmer + lit
      if (quiet) {
        const dx = (x + 1 - (quiet.x + quiet.w / 2)) / (quiet.w / 2)
        const dy = (j + 0.5 - (quiet.y + quiet.h / 2)) / (quiet.h / 2)
        b *= 0.25 + 0.75 * Math.min(1, Math.max(0, Math.hypot(dx, dy) - 0.55) / 0.6)
      }
      c.text(x, j, '■', { fg: mix(DOT_DARK, DOT_LIGHT, Math.min(1, b)) })
    }
  }
}
