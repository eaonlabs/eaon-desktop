import { useEffect, useRef, type JSX } from 'react'
import type { ChatScene } from '@shared/chatScenes'

/**
 * A scene drawn in characters behind the conversation: clouds, koi, jellyfish
 * and the like, built from a grid of `> < ? : "` marks that slowly moves.
 *
 * It stays behind the words. Each mark is faint, and the column where the
 * conversation and the message box sit is quieter still (chat.css .chat-scene),
 * so the scene frames the text without competing with it. It runs at a low
 * frame rate, stops while the window is hidden, and holds still under reduced
 * motion.
 */

const FONT_PX = 12
const CELL_H = 16
const FPS = 12
/** Marks from the thinnest edge to the densest middle. */
const RAMP = ['.', ':', '"', '<', '>', '?', '+', '#']
/** The brightest a mark gets, per theme. */
const PEAK = { dark: 0.85, light: 0.75 }

type Rgb = [number, number, number]
/** Each scene's colours, as [on a dark theme, on a light theme] for each of its parts. */
const PALETTE: Record<Exclude<ChatScene, 'off'>, Array<[Rgb, Rgb]>> = {
  sunburst: [[[255, 140, 105], [196, 78, 48]], [[255, 190, 150], [214, 112, 70]]],
  drift: [[[200, 226, 255], [58, 112, 178]], [[255, 255, 255], [96, 150, 208]]],
  koi: [[[255, 150, 70], [198, 92, 20]], [[255, 244, 228], [150, 116, 84]], [[130, 220, 170], [38, 128, 84]]],
  jellyfish: [[[200, 150, 255], [120, 72, 200]], [[255, 150, 200], [196, 62, 128]]],
  fireflies: [[[236, 255, 120], [138, 150, 10]], [[150, 255, 190], [34, 142, 88]]],
  moonlit: [[[255, 238, 180], [168, 134, 36]], [[170, 190, 255], [72, 92, 190]], [[220, 228, 255], [90, 104, 160]]]
}

interface Frame {
  cols: number
  rows: number
  cellW: number
  t: number
  /** Marks a cell with strength 0–1 and a colour index; the stronger one wins. */
  put: (c: number, r: number, strength: number, color: number) => void
  /** A filled ellipse in pixels (or just its top half), softest at its rim. */
  ellipse: (cx: number, cy: number, rx: number, ry: number, color: number, amp?: number, topHalf?: boolean) => void
  w: number
  h: number
}

const wrap = (v: number, span: number): number => ((v % span) + span) % span
/** Fixed pseudo-random values per index, so a scene's layout is the same each time. */
const rand = (i: number, salt = 0): number => {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453
  return x - Math.floor(x)
}

type Scene = (f: Frame) => void

const SCENES: Record<Exclude<ChatScene, 'off'>, Scene> = {
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
      f.ellipse(cx, cy, size, size * 0.8, color, 1, true)
      f.ellipse(cx, cy + 6, size * 0.55, size * 0.3, color, 0.55, true)
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
  }
}

export function ChatScene({ scene, className }: { scene: ChatScene; className?: string }): JSX.Element | null {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const el = canvas.current
    const ctx = el?.getContext('2d')
    if (!el || !ctx || scene === 'off') return
    const colors = PALETTE[scene]
    const render = SCENES[scene]
    let cols = 0
    let rows = 0
    let cellW = 7
    let w = 0
    let h = 0
    let peak = PEAK.dark
    let light = false
    let strength = new Float32Array(0)
    let color = new Uint8Array(0)
    let raf = 0
    let last = 0

    const put = (c: number, r: number, s: number, k: number): void => {
      if (c < 0 || r < 0 || c >= cols || r >= rows || s <= 0) return
      const i = r * cols + c
      if (s > strength[i]) {
        strength[i] = Math.min(1, s)
        color[i] = k
      }
    }
    const ellipse: Frame['ellipse'] = (cx, cy, rx, ry, k, amp = 1, topHalf = false) => {
      for (let r = Math.max(0, Math.floor((cy - ry) / CELL_H)); r <= Math.min(rows - 1, Math.ceil((cy + ry) / CELL_H)); r++) {
        for (let c = Math.max(0, Math.floor((cx - rx) / cellW)); c <= Math.min(cols - 1, Math.ceil((cx + rx) / cellW)); c++) {
          const dx = (c * cellW - cx) / rx
          const dy = (r * CELL_H - cy) / ry
          if (topHalf && dy > 0) continue
          const d = dx * dx + dy * dy
          if (d < 1) put(c, r, amp * (0.6 + 0.4 * (1 - d)), k)
        }
      }
    }

    const readTheme = (): void => {
      light = document.documentElement.dataset.theme === 'light'
      peak = light ? PEAK.light : PEAK.dark
    }

    const draw = (now: number): void => {
      strength.fill(0)
      render({ cols, rows, cellW, t: now / 1000, put, ellipse, w, h })
      ctx.clearRect(0, 0, el.width, el.height)
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const s = strength[r * cols + c]
          if (s < 0.06) continue
          const [dark, bright] = colors[color[r * cols + c]] ?? colors[0]
          const rgb = light ? bright : dark
          ctx.fillStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${(0.25 + 0.75 * s) * peak})`
          ctx.fillText(RAMP[Math.min(RAMP.length - 1, Math.floor(s * RAMP.length))], c * cellW, r * CELL_H)
        }
      }
    }

    const layout = (): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const rect = el.getBoundingClientRect()
      w = rect.width
      h = rect.height
      el.width = Math.max(1, Math.round(w * dpr))
      el.height = Math.max(1, Math.round(h * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.font = `600 ${FONT_PX}px ui-monospace, SFMono-Regular, Menlo, monospace`
      ctx.textBaseline = 'top'
      cellW = ctx.measureText('M').width + 1.4
      cols = Math.ceil(w / cellW)
      rows = Math.ceil(h / CELL_H)
      strength = new Float32Array(cols * rows)
      color = new Uint8Array(cols * rows)
      readTheme()
      draw(performance.now())
    }

    const still = (): boolean => document.body.dataset.reduceMotion === 'on' || window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick)
      if (document.hidden || now - last < 1000 / FPS) return
      last = now
      draw(now)
    }

    layout()
    if (!still()) raf = requestAnimationFrame(tick)
    const observer = new ResizeObserver(layout)
    observer.observe(el)
    const themes = new MutationObserver(() => {
      readTheme()
      draw(performance.now())
    })
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] })
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      themes.disconnect()
    }
  }, [scene])

  if (scene === 'off') return null
  return <canvas ref={canvas} className={className ?? 'chat-scene'} aria-hidden="true" />
}
