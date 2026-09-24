import { useCallback, useEffect, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react'
import type { PetActivity, PetSpecies } from '@shared/pets'
import { PetSprite } from './PetSprite'
import { SPECIES } from './species'

export type DragPhase = 'start' | 'move' | 'end'

interface Props {
  species: PetSpecies
  name: string
  /** Edge of the body box in CSS pixels. */
  px: number
  activity: PetActivity
  walking?: boolean
  facing?: 'left' | 'right'
  /** Cumulative pointer travel since the press, in screen pixels. */
  onDrag: (dx: number, dy: number, phase: DragPhase) => void
  onPet?: () => void
  onHover?: (over: boolean) => void
}

const PETTED_MS = 2200
/** Travel under this is a click (a pat), not a drag. */
const DRAG_SLOP = 4

/**
 * The pet as something you can touch: hover shows its name, a click pats it
 * (hearts), a drag carries it. Hosts decide what "moving" means — the in-app
 * layer moves an element, the desktop window moves itself — so drags are
 * reported as screen-pixel deltas and the host applies them.
 *
 * Only this element takes pointer events; everything around it, effects
 * included, lets clicks straight through to the UI underneath.
 */
export function Pet({ species, name, px, activity, walking, facing, onDrag, onPet, onHover }: Props): JSX.Element {
  const [petted, setPetted] = useState(false)
  const [held, setHeld] = useState(false)
  const [hover, setHover] = useState(false)
  const press = useRef<{ x: number; y: number; dragging: boolean } | null>(null)
  const pettedTimer = useRef(0)

  useEffect(() => () => window.clearTimeout(pettedTimer.current), [])

  const pat = useCallback(() => {
    setPetted(true)
    window.clearTimeout(pettedTimer.current)
    pettedTimer.current = window.setTimeout(() => setPetted(false), PETTED_MS)
    onPet?.()
  }, [onPet])

  const down = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    // Keep receiving moves when a fast drag outruns the pet (or, on the
    // desktop, the window). Can throw for a pointer that already lifted.
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* the drag still works while the pointer stays over the pet */
    }
    press.current = { x: event.screenX, y: event.screenY, dragging: false }
  }
  const move = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const p = press.current
    if (!p) return
    const dx = event.screenX - p.x
    const dy = event.screenY - p.y
    if (!p.dragging) {
      if (Math.hypot(dx, dy) < DRAG_SLOP) return
      p.dragging = true
      setHeld(true)
      onDrag(0, 0, 'start')
    }
    onDrag(dx, dy, 'move')
  }
  const up = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const p = press.current
    press.current = null
    if (!p) return
    if (p.dragging) {
      setHeld(false)
      onDrag(event.screenX - p.x, event.screenY - p.y, 'end')
    } else pat()
  }

  const mood = petted ? 'petted' : activity
  const label = name.trim() || SPECIES[species].label
  return (
    <div
      className="pet"
      style={{ width: px, height: px }}
      data-held={held || undefined}
      role="img"
      aria-label={`${label} the ${SPECIES[species].label.toLowerCase()}`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onPointerEnter={() => {
        setHover(true)
        onHover?.(true)
      }}
      onPointerLeave={() => {
        setHover(false)
        if (!press.current) onHover?.(false)
      }}
    >
      <span className="pet__tag" data-visible={(hover && !held) || undefined}>
        {label}
      </span>
      <PetSprite species={species} mood={mood} walking={walking && !held} facing={facing} held={held} />
    </div>
  )
}

/* ---------------------------------------------------------------- strolls */

/** Room either side of the pet, in pixels, for a stroll to use. */
export type Room = { left: number; right: number }

const STROLL_SPEED = 34 // px per second — an amble, not a dash
const STROLL_MIN_WAIT = 40_000
const STROLL_MAX_WAIT = 90_000

/**
 * Now and then, while nothing is happening, the pet wanders a short way along
 * the ground. `room()` says how far it may go each way; `step(dx)` moves it.
 * Returns what the sprite needs to walk and face the right way.
 */
export function useStroll(
  enabled: boolean,
  room: () => Room | Promise<Room>,
  step: (dx: number) => void,
  done: () => void
): { walking: boolean; facing: 'left' | 'right' } {
  const [walking, setWalkingState] = useState(false)
  const [facing, setFacing] = useState<'left' | 'right'>('left')
  const walkingRef = useRef(false)
  const setWalking = (on: boolean): void => {
    walkingRef.current = on
    setWalkingState(on)
  }
  const live = useRef({ room, step, done })
  live.current = { room, step, done }

  useEffect(() => {
    if (!enabled) return
    let frame = 0
    let cancelled = false
    let timer = 0

    const schedule = (): void => {
      timer = window.setTimeout(go, STROLL_MIN_WAIT + Math.random() * (STROLL_MAX_WAIT - STROLL_MIN_WAIT))
    }
    const go = async (): Promise<void> => {
      const space = await live.current.room()
      if (cancelled) return
      // Head for whichever side has more room, a random way along it.
      const dir = space.left > space.right ? -1 : 1
      const available = dir < 0 ? space.left : space.right
      const distance = Math.min(available, 60 + Math.random() * 140)
      if (distance < 24) return schedule()
      setFacing(dir < 0 ? 'left' : 'right')
      setWalking(true)
      let travelled = 0
      let last = performance.now()
      const tick = (now: number): void => {
        if (cancelled) return
        const dx = Math.min(distance - travelled, (STROLL_SPEED * (now - last)) / 1000)
        last = now
        travelled += dx
        live.current.step(dir * dx)
        if (travelled < distance) frame = requestAnimationFrame(tick)
        else {
          setWalking(false)
          live.current.done()
          schedule()
        }
      }
      frame = requestAnimationFrame(tick)
    }
    schedule()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      cancelAnimationFrame(frame)
      // Interrupted mid-stroll (a reply started, the user grabbed it): stop
      // where it stands and remember that spot.
      if (walkingRef.current) {
        setWalking(false)
        live.current.done()
      }
    }
  }, [enabled])

  return { walking, facing }
}

/** Whether motion is reduced right now, following `body[data-reduce-motion]`. */
export function useReducedMotion(): boolean {
  const read = (): boolean => document.body.dataset.reduceMotion === 'on'
  const [reduced, setReduced] = useState(read)
  useEffect(() => {
    const observer = new MutationObserver(() => setReduced(read()))
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-reduce-motion'] })
    return () => observer.disconnect()
  }, [])
  return reduced
}
