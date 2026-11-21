import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import './effort-track.css'

/** The handle's width, and the room kept between it and the track's ends. */
const THUMB = 12
const PAD = 4
/** The characters, from the faintest to the densest; the leading spaces keep the start of the fill bare. */
const RAMP = '   ..::--=+xX8'
const FONT_PX = 10
/** How far a character strays from the ramp's even climb, so the fill reads as drawn, not as a gradient. */
const JITTER = 0.1
/** At the top level the characters are redrawn this often, with a wave crossing toward the handle every few seconds. */
const FRAME_MS = 50
const WAVE_EVERY_S = 3.2
const WAVE_TAKES_S = 1.6

/** Motion is off: the system setting or Eaon's own (Settings → Appearance). */
function stillMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.body.dataset.reduceMotion === 'on'
}

/** A fixed number in [0, 1) for a cell, so each character keeps its own wobble. */
function noise(col: number, row: number): number {
  const n = Math.sin(col * 12.9898 + row * 78.233) * 43758.5453
  return n - Math.floor(n)
}

/**
 * Reasoning effort in the model picker: the level by name, and a flat track
 * whose filled part is drawn in characters, from a few dots at its start to
 * the densest by the handle, like the home page's field. `labels` are the
 * levels the model takes, lowest first (two or more); `value` is the chosen
 * one's index. `onChange` fires once a drag is let go, a click lands or a
 * key moves it. At the model's highest level the characters stir, a wave of
 * them brightening toward the handle every few seconds (still, with motion
 * turned down).
 */
export function EffortTrack({
  labels,
  value,
  model,
  onChange
}: {
  labels: string[]
  value: number
  model: string
  onChange: (index: number) => void
}): JSX.Element {
  const count = labels.length
  const max = count - 1
  const track = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)
  /** Where the handle is, in levels; between two while it is dragged or gliding. */
  const [pos, setPos] = useState(value)
  const posRef = useRef(value)
  const [dragging, setDragging] = useState(false)
  const draggingRef = useRef(false)
  /** The level the handle settles on: the chosen one, or the one just let go on until the choice comes back. */
  const [target, setTarget] = useState(value)
  useEffect(() => setTarget(value), [value])

  const move = (next: number): void => {
    posRef.current = next
    setPos(next)
  }

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

  // To its level, gliding, whenever that changes and nobody is dragging:
  // after a drag, a click, a key, or from elsewhere (another model, another window).
  useEffect(() => {
    if (draggingRef.current) return
    const from = posRef.current
    if (from === target) return
    if (stillMotion()) {
      move(target)
      return
    }
    const start = performance.now()
    let raf = 0
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / 200)
      move(from + (target - from) * (1 - (1 - t) ** 3))
      if (t < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target, dragging])

  const span = Math.max(1, width - PAD * 2 - THUMB)
  const centerOf = (level: number): number => PAD + THUMB / 2 + (level / max) * span
  const thumbX = centerOf(pos)
  const active = Math.round(pos)
  const top = active === max

  // The characters: drawn again as the handle moves, and over and over at the top level.
  useEffect(() => {
    const el = canvas.current
    const ctx = el?.getContext('2d')
    if (!el || !ctx || width === 0) return
    const height = el.offsetHeight
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    el.width = Math.round(width * dpr)
    el.height = Math.round(height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const style = getComputedStyle(el)
    ctx.font = `${FONT_PX}px ${style.fontFamily}`
    ctx.textBaseline = 'middle'
    ctx.fillStyle = style.color
    const cell = ctx.measureText('0').width || 6
    const end = thumbX - THUMB / 2 - 2
    const rows = [height / 2 - FONT_PX / 2 - 0.5, height / 2 + FONT_PX / 2 + 0.5]
    const still = stillMotion()
    const born = performance.now()

    const draw = (now: number): void => {
      const t = (now - born) / 1000
      const cycle = t % WAVE_EVERY_S
      const wave = top && !still && cycle < WAVE_TAKES_S ? (cycle / WAVE_TAKES_S) * (end + 40) - 20 : -1e3
      ctx.clearRect(0, 0, width, height)
      for (let col = 0; col * cell + cell <= end; col++) {
        const x = col * cell + cell / 2
        const climb = Math.pow(x / Math.max(1, end), 1.5)
        const swell = Math.exp(-(((x - wave) / 18) ** 2)) * 0.35
        rows.forEach((y, row) => {
          // At the top level each character drifts a little, slowly, on its own beat.
          const drift = top && !still ? Math.sin(t * 1.3 + noise(col, row) * 6.283) * 0.06 : 0
          const d = Math.min(1, Math.max(0, climb + (noise(col, row) - 0.5) * 2 * JITTER + swell + drift))
          const ch = RAMP[Math.round(d * (RAMP.length - 1))]
          if (ch === ' ') return
          ctx.globalAlpha = 0.28 + 0.72 * d
          ctx.fillText(ch, col * cell, y + 0.5)
        })
      }
      ctx.globalAlpha = 1
    }

    if (!top || still) {
      draw(born)
      return
    }
    let raf = 0
    let last = -Infinity
    const loop = (now: number): void => {
      raf = requestAnimationFrame(loop)
      if (now - last < FRAME_MS) return
      last = now
      draw(now)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [width, thumbX, top])

  /** The level under the pointer, between two while dragging. */
  const levelAt = (clientX: number): number => {
    const rect = track.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return posRef.current
    const x = ((clientX - rect.left) / rect.width) * width
    return Math.min(max, Math.max(0, ((x - PAD - THUMB / 2) / span) * max))
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    draggingRef.current = true
    setDragging(true)
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* Pointer capture needs a trusted event. */
    }
    move(levelAt(event.clientX))
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (draggingRef.current) move(levelAt(event.clientX))
  }
  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return
    draggingRef.current = false
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* Not captured: the event wasn't trusted. */
    }
    const next = Math.round(posRef.current)
    setTarget(next)
    setDragging(false)
    if (next !== value) onChange(next)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    let next = value
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = Math.min(max, value + 1)
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = Math.max(0, value - 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = max
    else return
    event.preventDefault()
    setTarget(next)
    if (next !== value) onChange(next)
  }

  return (
    <div className="effort-track" data-dragging={dragging || undefined} data-top={top || undefined}>
      <div className="effort-track__head">
        <span className="effort-track__eyebrow">Reasoning</span>
        <span key={labels[active]} className="effort-track__level">
          {labels[active]}
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
        aria-valuenow={active}
        aria-valuetext={`${model} ${labels[active]}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <div className="effort-track__fill" style={{ width: thumbX }} />
        <canvas ref={canvas} className="effort-track__chars" aria-hidden="true" />
        {/* The levels still ahead of the handle, as dots on the bare track. */}
        {labels.map((label, i) =>
          centerOf(i) > thumbX + THUMB ? <span key={label} className="effort-track__stop" style={{ left: centerOf(i) }} /> : null
        )}
        <span className="effort-track__thumb" style={{ left: thumbX }} />
      </div>
    </div>
  )
}
