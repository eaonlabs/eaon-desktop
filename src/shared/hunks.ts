/**
 * Accepting or rejecting one hunk of a file's uncommitted changes. A hunk is
 * a piece of `git diff` that starts with an "@@" line; a patch of just that
 * hunk is applied backwards to the working tree to reject it, or forwards to
 * git's index to keep it staged. This is the splitting and the patch, free of
 * git and Electron so it can be tested on its own.
 */

export interface RawHunk {
  /** `@@ -12,6 +12,8 @@ function name`, as git wrote it. */
  header: string
  /** The header and every line under it, ending in a newline. */
  text: string
}

export interface SplitDiff {
  /** The lines before the first hunk: "diff --git", "index", "---", "+++". */
  head: string
  hunks: RawHunk[]
}

/**
 * One file's `git diff` cut into its head and hunks. A line that starts with
 * "@@" is always a hunk header: lines inside a hunk start with a space, "+",
 * "-" or "\". Null for a diff of no file, or of more than one.
 */
export function splitFileDiff(raw: string): SplitDiff | null {
  const lines = raw.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  if (lines.filter((l) => l.startsWith('diff --git ')).length !== 1) return null
  const first = lines.findIndex((l) => l.startsWith('@@'))
  if (first === -1) return null
  const head = lines.slice(0, first).join('\n') + '\n'
  const hunks: RawHunk[] = []
  let current: string[] = []
  const flush = (): void => {
    if (current.length) hunks.push({ header: current[0], text: current.join('\n') + '\n' })
    current = []
  }
  for (const line of lines.slice(first)) {
    if (line.startsWith('@@')) flush()
    current.push(line)
  }
  flush()
  return { head, hunks }
}

/** A hunk's body lines as drawn: each with its " ", "+" or "-" in front, without git's "\\ No newline" notes. */
export const hunkBody = (hunk: RawHunk): string[] =>
  hunk.text
    .split('\n')
    .slice(1)
    .filter((l, i, all) => !(i === all.length - 1 && l === '') && !l.startsWith('\\'))

/**
 * A short fingerprint of a hunk's lines. The diff on screen and the diff git
 * gives when the button is pressed are the same hunk only if these match: the
 * `@@` line alone doesn't say so, since a line reworded keeps the counts.
 */
export function hunkFingerprint(lines: readonly string[]): string {
  let h = 0x811c9dc5
  for (const line of lines) {
    const clean = line.endsWith('\r') ? line.slice(0, -1) : line
    for (let i = 0; i < clean.length; i++) {
      h ^= clean.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    h ^= 10
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** A patch of one hunk, for `git apply`. */
export const hunkPatch = (split: SplitDiff, index: number): string | null => (index >= 0 && index < split.hunks.length ? split.head + split.hunks[index].text : null)

/** A path git is asked about: inside the folder, never absolute or climbing out of it. */
export function isRepoRelative(path: unknown): path is string {
  if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0')) return false
  if (path.startsWith('/') || path.startsWith('-') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\')) return false
  return !path.split(/[\\/]/).includes('..')
}
