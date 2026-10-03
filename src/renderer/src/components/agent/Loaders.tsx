// Adapted from MIT and Apache-2.0 components; see components/agent/LICENSES.txt.
import { memo, useEffect, useState, type CSSProperties, type JSX } from 'react'

/**
 * The transcript's three "still going" marks.
 *
 * - `Spinner`: a tool call in flight. A thin arc on a faint ring, so a row
 *   that is waiting on a command reads as busy without pulling the eye the
 *   way the old orb did on every running line.
 * - `PixelGrid`: the model itself is working. A 3×3 grid with a wavefront
 *   crossing it, left to right.
 * - `LoadingState`: the grid, a shimmering label and a live elapsed timer, for
 *   a reply that has nothing to show yet.
 */

export function Spinner({ size = 12 }: { size?: number }): JSX.Element {
  return (
    <svg className="spin-arc" viewBox="0 0 12 12" width={size} height={size} fill="none" aria-hidden>
      <circle cx="6" cy="6" r="4.4" stroke="currentColor" strokeWidth="1.5" opacity="0.25" />
      <path d="M10.4 6A4.4 4.4 0 0 0 6 1.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/** Each cell's delay: a chevron-shaped front that sweeps the grid from left to right. */
const WAVE = Array.from({ length: 9 }, (_, i) => (i % 3) * 90 + Math.abs(Math.floor(i / 3) - 1) * 90)

export const PixelGrid = memo(function PixelGrid({ cell = 4 }: { cell?: number }): JSX.Element {
  return (
    <span className="pixel-grid" style={{ '--cell': `${cell}px` } as CSSProperties} aria-hidden>
      {WAVE.map((delay, index) => (
        <span key={index} className="pixel-grid__cell" style={{ animationDelay: `${delay}ms` }} />
      ))}
    </span>
  )
})

/** "12s", "1m 5s"; nothing under a second, where a number only flickers. */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return ''
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
}

/**
 * Milliseconds since `since`, ticking every `every` ms while `running`.
 * Only the component that shows the clock re-renders on a tick.
 */
export function useElapsed(since: number, running = true, every = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(id)
  }, [running, every])
  return Math.max(0, now - since)
}

/** A reply that has started but shows nothing yet: what it is doing and for how long. */
export function LoadingState({ label }: { label: string }): JSX.Element {
  const [since] = useState(() => Date.now())
  const elapsed = useElapsed(since, true, 100)
  const seconds = elapsed / 1000
  const clock = seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s`
  return (
    <div className="loading-state" role="status">
      <PixelGrid />
      <span className="loading-state__label step-shimmer">{label}</span>
      <span className="loading-state__clock">{clock}</span>
    </div>
  )
}
