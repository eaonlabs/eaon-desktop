import type { JSX, ReactNode } from 'react'

/**
 * Pictures for Settings → Accounts → Usage meter: a small Eaon window per
 * placement, with the meter drawn where it would go in the style that is
 * picked, and a close-up of each style. Drawn in the app's own colours (CSS
 * variables), so they match whatever theme is on.
 */

export type MeterPlacement = 'sidebar' | 'header' | 'both'
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

/** The bar meter: a pill with a short fill and the figures. */
function Bar({ x, y, w = 44, h = 10 }: { x: number; y: number; w?: number; h?: number }): JSX.Element {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={h / 2} fill="var(--hover-strong)" />
      <rect x={x + 4} y={y + h / 2 - 1} width={w * 0.28} height={2} rx={1} fill="var(--border-strong)" />
      <rect x={x + 4} y={y + h / 2 - 1} width={w * 0.06} height={2} rx={1} fill="var(--text)" />
      <rect x={x + 4 + w * 0.34} y={y + h / 2 - 1.5} width={w * 0.5} height={3} rx={1.5} fill="var(--text-3)" />
    </g>
  )
}

/** A small Eaon window: sidebar, the top bar with its tab switch, and some lines of work. */
function Window({ children }: { children: ReactNode }): JSX.Element {
  return (
    <svg className="meter-preview" viewBox="0 0 213 148" aria-hidden="true">
      <rect x="0" y="0" width="213" height="148" fill="var(--canvas)" />
      {/* Sidebar panel */}
      <rect x="6" y="6" width="56" height="136" rx="7" fill="var(--surface-1)" stroke="var(--border-soft)" />
      <circle cx="14" cy="14" r="2" fill="#ff5f57" />
      <circle cx="21" cy="14" r="2" fill="#febc2e" />
      <circle cx="28" cy="14" r="2" fill="#28c840" />
      {[28, 38, 48, 66, 76, 86].map((y) => (
        <rect key={y} x="13" y={y} width={y > 60 ? 32 : 38} height="4" rx="2" fill="var(--hover-strong)" />
      ))}
      {/* Top bar: the tab switch in the middle */}
      <rect x="112" y="8" width="44" height="12" rx="6" fill="var(--surface-2)" stroke="var(--border-soft)" />
      <rect x="114" y="10" width="14" height="8" rx="4" fill="var(--hover-strong)" />
      {/* Work: terminal panes */}
      <rect x="70" y="27" width="66" height="114" rx="5" fill="var(--sunken)" stroke="var(--border-soft)" />
      <rect x="140" y="27" width="67" height="114" rx="5" fill="var(--sunken)" stroke="var(--border-soft)" />
      {[37, 45, 53].map((y) => (
        <g key={y}>
          <rect x="76" y={y} width={y === 45 ? 40 : 50} height="3" rx="1.5" fill="var(--text-4)" />
          <rect x="146" y={y} width={y === 53 ? 30 : 48} height="3" rx="1.5" fill="var(--text-4)" />
        </g>
      ))}
      <>{children}</>
    </svg>
  )
}

/** Where the meter goes, highlighted with a soft accent glow so the eye finds it. */
function Spot({ x, y, w, h }: { x: number; y: number; w: number; h: number }): JSX.Element {
  return <rect x={x} y={y} width={w} height={h} rx={h / 2} fill="color-mix(in srgb, var(--accent) 22%, transparent)" stroke="var(--accent)" strokeWidth={0.8} />
}

export function PlacementPreview({ placement, style }: { placement: MeterPlacement; style: MeterStyle }): JSX.Element {
  const sidebar = placement !== 'header'
  const header = placement !== 'sidebar'
  return (
    <Window>
      {sidebar && <Spot x={9} y={124} w={style === 'rings' ? 34 : 50} h={15} />}
      {sidebar && (style === 'rings' ? <RingPair x={18} y={131.5} r={5} /> : <Bar x={12} y={126.5} w={44} h={10} />)}
      {header && <Spot x={162} y={7} w={style === 'rings' ? 34 : 44} h={14} />}
      {header && (style === 'rings' ? <RingPair x={171} y={14} r={4.6} /> : <Bar x={165} y={9} w={38} h={10} />)}
    </Window>
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
