import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent, type PointerEvent } from 'react'
import { RotateCcw, Zap } from 'lucide-react'
import type { EffortLevel } from '@shared/types'
import { EFFORT_LABEL } from '@shared/effort'

/**
 * The model picker's effort row: a bolt, the level, a reset, and a stepped
 * pill slider with a white thumb. Dragging moves the thumb with the pointer,
 * one to one; letting go glides it onto the nearest step. A press on the
 * track glides the thumb there first. Keys step one level at a time. At the
 * model's highest level the row lights up with a moving purple pixel field.
 *
 * The motion runs outside React: one animation loop writes the thumb, the
 * fill and the dots straight onto their elements, so a frame never waits on
 * a render, and retargeting mid-glide continues from where the thumb is
 * rather than restarting.
 */

/** Thumb radius: the stops run from one thumb radius in to one thumb radius from the end. */
const R = 14

/**
 * Spring rates (rad/s) of a critically damped spring — it arrives without
 * overshoot or wobble. Gliding onto a step takes about 0.25 s; catching up
 * with the pointer after a press on the track, about 0.15 s.
 */
const SETTLE = 24
const CATCH_UP = 38

/** "Extra high" → "Extra High", as the level reads on the slider. */
const title = (level: EffortLevel): string => EFFORT_LABEL[level].replace(/\b\w/g, (c) => c.toUpperCase())

const reducedMotion = (): boolean =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.body.dataset.reduceMotion === 'on'

interface Motion {
  x: number
  v: number
  target: number
  rate: number
  frame: number
  then: number
  placed: boolean
}

export function EffortControl({
  levels,
  value,
  defaultLevel,
  onChange
}: {
  levels: EffortLevel[]
  value: EffortLevel
  /** What reset goes back to. */
  defaultLevel: EffortLevel
  onChange: (level: EffortLevel) => void
}): JSX.Element {
  const track = useRef<HTMLDivElement>(null)
  const thumb = useRef<HTMLDivElement>(null)
  const fill = useRef<HTMLDivElement>(null)
  const dots = useRef<(HTMLSpanElement | null)[]>([])
  const last = levels.length - 1
  const valueIndex = Math.max(0, levels.indexOf(value))

  const [width, setWidth] = useState(0)
  const widthRef = useRef(0)
  // The level the slider shows. Set the moment a drag ends or a key is
  // pressed, ahead of the saved setting: waiting for that round trip sent
  // the thumb back to the old step and then forward again.
  const [level, setLevel] = useState(valueIndex)
  const [dragging, setDragging] = useState(false)
  const [preview, setPreview] = useState(valueIndex)
  // Pointer handlers read these, not state: a quick click's pointerup can
  // arrive before React has rendered the pointerdown.
  const held = useRef(false)
  const grab = useRef(0)
  // How fast the pointer was moving the thumb, so letting go mid-flick glides on without a pause.
  const flick = useRef({ v: 0, at: 0 })
  const motion = useRef<Motion>({ x: 0, v: 0, target: 0, rate: SETTLE, frame: 0, then: 0, placed: false })

  const stopX = useCallback((i: number): number => {
    const w = widthRef.current
    return R + (last > 0 ? (i * (w - 2 * R)) / last : 0)
  }, [last])
  const nearest = useCallback((x: number): number => {
    const w = widthRef.current
    if (last <= 0 || w <= 2 * R) return 0
    return Math.round(((Math.min(Math.max(x, R), w - R) - R) / (w - 2 * R)) * last)
  }, [last])
  const clampX = (x: number): number => Math.min(Math.max(x, R), Math.max(R, widthRef.current - R))

  /** Draws the thumb at `x`: its position, the fill up to it, and the dots it has passed or covers. */
  const paint = useCallback((x: number): void => {
    if (thumb.current) thumb.current.style.transform = `translate3d(${x - R}px, 0, 0)`
    if (fill.current) fill.current.style.width = `${Math.max(0, x + 2)}px`
    dots.current.forEach((dot, i) => {
      if (!dot) return
      const at = stopX(i)
      dot.toggleAttribute('data-filled', at < x - 0.5)
      dot.toggleAttribute('data-hidden', Math.abs(at - x) < R - 3)
    })
  }, [stopX])

  /**
   * One step of a critically damped spring, solved exactly rather than
   * integrated, so it is smooth and stable whatever the frame time.
   */
  const step = useCallback((now: number): void => {
    const m = motion.current
    const dt = Math.min(0.05, Math.max(0, (now - m.then) / 1000))
    m.then = now
    const offset = m.x - m.target
    const w = m.rate
    const decay = Math.exp(-w * dt)
    const carry = m.v + w * offset
    m.x = m.target + (offset + carry * dt) * decay
    m.v = (m.v - w * carry * dt) * decay
    if (Math.abs(m.x - m.target) < 0.05 && Math.abs(m.v) < 1) {
      m.x = m.target
      m.v = 0
      m.frame = 0
      paint(m.x)
      return
    }
    paint(m.x)
    m.frame = requestAnimationFrame(step)
  }, [paint])

  /** Glides to `to`, carrying on from wherever the thumb is now; or puts it there at once. */
  const glide = useCallback((to: number, rate: number, instant = false): void => {
    const m = motion.current
    m.target = to
    m.rate = rate
    if (instant || !m.placed || reducedMotion()) {
      cancelAnimationFrame(m.frame)
      m.frame = 0
      m.x = to
      m.v = 0
      m.placed = true
      paint(to)
      return
    }
    if (!m.frame) {
      m.then = performance.now()
      m.frame = requestAnimationFrame(step)
    }
  }, [paint, step])

  /** Puts the thumb exactly under the pointer, ending any glide. */
  const place = useCallback((x: number): void => {
    const m = motion.current
    const now = performance.now()
    const dt = (now - flick.current.at) / 1000
    if (dt > 0 && dt < 0.1) flick.current.v = 0.6 * ((x - m.x) / dt) + 0.4 * flick.current.v
    flick.current.at = now
    cancelAnimationFrame(m.frame)
    m.frame = 0
    m.x = x
    m.target = x
    m.v = 0
    paint(x)
  }, [paint])

  useLayoutEffect(() => {
    const el = track.current
    if (!el) return
    const measure = (): void => {
      const w = el.clientWidth
      if (w === widthRef.current) return
      widthRef.current = w
      setWidth(w)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // A change from outside: another window, reset, a different model.
  useEffect(() => {
    if (held.current) return
    setLevel(valueIndex)
    setPreview(valueIndex)
  }, [valueIndex])

  // The thumb goes to the level. A new width (first layout, a resize) puts it there at once.
  const placedWidth = useRef(0)
  useLayoutEffect(() => {
    if (!width || held.current) return
    const resized = placedWidth.current !== width
    placedWidth.current = width
    glide(stopX(level), SETTLE, resized)
  }, [level, width, glide, stopX])

  useEffect(() => () => cancelAnimationFrame(motion.current.frame), [])

  const pointerX = (event: PointerEvent): number => event.clientX - track.current!.getBoundingClientRect().left

  /** Shows level `i` and saves it. `carry` keeps the speed of a drag that just ended. */
  const commit = (i: number, carry = false): void => {
    setLevel(i)
    setPreview(i)
    const m = motion.current
    const to = stopX(i)
    glide(to, SETTLE)
    if (carry && m.frame && performance.now() - flick.current.at < 60) {
      // Only speed toward the step, and never more than lands exactly on it:
      // a critically damped spring overshoots when it starts faster than
      // rate × distance.
      const toward = Math.sign(to - m.x)
      const speed = flick.current.v * toward
      m.v = speed > 0 ? toward * Math.min(speed, 0.9 * SETTLE * Math.abs(to - m.x)) : 0
    }
    if (levels[i] !== value) onChange(levels[i])
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !widthRef.current) return
    event.currentTarget.setPointerCapture(event.pointerId)
    held.current = true
    setDragging(true)
    flick.current = { v: 0, at: 0 }
    const at = pointerX(event)
    const m = motion.current
    if (Math.abs(at - m.x) <= R) {
      // On the thumb: it stays where it was grabbed and moves with the pointer from there.
      grab.current = m.x - at
      place(m.x)
    } else {
      // Elsewhere on the track: the thumb glides over to the pointer.
      grab.current = 0
      glide(clampX(at), CATCH_UP)
    }
    setPreview(nearest(clampX(at + grab.current)))
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (!held.current) return
    const x = clampX(pointerX(event) + grab.current)
    const m = motion.current
    // Still catching up after a press on the track: keep gliding, to the new spot.
    if (m.frame && Math.abs(m.x - x) > 1.5) glide(x, CATCH_UP)
    else place(x)
    setPreview(nearest(x))
  }

  const release = (event: PointerEvent<HTMLDivElement>): void => {
    if (!held.current) return
    held.current = false
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    setDragging(false)
    // Where the pointer let go, not where a glide had got to.
    commit(nearest(clampX(pointerX(event) + grab.current)), true)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    let next = level
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = Math.min(last, level + 1)
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = Math.max(0, level - 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = last
    else return
    event.preventDefault()
    if (next !== level) commit(next)
  }

  const showing = dragging ? preview : level
  const shown = levels[showing] ?? value
  const top = showing === last && last >= 2
  const defaultIndex = Math.max(0, levels.indexOf(defaultLevel))

  return (
    <div className="effort" data-top={top || undefined}>
      <UltraField on={top} />
      <div className="effort__head">
        <Zap className="effort__bolt" size={14.5} strokeWidth={0} fill="currentColor" aria-hidden="true" />
        <span className="effort__label" key={shown} aria-live="polite">
          {title(shown)}
        </span>
        <button
          className="effort__reset"
          disabled={level === defaultIndex}
          aria-label={`Reset to ${title(defaultLevel)}`}
          title={`Reset to ${title(defaultLevel)}`}
          onClick={() => commit(defaultIndex)}
        >
          <RotateCcw size={13} strokeWidth={1.7} />
        </button>
      </div>
      <div
        ref={track}
        className="effort__track"
        data-dragging={dragging || undefined}
        role="slider"
        tabIndex={0}
        aria-label="Effort"
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={level}
        aria-valuetext={title(levels[level] ?? value)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
        onKeyDown={onKeyDown}
      >
        <div ref={fill} className="effort__fill" />
        {width > 0 &&
          levels.map((item, i) => (
            <span
              key={item}
              ref={(el) => {
                dots.current[i] = el
              }}
              className="effort__dot"
              style={{ left: R + (last > 0 ? (i * (width - 2 * R)) / last : 0) }}
            />
          ))}
        <div ref={thumb} className="effort__thumb" />
      </div>
    </div>
  )
}

/**
 * The top level's light show: a field of purple pixel columns that drift
 * through a handful of shades, wiping in from the left when the level is
 * reached and fading out when it's left. A still frame with reduced motion.
 */
const SHADES = ['#24104d', '#2e1564', '#3a1b7c', '#462294', '#552bab', '#6535c2', '#7643d6', '#8655e6']
const CELL = 6

function UltraField({ on }: { on: boolean }): JSX.Element | null {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [mounted, setMounted] = useState(on)

  useEffect(() => {
    if (on) setMounted(true)
    else {
      const t = setTimeout(() => setMounted(false), 260)
      return () => clearTimeout(t)
    }
    return undefined
  }, [on])

  useEffect(() => {
    const el = canvas.current
    if (!el || !mounted) return
    const ctx = el.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const w = el.clientWidth
    const h = el.clientHeight
    el.width = Math.round(w * dpr)
    el.height = Math.round(h * dpr)
    ctx.scale(dpr, dpr)
    const cols = Math.ceil(w / CELL)
    const rows = Math.ceil(h / CELL)
    // A fixed per-column offset so neighbours don't move in lockstep.
    const jitter = Array.from({ length: cols }, (_, i) => Math.sin(i * 12.9898) * 0.9)
    const still = reducedMotion()
    const start = performance.now()
    let raf = 0
    let lastDraw = 0

    const draw = (now: number): void => {
      // ~20 frames a second: the stepped look is part of it.
      if (!still && now - lastDraw < 48) {
        raf = requestAnimationFrame(draw)
        return
      }
      lastDraw = now
      const t = still ? 2.4 : (now - start) / 1000
      const reveal = still ? cols : Math.min(cols, Math.floor(((now - start) / 420) * cols))
      ctx.clearRect(0, 0, w, h)
      for (let c = 0; c < cols; c++) {
        if (c > reveal) break
        for (let r = 0; r < rows; r++) {
          const v =
            Math.sin(c * 0.33 + t * 1.6 + jitter[c]) +
            Math.sin(r * 0.55 - t * 1.1 + c * 0.09) +
            Math.sin((c + r) * 0.17 + t * 0.8)
          const shade = Math.min(SHADES.length - 1, Math.max(0, Math.floor(((v + 3) / 6) * SHADES.length)))
          // Columns just revealed come in bright, then settle.
          const fresh = !still && reveal - c < 3 ? 2 : 0
          ctx.fillStyle = SHADES[Math.min(SHADES.length - 1, shade + fresh)]
          ctx.fillRect(c * CELL, r * CELL, CELL, CELL)
        }
      }
      if (!still) raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [mounted])

  if (!mounted) return null
  return <canvas ref={canvas} className="effort__field" data-on={on || undefined} aria-hidden="true" />
}
