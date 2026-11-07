import fs from 'node:fs'
import path from 'node:path'

/**
 * Which of the paths a terminal printed are files in the session's folder:
 * those get a link. Never a path outside the folder (an absolute path to
 * somewhere else, `../` out of it): the editor opens files of a session, and
 * a link that says "open /etc/passwd" is not one to offer.
 */

/** The absolute path `ref` names for a session in `folder`, or null when it isn't inside it. */
export function pathInFolder(folder: string, ref: string, home: string): string | null {
  const expanded = /^~[\\/]/.test(ref) ? path.join(home, ref.slice(2)) : ref
  const absolute = path.resolve(folder, expanded)
  const rel = path.relative(path.resolve(folder), absolute)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return absolute
}

/** For each of `refs` (printed paths, `src/app.ts`): the file's absolute path when it is a file inside `folder`, else null. */
export async function existingFiles(folder: string, refs: string[], home: string): Promise<(string | null)[]> {
  return Promise.all(
    refs.slice(0, 40).map(async (ref) => {
      const absolute = ref.length <= 1024 ? pathInFolder(folder, ref, home) : null
      if (!absolute) return null
      try {
        return (await fs.promises.stat(absolute)).isFile() ? absolute : null
      } catch {
        return null
      }
    })
  )
}
