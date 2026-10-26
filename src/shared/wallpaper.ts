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
