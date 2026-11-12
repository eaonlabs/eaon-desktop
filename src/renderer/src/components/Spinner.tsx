import type { JSX } from 'react'

/** A dash tracing the outline of a rounded square: a chat that is replying. */
export function Spinner({ size = 14, label = 'Working' }: { size?: number; label?: string }): JSX.Element {
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

/**
 * What a project's chat is doing, drawn on a 5 x 5 grid of dots.
 *   thinking  two lights orbiting, one round the edge and one round the middle
 *   working   a bar sweeping across while a tool runs
 *   writing   a wave running through the dots as the reply is written
 *   retrying  the ring breathing slowly while it waits to try again
 *   asking    three dots taking turns, waiting on you
 *   done      a tick;  failed  a cross
 */
export type DotState = 'thinking' | 'working' | 'writing' | 'retrying' | 'asking' | 'done' | 'failed'

/** The 16 outer cells, clockwise from the top left, as indexes into the 25. */
const OUTER = [0, 1, 2, 3, 4, 9, 14, 19, 24, 23, 22, 21, 20, 15, 10, 5]
/** The 8 cells round the middle one, anticlockwise from the top left. */
const INNER = [6, 11, 16, 17, 18, 13, 8, 7]
const SHAPES = {
  done: ['00000', '00001', '10010', '01100', '00100'],
  failed: ['10001', '01010', '00100', '01010', '10001']
} as const

const LABEL: Record<DotState, string> = {
  thinking: 'Thinking',
  working: 'Working',
  writing: 'Writing',
  retrying: 'Waiting to try again',
  asking: 'Waiting for your answer',
  done: 'Finished',
  failed: 'Failed'
}

/** Which dots are lit for a state, and the number each animates by (its place in the motion). */
function plan(state: DotState, cell: number): { on: boolean; step: number; of: number; ms: number } {
  const row = Math.floor(cell / 5)
  const col = cell % 5
  switch (state) {
    case 'thinking': {
      const outer = OUTER.indexOf(cell)
      if (outer >= 0) return { on: true, step: outer, of: 16, ms: 1400 }
      const inner = INNER.indexOf(cell)
      return { on: inner >= 0, step: inner, of: 8, ms: 1000 }
    }
    case 'working':
      return { on: true, step: col, of: 5, ms: 1100 }
    case 'writing':
      return { on: row >= 1 && row <= 3, step: col + row, of: 8, ms: 1000 }
    case 'retrying':
      return { on: OUTER.includes(cell), step: 0, of: 1, ms: 2200 }
    case 'asking':
      return { on: row === 2 && col % 2 === 0, step: col / 2, of: 3, ms: 1200 }
    default:
      return { on: SHAPES[state][row][col] === '1', step: row + col, of: 8, ms: 360 }
  }
}

export function DotMatrix({ state, size = 15 }: { state: DotState; size?: number }): JSX.Element {
  return (
    <span className="dotm" data-state={state} style={{ ['--dotm-size' as string]: `${size}px` }} role="img" aria-label={LABEL[state]}>
      {Array.from({ length: 25 }, (_, cell) => {
        const { on, step, of, ms } = plan(state, cell)
        return (
          <i
            key={cell}
            data-on={on || undefined}
            style={on ? { ['--dotm-step' as string]: step, ['--dotm-of' as string]: of, ['--dotm-ms' as string]: `${ms}ms` } : undefined}
          />
        )
      })}
    </span>
  )
}
