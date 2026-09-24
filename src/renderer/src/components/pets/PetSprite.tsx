import { memo, useId, type JSX } from 'react'
import type { PetMood, PetSpecies } from '@shared/pets'
import { Face, SPECIES } from './species'

interface Props {
  species: PetSpecies
  mood: PetMood
  /** Strolling: bob in step and face the way it is going. */
  walking?: boolean
  facing?: 'left' | 'right'
  /** Being dragged. */
  held?: boolean
  className?: string
}

/**
 * One pet, drawn on the shared 100×100 grid. Every moving part is a class the
 * stylesheet animates (pets.css), keyed off `data-mood` — the component only
 * swaps the face and the effects, so a mood change never remounts the body.
 *
 * The box is the body; effects (thought bubble, zZz, hearts) draw outside it
 * with `overflow: visible` so the pet's hit area stays exactly its body.
 */
export const PetSprite = memo(function PetSprite({
  species,
  mood,
  walking,
  facing = 'left',
  held,
  className
}: Props): JSX.Element {
  // Several pets share a page in Settings; gradient ids must not collide.
  const uid = useId().replace(/:/g, '')
  const art = SPECIES[species]
  const c = art.colours
  const ref = (name: string): string => `url(#${uid}-${name})`

  return (
    <svg
      className={`pet-svg ${className ?? ''}`}
      viewBox="0 0 100 100"
      data-species={species}
      data-mood={mood}
      data-walking={walking || undefined}
      data-held={held || undefined}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={`${uid}-main`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={c.light} />
          <stop offset="55%" stopColor={c.base} />
          <stop offset="100%" stopColor={c.shade} />
        </linearGradient>
      </defs>
      <ellipse className="pet-shadow" cx={50} cy={92.5} rx={27} ry={4.2} />
      <g className="pet-flip" data-facing={facing}>
        <g className="pet-move">
          <g className="pet-pose">
            <g className="pet-breathe">{art.draw(ref, <Face spec={art.face} mood={mood} />, mood)}</g>
          </g>
        </g>
      </g>
      <Effects mood={mood} />
    </svg>
  )
})

/* ----------------------------------------------------------------- effects */

const GEAR = gearPath(0, 0, 7.2, 5.2, 8)

function gearPath(cx: number, cy: number, outer: number, inner: number, teeth: number): string {
  const points: string[] = []
  const step = (Math.PI * 2) / teeth
  for (let i = 0; i < teeth; i++) {
    const a = i * step
    const corners = [
      [a - step * 0.5, inner],
      [a - step * 0.22, inner],
      [a - step * 0.14, outer],
      [a + step * 0.14, outer],
      [a + step * 0.22, inner]
    ]
    for (const [angle, r] of corners)
      points.push(`${(cx + Math.cos(angle) * r).toFixed(2)} ${(cy + Math.sin(angle) * r).toFixed(2)}`)
  }
  return `M${points.join(' L ')} Z`
}

const HEART = 'M0 2.6 C -3.2 0.2, -4.6 -2.2, -2.8 -3.8 C -1.6 -4.8, -0.4 -4.2, 0 -2.9 C 0.4 -4.2, 1.6 -4.8, 2.8 -3.8 C 4.6 -2.2, 3.2 0.2, 0 2.6 Z'
const SPARKLE = 'M0 -5 C 0.6 -1.6, 1.6 -0.6, 5 0 C 1.6 0.6, 0.6 1.6, 0 5 C -0.6 1.6, -1.6 0.6, -5 0 C -1.6 -0.6, -0.6 -1.6, 0 -5 Z'
const ZED = 'M-2.6 -2.6 H 2.6 L -2.6 2.6 H 2.6'

/**
 * State effects sit above and to the left of the head: the pet lives in the
 * bottom-right corner by default, so that is the side with room.
 */
function Effects({ mood }: { mood: PetMood }): JSX.Element | null {
  switch (mood) {
    case 'thinking':
      return (
        <g className="pet-fx pet-fx--think">
          <circle cx={21} cy={27} r={1.8} className="pet-bubble" />
          <circle cx={15} cy={20} r={2.8} className="pet-bubble" />
          <rect x={-10} y={-2} width={26} height={15} rx={7.5} className="pet-bubble" />
          <circle cx={-3} cy={5.5} r={1.7} className="pet-dot" />
          <circle cx={3} cy={5.5} r={1.7} className="pet-dot" />
          <circle cx={9} cy={5.5} r={1.7} className="pet-dot" />
        </g>
      )
    case 'working':
      return (
        <g className="pet-fx pet-fx--work" transform="translate(9 18)">
          <circle r={10.5} className="pet-bubble" />
          <g className="pet-gear">
            <path d={GEAR} className="pet-gear__teeth" />
            <circle r={2.1} className="pet-gear__hub" />
          </g>
        </g>
      )
    case 'happy':
      return (
        <g className="pet-fx pet-fx--happy">
          {[
            [16, 24, 1],
            [86, 18, 0.85],
            [90, 46, 0.6],
            [9, 50, 0.7]
          ].map(([x, y, s], i) => (
            <g key={i} transform={`translate(${x} ${y}) scale(${s})`}>
              <path d={SPARKLE} className="pet-sparkle" style={{ animationDelay: `${i * 160}ms` }} />
            </g>
          ))}
        </g>
      )
    case 'concerned':
      return (
        <g className="pet-fx pet-fx--concerned" transform="translate(76 30)">
          <path d="M0 -5 C 1.8 -2, 3.2 0, 3.2 1.8 C 3.2 3.6, 1.8 5, 0 5 C -1.8 5, -3.2 3.6, -3.2 1.8 C -3.2 0, -1.8 -2, 0 -5 Z" className="pet-drop" />
        </g>
      )
    case 'asleep':
      return (
        <g className="pet-fx pet-fx--asleep">
          {[
            [80, 18, 1],
            [88, 6, 1.3],
            [98, -8, 1.65]
          ].map(([x, y, s], i) => (
            <g key={i} transform={`translate(${x} ${y}) scale(${s})`}>
              {/* A pale halo under the stroke so the letter reads on any theme. */}
              <g className="pet-zed" style={{ animationDelay: `${i * 700}ms` }}>
                <path d={ZED} className="pet-zed__halo" />
                <path d={ZED} className="pet-zed__ink" />
              </g>
            </g>
          ))}
        </g>
      )
    case 'petted':
      return (
        <g className="pet-fx pet-fx--petted">
          {[
            [24, 20, 1],
            [74, 14, 0.85],
            [50, 4, 1.15]
          ].map(([x, y, s], i) => (
            <g key={i} transform={`translate(${x} ${y}) scale(${s})`}>
              <path d={HEART} className="pet-heart" style={{ animationDelay: `${i * 220}ms` }} />
            </g>
          ))}
        </g>
      )
    default:
      return null
  }
}
