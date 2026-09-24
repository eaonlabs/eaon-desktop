/**
 * Types shared by the pet in the main window, the desktop pet window and the
 * main process that relays between them.
 */

export const PET_SPECIES = ['fox', 'cat', 'axolotl', 'owl', 'slime', 'dragon'] as const
export type PetSpecies = (typeof PET_SPECIES)[number]

/** What the app is doing, as the pet understands it. */
export type PetActivity = 'idle' | 'thinking' | 'working' | 'happy' | 'concerned' | 'asleep'

/** Everything a pet draws with that is not its own interaction state. */
export type PetMood = PetActivity | 'petted'

export type PetSize = 'small' | 'medium' | 'large'

/** Rendered edge of the pet's body box, in CSS pixels. */
export const PET_PIXELS: Record<PetSize, number> = { small: 56, medium: 76, large: 104 }

/**
 * Sent main renderer → main process → desktop pet window whenever any of it
 * changes, so the floating pet mirrors the app without reading its store.
 */
export interface PetSnapshot {
  species: PetSpecies
  name: string
  size: PetSize
  activity: PetActivity
  /** Resolved appearance, so the name tag matches the app. */
  theme: 'light' | 'dark'
  palette: { background: string; foreground: string; accent: string }
  reduceMotion: boolean
}

export function isSpecies(value: string): value is PetSpecies {
  return (PET_SPECIES as readonly string[]).includes(value)
}
