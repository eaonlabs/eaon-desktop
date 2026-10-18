import { memo, useEffect, useState, type CSSProperties, type JSX } from 'react'
import { Brain } from 'lucide-react'

/**
 * The transcript's one "still going" mark: a small dot matrix.
 *
 * Every live thing in a turn (the model thinking, a file being read, a command
 * running, an edit being written) shows the same 21 dots, a 5×5 grid with its
 * corners off so it reads round at 14px. What changes is how light moves
 * through them, so a glance tells thinking from reading from running without a
 * different glyph for each:
 *
 * - `think`: rings ripple out from the centre.
 * - `scan`: a scanline runs down the rows (reading, listing, searching).
 * - `radar`: a beam sweeps round (the web, a page, the browser).
 * - `snake`: a head with a tail writes along the rows (an edit, a file).
 * - `columns`: columns rise and fall out of step (a command).
 * - `orbit`: two heads chase round the rim (sub-agents, a team).
 * - `wait`: the whole grid breathes, slowly (waiting on you).
 *
 * The motion is one CSS keyframe per dot, offset by a delay worked out once
 * per pattern, so a busy transcript costs no JavaScript per frame.
 */

export type Motion = 'think' | 'scan' | 'radar' | 'snake' | 'columns' | 'orbit' | 'wait'

const N = 5
const MID = (N - 1) / 2

/** The grid's dots, corners left out. */
const DOTS = (() => {
  const dots: { row: number; col: number }[] = []
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const corner = (row === 0 || row === N - 1) && (col === 0 || col === N - 1)
      if (!corner) dots.push({ row, col })
    }
  }
  return dots
})()

/** Clockwise from twelve o'clock, 0 to 1. */
const angle = (row: number, col: number): number => {
  const a = Math.atan2(col - MID, MID - row) / (2 * Math.PI)
  return (a + 1) % 1
}

/** On the rim: the ring a chase runs round. */
const rim = (row: number, col: number): boolean => row === 0 || col === 0 || row === N - 1 || col === N - 1

/** Bars rise out of step, like a level meter, not in a wave. */
const BAR_PHASE = [0, 0.42, 0.18, 0.62, 0.3]

/** A dot that sits out the pattern: lit faintly, or as the hub it turns round. */
const OFF = -1
const HUB = -2

/**
 * Each dot's place in the cycle, 0 to 1: the delay that makes the pattern.
 * `OFF` and `HUB` dots hold still.
 */
const ORDER: Record<Motion, number[]> = {
  think: DOTS.map(({ row, col }) => Math.hypot(row - MID, col - MID) / 3),
  scan: DOTS.map(({ row, col }) => row / N + Math.abs(col - MID) * 0.025),
  radar: DOTS.map(({ row, col }) => (row === MID && col === MID ? HUB : angle(row, col))),
  snake: (() => {
    // Rows left to right, then right to left: the order a line is written in.
    const path = DOTS.map((dot, index) => ({ index, key: dot.row * N + (dot.row % 2 ? N - 1 - dot.col : dot.col) }))
    path.sort((a, b) => a.key - b.key)
    const order = new Array<number>(DOTS.length)
    path.forEach((step, i) => (order[step.index] = i / DOTS.length))
    return order
  })(),
  columns: DOTS.map(({ row, col }) => ((N - 1 - row) / N) * 0.45 + BAR_PHASE[col]),
  orbit: DOTS.map(({ row, col }) => (row === MID && col === MID ? HUB : rim(row, col) ? (angle(row, col) * 2) % 1 : OFF)),
  wait: DOTS.map(({ row, col }) => Math.hypot(row - MID, col - MID) * 0.06)
}

/** One cycle of each pattern. A ripple breathes; a scan or a write moves on. */
const CYCLE: Record<Motion, number> = {
  think: 1500,
  scan: 1100,
  radar: 1200,
  snake: 1300,
  columns: 900,
  orbit: 1400,
  wait: 2400
}

export const DotMatrix = memo(function DotMatrix({
  motion = 'think',
  size = 14
}: {
  motion?: Motion
  /** Edge length in px. */
  size?: number
}): JSX.Element {
  const order = ORDER[motion]
  const cycle = CYCLE[motion]
  return (
    <svg
      className="dot-matrix"
      data-motion={motion}
      viewBox={`0 0 ${N} ${N}`}
      width={size}
      height={size}
      style={{ '--dm-cycle': `${cycle}ms` } as CSSProperties}
      aria-hidden
    >
      {DOTS.map(({ row, col }, index) =>
        order[index] < 0 ? (
          <circle key={index} cx={col + 0.5} cy={row + 0.5} r={0.37} data-still={order[index] === HUB ? 'hub' : 'off'} />
        ) : (
          <circle
            key={index}
            cx={col + 0.5}
            cy={row + 0.5}
            r={0.37}
            // Negative, so every dot is mid-cycle on the first frame rather
            // than the grid lighting up dot by dot from dark.
            style={{ animationDelay: `${(order[index] - 1) * cycle}ms`, '--dm-rest': restOpacity(order[index]) } as CSSProperties}
          />
        )
      )}
    </svg>
  )
})

/** Under reduced motion the pattern holds still, shaded by where each dot sits in it. */
const restOpacity = (order: number): number => Math.round((0.9 - (order % 1) * 0.7) * 100) / 100

/** Which pattern a tool call shows while it runs. */
const TOOL_MOTION: Record<string, Motion> = {
  read_file: 'scan',
  read: 'scan',
  list_dir: 'scan',
  ls: 'scan',
  grep: 'scan',
  codebase_search: 'scan',
  find_symbol: 'scan',
  find_file: 'scan',
  find: 'scan',
  email_inbox: 'scan',
  email_read: 'scan',
  web_search: 'radar',
  web_fetch: 'radar',
  browser: 'radar',
  web_browser: 'radar',
  computer: 'radar',
  trading_quote: 'radar',
  trading_history: 'radar',
  edit_file: 'snake',
  edit: 'snake',
  write_file: 'snake',
  write: 'snake',
  move_file: 'snake',
  delete_file: 'snake',
  generate_image: 'snake',
  email_send: 'snake',
  email_reply: 'snake',
  run_command: 'columns',
  bash: 'columns',
  powershell: 'columns',
  use_plugin_tool: 'columns',
  spawn_agents: 'orbit',
  subagent: 'orbit',
  agent: 'orbit',
  Agent: 'orbit',
  SubagentWorkflow: 'orbit',
  message_worker: 'orbit',
  check_worker: 'orbit',
  create_worker: 'orbit',
  ask_user: 'wait',
  wait: 'wait'
}

export const toolMotion = (name: string): Motion => TOOL_MOTION[name] ?? 'scan'

/** "12s", "1m 5s"; nothing under two seconds, where a number only flickers. */
export function formatElapsed(ms: number): string {
  if (ms < 2000) return ''
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

/** A clock that counts up from `since` in whole seconds. Its own component, so a tick re-renders only it. */
export function Elapsed({ since, className }: { since: number; className: string }): JSX.Element | null {
  const elapsed = formatElapsed(useElapsed(since))
  return elapsed ? <span className={className}>{elapsed}</span> : null
}

/** A reply that has started but shows nothing yet: what it is doing and for how long. */
export function LoadingState({ label }: { label: string }): JSX.Element {
  const [since] = useState(() => Date.now())
  return (
    <div className="loading-state" role="status">
      <span className="loading-state__icon" aria-hidden>
        <Brain size={14} strokeWidth={1.8} />
      </span>
      <span className="loading-state__label step-shimmer">{label}</span>
      <Elapsed since={since} className="loading-state__clock" />
    </div>
  )
}
