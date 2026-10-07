import { mix, type SceneId, type TerminalColors } from './themes'

/**
 * The pictures behind the ADE's terminals: small pixel-art scenes, drawn at a
 * third of the screen's resolution and scaled up crisp, in the theme's own
 * colours. They sit mostly along the bottom and stay close to the
 * background's tone, so whatever the terminal prints reads over them.
 *
 * One loop draws every scene on screen, about twenty times a second; it
 * stops while the window is hidden, and with reduced motion each scene is
 * drawn once and holds still.
 */

/** Screen pixels per art pixel. */
const PX = 3
const FRAME_MS = 50

type Paint = (g: CanvasRenderingContext2D, w: number, h: number, t: number, c: TerminalColors, rnd: () => number) => void

/** A seeded random sequence, so a scene's layout is the same every frame. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const dot = (g: CanvasRenderingContext2D, x: number, y: number, color: string, w = 1, h = 1): void => {
  g.fillStyle = color
  g.fillRect(Math.round(x), Math.round(y), w, h)
}

/** A disc of pixels. */
function disc(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string): void {
  g.fillStyle = color
  for (let y = -r; y <= r; y++) {
    const half = Math.round(Math.sqrt(r * r - y * y))
    g.fillRect(Math.round(cx - half), Math.round(cy + y), half * 2 + 1, 1)
  }
}

/** A filled skyline: `top(x)` is the y of its edge at x. */
function fillBelow(g: CanvasRenderingContext2D, w: number, h: number, top: (x: number) => number, color: string): void {
  g.fillStyle = color
  for (let x = 0; x < w; x++) {
    const y = Math.round(top(x))
    if (y < h) g.fillRect(x, y, 1, h - y)
  }
}

/** A pine: tiers of widening rows on a short trunk. */
function pine(g: CanvasRenderingContext2D, x: number, base: number, height: number, color: string): void {
  g.fillStyle = color
  const crown = Math.max(4, height - 2)
  for (let r = 0; r < crown; r++) {
    const tier = r % 5
    const half = Math.floor((r * 0.42) + tier * 0.35) - (tier === 0 && r > 0 ? 1 : 0)
    g.fillRect(Math.round(x - half), Math.round(base - height + r), half * 2 + 1, 1)
  }
  g.fillRect(Math.round(x), Math.round(base - 2), 1, 2)
}

/** A pale crescent moon: a disc, with a disc of the night sky taken out of it. */
function moon(g: CanvasRenderingContext2D, x: number, y: number, r: number, c: TerminalColors, strength = 0.38): void {
  disc(g, x, y, r, mix(c.background, c.foreground, strength))
  g.globalCompositeOperation = 'destination-out'
  disc(g, x + Math.ceil(r * 0.55), y - Math.ceil(r * 0.3), r, '#000000')
  g.globalCompositeOperation = 'source-over'
}

const dark = (c: TerminalColors, amount: number): string => mix(c.background, '#000000', amount)
const tone = (c: TerminalColors, color: string, amount: number): string => mix(c.background, color, amount)
const isLight = (c: TerminalColors): boolean => {
  const v = parseInt(c.background.slice(1, 3), 16) + parseInt(c.background.slice(3, 5), 16) + parseInt(c.background.slice(5, 7), 16)
  return v > 384
}
/** Away from the background: darker on a light theme, lighter on a dark one. */
const away = (c: TerminalColors, amount: number): string => (isLight(c) ? mix(c.background, '#000000', amount) : mix(c.background, '#ffffff', amount))
/** Into the background: the silhouette direction. */
const into = (c: TerminalColors, amount: number): string => (isLight(c) ? mix(c.background, c.foreground, amount) : dark(c, amount))

/* ------------------------------------------------------------------ scenes */

const forest: Paint = (g, w, h, t, c, rnd) => {
  moon(g, w * 0.82, h * 0.16, 5, c)
  const layers = [
    { color: tone(c, c.green, 0.1), base: h - 6, min: 0.22, max: 0.34, gap: 7 },
    { color: into(c, 0.18), base: h - 3, min: 0.16, max: 0.26, gap: 9 },
    { color: into(c, 0.32), base: h, min: 0.1, max: 0.2, gap: 12 }
  ]
  for (const layer of layers) {
    for (let x = -4; x < w + 6; x += layer.gap * (0.6 + rnd() * 0.8)) {
      pine(g, x, layer.base, h * (layer.min + rnd() * (layer.max - layer.min)), layer.color)
    }
    g.fillStyle = layer.color
    g.fillRect(0, layer.base - 1, w, h - layer.base + 1)
  }
  const flies = Math.max(6, Math.floor(w / 14))
  for (let i = 0; i < flies; i++) {
    const sx = rnd() * w
    const sy = h * (0.45 + rnd() * 0.45)
    const x = (sx + Math.sin(t * 0.35 + i) * 14 + t * (1 + (i % 3))) % (w + 4)
    const y = sy + Math.sin(t * 0.6 + i * 1.7) * 6
    const glow = (Math.sin(t * 2.2 + i * 2.3) + 1) / 2
    if (glow < 0.15) continue
    dot(g, x - 1, y - 1, tone(c, c.yellow, 0.12 * glow), 3, 3)
    dot(g, x, y, tone(c, c.yellow, 0.35 + 0.55 * glow))
  }
}

const aurora: Paint = (g, w, h, t, c, rnd) => {
  for (let i = 0; i < w * h * 0.004; i++) {
    const tw = (Math.sin(t * (0.8 + rnd() * 1.5) + i) + 1) / 2
    dot(g, rnd() * w, rnd() * h * 0.6, tone(c, c.foreground, 0.08 + 0.25 * tw))
  }
  const ribbons = [
    { color: c.green, y: 0.16, amp: 0.06, speed: 0.22, phase: 0 },
    { color: c.cyan, y: 0.24, amp: 0.05, speed: -0.17, phase: 2 },
    { color: c.magenta, y: 0.1, amp: 0.04, speed: 0.12, phase: 4 }
  ]
  for (const ribbon of ribbons) {
    for (let x = 0; x < w; x++) {
      const top = h * ribbon.y + Math.sin(x * 0.035 + t * ribbon.speed + ribbon.phase) * h * ribbon.amp + Math.sin(x * 0.011 - t * 0.1) * h * 0.04
      const tall = 7 + 5 * Math.sin(x * 0.05 + t * 0.5 + ribbon.phase)
      for (let k = 0; k < tall; k++) dot(g, x, top + k, tone(c, ribbon.color, 0.05 + 0.22 * (k / tall)))
    }
  }
  const peaks: { x: number; y: number }[] = []
  for (let x = -20; x < w + 40; x += 18 + rnd() * 26) peaks.push({ x, y: h * (0.58 + rnd() * 0.18) })
  const ridge = (x: number): number => {
    let best = h
    for (const peak of peaks) best = Math.min(best, peak.y + Math.abs(x - peak.x) * 0.85)
    return best
  }
  fillBelow(g, w, h, ridge, into(c, 0.28))
  for (let x = 0; x < w; x++) {
    const y = ridge(x)
    if (y < h * 0.72) dot(g, x, y, tone(c, c.foreground, 0.42), 1, 2)
  }
}

const waves: Paint = (g, w, h, t, c) => {
  const mx = w * 0.74
  const my = h * 0.26
  disc(g, mx, my, Math.max(6, Math.round(h * 0.09)), tone(c, c.yellow, 0.22))
  const rows = 5
  const spacing = Math.max(7, Math.round(h * 0.06))
  for (let k = rows - 1; k >= 0; k--) {
    const base = h - 6 - k * spacing
    const speed = 0.9 + k * 0.35
    const color = tone(c, c.blue, 0.3 - k * 0.04)
    const edge = (x: number): number => base + Math.sin(x * 0.07 + t * speed + k * 1.3) * 3.6 + Math.sin(x * 0.027 - t * 0.4) * 2
    fillBelow(g, w, h, edge, color)
    for (let x = 0; x < w; x++) {
      const y = edge(x)
      if (edge(x - 1) > y && edge(x + 1) > y) dot(g, x - 1, y, tone(c, c.foreground, 0.4), 3, 1)
    }
  }
  for (let i = 0; i < 6; i++) {
    const y = h - 9 - i * 3 + Math.sin(t * 1.4 + i) * 0.6
    dot(g, mx - 3 + Math.sin(t + i) * 2, y, tone(c, c.yellow, 0.3), 6 - (i % 3), 1)
  }
}

const sakura: Paint = (g, w, h, t, c, rnd) => {
  const branch = into(c, 0.35)
  const bloom = tone(c, c.red, 0.38)
  g.fillStyle = branch
  let x = w
  let y = 4
  for (let i = 0; i < w * 0.35; i++) {
    g.fillRect(Math.round(x), Math.round(y), 2, 1)
    x -= 1
    y += Math.sin(i * 0.18) * 0.5 + 0.25
    if (i % 9 === 4) {
      for (let k = 0; k < 6; k++) dot(g, x + (rnd() - 0.5) * 8, y + 2 + (rnd() - 0.5) * 6, bloom, 2, 2)
    }
  }
  fillBelow(g, w, h, (px) => h - 5 - Math.sin(px * 0.03) * 3, tone(c, c.green, 0.14))
  const petals = Math.max(8, Math.floor(w / 10))
  for (let i = 0; i < petals; i++) {
    const speed = 5 + rnd() * 7
    const px = (rnd() * w - t * 6 + Math.sin(t * 0.8 + i) * 6 + w * 4) % w
    const py = ((rnd() * h + t * speed) % (h + 10)) - 5
    dot(g, px, py, tone(c, c.red, 0.32 + rnd() * 0.25), Math.sin(t * 2 + i) > 0 ? 2 : 1, 1)
  }
}

const synthwave: Paint = (g, w, h, t, c) => {
  const horizon = Math.round(h * 0.62)
  const r = Math.max(10, Math.round(h * 0.2))
  const cx = w / 2
  for (let y = -r; y <= 0; y++) {
    const band = (y + r) / r
    // The classic stripes, widening toward the horizon.
    if (band > 0.45 && Math.floor((y + r) * (0.5 + band)) % 4 === 0) continue
    const half = Math.round(Math.sqrt(r * r - y * y))
    g.fillStyle = mix(tone(c, c.yellow, 0.5), tone(c, c.magenta, 0.5), band)
    g.fillRect(Math.round(cx - half), horizon + y, half * 2 + 1, 1)
  }
  const hills = (x: number): number => horizon - Math.abs(Math.sin(x * 0.04)) * 10 - Math.abs(Math.sin(x * 0.013 + 1)) * 8
  g.fillStyle = into(c, 0.3)
  for (let x = 0; x < w; x++) {
    if (Math.abs(x - cx) < r * 0.9) continue
    const top = Math.round(hills(x))
    g.fillRect(x, top, 1, horizon - top)
  }
  g.fillStyle = into(c, 0.35)
  g.fillRect(0, horizon, w, h - horizon)
  const line = tone(c, c.magenta, 0.42)
  const depth = h - horizon
  for (let i = 0; i < 9; i++) {
    const z = ((i + t * 0.7) % 9) / 9
    dot(g, 0, horizon + depth * z * z, line, w, 1)
  }
  for (let k = -14; k <= 14; k++) {
    for (let y = horizon; y < h; y++) {
      const f = (y - horizon) / depth
      dot(g, cx + k * 9 * f * (w / 160), y, line)
    }
  }
}

const rain: Paint = (g, w, h, t, c, rnd) => {
  const buildings: { x: number; w: number; top: number }[] = []
  for (let x = -2; x < w; ) {
    const bw = 6 + Math.floor(rnd() * 12)
    buildings.push({ x, w: bw, top: Math.round(h * (0.55 + rnd() * 0.3)) })
    x += bw + 1 + Math.floor(rnd() * 3)
  }
  const tick = Math.floor(t / 1.5)
  for (const b of buildings) {
    g.fillStyle = into(c, 0.3)
    g.fillRect(b.x, b.top, b.w, h - b.top)
    for (let wy = b.top + 2; wy < h - 2; wy += 3) {
      for (let wx = b.x + 1; wx < b.x + b.w - 1; wx += 2) {
        const lit = seeded(wx * 7919 + wy * 31 + (((wx * wy) % 13 === 0 ? tick : 0)))() > 0.72
        if (lit) dot(g, wx, wy, tone(c, c.yellow, 0.3))
      }
    }
  }
  const drops = Math.floor(w * h * 0.004)
  const color = tone(c, c.blue, 0.24)
  for (let i = 0; i < drops; i++) {
    const speed = 40 + rnd() * 30
    const x = (rnd() * w + t * 8) % w
    const y = ((rnd() * h + t * speed) % (h + 6)) - 3
    dot(g, x, y, color, 1, 3)
  }
}

const digital: Paint = (g, w, h, t, c, rnd) => {
  for (let x = 1; x < w; x += 4) {
    const speed = 8 + rnd() * 18
    const offset = rnd() * (h + 30)
    const head = ((offset + t * speed) % (h + 30)) - 15
    const trail = 10 + Math.floor(rnd() * 14)
    for (let k = 0; k < trail; k += 2) {
      const y = Math.round(head - k * 2)
      if (y < 0 || y >= h) continue
      const fade = 1 - k / trail
      // A glyph is a little 2×3 pattern that changes as it falls.
      const bits = seeded(x * 131 + y * 17 + Math.floor(t * 4))()
      const color = k === 0 ? tone(c, c.green, 0.42) : tone(c, c.green, 0.05 + 0.18 * fade)
      if (bits > 0.2) dot(g, x, y, color, 2, 1)
      if (bits > 0.5) dot(g, x + (bits > 0.75 ? 1 : 0), y + 1, color)
    }
  }
}

const stars: Paint = (g, w, h, t, c, rnd) => {
  for (let i = 0; i < w * h * 0.006; i++) {
    const x = rnd() * w
    const y = rnd() * h
    const tw = (Math.sin(t * (0.6 + rnd() * 2) + i * 1.3) + 1) / 2
    const big = rnd() > 0.93
    dot(g, x, y, tone(c, i % 7 === 0 ? c.magenta : i % 5 === 0 ? c.cyan : c.foreground, 0.1 + 0.32 * tw))
    if (big && tw > 0.6) {
      dot(g, x - 1, y, tone(c, c.foreground, 0.12))
      dot(g, x + 1, y, tone(c, c.foreground, 0.12))
      dot(g, x, y - 1, tone(c, c.foreground, 0.12))
      dot(g, x, y + 1, tone(c, c.foreground, 0.12))
    }
  }
  moon(g, w * 0.84, h * 0.18, 5, c)
  // A shooting star every eight seconds, for about one.
  const cycle = t % 8
  if (cycle < 1.1) {
    const start = seeded(Math.floor(t / 8))()
    const sx = w * (0.15 + start * 0.6)
    const sy = h * 0.08
    for (let k = 0; k < 10; k++) dot(g, sx + cycle * 60 - k, sy + cycle * 24 - k * 0.4, tone(c, c.foreground, 0.5 - k * 0.045))
  }
}

const embers: Paint = (g, w, h, t, c, rnd) => {
  for (let k = 0; k < 22; k++) dot(g, 0, h - 1 - k, tone(c, c.red, 0.2 * (1 - k / 22)), w, 1)
  fillBelow(g, w, h, (x) => h - 4 - Math.abs(Math.sin(x * 0.02)) * 4, into(c, 0.3))
  // The fire: crossed logs, and flames that flicker.
  const fx = Math.round(w * 0.5)
  const fy = h - 5
  for (let i = -6; i <= 6; i++) {
    dot(g, fx + i, fy - Math.round(Math.abs(i) * 0.25), into(c, 0.45), 1, 2)
  }
  for (let row = 0; row < 9; row++) {
    const half = Math.max(0, Math.round((9 - row) * 0.55 + Math.sin(t * 9 + row) * 0.8))
    const color = row < 3 ? tone(c, c.red, 0.75) : row < 6 ? tone(c, c.yellow, 0.7) : tone(c, c.yellow, 0.45)
    dot(g, fx - half, fy - 2 - row, color, half * 2 + 1, 1)
  }
  const sparks = Math.max(18, Math.floor(w / 4))
  for (let i = 0; i < sparks; i++) {
    const life = h * (0.35 + rnd() * 0.4)
    const speed = 8 + rnd() * 10
    const rise = (rnd() * life + t * speed) % life
    const x = rnd() * w + Math.sin(t * 1.3 + i) * (rise / 10)
    const y = h - 6 - rise
    const age = rise / life
    // Most rise from the fire; the rest drift up from the glow along the ground.
    const fromFire = i % 3 !== 0
    const sx = fromFire ? fx + Math.sin(i * 12.9) * 6 + Math.sin(t * 1.3 + i) * (rise / 6) : x
    dot(g, sx, y, tone(c, age < 0.4 ? c.yellow : c.red, 0.75 * (1 - age) + 0.1))
  }
}

const clouds: Paint = (g, w, h, t, c, rnd) => {
  disc(g, w * 0.86, h * 0.14, 7, tone(c, c.yellow, 0.55))
  const puffs = Math.max(3, Math.floor(w / 70))
  for (let i = 0; i < puffs; i++) {
    const cw = 18 + rnd() * 20
    const x = ((rnd() * (w + 60) + t * (1.5 + rnd())) % (w + 60)) - 40
    const y = h * (0.12 + rnd() * 0.3)
    const body = '#ffffff'
    const shade = tone(c, c.blue, 0.2)
    g.fillStyle = shade
    g.fillRect(Math.round(x + 2), Math.round(y + 4), Math.round(cw), 3)
    g.fillStyle = body
    g.fillRect(Math.round(x), Math.round(y + 2), Math.round(cw), 3)
    g.fillRect(Math.round(x + cw * 0.2), Math.round(y), Math.round(cw * 0.45), 3)
    g.fillRect(Math.round(x + cw * 0.5), Math.round(y - 1), Math.round(cw * 0.3), 3)
  }
  fillBelow(g, w, h, (x) => h - 12 - Math.sin(x * 0.02 + 1) * 6, tone(c, c.green, 0.18))
  fillBelow(g, w, h, (x) => h - 6 - Math.sin(x * 0.035) * 3, tone(c, c.green, 0.28))
}

const dunes: Paint = (g, w, h, t, c) => {
  disc(g, w * 0.3, h * 0.48, Math.max(8, Math.round(h * 0.12)), tone(c, c.yellow, 0.22))
  const layers = [
    { y: 0.6, amp: 5, f: 0.018, color: tone(c, c.yellow, 0.12) },
    { y: 0.72, amp: 6, f: 0.026, color: tone(c, c.yellow, 0.18) },
    { y: 0.84, amp: 4, f: 0.035, color: into(c, 0.25) }
  ]
  for (const [i, layer] of layers.entries()) {
    fillBelow(g, w, h, (x) => h * layer.y + Math.sin(x * layer.f + i * 2 + t * 0.03) * layer.amp, layer.color)
  }
  // Heat shimmer: a few pale lines drifting along the far dune.
  for (let i = 0; i < 4; i++) dot(g, ((t * 3 + i * w * 0.27) % (w + 20)) - 10, h * 0.58 - i, tone(c, c.foreground, 0.08), 12, 1)
}

export const SCENES: Record<SceneId, { name: string; paint: Paint }> = {
  forest: { name: 'Firefly forest', paint: forest },
  aurora: { name: 'Aurora', paint: aurora },
  waves: { name: 'Great wave', paint: waves },
  sakura: { name: 'Sakura', paint: sakura },
  synthwave: { name: 'Synthwave', paint: synthwave },
  rain: { name: 'City rain', paint: rain },
  digital: { name: 'Digital rain', paint: digital },
  stars: { name: 'Starfield', paint: stars },
  embers: { name: 'Embers', paint: embers },
  clouds: { name: 'Fair weather', paint: clouds },
  dunes: { name: 'Dunes', paint: dunes }
}

/* ------------------------------------------------------------------ runner */

interface View {
  scene: SceneId
  colors: TerminalColors
  seed: number
}

function stillMotion(): boolean {
  return document.body.dataset.reduceMotion === 'on' || (document.body.dataset.reduceMotion !== 'off' && matchMedia('(prefers-reduced-motion: reduce)').matches)
}

/** A stable number from a string: each pane gets its own layout of the same scene. */
export function seedOf(text: string): number {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return hash >>> 0
}

class SceneRunner {
  private views = new Map<HTMLCanvasElement, View>()
  private frame: number | null = null
  private last = 0
  private readonly start = performance.now()

  show(canvas: HTMLCanvasElement, view: View): void {
    this.views.set(canvas, view)
    this.paint(canvas, view, this.now())
    this.kick()
  }

  hide(canvas: HTMLCanvasElement): void {
    this.views.delete(canvas)
    const g = canvas.getContext('2d')
    g?.clearRect(0, 0, canvas.width, canvas.height)
  }

  private now(): number {
    // Held still, every scene shows the same pleasant moment rather than t = 0.
    return stillMotion() ? 12 : (performance.now() - this.start) / 1000
  }

  private kick(): void {
    if (this.frame !== null || this.views.size === 0) return
    this.frame = requestAnimationFrame(this.tick)
  }

  private tick = (at: number): void => {
    this.frame = null
    if (this.views.size === 0) return
    const still = stillMotion()
    if (!document.hidden && (still || at - this.last >= FRAME_MS)) {
      this.last = at
      const t = this.now()
      for (const [canvas, view] of this.views) {
        if (!canvas.isConnected) this.views.delete(canvas)
        // Held still, a scene is only drawn again when its pane changes size.
        else if (!still || this.resized(canvas)) this.paint(canvas, view, t)
      }
    }
    this.frame = requestAnimationFrame(this.tick)
  }

  private resized(canvas: HTMLCanvasElement): boolean {
    return canvas.width !== Math.max(1, Math.ceil(canvas.clientWidth / PX)) || canvas.height !== Math.max(1, Math.ceil(canvas.clientHeight / PX))
  }

  private paint(canvas: HTMLCanvasElement, view: View, t: number): void {
    const w = Math.max(1, Math.ceil(canvas.clientWidth / PX))
    const h = Math.max(1, Math.ceil(canvas.clientHeight / PX))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    const g = canvas.getContext('2d')
    if (!g) return
    g.clearRect(0, 0, w, h)
    SCENES[view.scene].paint(g, w, h, t, view.colors, seeded(view.seed))
  }
}

export const scenes = new SceneRunner()
