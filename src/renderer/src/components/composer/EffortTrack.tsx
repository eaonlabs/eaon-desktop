import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { EffortStyle } from '@shared/types'
import './effort-track.css'

/** The handle's width, and the room kept between it and the track's ends. */
const THUMB = 12
const PAD = 4
/** The text fills' characters, from the faintest to the densest; the leading spaces keep the start of the fill bare. */
const CHARACTERS = '   ..::--=+xX8'
const BLOCKS = '   ░░▒▒▓▓█'
/** A Braille cell's eight dots, in the order they fill in. */
const BRAILLE_DOTS = [0x40, 0x04, 0x10, 0x02, 0x80, 0x08, 0x20, 0x01]
/** Ordered dithering's threshold map, 4 × 4, and its pixels' pitch; the dots' pitch. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
const DITHER_PX = 2
const DOT_PITCH = 4
const FONT_PX = 10
/** How far a cell strays from the ramp's even climb, so the fill reads as drawn, not as a gradient. */
const JITTER = 0.1

/**
 * The handle's springs, as stiffness and damping ratio: settling on a level
 * (a touch loose, so it lands with a little give) and following a drag (stiff
 * and nearly critical, so it stays under the pointer without lagging).
 */
const SETTLE = { stiffness: 420, damping: 0.7 }
const FOLLOW = { stiffness: 1800, damping: 0.95 }
/** A flick carries on by its speed times this, in seconds, before it picks its level. */
const THROW_S = 0.08
/** The fill prints itself in, left to right, this fast when the menu opens. */
const REVEAL_MS = 520
/** A new level's flare by the handle, and the ripple it sends back along the fill. */
const FLARE_S = 0.42
const RIPPLE_SPEED = 560
const RIPPLE_S = 0.55
/** Reaching the top level: a bright sweep across the fill, once. */
const SWEEP_MS = 760
/** At the top level the fill keeps stirring: redrawn this often, with a wave toward the handle every few seconds. */
const FRAME_MS = 40
const WAVE_EVERY_S = 3.2
const WAVE_TAKES_S = 1.6

/** Motion is off: the system setting or Eaon's own (Settings → Appearance). */
function stillMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.body.dataset.reduceMotion === 'on'
}

/** A fixed number in [0, 1) for a cell, so each cell keeps its own wobble. */
function noise(col: number, row: number): number {
  const n = Math.sin(col * 12.9898 + row * 78.233) * 43758.5453
  return n - Math.floor(n)
}

const bell = (x: number, width: number): number => Math.exp(-((x / width) ** 2))
const easeOut = (t: number): number => 1 - (1 - t) ** 3

/**
 * Reasoning effort in the model picker: the level by name, and a flat track
 * whose filled part is drawn in characters (or dithered pixels, Braille,
 * shaded blocks or halftone dots: `look`), from next to nothing at its start
 * to the densest by the handle, like the home page's field. `labels` are the
 * levels the model takes, lowest first (two or more); `value` is the chosen
 * one's index. `onChange` fires once a drag is let go, a click lands or a
 * key moves it.
 *
 * It moves on springs, in one animation loop that writes straight to the
 * handle, the fill and the canvas and stops whenever nothing moves: the
 * handle follows a drag, keeps a flick's momentum into the level it picks
 * and lands with a little give, leans with its speed, and bumps as it
 * crosses each level. The fill prints itself in when the menu opens; a new
 * level flares by the handle and sends a ripple back along the fill; the
 * top level sweeps it once, then keeps it stirring. Hovering previews the
 * fill out to the pointer, or dims what a lower level would give up. The
 * level's name rolls up or down with the way it moved. With motion turned
 * down it all simply jumps.
 */
export function EffortTrack({
  labels,
  value,
  model,
  look = 'characters',
  onChange
}: {
  labels: string[]
  value: number
  model: string
  /** How the fill is drawn (Settings → Appearance → Reasoning slider). */
  look?: EffortStyle
  onChange: (index: number) => void
}): JSX.Element {
  const count = labels.length
  const max = count - 1
  const track = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const thumb = useRef<HTMLSpanElement>(null)
  const fill = useRef<HTMLDivElement>(null)
  const stops = useRef<(HTMLSpanElement | null)[]>([])
  const [width, setWidth] = useState(0)
  const [dragging, setDragging] = useState(false)
  /** The level the name shows, the one it rolled away from (for its way out), and which way it went. */
  const [shown, setShown] = useState<{ now: number; was: number | null; up: boolean }>({ now: value, was: null, up: true })

  /** Everything the loop moves, kept off React so a frame is never a render. */
  const m = useRef({
    x: value,
    v: 0,
    target: value,
    follow: value,
    dragging: false,
    /** The level the handle was last over, for its bump and the name. */
    over: value,
    press: 1,
    bump: 0,
    tilt: 0,
    hover: null as number | null,
    ghost: 0,
    born: performance.now(),
    flareAt: -1e9,
    sweepAt: -1e9,
    kick: () => {}
  })

  // The track's own width (the menu around it scales while it opens; this doesn't).
  useLayoutEffect(() => {
    const el = track.current
    if (!el) return
    const measure = (): void => setWidth(el.offsetWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // The chosen level changed from elsewhere (another model, another window): glide to it.
  useEffect(() => {
    const s = m.current
    if (s.dragging || s.target === value) return
    s.target = value
    s.kick()
  }, [value])

  // The loop: springs, the handle, the fill, the canvas. It runs while anything moves, and its
  // first frame is drawn before the page paints, so the handle is never seen out of place.
  useLayoutEffect(() => {
    const el = canvas.current
    const ctx = el?.getContext('2d')
    if (!el || !ctx || width === 0) return
    const s = m.current
    const height = el.offsetHeight
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    el.width = Math.round(width * dpr)
    el.height = Math.round(height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const font = `${FONT_PX}px ${getComputedStyle(el).fontFamily}`
    ctx.font = font
    const textCell = ctx.measureText('0').width || 6
    const textRows = [height / 2 - FONT_PX / 2 - 0.5, height / 2 + FONT_PX / 2 + 0.5]
    const span = Math.max(1, width - PAD * 2 - THUMB)
    const centerOf = (level: number): number => PAD + THUMB / 2 + (level / max) * span
    const still = stillMotion()
    if (still) s.born = -1e9
    let raf = 0
    let last = performance.now()
    let lastDraw = -Infinity

    /** Everything drawn in the fill (and its preview), from the cells' density. */
    const paint = (now: number, cx: number): void => {
      const t = now / 1000
      const end = cx - THUMB / 2 - 2
      const top = Math.round(s.x) === max && !s.dragging
      const stirring = top && !still
      const cycle = (t - s.born / 1000) % WAVE_EVERY_S
      const wave = stirring && cycle < WAVE_TAKES_S ? (cycle / WAVE_TAKES_S) * (end + 40) - 20 : -1e3
      const reveal = still ? 1 : Math.min(1, (now - s.born) / REVEAL_MS)
      // Once printed, everything is: a preview past the handle included.
      const front = reveal >= 1 ? Infinity : easeOut(reveal) * (end + 40) - 10
      const flare = still ? 0 : Math.exp(-(now - s.flareAt) / 1000 / FLARE_S)
      const ripple = still ? -1e3 : end - ((now - s.flareAt) / 1000) * RIPPLE_SPEED
      const rippleLeft = Math.exp(-(now - s.flareAt) / 1000 / RIPPLE_S)
      const sweepT = (now - s.sweepAt) / SWEEP_MS
      const sweep = !still && sweepT < 1 ? easeOut(sweepT) * (end + 80) - 40 : -1e3
      // A hover past the handle previews the fill out to it; before the handle, it dims what would go.
      const hoverX = s.hover === null ? null : centerOf(s.hover)
      const ahead = hoverX !== null && hoverX > cx + THUMB ? hoverX - THUMB / 2 - 2 : null
      const behind = hoverX !== null && hoverX < cx - THUMB ? hoverX : null
      const reach = ahead ?? end

      /** How full a cell at `x` is, 0–1, and how bright it is drawn. */
      const cellAt = (x: number, col: number, row: number): { d: number; a: number } | null => {
        const ghost = x > end
        if (ghost && (ahead === null || x > ahead)) return null
        // Printing in: a cell shows once the front has passed it, give or take its own beat.
        const printed = front - x - noise(col, row + 3) * 24
        if (printed < 0) return null
        const climb = Math.pow(Math.max(0, x) / Math.max(1, ghost ? reach : end), 1.5)
        const drift = stirring ? Math.sin(t * 1.3 + noise(col, row) * 6.283) * 0.06 : 0
        const lift =
          bell(x - wave, 18) * 0.35 +
          bell(x - end, 28) * 0.5 * flare +
          bell(x - ripple, 10) * 0.45 * rippleLeft +
          bell(x - sweep, 26) * 0.6 +
          bell(printed, 10) * 0.5 * (1 - reveal)
        const d = Math.min(1, Math.max(0, climb + (noise(col, row) - 0.5) * 2 * JITTER + drift + (ghost ? 0 : lift)))
        let a = 1
        if (ghost) a = 0.3 * s.ghost
        else if (behind !== null && x > behind) a = 1 - 0.55 * s.ghost
        return { d, a }
      }

      ctx.clearRect(0, 0, width, height)
      ctx.fillStyle = getComputedStyle(el).color
      const limit = Math.max(end, ahead ?? 0)
      if (look === 'dither') {
        // Tiny pixels on or off against the threshold map, over the track's whole height.
        for (let col = 0; col * DITHER_PX + DITHER_PX <= limit; col++) {
          for (let row = 0; (row + 1) * DITHER_PX <= height - 4; row++) {
            const cell = cellAt(col * DITHER_PX, col, row)
            if (!cell || cell.d * 16 <= BAYER[(row % 4) * 4 + (col % 4)] + 0.5) continue
            ctx.globalAlpha = 0.9 * cell.a
            ctx.fillRect(col * DITHER_PX, 2 + row * DITHER_PX, DITHER_PX - 0.4, DITHER_PX - 0.4)
          }
        }
      } else if (look === 'dots') {
        // A halftone screen: dots that grow toward the handle.
        for (let col = 0; (col + 1) * DOT_PITCH <= limit; col++) {
          const x = col * DOT_PITCH + DOT_PITCH / 2
          for (let row = 0; (row + 1) * DOT_PITCH <= height - 2; row++) {
            const cell = cellAt(x, col, row)
            const r = cell ? cell.d * DOT_PITCH * 0.48 : 0
            if (!cell || r < 0.3) continue
            ctx.globalAlpha = 0.9 * cell.a
            ctx.beginPath()
            ctx.arc(x, 1 + row * DOT_PITCH + DOT_PITCH / 2, r, 0, Math.PI * 2)
            ctx.fill()
          }
        }
      } else {
        // Text, two rows of it: characters, shaded blocks, or Braille cells with more dots toward the handle.
        ctx.font = font
        ctx.textBaseline = 'middle'
        for (let col = 0; col * textCell + textCell <= limit; col++) {
          const x = col * textCell + textCell / 2
          textRows.forEach((y, row) => {
            const cell = cellAt(x, col, row)
            if (!cell) return
            let ch: string
            if (look === 'braille') {
              const dots = Math.round(cell.d * 8)
              if (dots === 0) return
              // Each cell fills its dots in its own order, so neighbours don't match.
              const from = Math.floor(noise(col, row + 7) * 8)
              let bits = 0
              for (let i = 0; i < dots; i++) bits |= BRAILLE_DOTS[(from + i) % 8]
              ch = String.fromCharCode(0x2800 + bits)
            } else {
              const ramp = look === 'blocks' ? BLOCKS : CHARACTERS
              ch = ramp[Math.round(cell.d * (ramp.length - 1))]
              if (ch === ' ') return
            }
            ctx.globalAlpha = (0.28 + 0.72 * cell.d) * cell.a
            ctx.fillText(ch, col * textCell, y + 0.5)
          })
        }
      }
      ctx.globalAlpha = 1
    }

    const frame = (now: number): void => {
      raf = 0
      const dt = Math.min(0.032, Math.max(0.001, (now - last) / 1000))
      last = now
      // The handle: a spring toward the pointer while dragged, toward its level after.
      const goal = s.dragging ? s.follow : s.target
      if (still) {
        s.x = goal
        s.v = 0
      } else {
        const { stiffness, damping } = s.dragging ? FOLLOW : SETTLE
        s.v += (-stiffness * (s.x - goal) - 2 * Math.sqrt(stiffness) * damping * s.v) * dt
        s.x += s.v * dt
        if (!s.dragging && Math.abs(s.x - goal) < 0.0008 && Math.abs(s.v) < 0.004) {
          s.x = goal
          s.v = 0
        }
      }
      // Over a new level: the handle bumps, the name rolls, and the top level sweeps the fill.
      const over = Math.min(max, Math.max(0, Math.round(s.x)))
      if (over !== s.over) {
        if (!still) s.bump = 1
        if (over === max && !still) s.sweepAt = now
        setShown({ now: over, was: s.over, up: over > s.over })
        s.over = over
      }
      // Its lean (with its speed, in points a second), its lift while held, and the bump easing off.
      const speed = s.v * (span / max)
      const lean = still ? 0 : Math.max(-9, Math.min(9, speed / 90))
      s.tilt += (lean - s.tilt) * Math.min(1, dt * 16)
      s.press += ((s.dragging ? 1.08 : 1) - s.press) * Math.min(1, dt * 22)
      s.bump *= Math.exp(-dt / 0.12)
      s.ghost += ((s.hover === null || s.dragging ? 0 : 1) - s.ghost) * Math.min(1, dt * 14)

      // Past either end the handle presses into the wall, squashed, rather than leaving the track.
      const raw = centerOf(s.x)
      const lo = PAD + THUMB / 2
      const hi = width - PAD - THUMB / 2
      const cx = Math.min(hi, Math.max(lo, raw))
      const squash = Math.min(0.3, Math.abs(raw - cx) / 14)
      if (thumb.current) {
        const sx = s.press * (1 - squash) - s.bump * 0.05
        const sy = s.press * (1 + squash * 0.4) + s.bump * 0.14
        thumb.current.style.transform = `translate3d(${(cx - THUMB / 2).toFixed(2)}px, 0, 0) rotate(${s.tilt.toFixed(2)}deg) scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`
      }
      if (fill.current) fill.current.style.transform = `scaleX(${(cx / width).toFixed(4)})`
      stops.current.forEach((stop, i) => {
        if (!stop) return
        const covered = centerOf(i) <= cx + THUMB / 2 + 1
        if ((stop.dataset.covered === 'true') !== covered) stop.dataset.covered = String(covered)
        const hovered = !covered && s.hover === i && !s.dragging
        if ((stop.dataset.hovered === 'true') !== hovered) stop.dataset.hovered = String(hovered)
      })

      const moving = !still && (s.v !== 0 || s.dragging || Math.abs(s.press - (s.dragging ? 1.08 : 1)) > 0.002 || s.bump > 0.01 || Math.abs(s.tilt) > 0.05)
      const effects =
        !still &&
        (now - s.born < REVEAL_MS + 200 ||
          now - s.flareAt < FLARE_S * 4000 ||
          now - s.sweepAt < SWEEP_MS ||
          Math.abs(s.ghost - (s.hover === null || s.dragging ? 0 : 1)) > 0.01)
      const stirring = !still && over === max && !s.dragging
      if (moving || effects || now - lastDraw >= FRAME_MS || !stirring) {
        paint(now, cx)
        lastDraw = now
      }
      if (moving || effects || stirring) raf = requestAnimationFrame(frame)
    }

    s.kick = () => {
      if (raf) return
      last = performance.now()
      raf = requestAnimationFrame(frame)
    }
    frame(performance.now())
    // A change of theme changes the fill's colour: draw again.
    const theme = new MutationObserver(() => s.kick())
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] })
    return () => {
      cancelAnimationFrame(raf)
      theme.disconnect()
      s.kick = () => {}
    }
  }, [width, look, max])

  // The rolled-away name goes once its way out has played.
  useEffect(() => {
    if (shown.was === null) return
    const timer = window.setTimeout(() => setShown((s) => ({ ...s, was: null })), 260)
    return () => window.clearTimeout(timer)
  }, [shown])

  /** The level under the pointer, between two (or a little past the ends, which the handle presses into). */
  const levelAt = (clientX: number, overshoot = 0): number => {
    const rect = track.current?.getBoundingClientRect()
    if (!rect || rect.width === 0 || width === 0) return m.current.x
    const x = ((clientX - rect.left) / rect.width) * width
    const span = Math.max(1, width - PAD * 2 - THUMB)
    return Math.min(max + overshoot, Math.max(-overshoot, ((x - PAD - THUMB / 2) / span) * max))
  }

  /** Settle on `level` from wherever the handle is, with a flare if it is a new one. */
  const land = (level: number): void => {
    const s = m.current
    s.target = level
    if (level !== value) {
      s.flareAt = performance.now()
      onChange(level)
    }
    s.kick()
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const s = m.current
    s.dragging = true
    s.follow = levelAt(event.clientX, 0.12)
    setDragging(true)
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* Pointer capture needs a trusted event. */
    }
    s.kick()
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const s = m.current
    if (s.dragging) s.follow = levelAt(event.clientX, 0.12)
    else s.hover = Math.round(levelAt(event.clientX))
    s.kick()
  }
  const onPointerLeave = (): void => {
    m.current.hover = null
    m.current.kick()
  }
  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    const s = m.current
    if (!s.dragging) return
    s.dragging = false
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* Not captured: the event wasn't trusted. */
    }
    setDragging(false)
    // A flick carries on by its speed before it picks its level.
    land(Math.min(max, Math.max(0, Math.round(s.x + s.v * THROW_S))))
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const now = m.current.target
    let next = now
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = Math.min(max, now + 1)
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = Math.max(0, now - 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = max
    else return
    event.preventDefault()
    land(next)
  }

  const top = shown.now === max && !dragging
  return (
    <div className="effort-track" data-dragging={dragging || undefined} data-top={top || undefined}>
      <div className="effort-track__head">
        <span className="effort-track__eyebrow">Reasoning</span>
        <span className="effort-track__levels">
          {shown.was !== null && (
            <span key={`was-${shown.was}-${shown.now}`} className="effort-track__level" data-leaving={shown.up ? 'up' : 'down'} aria-hidden="true">
              {labels[shown.was]}
            </span>
          )}
          <span key={`now-${shown.now}`} className="effort-track__level" data-entering={shown.was === null ? undefined : shown.up ? 'up' : 'down'}>
            {labels[shown.now]}
          </span>
        </span>
      </div>
      <div
        ref={track}
        className="effort-track__track"
        role="slider"
        tabIndex={0}
        aria-label="Reasoning effort"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={shown.now}
        aria-valuetext={`${model} ${labels[shown.now]}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <div ref={fill} className="effort-track__fill" />
        <canvas ref={canvas} className="effort-track__chars" aria-hidden="true" />
        {/* The levels, as dots on the bare track; the fill takes in each one the handle passes. */}
        {labels.map((label, i) => (
          <span
            key={label}
            ref={(node) => {
              stops.current[i] = node
              // Those under the fill start taken in, rather than fading out as the menu opens.
              if (node && node.dataset.covered === undefined) node.dataset.covered = String(i <= value)
            }}
            className="effort-track__stop"
            style={{ left: PAD + THUMB / 2 + (i / max) * Math.max(1, width - PAD * 2 - THUMB) }}
          />
        ))}
        <span ref={thumb} className="effort-track__thumb" />
      </div>
    </div>
  )
}
