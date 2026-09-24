import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { useApp } from '../../state/store'
import { isSpecies, PET_PIXELS, type PetActivity, type PetSnapshot } from '@shared/pets'
import { Pet, useReducedMotion, useStroll, type DragPhase } from './Pet'
import { usePetActivity } from './usePetActivity'

/** Offset of the pet's box from the window's bottom-right corner. */
interface Offset {
  right: number
  bottom: number
}

const STORAGE_KEY = 'eaon.pet.offset'
const EDGE = 8
const HOME: Offset = { right: 22, bottom: 16 }
/** Strolls only happen while the pet is resting on (or near) the bottom edge. */
const GROUND = 40

function loadOffset(): Offset {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Offset | null
    if (saved && Number.isFinite(saved.right) && Number.isFinite(saved.bottom)) return saved
  } catch {
    /* no storage — start at home */
  }
  return HOME
}

function saveOffset(offset: Offset): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(offset))
  } catch {
    /* a lost position is not worth an error */
  }
}

/** Keep the whole pet inside the window, however it was resized. */
function clamp(offset: Offset, px: number): Offset {
  const maxRight = Math.max(EDGE, window.innerWidth - px - EDGE)
  const maxBottom = Math.max(EDGE, window.innerHeight - px - EDGE)
  return {
    right: Math.min(maxRight, Math.max(EDGE, offset.right)),
    bottom: Math.min(maxBottom, Math.max(EDGE, offset.bottom))
  }
}

/**
 * The pet over the main window, and the source of truth for the desktop pet:
 * this is the only place that can see the app's activity, so it works out the
 * mood and hands a snapshot to the floating window through the main process.
 * With "Float on desktop" on, the pet lives there instead of here.
 */
export function PetLayer(): JSX.Element | null {
  const pets = useApp((s) => s.settings?.pets)
  const enabled = Boolean(pets?.enabled)
  const desktop = enabled && Boolean(pets?.desktop)

  // Desktop window open/closed follows the setting, and closes on unmount.
  useEffect(() => {
    void window.api.pets.setDesktop(desktop)
  }, [desktop])

  if (!enabled || !pets) return null
  return <ActivePet desktop={desktop} />
}

function ActivePet({ desktop }: { desktop: boolean }): JSX.Element | null {
  const pets = useApp((s) => s.settings!.pets)
  const appearance = useApp((s) => s.settings!.appearance)
  const { activity, poke } = usePetActivity()
  const reduced = useReducedMotion()
  const species = isSpecies(pets.species) ? pets.species : 'fox'
  const px = PET_PIXELS[pets.size] ?? PET_PIXELS.medium

  // Petting the desktop pet wakes this one's idle clock too.
  useEffect(() => window.api.pets.onPoke(poke), [poke])

  // Resolved here rather than read off <html>: useTheme() writes that in an
  // effect, after this render, so it would lag a switch by one update.
  const theme =
    appearance.mode === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : appearance.mode
  const tone = appearance[theme]
  useDesktopMirror(desktop, {
    species,
    name: pets.name,
    size: pets.size,
    activity,
    theme,
    palette: { background: tone.background, foreground: tone.foreground, accent: tone.accent },
    reduceMotion: reduced
  })

  if (desktop) return null
  return <InAppPet species={species} name={pets.name} px={px} activity={activity} reduced={reduced} onPet={poke} />
}

/** Sends the snapshot whenever any part of it changes. */
function useDesktopMirror(on: boolean, snapshot: PetSnapshot): void {
  const key = JSON.stringify(snapshot)
  useEffect(() => {
    if (on) window.api.pets.sync(JSON.parse(key) as PetSnapshot)
  }, [on, key])
}

function InAppPet({
  species,
  name,
  px,
  activity,
  reduced,
  onPet
}: {
  species: PetSnapshot['species']
  name: string
  px: number
  activity: PetActivity
  reduced: boolean
  onPet: () => void
}): JSX.Element {
  const [offset, setOffset] = useState(() => clamp(loadOffset(), px))
  const [hover, setHover] = useState(false)
  const [dragging, setDragging] = useState(false)
  const dragStart = useRef(offset)
  const current = useRef(offset)
  current.current = offset

  useEffect(() => {
    const onResize = (): void => setOffset((o) => clamp(o, px))
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [px])

  const onDrag = useCallback(
    (dx: number, dy: number, phase: DragPhase) => {
      if (phase === 'start') {
        dragStart.current = current.current
        setDragging(true)
        return
      }
      const next = clamp({ right: dragStart.current.right - dx, bottom: dragStart.current.bottom - dy }, px)
      setOffset(next)
      if (phase === 'end') {
        setDragging(false)
        saveOffset(next)
      }
    },
    [px]
  )

  const onGround = offset.bottom <= GROUND
  const { walking, facing } = useStroll(
    activity === 'idle' && onGround && !hover && !dragging && !reduced,
    () => ({
      left: window.innerWidth - current.current.right - px - EDGE,
      right: current.current.right - EDGE
    }),
    (dx) => setOffset((o) => clamp({ ...o, right: o.right - dx }, px)),
    () => saveOffset(current.current)
  )

  return (
    <div className="pet-layer">
      <div className="pet-layer__anchor" style={{ right: offset.right, bottom: offset.bottom }}>
        <Pet
          species={species}
          name={name}
          px={px}
          activity={activity}
          walking={walking}
          facing={facing}
          onDrag={onDrag}
          onPet={onPet}
          onHover={setHover}
        />
      </div>
    </div>
  )
}
