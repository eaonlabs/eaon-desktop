import { useEffect, useRef } from 'react'

/**
 * A dotted, honestly-3D thinking orb rendered on a 2D canvas.
 *
 * Depth is carried by dot radius and ink weight alone — no filters, no
 * shadows — and every frame is z-sorted far→near before painting, so nearer
 * dots genuinely occlude farther ones. On dark substrates the ink value is
 * mirrored so near dots read bright, which is the same depth language on an
 * inverted background.
 *
 * Two states are wired to what the app actually does:
 *   working   — particles running tilted orbits (the model is thinking)
 *   searching — a scan meridian sweeping a dotted globe (a tool is running)
 */

export type OrbState = 'working' | 'searching'

interface Dot {
  x: number
  y: number
  z: number
  r: number
  /** Ink value: 0 = darkest. Mirrored on dark themes. */
  white: number
  a?: number
}

/** Deterministic hash in [0, 1) — keeps every orbit stable across frames. */
function hashD(a: number, b: number): number {
  const h = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453
  return h - Math.floor(h)
}

/** Shortest signed angular distance, wrapped to (-π, π]. */
function angleDelta(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b))
}

/** Spin + tilt + orthographic projection. */
function makeProj(
  yaw: number,
  tilt: number,
  cx: number,
  cy: number,
  scale: number
): (x: number, y: number, z: number) => [number, number, number] {
  const st = Math.sin(tilt)
  const ct = Math.cos(tilt)
  const sy = Math.sin(yaw)
  const cyw = Math.cos(yaw)
  return (x, y, z) => {
    const x1 = x * cyw + z * sy
    const z1 = -x * sy + z * cyw
    const y1 = y * ct - z1 * st
    const z2 = y * st + z1 * ct
    return [cx + x1 * scale, cy - y1 * scale, z2]
  }
}

/** Radii were tuned on a large frame; sub-linear scaling keeps small orbs legible. */
function radiusScale(size: number, pow = 0.6): number {
  return (size / 300) ** pow
}

/** Drop invisible marks, clamp radii, and z-sort into draw order. */
function finalize(dots: Dot[], rMin = 0.3): Dot[] {
  const visible: Dot[] = []
  for (const d of dots) {
    if ((d.a ?? 1) < 0.02) continue
    d.r = Math.max(rMin, d.r)
    visible.push(d)
  }
  visible.sort((a, b) => a.z - b.z)
  return visible
}

/** Particles on tilted orbits. */
function frameOrbits(size: number, t: number, count: number, sizeMul: number): Dot[] {
  const c = size / 2
  const R = (size / 2) * 0.82
  const pt = makeProj(t * 0.12, 0.3, c, c, 1)
  const rs = radiusScale(size) * sizeMul

  const dots: Dot[] = []
  const orbitN = Math.max(1, Math.round(12 * count))
  const ghostN = Math.max(2, Math.round(40 * count))

  for (let orb = 0; orb < orbitN; orb++) {
    const h1 = hashD(orb, 1.7)
    const h2 = hashD(orb, 5.2)
    const h3 = hashD(orb, 8.9)
    const ro = R * (0.45 + 0.52 * h1)
    const th = h1 * 2 * Math.PI
    const phi = Math.acos(2 * h2 - 1)

    // Orbit-plane basis (u, v perpendicular to the plane normal n).
    const nx = Math.sin(phi) * Math.cos(th)
    const ny = Math.cos(phi)
    const nz = Math.sin(phi) * Math.sin(th)
    let ux = -ny
    let uy = nx
    const uz = 0
    const ul = Math.max(1e-6, Math.sqrt(ux * ux + uy * uy))
    ux /= ul
    uy /= ul
    const vx = ny * uz - nz * uy
    const vy = nz * ux - nx * uz
    const vz = nx * uy - ny * ux
    const speed = (0.25 + 0.55 * h3) * (h3 > 0.5 ? 1 : -1)

    // The ghost path the particles run along.
    for (let k = 0; k < ghostN; k++) {
      const a = (k / ghostN) * 2 * Math.PI
      const [px, py, z] = pt(
        (ux * Math.cos(a) + vx * Math.sin(a)) * ro,
        (uy * Math.cos(a) + vy * Math.sin(a)) * ro,
        (uz * Math.cos(a) + vz * Math.sin(a)) * ro
      )
      const depth = (z / ro + 1) / 2
      dots.push({ x: px, y: py, z, r: 0.9 * rs, white: 0.72, a: 0.5 * (0.4 + 0.6 * depth) })
    }

    // The particles doing the work.
    for (let m = 0; m < 3; m++) {
      const a = t * speed + (m / 3) * 2 * Math.PI + h2 * 6
      const [px, py, z] = pt(
        (ux * Math.cos(a) + vx * Math.sin(a)) * ro,
        (uy * Math.cos(a) + vy * Math.sin(a)) * ro,
        (uz * Math.cos(a) + vz * Math.sin(a)) * ro
      )
      const depth = (z / ro + 1) / 2
      dots.push({ x: px, y: py, z, r: (1.2 + 1.6 * depth) * rs, white: 0.3 - 0.22 * depth })
    }
  }
  return finalize(dots)
}

/** A scan meridian sweeping a dotted globe. */
function frameGlobe(size: number, t: number, count: number, sizeMul: number): Dot[] {
  const spin = 0.5
  const c = size / 2
  const radius = (size / 2) * 0.82
  const tilt = 0.4 + 0.06 * Math.sin(t * 0.35)
  const pt = makeProj(t * spin, tilt, c, c, radius)
  // The scan sweeps relative to the spin, so it reads as a moving meridian
  // rather than the sphere simply turning.
  const scan = t * (spin + (1.7 - spin) * 4.2)
  const rs = radiusScale(size) * sizeMul
  const dimBase = 0.45

  const dots: Dot[] = []
  const root = Math.sqrt(count)
  const latRings = Math.max(2, Math.round(17 * root))
  const lonDensity = Math.max(2, Math.round(44 * root))

  for (let li = 0; li <= latRings; li++) {
    const lat = -Math.PI / 2 + (li / latRings) * Math.PI
    const cosLat = Math.cos(lat)
    const sinLat = Math.sin(lat)
    const lonCount = Math.max(1, Math.round(Math.abs(cosLat) * lonDensity))
    for (let lj = 0; lj < lonCount; lj++) {
      const lon = (lj / lonCount) * 2 * Math.PI
      const [px, py, z] = pt(cosLat * Math.cos(lon), sinLat, cosLat * Math.sin(lon))
      const depth = (z + 1) / 2
      // The scan reads as a size ripple rather than a shine.
      const d = angleDelta(lon + t * spin, scan)
      const boost = Math.exp(-(d * d) / 0.18) * Math.max(0, z)
      dots.push({
        x: px,
        y: py,
        z,
        r: (0.6 + 1.7 * depth + boost) * rs,
        white: 0.62 - 0.54 * depth,
        a: dimBase + (1 - dimBase) * Math.min(1, boost)
      })
    }
  }
  return finalize(dots)
}

/**
 * Per-size tunings. These are separate designs rather than one design scaled:
 * a 20px orb needs far fewer, proportionally larger dots to stay legible.
 */
const TUNING: Record<OrbState, { small: [number, number, number]; large: [number, number, number] }> = {
  //            [speed, countMul, sizeMul]
  working: { small: [3.9, 0.238, 2.4], large: [1.885, 1, 1] },
  searching: { small: [2.665, 0.105, 1.75], large: [2.015, 0.42, 1.15] }
}

export function ThinkingOrb({
  size = 20,
  state = 'working',
  className
}: {
  size?: number
  state?: OrbState
  className?: string
}): JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const ctx = el.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    el.width = size * dpr
    el.height = size * dpr
    ctx.scale(dpr, dpr)

    const dark = document.documentElement.dataset.theme !== 'light'
    const reduced =
      document.body.dataset.reduceMotion === 'on' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const tune = TUNING[state][size <= 32 ? 'small' : 'large']
    const [speed, count, sizeMul] = tune
    const build = state === 'searching' ? frameGlobe : frameOrbits

    let raf = 0
    const start = performance.now()

    const draw = (now: number): void => {
      const t = ((now - start) / 1000) * speed
      ctx.clearRect(0, 0, size, size)
      for (const d of build(size, t, count, sizeMul)) {
        const w = Math.min(1, Math.max(0, d.white))
        const g = Math.round((dark ? 1 - w : w) * 255)
        ctx.fillStyle = `rgba(${g},${g},${g},${d.a ?? 1})`
        ctx.beginPath()
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2)
        ctx.fill()
      }
      if (!reduced) raf = requestAnimationFrame(draw)
    }

    // Reduced motion still gets a rendered orb, just frozen on one frame.
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [size, state])

  return (
    <canvas
      ref={canvas}
      className={className}
      style={{ width: size, height: size, flex: 'none', display: 'block' }}
      aria-hidden="true"
    />
  )
}
