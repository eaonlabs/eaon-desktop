import type { Canvas } from './screen'
import { mix } from './theme'

/**
 * The Eaon mark, turning in 3D as a grid of lit dots — after the dot-matrix
 * logos OpenAI showed for its CLI. The app icon's tile is a thick slab with
 * the arrow cut through it, spinning about the vertical axis; every dot is
 * a ray cast at the slab and shaded by a point light, so its face, its edge
 * and the walls of the cut-out each catch the light as it turns. The walls
 * of the cut-out are Eaon's coral.
 *
 * A dot is "■ ": two columns by one row, which makes the grid square on a
 * terminal's tall cells.
 */

/* ------------------------------------------------------------- the shape */

// The tile: a rounded square from -1 to 1; y grows downward, as on screen.
const CORNER = 0.54
const THICKNESS = 0.32
// The arrow, from the icon (resources/icon.png), drawn larger: at a couple
// of dozen dots across, the icon's proportions leave it a smudge.
const APEX: [number, number] = [0, -0.354]
const LEFT: [number, number] = [-0.375, 0.349]
const RIGHT: [number, number] = [0.375, 0.349]
const ARC_CENTER: [number, number] = [0, 0.785]
const ARC_RADIUS = 0.575
const MARK_SCALE = 1.55
const MARK_SHIFT = 0.02

const len = (x: number, y: number): number => Math.hypot(x, y)

function roundBox(x: number, y: number): number {
  const qx = Math.abs(x) - (1 - CORNER)
  const qy = Math.abs(y) - (1 - CORNER)
  return len(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - CORNER
}

/** Signed distance to a triangle (Inigo Quilez's formulation). */
function triangle(px: number, py: number, a: [number, number], b: [number, number], c: [number, number]): number {
  const e0x = b[0] - a[0], e0y = b[1] - a[1]
  const e1x = c[0] - b[0], e1y = c[1] - b[1]
  const e2x = a[0] - c[0], e2y = a[1] - c[1]
  const v0x = px - a[0], v0y = py - a[1]
  const v1x = px - b[0], v1y = py - b[1]
  const v2x = px - c[0], v2y = py - c[1]
  const clamp = (v: number): number => Math.min(1, Math.max(0, v))
  const h0 = clamp((v0x * e0x + v0y * e0y) / (e0x * e0x + e0y * e0y))
  const h1 = clamp((v1x * e1x + v1y * e1y) / (e1x * e1x + e1y * e1y))
  const h2 = clamp((v2x * e2x + v2y * e2y) / (e2x * e2x + e2y * e2y))
  const q0 = (v0x - e0x * h0) ** 2 + (v0y - e0y * h0) ** 2
  const q1 = (v1x - e1x * h1) ** 2 + (v1y - e1y * h1) ** 2
  const q2 = (v2x - e2x * h2) ** 2 + (v2y - e2y * h2) ** 2
  const s = Math.sign(e0x * e2y - e0y * e2x)
  const d = Math.min(q0, q1, q2)
  const side = Math.min(s * (v0x * e0y - v0y * e0x), s * (v1x * e1y - v1y * e1x), s * (v2x * e2y - v2y * e2x))
  return -Math.sqrt(d) * Math.sign(side)
}

/** The arrow: the triangle above the arc that forms its base. */
function mark(x: number, y: number): number {
  const u = x / MARK_SCALE
  const v = (y - MARK_SHIFT) / MARK_SCALE
  return Math.max(triangle(u, v, APEX, LEFT, RIGHT), ARC_RADIUS - len(u - ARC_CENTER[0], v - ARC_CENTER[1])) * MARK_SCALE
}

/** The tile with the arrow cut out: negative inside. */
const shape = (x: number, y: number): number => Math.max(roundBox(x, y), -mark(x, y))

/* ------------------------------------------------------------ rendering */

/** A lit dot: brightness 0–1, and whether it is a wall of the cut-out. */
interface Dot {
  b: number
  wall: boolean
}

// A point light close in front, up and to the left: near enough that brightness falls off across the face.
const LIGHT = [-1.3, -1.5, 2.4]
const STEPS = 140
const LEVELS = 20

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
      let wall = false
      if (Math.abs(xIn) <= 1.02 && shape(xIn, y) <= 0) {
        // The face toward us.
        normal = [0, 0, Math.sign(sin * x + cos * zIn) || 1]
      } else {
        // Through the face's gap or past its edge: the first wall the ray meets.
        const n = Math.max(1, Math.ceil(Math.abs(xOut - xIn) / 0.008))
        for (let k = 1; k <= n; k++) {
          const xo = xIn + ((xOut - xIn) * k) / n
          if (Math.abs(xo) > 1.02 || shape(xo, y) > 0) continue
          const e = 0.004
          const gx = shape(xo + e, y) - shape(xo - e, y)
          const gy = shape(xo, y + e) - shape(xo, y - e)
          const g = len(gx, gy) || 1
          normal = [gx / g, gy / g, 0]
          z = zIn + ((zOut - zIn) * k) / n
          wall = -mark(xo, y) >= roundBox(xo, y)
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
      const diffuse = Math.max(0, (wx * lx + ny * ly + wz * lz) / ll) / (1 + 0.09 * ll * ll)
      const hx = lx / ll
      const hy = ly / ll
      const hz = lz / ll + 1
      const hl = Math.hypot(hx, hy, hz)
      const spec = Math.max(0, (wx * hx + ny * hy + wz * hz) / hl) ** 24
      // A little grain, fixed to the screen, like the reference's dots.
      const grain = (((Math.sin(i * 12.9898 + j * 78.233) * 43758.5453) % 1) + 1) % 1
      const b = Math.min(1, 0.1 + 1.45 * diffuse + 0.55 * spec + grain * 0.07)
      row.push({ b: Math.round(b * LEVELS) / LEVELS, wall })
    }
    out.push(row)
  }
  return out
}

const frames = new Map<string, (Dot | null)[][]>()

/**
 * The logo at `now`: one turn every seven seconds, slowing as either face
 * comes round so the arrow can be read, and hurrying past the edge. Frames
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

const FACE_DARK = '#18181B'
const FACE_LIGHT = '#FFFFFF'
const WALL_DARK = '#3A1C12'
const WALL_LIGHT = '#FF9A72'

/** Draws the turning logo with its top-left corner at (x, y). */
export function drawSpinningLogo(c: Canvas, x: number, y: number, rows: number, now = Date.now()): void {
  frameAt(rows, now).forEach((row, j) => {
    row.forEach((dot, i) => {
      if (!dot) return
      const fg = dot.wall ? mix(WALL_DARK, WALL_LIGHT, dot.b) : mix(FACE_DARK, FACE_LIGHT, dot.b ** 1.25)
      c.text(x + i * 2, y + j, '■', { fg })
    })
  })
}
