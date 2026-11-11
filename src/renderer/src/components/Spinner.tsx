import type { JSX } from 'react'

/**
 * The two working indicators: a bright cell chasing its trail around a square
 * (coding projects) and a dash tracing a rounded square (ordinary chats).
 * Shapes and timing follow the MIT-licensed loading-dev spinners "swirl" and
 * "trace"; the styles are in app.css.
 */

/** Clockwise order of the eight outer cells of the 3x3 grid, as grid positions. */
const SWIRL_RING = [0, 1, 2, 5, 8, 7, 6, 3]

export function Spinner({
  kind,
  size = 14,
  label = 'Working'
}: {
  kind: 'swirl' | 'trace'
  size?: number
  label?: string
}): JSX.Element {
  if (kind === 'swirl') {
    return (
      <span className="ld-swirl" style={{ ['--ld-size' as string]: `${size}px` }} role="img" aria-label={label}>
        {Array.from({ length: 9 }, (_, cell) => {
          const step = SWIRL_RING.indexOf(cell)
          return step < 0 ? <i key={cell} /> : <i key={cell} className="ld-swirl__cell" style={{ ['--ld-step' as string]: step }} />
        })}
      </span>
    )
  }
  return (
    <svg
      className="ld-trace"
      style={{ ['--ld-size' as string]: `${size}px` }}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      role="img"
      aria-label={label}
    >
      <rect x="1.25" y="1.25" width="17.5" height="17.5" rx="4" opacity="0.2" />
      <rect className="ld-trace__dash" x="1.25" y="1.25" width="17.5" height="17.5" rx="4" strokeDasharray="16 47.13" strokeLinecap="round" />
    </svg>
  )
}
