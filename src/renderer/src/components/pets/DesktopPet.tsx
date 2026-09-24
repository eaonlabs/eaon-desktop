import { useCallback, useEffect, useState, type JSX } from 'react'
import { PET_PIXELS, type PetSnapshot } from '@shared/pets'
import { Pet, useStroll, type DragPhase } from './Pet'

/**
 * The whole renderer of the floating desktop pet window (loaded with `#pet`).
 * It has no store and no settings of its own: the main window sends a
 * snapshot of everything it needs, and this draws it.
 *
 * The window is transparent and ignores the mouse except while the pointer is
 * over the pet, so it never steals a click from whatever is underneath.
 */
export function DesktopPet(): JSX.Element | null {
  const [snapshot, setSnapshot] = useState<PetSnapshot | null>(null)
  const [hover, setHover] = useState(false)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    document.body.dataset.surface = 'pet'
    void window.api.pets.current().then((s) => s && setSnapshot(s))
    return window.api.pets.onSnapshot(setSnapshot)
  }, [])

  // The name tag borrows the app's theme so it looks like part of Eaon.
  useEffect(() => {
    if (!snapshot) return
    const root = document.documentElement
    root.dataset.theme = snapshot.theme
    root.style.setProperty('--bg', snapshot.palette.background)
    root.style.setProperty('--fg', snapshot.palette.foreground)
    root.style.setProperty('--accent', snapshot.palette.accent)
    document.body.dataset.reduceMotion = snapshot.reduceMotion ? 'on' : 'off'
  }, [snapshot])

  const onHover = useCallback((over: boolean) => {
    setHover(over)
    window.api.pets.setInteractive(over)
  }, [])

  const onDrag = useCallback((dx: number, dy: number, phase: DragPhase) => {
    if (phase === 'start') setDragging(true)
    if (phase === 'end') setDragging(false)
    window.api.pets.drag(dx, dy, phase)
  }, [])

  const { walking, facing } = useStroll(
    Boolean(snapshot) && snapshot?.activity === 'idle' && !hover && !dragging && !snapshot?.reduceMotion,
    () => window.api.pets.room(),
    (dx) => window.api.pets.walk(dx),
    () => window.api.pets.settle()
  )

  if (!snapshot) return null
  return (
    <div className="pet-window">
      <Pet
        species={snapshot.species}
        name={snapshot.name}
        px={PET_PIXELS[snapshot.size]}
        activity={snapshot.activity}
        walking={walking}
        facing={facing}
        onDrag={onDrag}
        onPet={() => window.api.pets.poke()}
        onHover={onHover}
      />
    </div>
  )
}
