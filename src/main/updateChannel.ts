/**
 * The update channel a build should follow, when electron-updater's own pick
 * would strand it. It reads a prerelease build's channel from its version, and
 * a custom one (`2026.6.0-rc.1` is channel "rc") only ever looks for more
 * releases with that same tag, never the stable release that follows. That
 * left the 2026.6.0 release candidate unable to update. "beta" is the
 * built-in channel that moves on to the next stable release (or a newer beta),
 * so custom prerelease builds follow it instead. Stable, alpha and beta builds
 * keep electron-updater's own behaviour (null).
 */
/** A beta, release candidate or other prerelease build (`2026.6.2-beta.3`), as opposed to a stable one. */
export const isPrerelease = (version: string): boolean => /^\d+\.\d+\.\d+-[0-9A-Za-z]/.test(version)

export function updateChannelFor(version: string): string | null {
  const tag = /^\d+\.\d+\.\d+-([0-9A-Za-z-]+)/.exec(version)?.[1]
  if (!tag || tag === 'alpha' || tag === 'beta') return null
  return 'beta'
}
