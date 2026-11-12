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

const snow: Paint = (g, w, h, t, c, rnd) => {
  // Far peaks with snow on their tops, pines, and a cabin with a lit window.
  const peaks: { x: number; y: number }[] = []
  for (let x = -20; x < w + 40; x += 22 + rnd() * 30) peaks.push({ x, y: h * (0.4 + rnd() * 0.2) })
  const nearest = (x: number): { x: number; y: number } => {
    let best = peaks[0]
    for (const p of peaks) if (p.y + Math.abs(x - p.x) * 0.75 < best.y + Math.abs(x - best.x) * 0.75) best = p
    return best
  }
  const ridge = (x: number): number => {
    const p = nearest(x)
    return p.y + Math.abs(x - p.x) * 0.75
  }
  fillBelow(g, w, h, ridge, tone(c, c.blue, 0.13))
  // Snow on the tops only, thinning down the slopes.
  for (let x = 0; x < w; x++) {
    const p = nearest(x)
    const down = Math.abs(x - p.x)
    if (down < 9) dot(g, x, ridge(x), tone(c, c.foreground, 0.4 - down * 0.025), 1, Math.max(1, 4 - Math.floor(down / 3)))
  }
  fillBelow(g, w, h, (x) => h - 6 - Math.sin(x * 0.03) * 2, tone(c, c.foreground, 0.12))
  for (let x = 4; x < w; x += 10 + rnd() * 16) pine(g, x, h - 5, h * (0.1 + rnd() * 0.08), into(c, 0.3))
  const cx = Math.round(w * 0.24)
  const cy = h - 6
  g.fillStyle = into(c, 0.42)
  g.fillRect(cx - 7, cy - 7, 14, 7)
  for (let r = 0; r < 5; r++) dot(g, cx - 8 + r, cy - 8 - r, tone(c, c.foreground, 0.34), 17 - r * 2, 1)
  dot(g, cx - 3, cy - 5, tone(c, c.yellow, 0.55 + 0.1 * Math.sin(t * 3)), 3, 2)
  dot(g, cx + 3, cy - 12, into(c, 0.42), 2, 4)
  // Smoke from the chimney, and the snow.
  for (let i = 0; i < 6; i++) {
    const age = ((t * 0.5 + i / 6) % 1)
    dot(g, cx + 4 + Math.sin(t + i) * 2 + age * 6, cy - 13 - age * 14, tone(c, c.foreground, 0.12 * (1 - age)), 2, 2)
  }
  const flakes = Math.floor(w * h * 0.003)
  for (let i = 0; i < flakes; i++) {
    const speed = 5 + rnd() * 7
    const x = (rnd() * w + Math.sin(t * 0.8 + i) * 4 + t * 3 + w) % w
    const y = (rnd() * h + t * speed) % h
    dot(g, x, y, tone(c, c.foreground, 0.22 + 0.25 * rnd()), rnd() > 0.85 ? 2 : 1, 1)
  }
}

const volcano: Paint = (g, w, h, t, c, rnd) => {
  for (let k = 0; k < 14; k++) dot(g, 0, h - 1 - k, tone(c, c.red, 0.14 * (1 - k / 14)), w, 1)
  const cx = Math.round(w * 0.68)
  const top = Math.round(h * 0.45)
  const slope = (x: number): number => Math.max(top, top + (Math.abs(x - cx) - 4) * 0.85)
  fillBelow(g, w, h, (x) => Math.min(slope(x), h - 4 - Math.abs(Math.sin(x * 0.02)) * 3), into(c, 0.32))
  // Lava in the crater, and two flows pulsing down the slopes.
  for (let i = -3; i <= 3; i++) dot(g, cx + i, top, tone(c, Math.sin(t * 6 + i) > 0 ? c.yellow : c.red, 0.7))
  for (const dir of [-1, 1]) {
    for (let i = 0; i < h - top - 4; i++) {
      const x = cx + dir * (4 + i * 0.85) + Math.sin(i * 0.4 + dir) * 1.4
      const pulse = (Math.sin(t * 2.5 - i * 0.25) + 1) / 2
      dot(g, x, top + i, tone(c, pulse > 0.5 ? c.yellow : c.red, 0.3 + 0.35 * pulse))
    }
  }
  // Smoke rising from the top, widening as it goes.
  for (let i = 0; i < 9; i++) {
    const age = (t * 0.12 + i / 9) % 1
    disc(g, cx + Math.sin(t * 0.4 + i) * 4 + age * 18, top - 4 - age * h * 0.4, 2 + Math.round(age * 6), tone(c, c.foreground, 0.08 * (1 - age)))
  }
  // Bits of lava thrown up, falling back.
  const bombs = 10
  for (let i = 0; i < bombs; i++) {
    const life = 1.6 + rnd()
    const phase = ((t + rnd() * life) % life) / life
    const vx = (rnd() - 0.5) * 40
    const x = cx + vx * phase
    const y = top - 2 - Math.sin(phase * Math.PI) * h * (0.15 + rnd() * 0.15)
    dot(g, x, y, tone(c, phase < 0.5 ? c.yellow : c.red, 0.75 * (1 - phase) + 0.15))
  }
}

const deepsea: Paint = (g, w, h, t, c, rnd) => {
  // Light from the surface, slanting and slowly moving.
  for (let k = 0; k < 5; k++) {
    const x0 = ((rnd() * w + t * 2) % (w + 40)) - 20
    for (let y = 0; y < h * 0.7; y++) dot(g, x0 + y * 0.35, y, tone(c, c.cyan, 0.05 * (1 - y / (h * 0.7))), 3, 1)
  }
  fillBelow(g, w, h, (x) => h - 4 - Math.sin(x * 0.05) * 2 - Math.abs(Math.sin(x * 0.013)) * 3, into(c, 0.3))
  // Kelp swaying from the floor.
  for (let x0 = 6; x0 < w; x0 += 14 + rnd() * 26) {
    const tall = h * (0.2 + rnd() * 0.3)
    const seed = rnd() * 6
    for (let y = 0; y < tall; y++) {
      const sway = Math.sin(y * 0.15 + t * 1.1 + seed) * 2.2 * (y / tall)
      dot(g, x0 + sway, h - 5 - y, tone(c, c.green, 0.22 + 0.12 * (y / tall)), 2, 1)
    }
  }
  // Fish, crossing both ways.
  for (let i = 0; i < Math.max(3, Math.floor(w / 80)); i++) {
    const dir = i % 2 ? 1 : -1
    const speed = 6 + rnd() * 8
    const x = (((rnd() * w + dir * t * speed) % (w + 10)) + w + 10) % (w + 10) - 5
    const y = h * (0.3 + rnd() * 0.4) + Math.sin(t + i) * 2
    const color = tone(c, i % 3 ? c.yellow : c.cyan, 0.42)
    dot(g, x, y, color, 3, 1)
    dot(g, x + (dir > 0 ? -1 : 3), y - 1, color)
    dot(g, x + (dir > 0 ? -1 : 3), y + 1, color)
  }
  // Bubbles, wobbling up.
  for (let i = 0; i < Math.max(10, Math.floor(w / 9)); i++) {
    const speed = 8 + rnd() * 10
    const x = rnd() * w + Math.sin(t * 2 + i) * 1.5
    const y = h - 5 - ((rnd() * h + t * speed) % h)
    dot(g, x, y, tone(c, c.foreground, 0.18 + 0.16 * rnd()), rnd() > 0.8 ? 2 : 1, rnd() > 0.8 ? 2 : 1)
  }
}

const lighthouse: Paint = (g, w, h, t, c, rnd) => {
  for (let i = 0; i < w * h * 0.002; i++) dot(g, rnd() * w, rnd() * h * 0.5, tone(c, c.foreground, 0.1 + 0.15 * ((Math.sin(t + i) + 1) / 2)))
  const sea = h - 10
  for (let k = 0; k < 3; k++) {
    const base = sea + k * 3
    fillBelow(g, w, h, (x) => base + Math.sin(x * 0.08 + t * (0.8 + k * 0.3) + k) * 1.4, tone(c, c.blue, 0.14 + k * 0.05))
  }
  // A cliff on the left, and the lighthouse on it.
  const cliff = (x: number): number => (x < w * 0.22 ? h * 0.58 + Math.sin(x * 0.2) * 1.5 : h * 0.58 + (x - w * 0.22) * 1.6)
  fillBelow(g, w, h, cliff, into(c, 0.36))
  const lx = Math.round(w * 0.12)
  const ground = Math.round(h * 0.58)
  const tall = Math.max(12, Math.round(h * 0.26))
  for (let y = 0; y < tall; y++) {
    const half = 2 + Math.round((y / tall) * 1.2)
    dot(g, lx - half, ground - tall + y, Math.floor(y / 3) % 2 ? tone(c, c.red, 0.45) : tone(c, c.foreground, 0.35), half * 2, 1)
  }
  const ly = ground - tall - 2
  dot(g, lx - 2, ly, tone(c, c.yellow, 0.85), 4, 2)
  // The beam: sweeping round, brightest as it faces you.
  const angle = t * 0.9
  const facing = Math.cos(angle)
  const reach = w * (0.3 + 0.7 * Math.abs(Math.sin(angle)))
  const dir = Math.sin(angle) >= 0 ? 1 : -1
  for (let d = 3; d < reach; d += 1) {
    const spread = 1 + d * 0.06
    const strength = 0.14 * (1 - d / reach) * (0.6 + 0.4 * Math.max(0, facing))
    dot(g, lx + dir * d, ly - spread / 2 + 1, tone(c, c.yellow, strength), 1, Math.ceil(spread))
  }
}

const orbit: Paint = (g, w, h, t, c, rnd) => {
  for (let i = 0; i < w * h * 0.004; i++) dot(g, rnd() * w, rnd() * h, tone(c, c.foreground, 0.08 + 0.22 * ((Math.sin(t * (0.5 + rnd()) + i) + 1) / 2)))
  const px = w * 0.72
  const py = h * 0.48
  const r = Math.max(8, Math.round(h * 0.16))
  const ring = (front: boolean): void => {
    for (let a = 0; a < Math.PI * 2; a += 0.02) {
      const s = Math.sin(a)
      if (front !== s > 0) continue
      dot(g, px + Math.cos(a) * r * 1.9, py + s * r * 0.45, tone(c, c.yellow, 0.32), 1, 1)
    }
  }
  ring(false)
  disc(g, px, py, r, tone(c, c.blue, 0.32))
  // The night side.
  g.globalCompositeOperation = 'source-atop'
  disc(g, px + r * 0.55, py + r * 0.35, r, tone(c, c.blue, 0.18))
  g.globalCompositeOperation = 'source-over'
  ring(true)
  // Two moons; behind the planet, they're hidden.
  for (const [i, m] of [{ speed: 0.5, rx: 2.6, ry: 0.8, size: 2 }, { speed: -0.33, rx: 3.4, ry: 1.1, size: 1 }].entries()) {
    const a = t * m.speed + i * 2
    const mx = px + Math.cos(a) * r * m.rx
    const my = py + Math.sin(a) * r * m.ry * 0.5
    const behind = Math.sin(a) < 0 && Math.hypot(mx - px, my - py) < r
    if (!behind) disc(g, mx, my, m.size, tone(c, c.foreground, 0.42))
  }
}

const lanterns: Paint = (g, w, h, t, c, rnd) => {
  const water = Math.round(h * 0.78)
  fillBelow(g, w, h, (x) => water - 3 - Math.abs(Math.sin(x * 0.015 + 1)) * 6, into(c, 0.22))
  g.fillStyle = tone(c, c.blue, 0.1)
  g.fillRect(0, water, w, h - water)
  const count = Math.max(6, Math.floor(w / 26))
  for (let i = 0; i < count; i++) {
    const speed = 3 + rnd() * 4
    const span = water - 4
    const y = water - 6 - ((rnd() * span + t * speed) % span)
    const x = rnd() * w + Math.sin(t * 0.5 + i) * 3
    const size = rnd() > 0.6 ? 2 : 1
    const flicker = 0.12 * Math.sin(t * 3 + i)
    const color = tone(c, i % 4 === 0 ? c.red : c.yellow, 0.5 + flicker)
    // A soft round glow, the paper body with a brighter middle, and a dark rim on top.
    disc(g, x, y + size, 3 * size, tone(c, c.yellow, 0.05))
    disc(g, x, y + size, 2 * size, tone(c, c.yellow, 0.09))
    dot(g, x - size, y - size, color, 3 * size, 4 * size)
    dot(g, x, y, tone(c, c.yellow, 0.75 + flicker), size, 2 * size)
    dot(g, x - size, y - size - 1, into(c, 0.3), 3 * size, 1)
    // Its reflection, broken up by the water.
    const ry = water + (water - y) * 0.25
    if (ry < h - 1 && Math.sin(t * 4 + i + ry) > -0.3) dot(g, x - size, ry, tone(c, c.yellow, 0.18), 3 * size, 1)
  }
}

const jellyfish: Paint = (g, w, h, t, c, rnd) => {
  for (let i = 0; i < w * h * 0.002; i++) dot(g, (rnd() * w + t * 2) % w, (rnd() * h - t * 1.5 + h) % h, tone(c, c.foreground, 0.08 + 0.1 * rnd()))
  const count = Math.max(3, Math.floor(w / 90))
  for (let i = 0; i < count; i++) {
    const speed = 2 + rnd() * 3
    const span = h + 40
    const y = h + 10 - ((rnd() * span + t * speed) % span)
    const x = rnd() * w + Math.sin(t * 0.4 + i * 2) * 8
    const pulse = 1 + 0.18 * Math.sin(t * 2.2 + i)
    const r = Math.round((4 + rnd() * 4) * pulse)
    const color = i % 2 ? c.magenta : c.cyan
    // The bell: the top half of a disc.
    g.fillStyle = tone(c, color, 0.36)
    for (let yy = -r; yy <= 0; yy++) {
      const half = Math.round(Math.sqrt(r * r - yy * yy) * (1 + 0.1 * (pulse - 1)))
      g.fillRect(Math.round(x - half), Math.round(y + yy), half * 2 + 1, 1)
    }
    dot(g, x - r + 1, y - r + 2, tone(c, c.foreground, 0.3), 2, 1)
    // Tentacles, trailing and waving.
    for (let k = 0; k < 5; k++) {
      const tx = x - r + 1 + (k * (2 * r - 2)) / 4
      const len = 8 + ((i + k) % 3) * 4
      for (let s = 1; s < len; s++) dot(g, tx + Math.sin(s * 0.45 + t * 3 + k) * 1.2, y + s, tone(c, color, 0.3 * (1 - s / len) + 0.05))
    }
  }
}

const meadow: Paint = (g, w, h, t, c, rnd) => {
  disc(g, w * 0.84, h * 0.16, 7, tone(c, c.yellow, 0.4))
  fillBelow(g, w, h, (x) => h * 0.68 - Math.sin(x * 0.012 + 2) * 6, tone(c, c.green, 0.16))
  fillBelow(g, w, h, (x) => h - 8 - Math.sin(x * 0.03) * 2, tone(c, c.green, 0.24))
  // Grass blades leaning with the breeze, and a flower here and there.
  for (let x = 0; x < w; x += 1) {
    const tall = 5 + Math.floor(seeded(x * 977)() * 7)
    const sway = Math.round(Math.sin(t * 1.6 + x * 0.18) * 1.2)
    const base = h - 6
    for (let k = 0; k < tall; k++) dot(g, x + (k > tall / 2 ? sway : 0), base - k, tone(c, c.green, 0.38 + 0.1 * (k / tall)))
    const flower = seeded(x * 31 + 7)()
    if (flower > 0.93) dot(g, x + sway - 1, base - tall - 1, tone(c, flower > 0.98 ? c.red : flower > 0.955 ? c.magenta : c.yellow, 0.7), 3, 2)
  }
  // Butterflies, wings opening and closing.
  for (let i = 0; i < 3; i++) {
    const x = ((rnd() * w + t * (6 + i * 2)) % (w + 20)) - 10
    const y = h * (0.42 + 0.15 * i) + Math.sin(t * 1.7 + i * 2) * h * 0.08
    const open = Math.sin(t * 12 + i * 3) > 0
    const color = tone(c, i === 1 ? c.blue : c.magenta, 0.6)
    dot(g, x, y, tone(c, c.foreground, 0.5), 1, 2)
    if (open) {
      dot(g, x - 2, y - 1, color, 2, 2)
      dot(g, x + 1, y - 1, color, 2, 2)
    } else {
      dot(g, x - 1, y - 2, color, 1, 2)
      dot(g, x + 1, y - 2, color, 1, 2)
    }
  }
}

const mesa: Paint = (g, w, h, t, c, rnd) => {
  disc(g, w * 0.2, h * 0.62, Math.max(8, Math.round(h * 0.11)), tone(c, c.red, 0.18))
  // Flat-topped rocks, banded.
  const rocks: { x: number; w: number; top: number }[] = []
  for (let x = w * 0.05; x < w; x += 50 + rnd() * 80) rocks.push({ x, w: 26 + rnd() * 40, top: h * (0.5 + rnd() * 0.12) })
  const rock = (x: number): number => {
    let best = h
    for (const r of rocks) {
      const edge = Math.max(0, Math.max(r.x - x, x - (r.x + r.w)))
      best = Math.min(best, r.top + edge * 2.2)
    }
    return best
  }
  fillBelow(g, w, h, rock, tone(c, c.red, 0.24))
  for (let x = 0; x < w; x++) {
    const y = rock(x)
    if (y < h * 0.66) for (let b = 4; y + b < h * 0.7; b += 5) dot(g, x, y + b, tone(c, c.red, 0.32))
  }
  fillBelow(g, w, h, (x) => h * 0.74 + Math.sin(x * 0.02) * 2, tone(c, c.yellow, 0.2))
  // Saguaros.
  for (let x = 12; x < w; x += 40 + rnd() * 70) {
    const tall = 9 + Math.floor(rnd() * 8)
    const base = Math.round(h * 0.74 + 4 + rnd() * 6)
    const color = tone(c, c.green, 0.5)
    dot(g, x, base - tall, color, 2, tall)
    dot(g, x - 3, base - tall + 5, color, 3, 1)
    dot(g, x - 3, base - tall + 2, color, 1, 4)
    dot(g, x + 2, base - tall + 7, color, 3, 1)
    dot(g, x + 4, base - tall + 3, color, 1, 5)
  }
  // A tumbleweed rolling through, and birds far off.
  const tx = ((t * 14) % (w + 30)) - 15
  const ty = h - 6 - Math.abs(Math.sin(t * 4)) * 4
  disc(g, tx, ty, 2, tone(c, c.yellow, 0.45))
  for (let i = 0; i < 3; i++) {
    const bx = ((rnd() * w + t * 5) % (w + 20)) - 10
    const by = h * (0.18 + rnd() * 0.15)
    const flap = Math.sin(t * 6 + i) > 0 ? 1 : 0
    const color = tone(c, c.foreground, 0.35)
    dot(g, bx - 2, by - flap, color)
    dot(g, bx - 1, by - 1 + flap, color)
    dot(g, bx, by, color)
    dot(g, bx + 1, by - 1 + flap, color)
    dot(g, bx + 2, by - flap, color)
  }
}

const fireworks: Paint = (g, w, h, t, c, rnd) => {
  const colors = [c.red, c.yellow, c.green, c.cyan, c.magenta, c.blue]
  // Rockets go up, burst, and the sparks fall and fade.
  for (let i = 0; i < 4; i++) {
    const length = 3 + i * 0.7
    const at = t + i * 1.3
    const round = Math.floor(at / length)
    const phase = (at % length) / length
    const pick = seeded(round * 97 + i * 13)
    const x0 = w * (0.15 + pick() * 0.7)
    const y0 = h * (0.15 + pick() * 0.25)
    const color = colors[Math.floor(pick() * colors.length)]
    if (phase < 0.25) {
      const p = phase / 0.25
      dot(g, x0, h - (h - y0) * p, tone(c, c.yellow, 0.6))
      dot(g, x0, h - (h - y0) * p + 2, tone(c, c.yellow, 0.2))
      continue
    }
    const p = (phase - 0.25) / 0.75
    const n = 26
    for (let j = 0; j < n; j++) {
      const a = (j / n) * Math.PI * 2 + pick()
      const speed = 18 + pick() * 10
      const x = x0 + Math.cos(a) * speed * p
      const y = y0 + Math.sin(a) * speed * p + p * p * 12
      dot(g, x, y, tone(c, color, 0.75 * (1 - p) + 0.05), p < 0.5 ? 2 : 1, 1)
    }
  }
  // The city below, a few windows lit.
  for (let x = -2; x < w; ) {
    const bw = 5 + Math.floor(rnd() * 10)
    const top = Math.round(h * (0.74 + rnd() * 0.16))
    g.fillStyle = into(c, 0.34)
    g.fillRect(x, top, bw, h - top)
    for (let wy = top + 2; wy < h - 1; wy += 3) for (let wx = x + 1; wx < x + bw - 1; wx += 2) if (seeded(wx * 7 + wy * 131)() > 0.8) dot(g, wx, wy, tone(c, c.yellow, 0.28))
    x += bw + 1
  }
}

/* ------------------------------------------------------------ more helpers */

/** An ellipse's outline. */
function ring(g: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, color: string, step = 0.12): void {
  for (let a = 0; a < Math.PI * 2; a += step) dot(g, cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, color)
}

/** A filled ellipse. */
function oval(g: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, color: string): void {
  g.fillStyle = color
  const rows = Math.max(1, Math.round(ry))
  for (let y = -rows; y <= rows; y++) {
    const half = Math.round(rx * Math.sqrt(Math.max(0, 1 - (y * y) / (rows * rows))))
    g.fillRect(Math.round(cx - half), Math.round(cy + y), half * 2 + 1, 1)
  }
}

/** Twinkling stars over the top `share` of the scene. */
function starfield(g: CanvasRenderingContext2D, w: number, h: number, t: number, c: TerminalColors, rnd: () => number, share = 0.55, density = 0.003): void {
  for (let i = 0; i < w * h * density; i++) dot(g, rnd() * w, rnd() * h * share, tone(c, c.foreground, 0.08 + 0.22 * ((Math.sin(t * (0.6 + (i % 5) * 0.3) + i) + 1) / 2)))
}

/** A bird far off, its wings going up and down. */
function bird(g: CanvasRenderingContext2D, x: number, y: number, t: number, i: number, color: string): void {
  const flap = Math.sin(t * 6 + i) > 0 ? 1 : 0
  dot(g, x - 2, y - flap, color)
  dot(g, x - 1, y - 1 + flap, color)
  dot(g, x, y, color)
  dot(g, x + 1, y - 1 + flap, color)
  dot(g, x + 2, y - flap, color)
}

type Pt = [number, number]

/** Every pixel along a path of straight and 45° runs. */
function walk(path: Pt[], visit: (x: number, y: number) => void): void {
  for (let i = 1; i < path.length; i++) {
    const [x0, y0] = path[i - 1]
    const [x1, y1] = path[i]
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
    for (let s = 0; s < steps; s++) visit(x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps)
  }
}

/** The point `d` pixels along a path. */
function along(path: Pt[], d: number): Pt {
  for (let i = 1; i < path.length; i++) {
    const [x0, y0] = path[i - 1]
    const [x1, y1] = path[i]
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
    if (d <= steps) return [x0 + ((x1 - x0) * d) / steps, y0 + ((y1 - y0) * d) / steps]
    d -= steps
  }
  return path[path.length - 1]
}

const lengthOf = (path: Pt[]): number => path.slice(1).reduce((sum, [x, y], i) => sum + Math.max(Math.abs(x - path[i][0]), Math.abs(y - path[i][1])), 0)

/* -------------------------------------------------------------- more scenes */

const blackhole: Paint = (g, w, h, t, c, rnd) => {
  const cx = w * 0.7
  const cy = h * 0.4
  const r = Math.max(6, Math.round(h * 0.1))
  // Stars wheeling slowly round the hole, the nearer ones faster.
  for (let i = 0; i < w * h * 0.003; i++) {
    const d = r * 3 + rnd() * w
    const a = rnd() * Math.PI * 2 + t * (0.01 + 1.2 / d)
    const x = cx + Math.cos(a) * d
    const y = cy + Math.sin(a) * d * 0.6
    if (x >= 0 && x < w && y >= 0 && y < h) dot(g, x, y, tone(c, c.foreground, 0.08 + 0.24 * ((Math.sin(t * 1.3 + i) + 1) / 2)))
  }
  // The disk: rings of gas, hot and quick near the hole, cooler and slower
  // further out, with brighter streaks swirling round.
  const disk = (front: boolean): void => {
    for (let k = 0; k < 9; k++) {
      const band = k / 8
      const rx = r * (1.5 + band * 2.4)
      const color = band < 0.35 ? c.yellow : band < 0.7 ? c.red : c.magenta
      for (let a = 0; a < Math.PI * 2; a += 0.7 / rx) {
        const s = Math.sin(a)
        if (front !== s > 0) continue
        const streak = (Math.sin(a * 4 - t * (2.2 - band * 1.4) + k * 1.3) + 1) / 2
        dot(g, cx + Math.cos(a) * rx, cy + s * rx * 0.2, tone(c, color, (0.12 + 0.45 * (1 - band)) * (0.45 + 0.55 * streak)))
      }
    }
  }
  disk(false)
  // The far side of the disk, bent up over the top of the hole.
  for (let a = Math.PI; a <= Math.PI * 2; a += 0.04) dot(g, cx + Math.cos(a) * r * 1.5, cy + Math.sin(a) * r * 1.35, tone(c, c.yellow, 0.28))
  disc(g, cx, cy, r + 1, tone(c, c.yellow, 0.6))
  disc(g, cx, cy, r, mix(c.background, '#000000', 0.75))
  disk(true)
}

const circuit: Paint = (g, w, h, t, c, rnd) => {
  const top = Math.round(h * 0.46)
  // Traces: straight runs with the odd 45° jog.
  const traces: Pt[][] = []
  for (let y0 = top + 2; y0 < h - 1; y0 += 4 + Math.floor(rnd() * 3)) {
    let x = -Math.floor(rnd() * 30)
    let y = y0
    const path: Pt[] = [[x, y]]
    while (x < w + 2) {
      x += 6 + Math.floor(rnd() * 28)
      path.push([x, y])
      const jog = rnd() < 0.45 ? (rnd() < 0.5 ? -1 : 1) * (2 + Math.floor(rnd() * 3)) : 0
      if (jog && y + jog > top && y + jog < h - 1) {
        x += Math.abs(jog)
        y += jog
        path.push([x, y])
      }
    }
    traces.push(path)
  }
  const copper = tone(c, c.green, 0.2)
  for (const path of traces) walk(path, (x, y) => dot(g, x, y, copper))
  // Vias where a trace turns.
  for (const path of traces) {
    for (const [x, y] of path.slice(1, -1)) {
      if (seeded(x * 31 + y * 7)() < 0.72) continue
      dot(g, x - 1, y - 1, tone(c, c.yellow, 0.3), 3, 3)
      g.clearRect(x, y, 1, 1)
    }
  }
  // Chips sitting on the traces.
  for (let x = 14 + rnd() * 30; x < w - 16; x += 60 + rnd() * 80) {
    const cw = 12 + Math.floor(rnd() * 10)
    const ch = 6 + Math.floor(rnd() * 3)
    const y = Math.round(top + 2 + rnd() * Math.max(1, h - top - ch - 4))
    for (let px = 1; px < cw - 1; px += 2) {
      dot(g, x + px, y - 1, tone(c, c.foreground, 0.28))
      dot(g, x + px, y + ch, tone(c, c.foreground, 0.28))
    }
    dot(g, x, y, into(c, 0.45), cw, ch)
    dot(g, x + 1, y + 1, tone(c, c.foreground, 0.3))
  }
  // Signals racing along, each with a fading tail.
  traces.forEach((path, i) => {
    const length = lengthOf(path)
    const pick = seeded(i * 97 + 5)
    const color = pick() < 0.5 ? c.cyan : c.green
    const speed = 16 + pick() * 22
    for (let k = 0; k < 2; k++) {
      const head = (t * speed + pick() * length) % (length + 40)
      for (let tail = 0; tail < 8; tail++) {
        const d = head - tail
        if (d < 0 || d > length) continue
        const [x, y] = along(path, d)
        dot(g, x, y, tone(c, color, 0.85 * (1 - tail / 8)))
      }
    }
  })
}

const koi: Paint = (g, w, h, t, c, rnd) => {
  // Koi circling, under everything else on the water: a plump body that
  // tapers to a forked tail, and the tail swishing.
  const orange = mix(c.red, c.yellow, 0.4)
  for (let i = 0; i < 5; i++) {
    const cx = w * (0.15 + rnd() * 0.7)
    const cy = h * (0.45 + rnd() * 0.3)
    const rx = 18 + rnd() * w * 0.18
    const ry = 6 + rnd() * h * 0.14
    const dir = rnd() < 0.5 ? -1 : 1
    const speed = (0.3 + rnd() * 0.25) * dir
    const body = i % 3 === 0 ? orange : i % 3 === 1 ? c.yellow : c.foreground
    const at = (k: number): Pt => {
      const a = t * speed + i * 1.9 - k * dir * (1.4 / rx)
      const swish = k > 6 ? Math.sin(t * 5 + i) * (k - 6) * 0.25 : 0
      return [cx + Math.cos(a) * rx + swish, cy + Math.sin(a) * ry + swish]
    }
    for (let k = 11; k >= 0; k--) {
      const [x, y] = at(k)
      const size = k <= 2 ? 4 : k <= 5 ? 3 : k <= 8 ? 2 : 1
      dot(g, x - size / 2, y - size / 2, tone(c, body, 0.68 - k * 0.02), size, size)
      // The white ones have red patches.
      if (i % 3 === 2 && (k === 1 || k === 5)) dot(g, x - 0.5, y - 0.5, tone(c, c.red, 0.6), 2, 2)
    }
    // The tail fin, across the way it swims.
    const [tx, ty] = at(12)
    const [px, py] = at(11)
    const len = Math.hypot(tx - px, ty - py) || 1
    for (const side of [-1, 1]) dot(g, tx + (side * -(ty - py) / len) * 1.5, ty + (side * (tx - px) / len) * 1.5, tone(c, body, 0.45))
  }
  // Lily pads bobbing, each with its notch, and a flower on some.
  for (let i = 0; i < Math.max(5, Math.floor(w / 35)); i++) {
    const x = rnd() * w
    const y = h * (0.3 + rnd() * 0.65) + Math.sin(t * 0.5 + i) * 0.6
    const r = 5 + Math.floor(rnd() * 5)
    oval(g, x, y, r, r * 0.7, tone(c, c.green, 0.3))
    // A narrow notch, pointing whichever way the pad has turned.
    const facing = rnd() * Math.PI * 2
    g.globalCompositeOperation = 'destination-out'
    for (let d = 0; d <= r; d++) {
      for (let s = -d * 0.07; s <= d * 0.07; s += 0.5) {
        g.fillRect(Math.round(x + Math.cos(facing) * d - Math.sin(facing) * s), Math.round(y + (Math.sin(facing) * d + Math.cos(facing) * s) * 0.7), 1, 1)
      }
    }
    g.globalCompositeOperation = 'source-over'
    if (rnd() > 0.6) {
      dot(g, x - 2, y - 2, tone(c, c.magenta, 0.65), 3, 2)
      dot(g, x - 1, y - 3, tone(c, c.magenta, 0.8))
    }
  }
  // Ripples spreading where something touched the water.
  for (let i = 0; i < 4; i++) {
    const length = 4 + i * 0.9
    const at = t + i * 1.7
    const pick = seeded(Math.floor(at / length) * 53 + i * 11)
    const p = (at % length) / length
    const r = 2 + p * 16
    ring(g, pick() * w, h * (0.3 + pick() * 0.6), r, r * 0.45, tone(c, c.foreground, 0.2 * (1 - p)), 0.08)
  }
}

const train: Paint = (g, w, h, t, c, rnd) => {
  starfield(g, w, h, t, c, rnd, 0.5, 0.002)
  moon(g, w * 0.78, h * 0.2, 5, c)
  fillBelow(g, w, h, (x) => h * 0.58 - Math.sin(x * 0.015 + 1) * 7 - Math.sin(x * 0.05) * 2, into(c, 0.14))
  // The viaduct: a deck on stone arches, a river below.
  const deck = Math.round(h * 0.72)
  g.fillStyle = into(c, 0.3)
  g.fillRect(0, deck, w, 2)
  for (let x = -6; x < w + 16; x += 16) {
    g.fillRect(x, deck + 2, 3, h - deck - 2)
    for (let k = 0; k < 13; k++) {
      const u = (k - 6) / 6.5
      g.fillRect(x + 3 + k, deck + 2, 1, 1 + Math.round(5 * (1 - Math.sqrt(Math.max(0, 1 - u * u)))))
    }
  }
  fillBelow(g, w, h, (x) => h - 4 + Math.sin(x * 0.1 + t) * 0.8, tone(c, c.blue, 0.14))
  // The train: lit carriages, then the engine and its headlight.
  const cars = 5
  const carW = 14
  const long = cars * (carW + 1) + 12
  const tx = ((t * 20) % (w + long + 80)) - long
  const body = into(c, 0.5)
  for (let i = 0; i < cars; i++) {
    const x = Math.round(tx + i * (carW + 1))
    dot(g, x, deck - 6, body, carW, 5)
    for (let wx = x + 2; wx < x + carW - 2; wx += 3) dot(g, wx, deck - 5, tone(c, c.yellow, 0.6), 2, 2)
    dot(g, x + 2, deck - 1, body, 2, 1)
    dot(g, x + carW - 4, deck - 1, body, 2, 1)
  }
  const lx = Math.round(tx + cars * (carW + 1))
  dot(g, lx, deck - 7, body, 10, 6)
  dot(g, lx + 10, deck - 5, body, 2, 4)
  dot(g, lx + 2, deck - 6, tone(c, c.yellow, 0.5), 2, 2)
  dot(g, lx + 11, deck - 4, tone(c, c.yellow, 0.9))
  for (let d = 1; d < 30; d++) dot(g, lx + 12 + d, deck - 4 - d * 0.08, tone(c, c.yellow, 0.22 * (1 - d / 30)), 1, 1 + Math.floor(d / 8))
}

const storm: Paint = (g, w, h, t, c, rnd) => {
  // One strike every few seconds, and the sky flickering with it.
  const cycle = 6
  const pick = seeded(Math.floor(t / cycle) * 131 + 7)
  const since = (t % cycle) - (1 + pick() * 3.5)
  const lit = since >= 0 && since < 0.45
  const flash = lit ? (since < 0.06 || (since > 0.14 && since < 0.2) ? 1 : 0.3) * (1 - since / 0.45) : 0
  if (flash > 0) {
    g.fillStyle = tone(c, c.foreground, 0.07 * flash)
    g.fillRect(0, 0, w, h)
  }
  // Heavy clouds with a scalloped underside, lit from below by the flashes.
  const base = (x: number): number => h * 0.22 + Math.sin(x * 0.045 + t * 0.12) * 3 + Math.sin(x * 0.11 - t * 0.2) * 2 + Math.abs(Math.sin(x * 0.09 + t * 0.1)) * 4
  g.fillStyle = tone(c, c.foreground, 0.07 + 0.08 * flash)
  for (let x = 0; x < w; x++) g.fillRect(x, 0, 1, Math.round(base(x)))
  for (let x = 0; x < w; x++) dot(g, x, base(x), tone(c, c.foreground, 0.12 + 0.3 * flash), 1, 2)
  const ground = (x: number): number => h * 0.8 - Math.sin(x * 0.02 + 0.5) * 5
  if (lit && since < 0.3) {
    let x = w * (0.2 + pick() * 0.6)
    let y = base(x)
    while (y < ground(x)) {
      const nx = x + (pick() - 0.5) * 6
      const ny = y + 2 + pick() * 4
      const branch = pick() > 0.85
      const steps = Math.ceil(Math.max(Math.abs(nx - x), ny - y))
      for (let s = 0; s <= steps; s++) dot(g, x + ((nx - x) * s) / steps, y + ((ny - y) * s) / steps, tone(c, c.yellow, 0.9))
      if (branch) for (let s = 1; s < 6; s++) dot(g, nx + s * (pick() > 0.5 ? 1 : -1), ny + s, tone(c, c.yellow, 0.5))
      x = nx
      y = ny
    }
  }
  // Rain, slanting a little.
  for (let i = 0; i < w * h * 0.005; i++) {
    const speed = 55 + rnd() * 25
    const y = ((rnd() * h + t * speed) % (h + 6)) - 3
    const x = (((rnd() * w - y * 0.3) % w) + w) % w
    dot(g, x, y, tone(c, c.blue, 0.28), 1, 3)
  }
  fillBelow(g, w, h, ground, into(c, 0.28))
  // A bare tree on the hill.
  const tx = Math.round(w * 0.76)
  const ty = Math.round(ground(tx))
  const wood = into(c, 0.4)
  dot(g, tx, ty - 9, wood, 2, 9)
  for (let k = 1; k < 5; k++) {
    dot(g, tx - k, ty - 7 - k, wood)
    dot(g, tx + 1 + k, ty - 6 - k, wood)
  }
}

const ufo: Paint = (g, w, h, t, c, rnd) => {
  starfield(g, w, h, t, c, rnd, 0.6)
  const ground = (x: number): number => h * 0.8 + Math.sin(x * 0.03) * 2
  fillBelow(g, w, h, ground, into(c, 0.22))
  for (let y = Math.round(h * 0.86); y < h; y += 3) for (let x = y % 2; x < w; x += 2) dot(g, x, y, into(c, 0.3))
  // A barn, its window lit.
  const bx = Math.round(w * 0.14)
  const by = Math.round(ground(bx + 6))
  const barn = tone(c, c.red, 0.3)
  dot(g, bx, by - 8, barn, 12, 8)
  for (let k = 0; k < 5; k++) dot(g, bx - 1 + k, by - 9 - k, barn, 14 - k * 2, 1)
  dot(g, bx + 4, by - 5, into(c, 0.4), 4, 5)
  dot(g, bx + 5, by - 11, tone(c, c.yellow, 0.55), 2, 2)
  // Every so often the saucer finds a cow, beams it up, and drops it.
  // Offset so the still frame (reduced motion) catches the cow halfway up.
  const cycle = 10
  const p = ((t + 3) % cycle) / cycle
  const cowX = Math.round(w * (0.5 + 0.2 * Math.sin(Math.floor((t + 3) / cycle) * 1.7)))
  const ux = cowX + Math.sin(t * 0.8) * 2
  const uy = h * 0.32 + Math.sin(t * 1.3) * 1.5
  const floor = Math.round(ground(cowX)) - 1
  const beam = p > 0.15 && p < 0.85 ? Math.min(1, (p - 0.15) * 12, (0.85 - p) * 12) : 0
  // The beam: a glowing cone with bright edges and sparkles drifting up it.
  if (beam > 0) {
    for (let y = Math.round(uy + 3); y <= floor; y++) {
      const half = 2 + ((y - uy) / (floor - uy)) * 9
      dot(g, ux - half, y, tone(c, c.green, 0.2 * beam), half * 2, 1)
      dot(g, ux - half, y, tone(c, c.green, 0.4 * beam))
      dot(g, ux + half - 1, y, tone(c, c.green, 0.4 * beam))
    }
    for (let k = 0; k < 8; k++) {
      const u = (seeded(k * 17)() + t * 0.5) % 1
      const y = floor - u * (floor - uy - 3)
      const half = 2 + ((y - uy) / (floor - uy)) * 9
      dot(g, ux + (seeded(k * 29)() - 0.5) * half * 1.6, y, tone(c, c.green, 0.7 * beam))
    }
  }
  const ease = (u: number): number => u * u * (3 - 2 * u)
  const lift = p < 0.25 ? 0 : p < 0.7 ? 0.8 * ease((p - 0.25) / 0.45) : p < 0.78 ? 0.8 * (1 - ((p - 0.7) / 0.08) ** 2) : 0
  const cy = Math.round(floor - lift * (floor - uy - 8))
  const hide = tone(c, c.foreground, 0.6)
  const kick = lift > 0 && Math.sin(t * 14) > 0 ? 1 : 0
  dot(g, cowX - 3, cy - 4, hide, 6, 3)
  dot(g, cowX - 1, cy - 4, into(c, 0.5), 2, 2)
  dot(g, cowX + 3, cy - 5, hide, 2, 2)
  dot(g, cowX - 3 - kick, cy - 1, hide)
  dot(g, cowX + 2 + kick, cy - 1, hide)
  // The saucer, lights running round its rim.
  disc(g, ux, uy - 1, 3, tone(c, c.cyan, 0.45))
  dot(g, ux - 8, uy, tone(c, c.foreground, 0.42), 17, 2)
  dot(g, ux - 5, uy + 2, tone(c, c.foreground, 0.3), 11, 1)
  for (let k = 0; k < 5; k++) dot(g, ux - 6 + k * 3, uy, tone(c, [c.red, c.yellow, c.green][(k + Math.floor(t * 4)) % 3], 0.85))
}

const neoncity: Paint = (g, w, h, t, c, rnd) => {
  for (let x = -2; x < w; ) {
    const bw = 5 + Math.floor(rnd() * 9)
    const top = Math.round(h * (0.34 + rnd() * 0.26))
    dot(g, x, top, into(c, 0.14), bw, h - top)
    x += bw + Math.floor(rnd() * 2)
  }
  // Flying cars in three lanes, between the far towers and the near ones.
  for (const [lane, ly] of [0.3, 0.4, 0.5].entries()) {
    const dir = lane % 2 ? -1 : 1
    const speed = 18 + lane * 7
    for (let k = 0; k < 4; k++) {
      const run = ((t * speed + k * (w / 4 + 17)) % (w + 10)) - 5
      const x = dir > 0 ? run : w - run
      const y = Math.round(h * ly)
      dot(g, x - 1, y, tone(c, c.foreground, 0.3), 3, 1)
      dot(g, x + dir * 2, y, tone(c, c.yellow, 0.75))
      dot(g, x - dir * 2, y, tone(c, c.red, 0.65))
    }
  }
  let tallest = { x: 0, top: h }
  for (let x = -2, i = 0; x < w; i++) {
    const bw = 7 + Math.floor(rnd() * 12)
    const top = Math.round(h * (0.48 + rnd() * 0.3))
    dot(g, x, top, into(c, 0.32), bw, h - top)
    for (let wy = top + 2; wy < h - 1; wy += 3) {
      for (let wx = x + 1; wx < x + bw - 1; wx += 2) {
        const v = seeded(wx * 131 + wy * 17)()
        if (v > 0.82) dot(g, wx, wy, tone(c, v > 0.95 ? c.magenta : c.cyan, 0.26))
      }
    }
    // A neon sign down the front, flickering now and then.
    if (rnd() > 0.55) {
      const sx = x + Math.floor(bw / 2) - 1
      const color = rnd() > 0.5 ? c.magenta : c.cyan
      const on = seeded(Math.floor(t * 6) * 7 + i)() > 0.07 ? 1 : 0.25
      dot(g, sx - 1, top + 2, tone(c, color, 0.3 * on), 4, 10)
      dot(g, sx, top + 3, tone(c, color, 0.75 * on), 2, 8)
    }
    if (top < tallest.top) tallest = { x: x + Math.floor(bw / 2), top }
    x += bw + 1
  }
  dot(g, tallest.x, tallest.top - 6, into(c, 0.32), 1, 6)
  if (Math.sin(t * 3) > 0.3) dot(g, tallest.x, tallest.top - 7, tone(c, c.red, 0.9))
}

const satellite: Paint = (g, w, h, t, c, rnd) => {
  starfield(g, w, h, t, c, rnd, 0.75)
  // The planet: a gentle curve along the bottom, its night side to the right.
  const dip = h * 0.16
  const R = Math.max(h, (w * w) / (8 * dip))
  const cx = w * 0.45
  const cy = h * 0.74 + R
  const limb = (x: number): number => cy - Math.sqrt(Math.max(0, R * R - (x - cx) ** 2))
  const night = w * 0.62
  for (let x = 0; x < w; x++) {
    const dusk = Math.min(1, Math.max(0, (x - night) / (w * 0.12)))
    const y = Math.round(limb(x))
    if (y < h) dot(g, x, y, tone(c, c.blue, 0.2 - 0.09 * dusk), 1, h - y)
  }
  for (let x = 0; x < w; x++) {
    const y = limb(x)
    dot(g, x, y - 1, tone(c, c.cyan, 0.42))
    dot(g, x, y - 2, tone(c, c.cyan, 0.16))
    dot(g, x, y - 3, tone(c, c.cyan, 0.06))
  }
  for (let i = 0; i < Math.floor(w / 6); i++) {
    const depth = 3 + rnd() * h * 0.22
    const len = 4 + Math.floor(rnd() * 12)
    const x = ((rnd() * (w + 40) + t * 2) % (w + 40)) - 20
    const y = limb(x) + depth
    if (y < h && x < night) dot(g, x, y, tone(c, c.foreground, 0.2), len, 1)
  }
  // City lights on the night side.
  for (let i = 0; i < w * 0.4; i++) {
    const x = night + rnd() * (w - night)
    const y = limb(x) + 3 + rnd() * h * 0.2
    if (y < h && Math.sin(t * 2 + i) > -0.6) dot(g, x, y, tone(c, c.yellow, 0.4))
  }
  // The satellite: a body, two solar panels and a blinking light.
  const sx = ((t * 7) % (w + 50)) - 25
  const sy = h * 0.3 + (sx / w) * h * 0.08
  dot(g, sx - 1, sy - 1, tone(c, c.foreground, 0.55), 3, 3)
  dot(g, sx - 2, sy, tone(c, c.foreground, 0.35))
  dot(g, sx + 2, sy, tone(c, c.foreground, 0.35))
  dot(g, sx - 8, sy - 1, tone(c, c.blue, 0.65), 5, 3)
  dot(g, sx + 4, sy - 1, tone(c, c.blue, 0.65), 5, 3)
  if (Math.floor(t * 1.5) % 2 === 0) dot(g, sx, sy - 2, tone(c, c.red, 0.9))
}

const skywhale: Paint = (g, w, h, t, c, rnd) => {
  if (!isLight(c)) starfield(g, w, h, t, c, rnd, 0.6, 0.0025)
  const cloud = (front: boolean): void => {
    for (let i = 0; i < Math.max(2, Math.floor(w / (front ? 110 : 60))); i++) {
      const cw = (front ? 22 : 14) + rnd() * 18
      const x = ((rnd() * (w + 60) + t * (front ? 3 : 1.2)) % (w + 60)) - 40
      const y = h * ((front ? 0.5 : 0.15) + rnd() * 0.3)
      g.fillStyle = tone(c, c.foreground, front ? 0.13 : 0.07)
      g.fillRect(Math.round(x), Math.round(y + 2), Math.round(cw), 3)
      g.fillRect(Math.round(x + cw * 0.2), Math.round(y), Math.round(cw * 0.45), 3)
      g.fillRect(Math.round(x + cw * 0.5), Math.round(y - 1), Math.round(cw * 0.3), 3)
    }
  }
  cloud(false)
  // The whale, swimming right with its tail rising and falling.
  const long = Math.max(34, Math.round(w * 0.16))
  const x0 = ((t * 5) % (w + long * 3)) - long * 1.5
  const y0 = h * 0.45 + Math.sin(t * 0.45) * h * 0.06
  const thick = Math.max(5, Math.round(long * 0.18))
  const body = tone(c, c.blue, 0.38)
  const belly = tone(c, c.foreground, 0.22)
  const wave = (u: number): number => Math.sin(t * 1.4 - u * 3) * (1 - u) * 2.2
  for (let k = 0; k <= long; k++) {
    const u = k / long
    const half = u < 0.72 ? thick * Math.pow(u / 0.72, 0.7) : thick * Math.sqrt(Math.max(0, 1 - ((u - 0.72) / 0.28) ** 2))
    const y = y0 + wave(u)
    dot(g, x0 + k, y - half, body, 1, Math.max(1, Math.round(half * 2)))
    if (u > 0.35 && u < 0.92 && k % 2 === 0) dot(g, x0 + k, y + half * 0.35, belly, 1, Math.max(1, Math.round(half * 0.6)))
  }
  for (let d = 0; d < 5; d++) {
    dot(g, x0 - d, y0 + wave(0) - 1 - d * 0.8, body, 2, 1)
    dot(g, x0 - d, y0 + wave(0) + 1 + d * 0.8, body, 2, 1)
  }
  for (let d = 0; d < 4; d++) dot(g, x0 + long * 0.62 - d, y0 + wave(0.62) + thick * 0.7 + d * 0.6, body)
  dot(g, x0 + long * 0.84, y0 + wave(0.84), tone(c, c.foreground, 0.6))
  cloud(true)
}

const bamboo: Paint = (g, w, h, t, c, rnd) => {
  moon(g, w * 0.8, h * 0.2, 6, c, 0.3)
  // Three depths of stalks, sparse, and fading as they go up so the top of
  // the pane stays clear for text.
  const layers = [
    { amount: 0.08, gap: 13, width: 2 },
    { amount: 0.13, gap: 24, width: 2 },
    { amount: 0.22, gap: 42, width: 3 }
  ]
  for (const [li, layer] of layers.entries()) {
    const leaf = tone(c, c.green, layer.amount + 0.04)
    // Ten steps of fade from the foot of a stalk to its top, worked out once.
    const fade = Array.from({ length: 11 }, (_, k) => layer.amount * (0.35 + 0.65 * (k / 10)))
    const stalk = fade.map((amount) => tone(c, c.green, amount))
    const joint = fade.map((amount) => tone(c, c.green, amount + 0.08))
    for (let x = rnd() * layer.gap; x < w + 4; x += layer.gap * (0.6 + rnd() * 0.9)) {
      const phase = rnd() * 6
      const nodeGap = 7 + Math.floor(rnd() * 5)
      const lean = (rnd() - 0.5) * 3
      for (let y = h; y > -2; y--) {
        const up = 1 - y / h
        const sx = x + Math.sin(t * 0.7 + phase) * up * up * (1.5 + li) + lean * up
        const node = (h - y) % nodeGap === 0
        const step = Math.max(0, Math.min(10, Math.round((1 - up) * 10)))
        dot(g, sx - (node ? 0.5 : 0), y, node ? joint[step] : stalk[step], layer.width + (node ? 1 : 0), 1)
        // Leaves from some of the joints, high up.
        if (node && y < h * 0.7 && seeded(Math.round(x) * 13 + y)() > 0.6) {
          const side = seeded(Math.round(x) * 7 + y)() > 0.5 ? 1 : -1
          for (let d = 1; d < 6; d++) dot(g, sx + side * (d + 1), y + d * 0.5, leaf)
        }
      }
    }
  }
  // Mist drifting through the grove.
  g.fillStyle = tone(c, c.foreground, 0.25)
  for (const band of [0.6, 0.84]) {
    for (let x = 0; x < w; x++) {
      g.globalAlpha = (0.18 * (Math.sin(x * 0.03 + t * 0.15 + band * 9) + 1)) / 2
      g.fillRect(x, Math.round(h * band), 1, 4)
    }
  }
  g.globalAlpha = 1
  for (let i = 0; i < 6; i++) {
    const x = (rnd() * w + t * (4 + i) + Math.sin(t * 1.1 + i) * 6) % (w + 4)
    const y = (rnd() * h + t * (6 + i * 1.5)) % (h + 4)
    const flat = Math.sin(t * 3 + i) > 0
    dot(g, x, y, tone(c, i % 2 ? c.green : c.yellow, 0.45), flat ? 3 : 1, flat ? 1 : 2)
  }
}

const autumn: Paint = (g, w, h, t, c, rnd) => {
  disc(g, w * 0.82, h * 0.2, 6, tone(c, c.yellow, isLight(c) ? 0.45 : 0.3))
  fillBelow(g, w, h, (x) => h * 0.66 - Math.sin(x * 0.014 + 1) * 6, tone(c, c.yellow, 0.12))
  const hill = (x: number): number => h - 9 - Math.sin(x * 0.025 + 2) * 3
  const leaves = [c.red, c.yellow, mix(c.red, c.yellow, 0.5)]
  // Maples: a trunk and a round crown of reds and golds.
  for (let x = 10 + rnd() * 20; x < w - 6; x += 38 + rnd() * 60) {
    const base = hill(x) + 2
    const tall = 13 + Math.floor(rnd() * 9)
    const trunk = into(c, 0.38)
    dot(g, x, base - tall, trunk, 2, tall)
    dot(g, x - 2, base - tall + 3, trunk, 2, 1)
    dot(g, x + 2, base - tall + 5, trunk, 2, 1)
    const r = 6 + Math.floor(rnd() * 4)
    for (let k = 0; k < 7; k++) {
      const ox = (rnd() - 0.5) * r * 1.6
      const oy = (rnd() - 0.5) * r
      disc(g, x + 1 + ox, base - tall - 1 + oy, Math.max(2, r - 2 + Math.floor(rnd() * 2)), tone(c, leaves[k % 3], 0.45 + rnd() * 0.18))
    }
  }
  fillBelow(g, w, h, hill, tone(c, c.red, 0.16))
  for (let x = 0; x < w; x += 2) if (seeded(x * 53)() > 0.7) dot(g, x, hill(x) + 1 + Math.floor(seeded(x * 7)() * 6), tone(c, leaves[x % 3], 0.35))
  // Leaves blowing across.
  for (let i = 0; i < Math.max(8, Math.floor(w / 20)); i++) {
    const speed = 5 + rnd() * 6
    const x = ((rnd() * w + t * speed * 1.6 + Math.sin(t * 1.3 + i) * 5) % (w + 6)) - 3
    const y = ((rnd() * h + t * speed) % (h + 6)) - 3
    const flip = Math.sin(t * 5 + i * 1.3)
    dot(g, x, y, tone(c, leaves[i % 3], 0.6), flip > 0.3 ? 2 : 1, flip < -0.3 ? 2 : 1)
  }
}

const launch: Paint = (g, w, h, t, c, rnd) => {
  starfield(g, w, h, t, c, rnd, 0.6, 0.002)
  const ground = h - 5
  const px = Math.round(w * 0.32)
  const tall = Math.max(16, Math.round(h * 0.2))
  // Searchlights sweeping the sky.
  for (const [i, sx] of [w * 0.7, w * 0.88].entries()) {
    const a = -Math.PI / 2 + Math.sin(t * 0.4 + i * 2) * 0.5
    const reach = h * 0.9
    for (let d = 2; d < reach; d++) {
      const spread = 1 + d * 0.05
      dot(g, sx + Math.cos(a) * d - spread / 2, ground + Math.sin(a) * d, tone(c, c.foreground, 0.07 * (1 - d / reach)), Math.ceil(spread), 1)
    }
  }
  // On the pad for a while; then ignition, liftoff, and up and away.
  // Offset so the still frame (reduced motion) has the rocket on the pad.
  const cycle = 16
  const p = (t + 7) % cycle
  const height = (at: number): number => (at < 7 ? 0 : (at - 7) ** 2 * 5)
  const ry = ground - tall - height(p)
  if (p > 6.2) {
    for (let k = 0; k < 40; k++) {
      const age = k * 0.2
      const at = p - age
      if (at < 6.2) break
      const fade = 1 - age / 8
      if (fade <= 0) break
      const x = px + 2 + (seeded(k * 31 + Math.floor((t + 7) / cycle))() - 0.5) * age * 3 + age * 1.5
      disc(g, x, ground - height(at) + 1, Math.min(6, 1 + age * 1.2), tone(c, c.foreground, 0.14 * fade))
    }
  }
  fillBelow(g, w, h, () => ground, into(c, 0.3))
  // Launch control, its windows lit.
  const bx = Math.round(w * 0.6)
  dot(g, bx, ground - 7, into(c, 0.38), 20, 7)
  for (let wx = bx + 2; wx < bx + 18; wx += 3) dot(g, wx, ground - 5, tone(c, c.yellow, 0.45), 2, 1)
  const steel = tone(c, c.foreground, 0.2)
  dot(g, px + 7, ground - tall - 4, steel, 2, tall + 4)
  for (let y = ground - tall - 3; y < ground; y += 3) dot(g, px + 6, y, steel, 4, 1)
  if (p < 6.8) dot(g, px + 4, ground - tall + 3, steel, 3, 1)
  if (p > 4 && p < 6.2 && Math.floor(t * 4) % 2 === 0) dot(g, px + 8, ground - tall - 5, tone(c, c.red, 0.9))
  dot(g, px - 3, ground - 1, steel, 10, 1)
  if (ry > -tall - 10) {
    const hull = tone(c, c.foreground, 0.6)
    dot(g, px, ry + 3, hull, 4, tall - 3)
    dot(g, px + 1, ry + 1, hull, 2, 2)
    dot(g, px + 1, ry, tone(c, c.red, 0.6), 2, 1)
    dot(g, px + 1, ry + 6, tone(c, c.blue, 0.6), 2, 2)
    dot(g, px - 1, ry + tall - 4, tone(c, c.red, 0.55), 1, 4)
    dot(g, px + 4, ry + tall - 4, tone(c, c.red, 0.55), 1, 4)
    if (p > 6.2) {
      const flame = 2 + Math.floor(seeded(Math.floor(t * 20))() * 3) + (p > 7 ? 3 : 0)
      dot(g, px, ry + tall, tone(c, c.red, 0.7), 4, flame)
      dot(g, px + 1, ry + tall, tone(c, c.yellow, 0.9), 2, flame - 1)
    }
  }
}

const mushrooms: Paint = (g, w, h, t, c, rnd) => {
  for (let x = rnd() * 30; x < w; x += 60 + rnd() * 90) {
    const tw = 6 + Math.floor(rnd() * 8)
    dot(g, x, 0, into(c, 0.18), tw, h)
    dot(g, x - 2, h - 9, into(c, 0.18), tw + 4, 3)
  }
  const floor = (x: number): number => h - 7 - Math.sin(x * 0.04) * 2 - Math.sin(x * 0.13)
  fillBelow(g, w, h, floor, into(c, 0.3))
  const glows = [c.cyan, c.green, c.magenta, c.blue]
  // Mushrooms, each glowing at its own slow pace.
  let i = 0
  for (let x = 4 + rnd() * 10; x < w - 2; x += 9 + rnd() * 26, i++) {
    const s = 2 + Math.floor(rnd() * 4)
    const color = glows[Math.floor(rnd() * glows.length)]
    const pulse = 0.5 + 0.5 * Math.sin(t * (0.8 + rnd() * 0.8) + i * 1.7)
    const base = Math.round(floor(x)) + 1
    const stem = s + 1 + Math.floor(rnd() * s)
    disc(g, x, base - stem - 1, s + 3, tone(c, color, 0.05 + 0.06 * pulse))
    dot(g, x, base - stem, tone(c, c.foreground, 0.28), s > 3 ? 2 : 1, stem)
    const cap = Math.ceil(s * 0.6)
    for (let k = 0; k <= cap; k++) {
      const half = Math.round(s * Math.sqrt(1 - (k / (cap + 1)) ** 2))
      dot(g, x - half, base - stem - k, tone(c, color, 0.4 + 0.35 * pulse), half * 2 + 1, 1)
    }
    if (s > 2) dot(g, x - 1, base - stem - Math.ceil(s * 0.4), tone(c, c.foreground, 0.5 + 0.3 * pulse))
  }
  // Spores drifting up and fading.
  for (let k = 0; k < Math.max(10, Math.floor(w / 12)); k++) {
    const x0 = rnd() * w
    const rise = (rnd() * h + t * (3 + rnd() * 4)) % h
    dot(g, x0 + Math.sin(t * 0.9 + k) * 4, h - 6 - rise, tone(c, glows[k % glows.length], 0.15 + 0.5 * (1 - rise / h)))
  }
}

const windmills: Paint = (g, w, h, t, c, rnd) => {
  if (isLight(c)) disc(g, w * 0.82, h * 0.2, 7, tone(c, c.yellow, 0.4))
  else moon(g, w * 0.82, h * 0.2, 5, c)
  for (let i = 0; i < Math.max(2, Math.floor(w / 90)); i++) {
    const cw = 16 + rnd() * 18
    const x = ((rnd() * (w + 60) + t * (1.2 + rnd())) % (w + 60)) - 40
    const y = h * (0.1 + rnd() * 0.2)
    g.fillStyle = tone(c, c.foreground, isLight(c) ? 0.06 : 0.08)
    g.fillRect(Math.round(x), Math.round(y + 2), Math.round(cw), 3)
    g.fillRect(Math.round(x + cw * 0.25), Math.round(y), Math.round(cw * 0.45), 3)
  }
  const far = (x: number): number => h * 0.68 - Math.sin(x * 0.016 + 1) * 7
  const near = (x: number): number => h - 7 - Math.sin(x * 0.03) * 3
  // A turbine: a mast, and three blades going round.
  const turbine = (x: number, base: number, tall: number, color: string, speed: number, phase: number): void => {
    const hub = base - tall
    dot(g, x, hub, color, 1, tall)
    dot(g, x - 1, hub - 1, color, 2, 2)
    for (let k = 0; k < 3; k++) {
      const a = t * speed + phase + (k * Math.PI * 2) / 3
      for (let d = 1; d < tall * 0.55; d++) dot(g, x + Math.cos(a) * d, hub + Math.sin(a) * d, color)
    }
  }
  fillBelow(g, w, h, far, tone(c, c.green, 0.14))
  for (let x = 8 + rnd() * 20; x < w; x += 26 + rnd() * 30) turbine(x, far(x) + 1, 12 + rnd() * 6, tone(c, c.foreground, 0.22), 1.1 + rnd(), rnd() * 6)
  fillBelow(g, w, h, near, tone(c, c.green, 0.24))
  for (let x = 30 + rnd() * 30; x < w; x += 70 + rnd() * 70) turbine(x, near(x) + 1, 20 + rnd() * 8, tone(c, c.foreground, 0.4), 0.8 + rnd() * 0.6, rnd() * 6)
  for (let i = 0; i < 3; i++) bird(g, ((rnd() * w + t * 5) % (w + 20)) - 10, h * (0.25 + rnd() * 0.15), t, i, tone(c, c.foreground, 0.35))
}

const beach: Paint = (g, w, h, t, c, rnd) => {
  const horizon = Math.round(h * 0.6)
  const shore = Math.round(h * 0.82)
  const sx = Math.round(w * 0.62)
  const sr = Math.max(8, Math.round(h * 0.14))
  disc(g, sx, horizon, sr + 3, tone(c, c.yellow, 0.12))
  disc(g, sx, horizon, sr, tone(c, c.yellow, 0.42))
  // The sea, over the bottom of the sun, and the sun's road across it.
  dot(g, 0, horizon, tone(c, c.blue, 0.16), w, shore - horizon)
  for (let y = horizon + 1; y < shore; y++) {
    const u = (y - horizon) / (shore - horizon)
    const half = sr * (0.9 - u * 0.4)
    for (let x = -half; x < half; x += 3) if (Math.sin(x * 1.7 + y * 2.3 + t * 3) > 0.2) dot(g, sx + x, y, tone(c, c.yellow, 0.3 * (1 - u * 0.5)), 2, 1)
  }
  for (let y = horizon + 3; y < shore; y += 4) for (let x = 0; x < w; x++) if (Math.sin(x * 0.2 + y + t * 0.8) > 0.92) dot(g, x, y, tone(c, c.foreground, 0.16))
  // The sand, and the waves running up it and back.
  const sand = (x: number): number => shore + Math.sin(x * 0.03) * 1.2
  fillBelow(g, w, h, sand, tone(c, c.yellow, 0.2))
  const reach = (Math.sin(t * 0.7) + 1) / 2
  for (let x = 0; x < w; x++) {
    const y = sand(x) + reach * 3 + Math.sin(x * 0.15 + t) * 0.8
    dot(g, x, sand(x), tone(c, c.blue, 0.2), 1, Math.max(0, Math.round(y - sand(x))))
    dot(g, x, y, tone(c, c.foreground, 0.35))
  }
  // A palm, leaning out over the sand.
  const px = Math.round(w * 0.12)
  const base = shore + 4
  const tall = Math.max(16, Math.round(h * 0.36))
  const sway = Math.sin(t * 0.8) * 1.5
  // A silhouette against a dark sky; in daylight, a trunk and green fronds.
  const trunk = isLight(c) ? tone(c, c.yellow, 0.6) : into(c, 0.42)
  const fronds = isLight(c) ? tone(c, c.green, 0.55) : trunk
  let top: Pt = [px, base - tall]
  for (let k = 0; k < tall; k++) {
    const u = k / tall
    const x = px + Math.sin(u * 1.3) * 7 + sway * u * u
    dot(g, x, base - k, trunk, 2, 1)
    top = [x, base - k]
  }
  // Fronds arching out and drooping at the tips.
  for (const [i, a] of [-3.0, -2.5, -1.95, -1.25, -0.65, -0.15].entries()) {
    const reach = 9 + ((i * 5) % 5)
    for (let d = 1; d < reach; d++) dot(g, top[0] + Math.cos(a + sway * 0.05) * d, top[1] + Math.sin(a) * d * 0.8 + d * d * 0.1, fronds, 2, d < reach / 2 ? 2 : 1)
  }
  for (let i = 0; i < 2; i++) bird(g, ((rnd() * w + t * 4) % (w + 20)) - 10, h * (0.2 + rnd() * 0.2), t, i, tone(c, c.foreground, 0.35))
}

const zen: Paint = (g, w, h, t, c, rnd) => {
  if (!isLight(c)) moon(g, w * 0.85, h * 0.18, 5, c, 0.3)
  const top = Math.round(h * 0.55)
  // Raked lines, a cloud's shadow passing slowly over them.
  const shadow = ((t * 3) % (w + 120)) - 60
  const lines = tone(c, c.foreground, 0.12)
  const shaded = tone(c, c.foreground, 0.08)
  for (let y = top; y < h; y += 3) {
    dot(g, 0, y, lines, w, 1)
    dot(g, shadow - 40, y, shaded, 80, 1)
  }
  // Stones, the sand raked in rings round each.
  for (let x = w * 0.15 + rnd() * 20; x < w - 10; x += 60 + rnd() * 90) {
    const y = top + 6 + rnd() * Math.max(1, h - top - 12)
    const r = 2 + Math.floor(rnd() * 3)
    const size = (k: number): number => r + 1 + k * 2.5
    g.globalCompositeOperation = 'destination-out'
    oval(g, x, y, size(3) * 1.8 + 1, size(3) * 0.7 + 1, '#000000')
    g.globalCompositeOperation = 'source-over'
    for (let k = 1; k <= 3; k++) ring(g, x, y, size(k) * 1.8, size(k) * 0.7, tone(c, c.foreground, 0.12), 0.06)
    // Darker than the sand on a light theme, lighter on a dark one.
    oval(g, x, y - 1, r * 1.4, r, isLight(c) ? into(c, 0.4) : tone(c, c.foreground, 0.26))
    dot(g, x - 1, y - r, tone(c, c.foreground, isLight(c) ? 0.35 : 0.45), 2, 1)
    if (rnd() > 0.5) for (let k = 0; k < 4; k++) dot(g, x - r - 1 + k * 2, y + r - 1, tone(c, c.green, 0.4))
  }
  // A leaf drifting down onto the sand.
  const cycle = 12
  const p = (t % cycle) / cycle
  const lx = w * (0.3 + 0.4 * seeded(Math.floor(t / cycle))()) + Math.sin(p * 12) * 6 + p * 20
  const turn = Math.sin(p * 30) > 0
  dot(g, lx, -2 + p * (top + 8), tone(c, c.red, 0.55), turn ? 2 : 1, turn ? 1 : 2)
}

const moonbase: Paint = (g, w, h, t, c, rnd) => {
  // The Earth first, while the canvas is empty, so its land and shadow stay on it.
  const ex = w * 0.76
  const ey = h * 0.25
  const er = Math.max(6, Math.round(h * 0.1))
  disc(g, ex, ey, er, tone(c, c.blue, 0.45))
  g.globalCompositeOperation = 'source-atop'
  for (let k = 0; k < 6; k++) {
    const pick = seeded(k * 71 + 3)
    const lon = ((pick() * 4 + t * 0.06) % 2.4) - 1.2
    disc(g, ex + lon * er, ey + (pick() - 0.5) * er * 1.4, 1 + Math.floor(pick() * 3), tone(c, c.green, 0.45))
  }
  disc(g, ex + er * 0.6, ey + er * 0.2, er, tone(c, c.blue, 0.18))
  g.globalCompositeOperation = 'source-over'
  for (let i = 0; i < w * h * 0.004; i++) {
    const x = rnd() * w
    const y = rnd() * h * 0.7
    if (Math.hypot(x - ex, y - ey) > er + 1) dot(g, x, y, tone(c, c.foreground, 0.08 + 0.22 * ((Math.sin(t * (0.6 + (i % 5) * 0.3) + i) + 1) / 2)))
  }
  fillBelow(g, w, h, (x) => h * 0.62 + Math.sin(x * 0.02 + 1) * 4 + Math.abs(Math.sin(x * 0.07)) * 3, tone(c, c.foreground, 0.07))
  const ground = (x: number): number => h * 0.76 + Math.sin(x * 0.035) * 1.5
  fillBelow(g, w, h, ground, tone(c, c.foreground, 0.14))
  for (let x = rnd() * 30; x < w; x += 20 + rnd() * 50) {
    const r = 2 + Math.floor(rnd() * 5)
    const y = ground(x) + 3 + rnd() * Math.max(1, h - ground(x) - 6)
    oval(g, x, y, r * 2, r * 0.6, tone(c, c.foreground, 0.08))
    for (let a = Math.PI; a <= Math.PI * 2; a += 0.15) dot(g, x + Math.cos(a) * r * 2, y + Math.sin(a) * r * 0.6 - 1, tone(c, c.foreground, 0.2))
  }
  // The base: a dome with its windows lit, and a mast.
  const bx = Math.round(w * 0.22)
  const by = Math.round(ground(bx)) + 1
  for (let k = 0; k <= 7; k++) {
    const half = Math.round(Math.sqrt(49 - k * k) * 1.3)
    dot(g, bx - half, by - k, tone(c, c.foreground, 0.32), half * 2 + 1, 1)
  }
  for (const wx of [-5, -1, 3]) dot(g, bx + wx, by - 3, tone(c, c.yellow, 0.6), 2, 1)
  dot(g, bx + 11, by - 13, tone(c, c.foreground, 0.3), 1, 13)
  if (Math.sin(t * 2.5) > 0) dot(g, bx + 11, by - 14, tone(c, c.red, 0.9))
  // A rover crawling along, its tracks behind it.
  const rx = ((t * 3) % (w + 30)) - 15
  for (let x = 0; x < rx - 3; x += 2) dot(g, x, Math.round(ground(x)) + 3, tone(c, c.foreground, 0.2))
  const ry = Math.round(ground(rx)) + 2
  dot(g, rx - 3, ry - 3, tone(c, c.foreground, 0.5), 7, 2)
  for (const wx of [-3, 0, 3]) dot(g, rx + wx, ry - 1, tone(c, c.foreground, 0.3))
  dot(g, rx + 2, ry - 6, tone(c, c.foreground, 0.4), 1, 3)
  dot(g, rx + 1, ry - 7, tone(c, c.foreground, 0.4), 3, 1)
  dot(g, rx + 4, ry - 2, tone(c, c.yellow, 0.8))
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
  dunes: { name: 'Dunes', paint: dunes },
  snow: { name: 'Snowfall', paint: snow },
  volcano: { name: 'Volcano', paint: volcano },
  deepsea: { name: 'Deep sea', paint: deepsea },
  lighthouse: { name: 'Lighthouse', paint: lighthouse },
  orbit: { name: 'Ringed planet', paint: orbit },
  lanterns: { name: 'Lanterns', paint: lanterns },
  jellyfish: { name: 'Jellyfish', paint: jellyfish },
  meadow: { name: 'Meadow', paint: meadow },
  mesa: { name: 'Mesas', paint: mesa },
  fireworks: { name: 'Fireworks', paint: fireworks },
  blackhole: { name: 'Event horizon', paint: blackhole },
  circuit: { name: 'Circuit board', paint: circuit },
  koi: { name: 'Koi pond', paint: koi },
  train: { name: 'Night train', paint: train },
  storm: { name: 'Thunderstorm', paint: storm },
  ufo: { name: 'Close encounter', paint: ufo },
  neoncity: { name: 'Neon city', paint: neoncity },
  satellite: { name: 'Low orbit', paint: satellite },
  skywhale: { name: 'Sky whale', paint: skywhale },
  bamboo: { name: 'Bamboo grove', paint: bamboo },
  autumn: { name: 'Autumn', paint: autumn },
  launch: { name: 'Launch day', paint: launch },
  mushrooms: { name: 'Glowshrooms', paint: mushrooms },
  windmills: { name: 'Wind farm', paint: windmills },
  beach: { name: 'Sunset beach', paint: beach },
  zen: { name: 'Zen garden', paint: zen },
  moonbase: { name: 'Moon base', paint: moonbase }
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
