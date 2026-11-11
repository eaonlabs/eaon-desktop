import { remoteLocation } from './adeRemote'

/**
 * Paths in a project on another machine. A remote project's folder is
 * `ssh://<host id>/<absolute path>` (adeRemote.ts); a path inside it is
 * judged here by its words alone, the way the agent wrote it. The host has
 * the last word: every tool also checks, on the host, where the path really
 * leads once links are followed (main/remoteWork.ts).
 */

/** `.` and `..` folded away and repeated slashes collapsed, as a POSIX path; never climbs above `/`. */
export function posixNormalize(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

export interface RemoteSpot {
  hostId: string
  /** The project's own folder on the host. */
  root: string
  /** The path asked for, absolute on the host. */
  path: string
  /** Whether it is the project's folder or inside it. */
  inside: boolean
}

const within = (root: string, path: string): boolean => root === '/' || path === root || path.startsWith(`${root}/`)

/**
 * Where `target` (relative to the project's folder, or absolute on the host)
 * lies. `~` is the host user's home, which isn't known here, so it counts as
 * outside; the folders a project may use are its own.
 */
export function remoteSpot(cwd: string, target: string): RemoteSpot | null {
  const place = remoteLocation(cwd)
  if (!place) return null
  const root = posixNormalize(place.path)
  const asked = target.trim()
  const path = asked.startsWith('~') ? `/~outside/${asked}` : posixNormalize(asked.startsWith('/') ? asked : `${root}/${asked || '.'}`)
  return { hostId: place.hostId, root, path, inside: !asked.startsWith('~') && within(root, path) }
}

/** The path as the agent and the person read it: relative to the project's folder when it is inside. */
export function remoteShown(root: string, path: string): string {
  if (path === root) return '.'
  return root !== '/' && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
}

/** Whether a remote folder (an `ssh://` string) is the project folder `root` or lies inside it. */
export function remoteInside(rootCwd: string, cwd: string): boolean {
  const a = remoteLocation(rootCwd)
  const b = remoteLocation(cwd)
  return !!a && !!b && a.hostId === b.hostId && !b.path.split('/').includes('..') && within(posixNormalize(a.path), posixNormalize(b.path))
}
