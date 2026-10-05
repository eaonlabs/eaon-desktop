/**
 * Where Eaon's own pages live: the public repository, its releases and
 * issues, and the user documentation on eaon.dev. One place, so a move (the
 * repository went from a personal account to the eaonlabs organisation in
 * 2026.6) is one edit rather than a hunt through Settings, the sidebar and
 * the menus.
 */

export const REPO_URL = 'https://github.com/eaonlabs/eaon-desktop'
export const RELEASES_URL = `${REPO_URL}/releases`
export const ISSUES_URL = `${REPO_URL}/issues`
/** The user guide (install, first launch, models, Workers, the ADE). The repository README is for developers. */
export const DOCS_URL = 'https://eaon.dev/docs'

/**
 * The release page for one version, or null for a string no release could
 * carry. Tags are the version with a `v` in front (`v2026.6.1`,
 * `v2026.6.0-rc.1`).
 */
export function releaseTagUrl(version: string): string | null {
  const v = version.trim().replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v)) return null
  return `${RELEASES_URL}/tag/v${v}`
}

/**
 * Release notes for the version that is running: its own release page when
 * GitHub has one, the list of releases otherwise. A local or not-yet-published
 * build has no page of its own, and a dead tag link is worse than the list.
 * `exists` asks whether a URL answers; any failure (offline, slow, rate
 * limited) falls back to the list, which always works.
 */
export async function releaseNotesUrl(version: string, exists: (url: string) => Promise<boolean>): Promise<string> {
  const tag = releaseTagUrl(version)
  if (!tag) return RELEASES_URL
  try {
    return (await exists(tag)) ? tag : RELEASES_URL
  } catch {
    return RELEASES_URL
  }
}
