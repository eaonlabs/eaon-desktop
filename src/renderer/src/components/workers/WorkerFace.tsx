import { memo, useEffect, useRef, type JSX } from 'react'
import type { WorkerMood } from '@shared/workers'

/**
 * A worker's face: a flat circle in the colour the user picked, with two soft
 * rounded-rectangle eyes. Drawn on a 100×100 grid measured from the design
 * spec — eyes centred at x 33.3 / 66.7, y 40, 13.5 wide and 25 tall.
 *
 * The body never moves; every animation is in the eyes. They blink, glance
 * around, scan while the worker is busy, and blink into each new expression
 * rather than snapping to it (the eye group is keyed by mood, so a mood
 * change remounts it and replays the opening blink).
 */

const EYE_X = [33.3, 66.7] as const
const EYE_Y = 40

/**
 * Eye outlines in the eye's own coordinates (centre 0,0), for the left eye.
 * The right eye is the same shape mirrored, so the angry slant points inward
 * on both sides.
 */
const SHAPES: Record<Exclude<WorkerMood, 'asleep' | 'dead'>, string> = {
  // A full pill: semicircles of radius 6.75 at y −5.85 and +5.85.
  neutral: 'M -6.75 -5.85 A 6.75 6.75 0 0 1 6.75 -5.85 L 6.75 5.85 A 6.75 6.75 0 0 1 -6.75 5.85 Z',
  // Rounded top, lower edge lifted into an arc — smiling eyes.
  happy: 'M -6.75 -5.85 A 6.75 6.75 0 0 1 6.75 -5.85 L 6.75 2.4 Q 0 -1.9 -6.75 2.4 Z',
  // Flat lid across the top, rounded bottom — unimpressed.
  serious: 'M -6.75 -5 L 6.75 -5 L 6.75 4.25 A 6.75 6.75 0 0 1 -6.75 4.25 Z',
  // Lid slanting down toward the nose, rounded bottom.
  angry: 'M -6.75 -7.6 L 6.75 -1.6 L 6.75 4.25 A 6.75 6.75 0 0 1 -6.75 4.25 Z'
}

export interface WorkerFaceProps {
  color: string
  mood?: WorkerMood
  size?: number
  /** Eyes follow the pointer. For the big faces only — one listener per face. */
  follow?: boolean
  /** Adds the busy scan even when the mood alone would not (a turn is running). */
  busy?: boolean
  className?: string
  title?: string
}

export const WorkerFace = memo(function WorkerFace({
  color,
  mood = 'neutral',
  size = 40,
  follow = false,
  busy = false,
  className,
  title
}: WorkerFaceProps): JSX.Element {
  const look = useRef<SVGGElement>(null)
  useFollowPointer(look, follow && mood !== 'dead' && mood !== 'asleep')

  const eye = eyeColor(color)
  // Thin strokes vanish at avatar sizes; keep them at least ~1.2px on screen.
  const lineWidth = Math.max(2.2, 120 / size)

  return (
    <svg
      className={`wf ${className ?? ''}`}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      data-mood={mood}
      data-busy={busy || undefined}
      role="img"
      aria-label={title ?? `${mood} face`}
    >
      {title && <title>{title}</title>}
      <circle cx="50" cy="50" r="50" fill={color} />
      <g ref={look} className="wf-look">
        <g key={mood} className="wf-eyes">
          {EYE_X.map((x, side) => (
            <g key={side} transform={`translate(${x} ${EYE_Y})${side === 1 ? ' scale(-1 1)' : ''}`}>
              <g className="wf-eye">{eyeShape(mood, eye, lineWidth)}</g>
            </g>
          ))}
        </g>
      </g>
    </svg>
  )
})

function eyeShape(mood: WorkerMood, fill: string, lineWidth: number): JSX.Element {
  if (mood === 'dead') {
    // An X per eye, square-capped like the spec's.
    return (
      <g stroke={fill} strokeWidth={4.6} strokeLinecap="square">
        <line x1={-5.4} y1={-5.4} x2={5.4} y2={5.4} />
        <line x1={5.4} y1={-5.4} x2={-5.4} y2={5.4} />
      </g>
    )
  }
  if (mood === 'asleep') {
    // Closed: a thin line a little below where the eyes sit open.
    return <line x1={-7} y1={6} x2={7} y2={6} stroke={fill} strokeWidth={lineWidth} strokeLinecap="round" />
  }
  return <path d={SHAPES[mood]} fill={fill} />
}

/** White eyes, unless the body is so light that white would disappear into it. */
function eyeColor(hex: string): string {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return '#ffffff'
  const n = parseInt(match[1], 16)
  const channel = (v: number): number => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const luminance = 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  return luminance > 0.62 ? '#1d2127' : '#ffffff'
}

/**
 * Nudges the eyes toward the pointer, a few units at most. Writes the
 * transform straight onto the group (no React state), so following the mouse
 * costs no renders; the glance animation is paused meanwhile via CSS vars.
 */
function useFollowPointer(ref: React.RefObject<SVGGElement>, enabled: boolean): void {
  useEffect(() => {
    const node = ref.current
    if (!enabled || !node) return
    if (document.body.dataset.reduceMotion === 'on') return
    let frame = 0
    let idle: ReturnType<typeof setTimeout> | undefined
    const onMove = (event: PointerEvent): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const svg = node.ownerSVGElement
        if (!svg) return
        const box = svg.getBoundingClientRect()
        const dx = event.clientX - (box.left + box.width / 2)
        const dy = event.clientY - (box.top + box.height * 0.4)
        const distance = Math.hypot(dx, dy) || 1
        // Full deflection a few face-widths away; tiny when the pointer is on the face.
        const reach = Math.min(1, distance / (box.width * 2.5))
        const x = (dx / distance) * 4.2 * reach
        const y = (dy / distance) * 3 * reach
        node.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`
        node.dataset.following = 'true'
        clearTimeout(idle)
        // Drift back to looking ahead a moment after the pointer stops.
        idle = setTimeout(() => {
          node.style.transform = ''
          delete node.dataset.following
        }, 2200)
      })
    }
    window.addEventListener('pointermove', onMove)
    return () => {
      window.removeEventListener('pointermove', onMove)
      cancelAnimationFrame(frame)
      clearTimeout(idle)
      node.style.transform = ''
      delete node.dataset.following
    }
  }, [ref, enabled])
}
