import type { ChatScene } from '@shared/chatScenes'

/**
 * The scenes behind the chat, each a function that stamps marks onto a grid
 * of characters for the time it is given (ChatScene.tsx draws them).
 * Positions are in pixels of a window-sized canvas, so a scene is the same
 * picture at any size, and in a small thumbnail.
 */

export const CELL_H = 16

type Rgb = [number, number, number]
export type SceneId = Exclude<ChatScene, 'off'>

/** Each scene's marks: for every part [on a dark theme, on a light theme]. */
export const PALETTE: Record<SceneId, Array<[Rgb, Rgb]>> = {
  aurora: [[[120, 255, 176], [14, 138, 84]], [[96, 232, 232], [14, 118, 150]], [[196, 140, 255], [112, 62, 196]], [[236, 242, 255], [92, 102, 142]], [[120, 142, 190], [70, 86, 124]]],
  sunburst: [[[255, 140, 105], [196, 78, 48]], [[255, 190, 150], [214, 112, 70]]],
  drift: [[[236, 246, 255], [58, 112, 178]], [[255, 255, 255], [96, 150, 208]]],
  lagoon: [[[128, 238, 168], [30, 130, 80]], [[214, 255, 130], [90, 140, 20]], [[255, 176, 96], [200, 100, 30]], [[232, 252, 255], [60, 120, 150]], [[130, 226, 236], [30, 130, 150]]],
  koi: [[[255, 150, 70], [198, 92, 20]], [[255, 244, 228], [150, 116, 84]], [[130, 220, 170], [38, 128, 84]]],
  jellyfish: [[[200, 150, 255], [120, 72, 200]], [[255, 150, 200], [196, 62, 128]]],
  boats: [[[250, 250, 255], [100, 110, 140]], [[140, 214, 245], [40, 120, 180]], [[255, 160, 140], [200, 80, 60]]],
  fireflies: [[[236, 255, 120], [138, 150, 10]], [[150, 255, 190], [34, 142, 88]]],
  moonlit: [[[255, 238, 180], [168, 134, 36]], [[170, 190, 255], [72, 92, 190]], [[220, 228, 255], [90, 104, 160]]]
}

/** The colour wash each scene lies over the page: [top, bottom] for a dark theme, then a light one. */
export const SKY: Record<SceneId, [[string, string], [string, string]]> = {
  aurora: [['#04091c', '#0a2a30'], ['#e4ecff', '#efe8ff']],
  sunburst: [['#2c100a', '#160a0c'], ['#ffe6da', '#fff4ee']],
  drift: [['#184f8a', '#3a8ccc'], ['#d4ebff', '#f0f8ff']],
  lagoon: [['#0a5565', '#169aa8'], ['#d2f3f2', '#eafaf7']],
  koi: [['#0d4540', '#1e7060'], ['#d6f0e6', '#eef9f1']],
  jellyfish: [['#081240', '#1a1c68'], ['#e0e4ff', '#f0e8ff']],
  boats: [['#1a5c78', '#42a0bc'], ['#d6eef8', '#f1faff']],
  fireflies: [['#06180f', '#0f2c1c'], ['#e6f2d8', '#f3f9e8']],
  moonlit: [['#0a1040', '#1e2e74'], ['#dde4ff', '#eef0ff']]
}

export interface Frame {
  cols: number
  rows: number
  cellW: number
  t: number
  w: number
  h: number
  /** Marks a cell with strength 0–1 and a colour index; the stronger one wins. `ch` forces the character. */
  put: (c: number, r: number, strength: number, color: number, ch?: string) => void
  /** A filled ellipse in pixels (or only its top or bottom half), softest at its rim. */
  ellipse: (cx: number, cy: number, rx: number, ry: number, color: number, amp?: number, half?: 'top' | 'bottom') => void
}

const wrap = (v: number, span: number): number => ((v % span) + span) % span
/** Fixed pseudo-random values per index, so a scene's layout is the same each time. */
const rand = (i: number, salt = 0): number => {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453
  return x - Math.floor(x)
}
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))

type Scene = (f: Frame) => void

/** A sea turtle swimming right: shell, head, four flippers that row. */
function turtle(f: Frame, cx: number, cy: number, s: number, phase: number): void {
  const row = Math.sin(f.t * 1.5 + phase)
  f.ellipse(cx + 2 * s, cy + 14 * s, 50 * s, 30 * s, 4, 0.4)
  f.ellipse(cx - 40 * s, cy + 2 * s, 12 * s, 6 * s, 0, 0.9)
  f.ellipse(cx + 28 * s, cy - 34 * s + row * 7 * s, 30 * s, 9 * s, 0, 0.95)
  f.ellipse(cx + 28 * s, cy + 34 * s - row * 7 * s, 30 * s, 9 * s, 0, 0.95)
  f.ellipse(cx - 26 * s, cy - 26 * s - row * 5 * s, 18 * s, 7 * s, 0, 0.9)
  f.ellipse(cx - 26 * s, cy + 26 * s + row * 5 * s, 18 * s, 7 * s, 0, 0.9)
  f.ellipse(cx, cy, 54 * s, 36 * s, 0, 1)
  f.ellipse(cx, cy, 38 * s, 24 * s, 1, 0.95)
  f.ellipse(cx, cy, 14 * s, 9 * s, 0, 0.9)
  f.ellipse(cx + 66 * s, cy - 2 * s, 18 * s, 13 * s, 0, 1)
  f.put(Math.round((cx + 70 * s) / f.cellW), Math.round((cy - 6 * s) / CELL_H), 1, 3, 'o')
}

export const SCENES: Record<SceneId, Scene> = {
  aurora: (f) => {
    // Stars.
    for (let i = 0; i < 110; i++) {
      const tw = 0.35 + 0.65 * Math.max(0, Math.sin(f.t * (0.5 + rand(i, 2) * 1.2) + i * 4))
      f.put(Math.floor(rand(i, 1) * f.cols), Math.floor(rand(i, 3) * f.rows * 0.72), tw * 0.85, 3, rand(i, 4) > 0.86 ? '*' : '.')
    }
    // Curtains of light: each column of a ribbon is brightest at its lower edge and fades upward, with rays running through it.
    const ribbons = [{ base: 0.34, hue: 0 }, { base: 0.26, hue: 1 }, { base: 0.42, hue: 0 }]
    ribbons.forEach(({ base, hue }, k) => {
      for (let c = 0; c < f.cols; c++) {
        const centre = f.rows * (base + 0.075 * Math.sin(c * 0.034 + f.t * 0.2 + k * 2.1) + 0.04 * Math.sin(c * 0.09 - f.t * 0.15 + k) + 0.02 * Math.sin(c * 0.21 + f.t * 0.4))
        const thick = f.rows * (0.16 + 0.07 * Math.sin(c * 0.05 + f.t * 0.27 + k * 1.7))
        const ray = 0.62 + 0.38 * Math.sin(c * 0.7 + f.t * 0.9 + k * 3) * Math.sin(c * 0.23 - f.t * 0.3)
        for (let r = Math.max(0, Math.floor(centre - thick)); r <= Math.min(f.rows - 1, Math.ceil(centre + thick * 0.22)); r++) {
          const u = (centre - r) / thick
          const s = u >= 0 ? Math.pow(1 - u, 1.35) : 1 + u * 4.5
          const color = u > 0.55 ? 2 : u > 0.28 ? (hue === 0 ? 1 : 2) : hue
          f.put(c, r, clamp01(s * ray) * 0.95, color)
        }
      }
    })
    // Mountains.
    for (let c = 0; c < f.cols; c++) {
      const ridge = Math.floor(f.rows * (0.8 - 0.1 * Math.abs(Math.sin(c * 0.021 + 1)) - 0.055 * Math.sin(c * 0.07) - 0.025 * Math.sin(c * 0.19 + 2)))
      f.put(c, ridge, 0.75, 4, '^')
      for (let r = ridge + 1; r < f.rows; r++) f.put(c, r, 0.2 + 0.08 * ((r - ridge) % 2), 4, (r - ridge) % 3 === 0 ? ':' : '.')
    }
    // A shooting star every so often.
    const every = 11
    const phase = (f.t % every) / 1.4
    if (phase < 1) {
      const startC = f.cols * (0.15 + 0.55 * rand(Math.floor(f.t / every), 5))
      const startR = f.rows * 0.06
      for (let tail = 0; tail < 9; tail++) {
        const p = Math.max(0, phase - tail * 0.018)
        f.put(Math.round(startC + p * f.cols * 0.22), Math.round(startR + p * f.rows * 0.3), (1 - tail / 9) * (1 - phase * 0.4), 3, tail === 0 ? '*' : '-')
      }
    }
  },
  sunburst: (f) => {
    const cx = f.w * 0.82
    const cy = f.h * 0.24
    const unit = Math.min(f.w, f.h)
    const core = unit * (0.09 + 0.008 * Math.sin(f.t * 1.4))
    f.ellipse(cx, cy, core, core * 0.9, 0)
    const rays = 20
    for (let i = 0; i < rays; i++) {
      const angle = (i / rays) * Math.PI * 2 + f.t * 0.05
      const length = unit * (0.14 + 0.09 * (0.5 + 0.5 * Math.sin(f.t * 0.9 + i * 1.7)) + (i % 2) * 0.05)
      for (let d = core * 1.3; d < core + length; d += 6) {
        const px = cx + Math.cos(angle) * d
        const py = cy + Math.sin(angle) * d * 0.55
        f.put(Math.round(px / f.cellW), Math.round(py / CELL_H), 0.9 - (d - core) / (length + core), i % 2 ? 1 : 0)
      }
    }
  },
  drift: (f) => {
    const clouds = 6
    for (let i = 0; i < clouds; i++) {
      const span = f.w + 360
      const x = wrap(rand(i) * span + f.t * (6 + rand(i, 2) * 9), span) - 180
      const y = f.h * (0.1 + (i / clouds) * 0.8) + Math.sin(f.t * 0.2 + i) * 6
      const size = 56 + rand(i, 3) * 50
      f.ellipse(x, y, size * 1.7, size * 0.42, 0)
      f.ellipse(x - size * 0.7, y - size * 0.22, size * 0.8, size * 0.38, 0)
      f.ellipse(x + size * 0.55, y - size * 0.3, size * 0.9, size * 0.42, 0)
      f.ellipse(x + size * 0.1, y - size * 0.4, size * 0.5, size * 0.3, 1, 0.8)
    }
  },
  koi: (f) => {
    const fish = 4
    for (let i = 0; i < fish; i++) {
      const path = (u: number): [number, number] => [
        f.w * (0.5 + 0.44 * Math.sin(u * 0.19 + i * 1.9)),
        f.h * (0.5 + 0.36 * Math.sin(u * 0.27 + i * 2.7))
      ]
      const color = i % 3
      for (let j = 0; j < 10; j++) {
        const [x, y] = path(f.t - j * 0.24)
        const radius = j === 0 ? 34 : 38 - j * 3.2
        f.ellipse(x, y, radius, radius * 0.7, color, j >= 8 ? 0.7 : 1)
      }
      // Fins flick either side of the middle.
      const [fx, fy] = path(f.t - 3 * 0.24)
      const flick = Math.sin(f.t * 5 + i) * 4
      f.ellipse(fx - 18, fy - 30 + flick, 16, 9, color, 0.75)
      f.ellipse(fx + 18, fy + 30 - flick, 16, 9, color, 0.75)
    }
    // Lily pads.
    for (let i = 0; i < 5; i++) f.ellipse(f.w * (0.08 + rand(i, 7) * 0.84), f.h * (0.12 + rand(i, 9) * 0.76), 26, 12, 2, 0.6)
  },
  jellyfish: (f) => {
    const count = 3
    for (let i = 0; i < count; i++) {
      const cx = f.w * (0.14 + 0.36 * i + 0.04 * Math.sin(f.t * 0.2 + i))
      const bob = Math.sin(f.t * 0.7 + i * 2) * f.h * 0.035
      const cy = f.h * (0.3 + 0.1 * rand(i, 4)) + bob
      const size = 64 + rand(i, 5) * 30 + Math.sin(f.t * 1.6 + i) * 5
      const color = i % 2
      f.ellipse(cx, cy, size, size * 0.8, color, 1, 'top')
      f.ellipse(cx, cy + 6, size * 0.55, size * 0.3, color, 0.55, 'top')
      for (let k = -3; k <= 3; k++) {
        for (let d = 8; d < size * 2.8; d += 6) {
          const sway = Math.sin(f.t * 1.8 + d * 0.045 + k) * (5 + d * 0.07)
          f.put(Math.round((cx + k * size * 0.28 + sway) / f.cellW), Math.round((cy + d) / CELL_H), 0.95 - d / (size * 3.2), color)
        }
      }
    }
  },
  fireflies: (f) => {
    for (let i = 0; i < 34; i++) {
      const x = f.w * (0.04 + 0.92 * (0.5 + 0.5 * Math.sin(f.t * (0.05 + rand(i, 1) * 0.08) + i * 3.1)))
      const y = f.h * (0.06 + 0.88 * (0.5 + 0.5 * Math.sin(f.t * (0.04 + rand(i, 2) * 0.07) + i * 1.3)))
      const glow = Math.pow(Math.max(0, Math.sin(f.t * (0.5 + rand(i, 3) * 0.9) + i * 5)), 3)
      if (glow < 0.05) continue
      const c = Math.round(x / f.cellW)
      const r = Math.round(y / CELL_H)
      const color = i % 4 === 0 ? 1 : 0
      f.put(c, r, glow, color)
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) f.put(c + dc, r + dr, glow * 0.42, color)
    }
    // Tall grass at the foot.
    for (let c = 0; c < f.cols; c++) {
      const height = 2 + Math.floor(rand(c, 6) * 3)
      for (let k = 0; k < height; k++) f.put(c, f.rows - 1 - k, 0.35 - k * 0.08 + 0.05 * Math.sin(f.t * 1.4 + c * 0.5), 1)
    }
  },
  moonlit: (f) => {
    const cx = f.w * 0.8
    const cy = f.h * 0.2
    const radius = Math.min(f.w, f.h) * 0.12
    for (let r = 0; r < f.rows; r++) {
      for (let c = 0; c < f.cols; c++) {
        const dx = c * f.cellW - cx
        const dy = r * CELL_H - cy
        const inside = (dx * dx) / (radius * radius) + (dy * dy) / (radius * radius) < 1
        const cut = ((dx - radius * 0.5) ** 2 + (dy + radius * 0.15) ** 2) / (radius * radius * 0.9) < 1
        if (inside && !cut) f.put(c, r, 0.9, 0)
      }
    }
    for (let i = 0; i < 46; i++) {
      const tw = 0.4 + 0.6 * Math.max(0, Math.sin(f.t * (0.6 + rand(i, 2)) + i * 4))
      f.put(Math.floor(rand(i, 11) * f.cols), Math.floor(rand(i, 12) * f.rows * 0.8), tw * 0.8, 2)
    }
    for (let i = 0; i < 3; i++) {
      const span = f.w + 520
      const x = wrap(rand(i, 3) * span + f.t * (4 + i * 2), span) - 260
      const y = f.h * (0.18 + i * 0.28)
      for (let k = -4; k <= 4; k++) f.ellipse(x + k * 40, y + (k % 2) * 8, 46, 12, 1, 0.8)
    }
  },
  lagoon: (f) => {
    // Light moving on the water.
    for (let r = 0; r < f.rows; r++) {
      for (let c = 0; c < f.cols; c++) {
        const v = Math.sin(c * 0.17 + f.t * 0.5 + Math.sin(r * 0.5 + f.t * 0.3) * 1.5) + Math.sin(r * 0.42 - f.t * 0.4 + c * 0.05)
        if (v > 1.55) f.put(c, r, 0.22 + (v - 1.55) * 0.6, 4, v > 1.85 ? ':' : '.')
      }
    }
    turtle(f, wrap(f.t * 15, f.w + 360) - 180, f.h * 0.48 + Math.sin(f.t * 0.5) * f.h * 0.05, 1.15, 0)
    turtle(f, wrap(f.t * 9 + f.w * 0.5, f.w + 260) - 130, f.h * 0.78 + Math.sin(f.t * 0.4 + 2) * f.h * 0.04, 0.6, 2)
    for (let i = 0; i < 16; i++) {
      const dir = i % 3 === 0 ? -1 : 1
      const span = f.w + 120
      const x = dir > 0 ? wrap(rand(i) * span + f.t * (22 + rand(i, 2) * 22), span) - 60 : span - wrap(rand(i) * span + f.t * (18 + rand(i, 2) * 14), span) - 60
      const y = f.h * (0.1 + 0.8 * rand(i, 3)) + Math.sin(f.t * 1.3 + i) * 6
      const c = Math.round(x / f.cellW)
      const r = Math.round(y / CELL_H)
      f.put(c, r, 0.9, 2, dir > 0 ? '=' : '<')
      f.put(c + 1, r, 0.9, 2, dir > 0 ? '>' : '=')
    }
    for (let i = 0; i < 18; i++) {
      const x = f.w * rand(i, 6) + Math.sin(f.t * 0.8 + i) * 8
      const y = f.h - wrap(f.t * (14 + rand(i, 7) * 22) + rand(i, 8) * f.h, f.h + 30)
      f.put(Math.round(x / f.cellW), Math.round(y / CELL_H), 0.8, 3, rand(i, 9) > 0.5 ? 'o' : 'O')
    }
  },
  boats: (f) => {
    for (let r = Math.floor(f.rows * 0.5); r < f.rows; r++) {
      for (let c = 0; c < f.cols; c++) {
        const s = 0.12 + 0.2 * (0.5 + 0.5 * Math.sin(c * 0.3 + r * 1.3 + f.t * 1.4 + Math.sin(c * 0.05 + f.t * 0.2) * 2))
        if (s > 0.2) f.put(c, r, s, 1, '~')
      }
    }
    for (let i = 0; i < 4; i++) {
      const size = 1.5 - i * 0.28
      const span = f.w + 320
      const x = wrap(rand(i, 3) * span + f.t * (7 + i * 3), span) - 160
      const y = f.h * (0.58 + i * 0.1) + Math.sin(f.t * 0.9 + i * 2) * 5
      f.ellipse(x, y, 52 * size, 15 * size, i === 1 ? 2 : 0, 1, 'bottom')
      // The sail, a triangle that narrows toward the top.
      const rowsUp = Math.round(6 * size)
      for (let k = 1; k <= rowsUp; k++) {
        const half = Math.max(0, (rowsUp - k) * 1.5 + 1)
        for (let d = -half; d <= half; d++) f.put(Math.round(x / f.cellW + d), Math.round(y / CELL_H) - k, 0.88, i === 1 ? 2 : 0)
      }
      f.put(Math.round(x / f.cellW), Math.round(y / CELL_H) - rowsUp - 1, 0.9, 0, '^')
      // Its wake.
      for (let d = 1; d < 9; d++) f.put(Math.round(x / f.cellW - 7 * size - d), Math.round(y / CELL_H + 1), 0.45 - d * 0.04, 1, '-')
    }
  },

}
