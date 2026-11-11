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
 * What a project's chat is doing, drawn on a 5 x 5 grid of dots: a light
 * running round the edge, three dots taking turns while it waits on you, a
 * tick when it finished, a cross when it failed.
 */
export type DotState = 'running' | 'asking' | 'done' | 'failed'

/** The 16 outer cells, clockwise from the top left, as indexes into the 25. */
const RING = [0, 1, 2, 3, 4, 9, 14, 19, 24, 23, 22, 21, 20, 15, 10, 5]
const SHAPES = {
  done: ['00000', '00001', '10010', '01100', '00100'],
  failed: ['10001', '01010', '00100', '01010', '10001']
} as const

const LABEL: Record<DotState, string> = {
  running: 'Working',
  asking: 'Waiting for your answer',
  done: 'Finished',
  failed: 'Failed'
}

export function DotMatrix({ state, size = 15 }: { state: DotState; size?: number }): JSX.Element {
  return (
    <span className="dotm" data-state={state} style={{ ['--dotm-size' as string]: `${size}px` }} role="img" aria-label={LABEL[state]}>
      {Array.from({ length: 25 }, (_, cell) => {
        const row = Math.floor(cell / 5)
        const col = cell % 5
        let on = false
        let step = 0
        if (state === 'running') {
          step = RING.indexOf(cell)
          on = step >= 0
        } else if (state === 'asking') {
          on = row === 2 && col % 2 === 0
          step = col / 2
        } else {
          on = SHAPES[state][row][col] === '1'
          step = row + col
        }
        return <i key={cell} data-on={on || undefined} style={on ? { ['--dotm-step' as string]: step } : undefined} />
      })}
    </span>
  )
}
