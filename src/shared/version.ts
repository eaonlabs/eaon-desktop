/**
 * The version a release is called, for people. A release's version must be
 * semver for updates to compare (package.json, `app.getVersion()`, the
 * latest*.yml files), so a release named with a fourth part on GitHub carries
 * the next semver underneath: 2026.7.2.1 is 2026.7.3. Everything the user
 * reads (Settings, the About panel, update notices, release notes) says its
 * GitHub name; everything that compares versions keeps the semver.
 */
const RELEASE_NAMES: Record<string, string> = {
  '2026.7.3': '2026.7.2.1'
}

export function versionLabel(version: string): string {
  return RELEASE_NAMES[version] ?? version
}
