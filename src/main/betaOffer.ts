/**
 * Offering a beta to someone on a stable build, only if they ask for it.
 *
 * A stable build never moves to a prerelease by itself: its updater follows
 * the latest stable release. This module decides whether a prerelease the
 * updater found is worth *offering* (newer than this build, and actually a
 * prerelease), and holds the warning the user is shown before anything is
 * downloaded.
 */

/** The warning shown before a beta is installed; deliberately loud. */
export const BETA_WARNING = 'UPDATE IF YOU WANT YOUR APP TO BE UNSTABLE, BETA UPDATE ONLY'

/** A beta, release candidate or other prerelease build (`2026.6.2-beta.4`), as opposed to a stable one. */
export const isPrerelease = (version: string): boolean => /^\d+\.\d+\.\d+-[0-9A-Za-z]/.test(version)

const core = (version: string): number[] | null => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/**
 * Whether `found` (what the updater says is the newest release, prereleases
 * included) is a beta to offer a stable `current` build: a prerelease of a
 * version *above* this one. A prerelease of the same version (2026.6.1-beta.2
 * for 2026.6.1) comes before the stable release and is not an upgrade, and a
 * newer stable release is the normal update's business, not an offer.
 */
export function isOfferable(current: string, found: string | null | undefined): found is string {
  if (!found || isPrerelease(current) || !isPrerelease(found)) return false
  const a = core(current)
  const b = core(found)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return b[i] > a[i]
  return false
}

export function betaDialogText(version: string): { message: string; detail: string } {
  return {
    message: BETA_WARNING,
    detail:
      `Eaon ${version} is a beta. It can crash, behave oddly or lose work, and it is meant for testing, not for everyday use.\n\n` +
      'Nothing is installed unless you choose Update to beta. You can go back to the stable version afterwards in Settings → General.'
  }
}
