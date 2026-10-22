import type { JSX } from 'react'

/**
 * Pictures for Settings → Accounts → Usage meter: a close-up of each style.
 * Drawn in the app's own colours (CSS variables), so they match whatever
 * theme is on.
 */

export type MeterStyle = 'rings' | 'bar'

const SESSION = '#3fb984'
const WEEK = '#e9b443'

/** A ring meter at (x, y): the week outside, the session inside, a dot for the logo. */
function Rings({ x, y, r = 6 }: { x: number; y: number; r?: number }): JSX.Element {
  const arc = (radius: number, left: number): string => {
    const length = 2 * Math.PI * radius
    return `${(length * left) / 100} ${length}`
  }
  const inner = r * 0.68
  return (
    <g>
      <circle cx={x} cy={y} r={r} fill="none" stroke="var(--border-strong)" strokeWidth={1.6} />
      <circle cx={x} cy={y} r={r} fill="none" stroke={WEEK} strokeWidth={1.6} strokeLinecap="round" strokeDasharray={arc(r, 46)} transform={`rotate(-90 ${x} ${y})`} />
      <circle cx={x} cy={y} r={inner} fill="none" stroke="var(--border-strong)" strokeWidth={1.4} />
      <circle cx={x} cy={y} r={inner} fill="none" stroke={SESSION} strokeWidth={1.4} strokeLinecap="round" strokeDasharray={arc(inner, 90)} transform={`rotate(-90 ${x} ${y})`} />
      <circle cx={x} cy={y} r={r * 0.28} fill="var(--text-2)" />
    </g>
  )
}

/** Two CLIs' rings side by side, starting at (x, y). */
function RingPair({ x, y, r = 6 }: { x: number; y: number; r?: number }): JSX.Element {
  return (
    <>
      <Rings x={x} y={y} r={r} />
      <Rings x={x + r * 2 + 4} y={y} r={r} />
    </>
  )
}

export function StylePreview({ style }: { style: MeterStyle }): JSX.Element {
  return (
    <svg className="meter-preview" viewBox="0 0 213 148" aria-hidden="true">
      <rect x="0" y="0" width="213" height="148" fill="var(--canvas)" />
      <rect x="18" y="34" width="177" height="80" rx="12" fill="var(--surface-1)" stroke="var(--border-soft)" />
      {style === 'rings' ? (
        <>
          <RingPair x={78} y={74} r={18} />
          <text x="106.5" y="128" textAnchor="middle" fontSize="9" fill="var(--text-3)">
            week outside · session inside
          </text>
        </>
      ) : (
        <>
          <rect x="40" y="62" width="133" height="24" rx="12" fill="var(--hover-strong)" />
          <rect x="52" y="72.5" width="34" height="3" rx="1.5" fill="var(--border-strong)" />
          <rect x="52" y="72.5" width="8" height="3" rx="1.5" fill="var(--text)" />
          <text x="94" y="78" fontSize="10" fontFamily="var(--font-mono)" fill="var(--text-2)">
            30% · 57% wk
          </text>
          <text x="106.5" y="128" textAnchor="middle" fontSize="9" fill="var(--text-3)">
            the figures spelled out
          </text>
        </>
      )}
    </svg>
  )
}
