import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore, type JSX, type RefObject } from 'react'
import type { WorkerMood } from '@shared/workers'

/**
 * A worker's face: a flat circle in the colour the user picked, with two soft
 * rounded-rectangle eyes. Drawn on a 100×100 grid measured from the design
 * spec — eyes centred at x 33.3 / 66.7, y 40, 13.5 wide and 25 tall.
 *
 * The body never leaves its circle, so a face is always recognisably the same
 * face; it only breathes, a scale too small to notice except as "alive".
 * The eyes do the living (useLivingEyes): each face darts its gaze to a new
 * spot now and then and holds it for a varying while, and blinks at random
 * intervals, sometimes twice, often with a big glance — never in step with
 * the faces beside it. A new expression arrives with a blink (the eye group
 * is keyed by mood, so a change remounts it and replays the opening blink).
 *
 * Reactions: clicking a big face gets a wink, a delighted look or surprise;
 * `nudge` going up (a new message) startles it; waiting on the user it keeps
 * glancing at the blue dot; hovering makes it blink and look at you.
 *
 * At work the eyes narrow into focus and read left to right, and a thin ring
 * in the worker's colour draws in around the face with an arc chasing round
 * it. When the turn ends the ring doesn't vanish: finishing well completes it
 * into a full circle that ripples out while the face pops once; stopping or
 * failing just fades it. A face can also bounce into place when first shown.
 *
 * All of it holds still while the window is hidden or in the background
 * (useWindowResting): a face is SVG, which the browser repaints on the main
 * thread for every frame it moves.
 */

const reducedMotion = (): boolean => typeof document !== 'undefined' && document.body.dataset.reduceMotion === 'on'

const EYE_X = [33.3, 66.7] as const
const EYE_Y = 40

/** The working ring: a circle just clear of the body (r 50), drawn with pathLength 100 so its dashes are percentages. */
const RING_R = 57
/** Faces smaller than this get the focused eyes but no ring, which would be a smudge (the sidebar shows its own spinner). */
const RING_MIN_SIZE = 40
/** How long the ring stays after work ends, to finish its exit (matches wf-ring-out / wf-ring-done in workers.css). */
const RING_EXIT_MS = 560
/**
 * Below this the gaze would move the eyes by under a pixel, so small faces
 * only blink: no glances, and no reading or trembling loop either (data-small).
 */
const GAZE_MIN_SIZE = 24

const PILL = 'M -6.75 -5.85 A 6.75 6.75 0 0 1 6.75 -5.85 L 6.75 5.85 A 6.75 6.75 0 0 1 -6.75 5.85 Z'

/**
 * Eye outlines in the eye's own coordinates (centre 0,0), for the left eye.
 * The right eye is the same shape mirrored, so slanted lids point the same
 * way on both sides. Excited, asleep and dead are strokes (eyeShape).
 */
const SHAPES: Record<Exclude<WorkerMood, 'excited' | 'asleep' | 'dead'>, string> = {
  // A full pill: semicircles of radius 6.75 at y −5.85 and +5.85.
  neutral: PILL,
  // Rounded top, lower edge lifted into an arc — smiling eyes.
  happy: 'M -6.75 -5.85 A 6.75 6.75 0 0 1 6.75 -5.85 L 6.75 2.4 Q 0 -1.9 -6.75 2.4 Z',
  // Flat lid across the top, rounded bottom — unimpressed.
  serious: 'M -6.75 -5 L 6.75 -5 L 6.75 4.25 A 6.75 6.75 0 0 1 -6.75 4.25 Z',
  // One eye wide, the other squinting (see CURIOUS_RIGHT): a raised brow.
  curious: 'M -7.2 -6.6 A 7.2 7.2 0 0 1 7.2 -6.6 L 7.2 5.6 A 7.2 7.2 0 0 1 -7.2 5.6 Z',
  // Wide open: rounder and fuller than the resting pills.
  surprised: 'M -9.4 0 A 9.4 12.4 0 1 1 9.4 0 A 9.4 12.4 0 1 1 -9.4 0 Z',
  // Lids sloping down to the outside, the inner corners raised.
  sad: 'M -6.75 -1.4 L 6.75 -7.2 L 6.75 4.25 A 6.75 6.75 0 0 1 -6.75 4.25 Z',
  // Lid slanting down toward the nose, rounded bottom.
  angry: 'M -6.75 -7.6 L 6.75 -1.6 L 6.75 4.25 A 6.75 6.75 0 0 1 -6.75 4.25 Z',
  // Heavy lids: only the lower half of each eye open.
  sleepy: 'M -6.75 0.6 L 6.75 0.6 L 6.75 4.25 A 6.75 6.75 0 0 1 -6.75 4.25 Z'
}
const CURIOUS_RIGHT = 'M -6.75 -1.8 L 6.75 -1.8 L 6.75 4.25 A 6.75 6.75 0 0 1 -6.75 4.25 Z'

/** Where each mood tends to look, added to every glance: down when sad or sleepy, up when curious. */
const GAZE_BIAS: Partial<Record<WorkerMood, [number, number]>> = {
  sad: [0, 2.6],
  sleepy: [0, 1.6],
  curious: [0.8, -1.6]
}

type Reaction = 'wink' | 'excited' | 'surprised'
/**
 * What a click on a face does, every time: a wink. It used to be a random
 * pick of three that never repeated, so the same click got a different face
 * each time; "surprised" is kept for mail arriving (`nudge`), so each look
 * means one thing.
 */
const CLICK_REACTION: Reaction = 'wink'

export interface WorkerFaceProps {
  color: string
  mood?: WorkerMood
  size?: number
  /** Eyes follow the pointer. For the big faces only — one listener per face. */
  follow?: boolean
  /**
   * A click winks. Only where the face is what's being clicked (a worker's
   * page, the editor's preview) — not inside a card or row whose click opens
   * something, where the reaction would be cut off by the page changing.
   */
  reactOnClick?: boolean
  /** A turn is running: focused, reading eyes and the working ring. */
  busy?: boolean
  /** Waiting on the user (a question): a blue dot, which the eyes keep glancing at. */
  attention?: boolean
  /**
   * A count that goes up when something arrives for this worker — its inbox
   * of waiting mail — and each rise startles it. Not its unread replies: those
   * arrive as it finishes, which is the happy pop's moment.
   */
  nudge?: number
  /** Bounce into place when first shown. */
  enter?: boolean
  className?: string
  title?: string
}

export const WorkerFace = memo(function WorkerFace({
  color,
  mood = 'neutral',
  size = 40,
  follow = false,
  reactOnClick = false,
  busy = false,
  attention = false,
  nudge = 0,
  enter = false,
  className,
  title
}: WorkerFaceProps): JSX.Element {
  const look = useRef<SVGGElement>(null)
  const gaze = useRef<SVGGElement>(null)
  const focus = useRef<SVGGElement>(null)
  useFollowPointer(look, follow && mood !== 'dead' && mood !== 'asleep')
  const ending = useRingExit(busy, mood)
  const [reacting, react] = useReaction(nudge)
  // Finishing well is the happy pop's moment; no passing reaction talks over it.
  const reaction = ending === 'done' ? null : reacting
  // Working is derived as "serious", whose flat-lidded eyes read as grumpy on
  // a busy face; at work the pills narrow into focus instead (see .wf-focus).
  // Keeping the same key also means starting work doesn't replay the blink.
  const base: WorkerMood = busy && mood === 'serious' ? 'neutral' : mood
  const face: WorkerMood = reaction === 'wink' ? 'happy' : (reaction ?? base)
  const blink = useLivingEyes(gaze, focus, {
    gaze: size >= GAZE_MIN_SIZE && !busy,
    blinks: face !== 'asleep' && face !== 'dead' && face !== 'angry',
    mood: face,
    busy,
    attention
  })
  // A random phase per face, so a row of faces never breathes in step.
  const [breathDelay] = useState(() => `${(-Math.random() * 4.8).toFixed(2)}s`)

  const eye = eyeColor(color)
  // Thin strokes vanish at avatar sizes; keep them at least ~1.2px on screen.
  const lineWidth = Math.max(2.2, 120 / size)
  const ring = (busy || ending !== null) && size >= RING_MIN_SIZE
  // Between 2 and 3px on screen whatever the size, within reason.
  const ringWidth = Math.min(4.5, Math.max(3, 280 / size))

  return (
    <svg
      className={`wf ${className ?? ''}`}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      data-mood={face}
      data-busy={busy || undefined}
      data-done={ending === 'done' || undefined}
      data-enter={enter || undefined}
      data-alive={size >= RING_MIN_SIZE && face !== 'dead' ? 'true' : undefined}
      data-small={size < GAZE_MIN_SIZE || undefined}
      style={{ ['--breath-delay' as string]: breathDelay }}
      onPointerEnter={follow ? () => blink() : undefined}
      onPointerDown={reactOnClick ? () => react(CLICK_REACTION) : undefined}
      role="img"
      aria-label={title ?? `${mood} face${busy ? ', working' : ''}${attention ? ', needs you' : ''}`}
    >
      {title && <title>{title}</title>}
      {ring && (
        <g className="wf-ring" data-ending={busy ? undefined : (ending ?? undefined)} aria-hidden="true">
          <circle className="wf-ring__track" cx="50" cy="50" r={RING_R} fill="none" stroke={color} strokeWidth={ringWidth} />
          <g className="wf-ring__spin">
            <circle
              className="wf-ring__arc"
              cx="50"
              cy="50"
              r={RING_R}
              pathLength={100}
              fill="none"
              stroke={color}
              strokeWidth={ringWidth}
              strokeLinecap="round"
            />
          </g>
        </g>
      )}
      <g className="wf-body">
        <circle cx="50" cy="50" r="50" fill={color} />
        <g ref={look} className="wf-look">
          <g ref={gaze} className="wf-gaze">
            <g ref={focus} className="wf-focus" data-wink={reaction === 'wink' || undefined}>
              <g key={face} className="wf-eyes">
                {EYE_X.map((x, side) => (
                  <g key={side} transform={`translate(${x} ${EYE_Y})${side === 1 ? ' scale(-1 1)' : ''}`}>
                    <g className="wf-eye">{eyeShape(face, side, eye, lineWidth)}</g>
                  </g>
                ))}
              </g>
            </g>
          </g>
        </g>
      </g>
      {attention && <circle className="wf-attention" cx="12" cy="12" r="11" fill="#0A84FF" strokeWidth={3} />}
    </svg>
  )
})

/**
 * A short-lived expression laid over the mood: from a click (react), or a
 * startle when `nudge` rises. Ends by itself after a moment.
 */
function useReaction(nudge: number): [Reaction | null, (reaction: Reaction) => void] {
  const [reaction, setReaction] = useState<Reaction | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const react = useRef((next: Reaction): void => {
    if (reducedMotion()) return
    clearTimeout(timer.current)
    // Off for a frame, then on: a second click during a wink plays it again
    // instead of doing nothing (the state would already be "wink").
    setReaction(null)
    requestAnimationFrame(() => setReaction(next))
    timer.current = setTimeout(() => setReaction(null), next === 'surprised' ? 900 : 1300)
  }).current
  const lastNudge = useRef(nudge)
  useEffect(() => {
    if (nudge > lastNudge.current) react('surprised')
    lastNudge.current = nudge
  }, [nudge, react])
  useEffect(() => () => clearTimeout(timer.current), [])
  return [reaction, react]
}

interface LivingOptions {
  gaze: boolean
  blinks: boolean
  mood: WorkerMood
  busy: boolean
  attention: boolean
}

/**
 * The eyes' own life, scheduled per face with random timing:
 *
 * - Gaze: a quick dart (CSS transitions --gx/--gy on .wf-gaze, easing out
 *   fast like a saccade) to a spot within a few units, held for a while,
 *   then often back to looking ahead. Waiting on the user, every third look
 *   or so goes to the blue dot. Off while working (the eyes read instead).
 * - Blinks: every 2–7 s, one in six a double blink, and a third of the big
 *   glances blink on the way. Slower and lazier when sleepy, rarer when
 *   concentrating. Starting work gets a blink, as if noticing.
 *
 * Nothing is scheduled while the window rests (useWindowResting), nor for a
 * face that couldn't use it — no glances for a small or busy face, no blink
 * timer for one whose eyes are shut — so a sidebar of sleeping workers costs
 * nothing at all. Returns blink(), for hover.
 */
function useLivingEyes(gazeRef: RefObject<SVGGElement>, focusRef: RefObject<SVGGElement>, options: LivingOptions): () => void {
  const opts = useRef(options)
  opts.current = options
  const resting = useWindowResting()
  const { gaze, blinks, busy } = options

  // Played with the Web Animations API, which restarts a blink that has only
  // just finished without the forced layout replaying a CSS animation needs —
  // every few seconds on every face, that added up.
  const blink = useCallback((): void => {
    const focus = focusRef.current
    if (!focus || !opts.current.blinks || reducedMotion()) return
    const duration = opts.current.mood === 'sleepy' ? 470 : 180
    focus.querySelectorAll<SVGGElement>('.wf-eye').forEach((eye, side) => {
      // A wink is already holding the second eye shut.
      if (side === 1 && focus.dataset.wink) return
      // The second eye a frame behind, as real eyes are.
      eye.animate(BLINK, { duration, delay: side * 14 })
    })
  }, [focusRef])

  useEffect(() => {
    if (!blinks || resting || reducedMotion()) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let again: ReturnType<typeof setTimeout> | undefined
    const next = (): void => {
      const { mood } = opts.current
      const wait = mood === 'sleepy' ? 1400 + Math.random() * 2600 : opts.current.busy ? 3800 + Math.random() * 5200 : 2200 + Math.random() * 4800
      timer = setTimeout(() => {
        blink()
        if (Math.random() < 0.16) again = setTimeout(blink, 260)
        next()
      }, wait)
    }
    next()
    return () => {
      clearTimeout(timer)
      clearTimeout(again)
    }
  }, [blinks, resting, blink])

  useEffect(() => {
    const node = gazeRef.current
    if (!node || !gaze || resting || reducedMotion()) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let away = false
    const next = (first = false): void => {
      const hold = first ? 300 + Math.random() * 1800 : away ? 600 + Math.random() * 1700 : 1400 + Math.random() * 3600
      timer = setTimeout(
        () => {
          const { mood, attention } = opts.current
          const [bx, by] = GAZE_BIAS[mood] ?? [0, 0]
          let x = 0
          let y = 0
          if (attention && Math.random() < 0.34) {
            // Toward the blue dot in the corner.
            x = -3.6
            y = -3
          } else if (!away || Math.random() < 0.45) {
            const angle = Math.random() * Math.PI * 2
            const reach = 1.4 + Math.random() * 2.6
            x = Math.cos(angle) * reach * 1.15
            y = Math.sin(angle) * reach * 0.7
          }
          away = x !== 0 || y !== 0
          node.style.setProperty('--gx', `${(x + bx).toFixed(2)}px`)
          node.style.setProperty('--gy', `${(y + by).toFixed(2)}px`)
          if (Math.hypot(x, y) > 2.6 && Math.random() < 0.33) blink()
          next()
        },
        opts.current.mood === 'sleepy' ? hold * 1.7 : hold
      )
    }
    next(true)
    return () => clearTimeout(timer)
  }, [gaze, resting, gazeRef, blink])

  // Noticing: work starting gets a blink.
  useEffect(() => {
    if (busy) blink()
  }, [busy, blink])

  // When glances stop (work began, or the face shrank), look ahead at once
  // rather than holding the last glance until the next scheduled one.
  useEffect(() => {
    if (gaze) return
    gazeRef.current?.style.setProperty('--gx', '0px')
    gazeRef.current?.style.setProperty('--gy', '0px')
  }, [gaze, gazeRef])

  return blink
}

/** A blink: closes fast, opens a touch slower. */
const BLINK: Keyframe[] = [
  { transform: 'scaleY(1)', easing: 'ease-in-out' },
  { transform: 'scaleY(0.08)', offset: 0.38, easing: 'ease-in-out' },
  { transform: 'scaleY(0.08)', offset: 0.52, easing: 'ease-in-out' },
  { transform: 'scaleY(1)' }
]

/**
 * Whether the window is out of sight or behind another app — hidden,
 * minimised, or simply not focused. Faces hold still then: their loops pause
 * (body[data-idle] in workers.css) and useLivingEyes schedules nothing. A
 * face is SVG, which the browser repaints on the main thread for every frame
 * it moves, so a page of them kept the renderer busy all day with nobody
 * looking. One set of listeners serves every face; the flag is on <body> so
 * other loops can rest with them.
 */
let windowResting = false
let watchingRest = false
const restListeners = new Set<() => void>()

function checkRest(): void {
  const next = document.visibilityState === 'hidden' || !document.hasFocus()
  if (next === windowResting) return
  windowResting = next
  if (next) document.body.dataset.idle = 'true'
  else delete document.body.dataset.idle
  for (const listener of restListeners) listener()
}

function subscribeRest(listener: () => void): () => void {
  if (!watchingRest) {
    watchingRest = true
    document.addEventListener('visibilitychange', checkRest)
    window.addEventListener('focus', checkRest)
    // Focus moving into a frame (the in-app browser) blurs the window too,
    // while the document keeps focus; look again once it has settled.
    window.addEventListener('blur', () => setTimeout(checkRest))
    checkRest()
  }
  restListeners.add(listener)
  return () => restListeners.delete(listener)
}

function useWindowResting(): boolean {
  return useSyncExternalStore(subscribeRest, () => windowResting)
}

/**
 * After a turn ends, how the ring leaves: `done` when it ended well (the face
 * turns happy), so the ring completes and ripples out and the face pops;
 * `stopped` otherwise, so it fades. Null while working and once the exit has
 * played. Under reduced motion the ring simply goes.
 */
function useRingExit(busy: boolean, mood: WorkerMood): 'done' | 'stopped' | null {
  const [ending, setEnding] = useState<'done' | 'stopped' | null>(null)
  const was = useRef(busy)
  // Read, not depended on: a mood that settles a render after busy flips must
  // not restart the effect, whose cleanup would cancel the exit timer.
  const moodNow = useRef(mood)
  moodNow.current = mood
  useEffect(() => {
    const finished = was.current && !busy
    was.current = busy
    if (busy) {
      setEnding(null)
      return
    }
    if (!finished || reducedMotion()) return
    setEnding(moodNow.current === 'happy' ? 'done' : 'stopped')
    const timer = setTimeout(() => setEnding(null), RING_EXIT_MS)
    return () => clearTimeout(timer)
  }, [busy])
  return ending
}

function eyeShape(mood: WorkerMood, side: number, fill: string, lineWidth: number): JSX.Element {
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
  if (mood === 'excited') {
    // Delighted: eyes squeezed into upturned arcs, ^ ^.
    return <path d="M -7.4 4.6 Q 0 -9.4 7.4 4.6" fill="none" stroke={fill} strokeWidth={Math.max(4.4, lineWidth)} strokeLinecap="round" />
  }
  if (mood === 'curious' && side === 1) return <path d={CURIOUS_RIGHT} fill={fill} />
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
function useFollowPointer(ref: RefObject<SVGGElement>, enabled: boolean): void {
  useEffect(() => {
    const node = ref.current
    if (!enabled || !node || reducedMotion()) return
    return followPointer({
      measure: () => node.ownerSVGElement?.getBoundingClientRect() ?? null,
      aim: (box, pointerX, pointerY) => {
        const dx = pointerX - (box.left + box.width / 2)
        const dy = pointerY - (box.top + box.height * 0.4)
        const distance = Math.hypot(dx, dy) || 1
        // Full deflection a few face-widths away; tiny when the pointer is on the face.
        const reach = Math.min(1, distance / (box.width * 2.5))
        const x = (dx / distance) * 4.2 * reach
        const y = (dy / distance) * 3 * reach
        node.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`
        node.dataset.following = 'true'
      },
      release: () => {
        node.style.transform = ''
        delete node.dataset.following
      }
    })
  }, [ref, enabled])
}

interface Follower {
  measure: () => DOMRect | null
  aim: (box: DOMRect, x: number, y: number) => void
  /** Back to looking ahead. */
  release: () => void
}

/**
 * Every face following the pointer, served by one window listener rather
 * than one each. Once a frame, all of them are measured before any moves, so
 * a page of faces lays out once instead of once per face.
 */
const followers = new Set<Follower>()
const pointer = { x: 0, y: 0 }
let pointerFrame = 0
let pointerStill: ReturnType<typeof setTimeout> | undefined

function onPointerMove(event: PointerEvent): void {
  pointer.x = event.clientX
  pointer.y = event.clientY
  if (pointerFrame) return
  pointerFrame = requestAnimationFrame(() => {
    pointerFrame = 0
    const faces = [...followers]
    const boxes = faces.map((face) => face.measure())
    faces.forEach((face, i) => {
      const box = boxes[i]
      if (box) face.aim(box, pointer.x, pointer.y)
    })
    // Drift back to looking ahead a moment after the pointer stops.
    clearTimeout(pointerStill)
    pointerStill = setTimeout(() => {
      for (const face of followers) face.release()
    }, 2200)
  })
}

function followPointer(face: Follower): () => void {
  if (followers.size === 0) window.addEventListener('pointermove', onPointerMove, { passive: true })
  followers.add(face)
  return () => {
    followers.delete(face)
    face.release()
    if (followers.size > 0) return
    window.removeEventListener('pointermove', onPointerMove)
    cancelAnimationFrame(pointerFrame)
    pointerFrame = 0
    clearTimeout(pointerStill)
  }
}
