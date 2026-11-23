/**
 * The version a release is called, for people. A release's version must be
 * semver for updates to compare (package.json, `app.getVersion()`, the
 * latest*.yml files), so a release named with a fourth part on GitHub carries
 * the next semver underneath: 2026.7.2.1 is 2026.7.3. Everything the user
 * reads (Settings, the About panel, update notices, release notes) says its
 * GitHub name; everything that compares versions keeps the semver.
 */
const RELEASE_NAMES: Record<string, string> = {
  '2026.7.3': '2026.7.2.1',
  '2026.7.8': '2026.7.7.1',
  // 2026.7.7.1 already went out as 2026.7.8, so the release named 2026.7.8 is 2026.7.9 underneath.
  '2026.7.9': '2026.7.8',
  '2026.7.10': '2026.7.8.1',
  '2026.7.11': '2026.7.8.2'
}

export function versionLabel(version: string): string {
  return RELEASE_NAMES[version] ?? version
}

/**
 * A release's name as its GitHub title gives it ("Eaon 2026.7.7.1" gives
 * "2026.7.7.1"). electron-updater passes the title on as `releaseName`, and
 * it's the only way a copy that's already installed learns what a later
 * release is called: RELEASE_NAMES only knows the releases before it. Null
 * when the title has no version in it.
 */
export function releaseNameVersion(releaseName: string | null | undefined): string | null {
  return releaseName?.match(/\d+\.\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]+)?/)?.[0] ?? null
}

/** What to call an update for people: its release's name, else its version's label. */
export function updateLabel(update: { version: string; name?: string }): string {
  return update.name ?? versionLabel(update.version)
}
