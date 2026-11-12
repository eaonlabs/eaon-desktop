import { useEffect, useRef, useState, type JSX } from 'react'

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

/** One loop for every state, so changing state never changes the tempo. */
const LOOP_MS = 1600

/** Which dots are lit for a state, and the number each animates by (its place in the motion). */
function plan(state: DotState, cell: number): { on: boolean; step: number; of: number } {
  const row = Math.floor(cell / 5)
  const col = cell % 5
  switch (state) {
    case 'thinking': {
      const outer = OUTER.indexOf(cell)
      if (outer >= 0) return { on: true, step: outer, of: 16 }
      const inner = INNER.indexOf(cell)
      return { on: inner >= 0, step: inner, of: 8 }
    }
    case 'working':
      return { on: true, step: col, of: 5 }
    case 'writing':
      return { on: row >= 1 && row <= 3, step: col + row, of: 8 }
    case 'retrying':
      return { on: OUTER.includes(cell), step: 0, of: 1 }
    case 'asking':
      return { on: row === 2 && col % 2 === 0, step: col / 2, of: 3 }
    default:
      return { on: SHAPES[state][row][col] === '1', step: row + col, of: 8 }
  }
}

function Layer({ state, leaving, first }: { state: DotState; leaving?: boolean; first?: boolean }): JSX.Element {
  return (
    <span className="dotm__layer" data-state={state} data-leaving={leaving || undefined} data-first={first || undefined} aria-hidden="true">
      {Array.from({ length: 25 }, (_, cell) => {
        const { on, step, of } = plan(state, cell)
        return <i key={cell} data-on={on || undefined} style={on ? { ['--dotm-step' as string]: step, ['--dotm-of' as string]: of } : undefined} />
      })}
    </span>
  )
}

/**
 * The dots keep one size, one footprint (a faint grid under every state) and
 * one tempo; a new state fades in over the one it replaces rather than
 * snapping to it, and only after it has held for a moment.
 */
export function DotMatrix({ state: asked, size = 16 }: { state: DotState; size?: number }): JSX.Element {
  // A new state has to hold for a moment before it shows: a blip of one never flickers the icon.
  const [state, setState] = useState<DotState>(asked)
  useEffect(() => {
    if (asked === state) return
    const timer = setTimeout(() => setState(asked), 700)
    return () => clearTimeout(timer)
  }, [asked, state])

  // The layers on show: the one fading out (until it is gone) and the current one. Each keeps its own
  // id for its whole life, so the current layer is never remounted (which would play its fade-in again).
  const next = useRef(1)
  const [layers, setLayers] = useState<{ id: number; state: DotState }[]>([{ id: 0, state }])
  useEffect(() => {
    setLayers((list) => (list[list.length - 1].state === state ? list : [...list.slice(-1), { id: next.current++, state }]))
    const timer = setTimeout(() => setLayers((list) => (list.length > 1 ? list.slice(-1) : list)), 600)
    return () => clearTimeout(timer)
  }, [state])

  return (
    <span className="dotm" style={{ ['--dotm-size' as string]: `${size}px`, ['--dotm-ms' as string]: `${LOOP_MS}ms` }} role="img" aria-label={LABEL[state]}>
      <span className="dotm__base" aria-hidden="true">
        {Array.from({ length: 25 }, (_, cell) => (
          <i key={cell} />
        ))}
      </span>
      {layers.map((layer, index) => (
        <Layer key={layer.id} state={layer.state} leaving={layers.length > 1 && index === 0} first={layer.id === 0} />
      ))}
    </span>
  )
}
