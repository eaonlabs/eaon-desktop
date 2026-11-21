import type { SeeThrough } from './types'

/**
 * Where the page loads a video wallpaper from: Eaon's own copy of it, by name,
 * through a scheme that serves only that folder (main/features/wallpaper.ts).
 */
export const WALLPAPER_SCHEME = 'eaon-wallpaper'

/** The URL of a chosen video wallpaper, from its path in Eaon's folder. */
export function wallpaperVideoUrl(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? ''
  return `${WALLPAPER_SCHEME}://wallpaper/${encodeURIComponent(name)}`
}

/**
 * Eaon's own wallpapers (scripts/make-wallpapers.py), shipped in
 * resources/wallpapers. Each comes dark and light, and the window shows the
 * one that goes with the theme.
 */
export const WALLPAPERS = [
  { id: 'dusk', name: 'Dusk' },
  { id: 'tide', name: 'Tide' },
  { id: 'dune', name: 'Dune' },
  { id: 'moss', name: 'Moss' },
  { id: 'ember', name: 'Ember' },
  { id: 'slate', name: 'Slate' }
] as const

export type WallpaperId = (typeof WALLPAPERS)[number]['id']

/** One of Eaon's wallpapers by id; the first for an unknown or unset one. */
export const wallpaperOf = (id: string | null | undefined): (typeof WALLPAPERS)[number] => WALLPAPERS.find((w) => w.id === id) ?? WALLPAPERS[0]

/** Its file in resources/wallpapers, in the version for the theme. */
export const wallpaperFile = (id: string | null | undefined, light: boolean): string => `${wallpaperOf(id).id}-${light ? 'light' : 'dark'}.jpg`

/** Whether the OS says which picture the desktop shows: macOS and Windows do, Linux doesn't. */
export const desktopKnown = (platform: string): boolean => platform === 'darwin' || platform === 'win32'

/**
 * Where the picture behind the window comes from, as it can be shown: a
 * chosen file once there is one, the desktop's own where the OS says what it
 * is, and otherwise one of Eaon's.
 */
export function wallpaperSource(see: Pick<SeeThrough, 'source' | 'custom'>, platform: string): SeeThrough['source'] {
  if (see.source === 'custom' && see.custom) return 'custom'
  if (see.source === 'eaon' || !desktopKnown(platform)) return 'eaon'
  return 'desktop'
}
