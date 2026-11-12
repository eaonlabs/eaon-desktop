import { ago } from './modelSelection'

/**
 * Who last changed a line of the open file, and the file's own commits: what
 * the editor's status bar and History button show (main/features/gitHistory.ts
 * asks git). `git log --follow` rows are shared/chatCode.ts's parseCommits.
 */

/** The commit that last changed one line. */
export interface LineBlame {
  sha: string
  short: string
  author: string
  /** Committed at, in ms; 0 for a line not committed yet. */
  at: number
  subject: string
  /** False for a line that is only in the working copy. */
  committed: boolean
}

export type LineBlameResult = { ok: true; blame: LineBlame } | { ok: false; error: string }

/** How many commits the file's History lists. */
export const FILE_COMMITS_SHOWN = 30

const ZERO = /^0+$/

/**
 * One line's `git blame -L n,n --porcelain` output. The header names the
 * commit; the next lines hold what is known of it. A line not committed yet
 * has an all-zero commit. Null when the output isn't a blame.
 */
export function parseBlame(out: string): LineBlame | null {
  const lines = out.split('\n')
  const head = /^([0-9a-f]{7,64}) \d+ \d+/.exec(lines[0] ?? '')
  if (!head) return null
  const sha = head[1]
  const field = (name: string): string => {
    const row = lines.find((l) => l.startsWith(`${name} `))
    return row ? row.slice(name.length + 1).trim() : ''
  }
  if (ZERO.test(sha)) return { sha, short: '', author: 'Not committed yet', at: 0, subject: '', committed: false }
  return {
    sha,
    short: sha.slice(0, 7),
    author: field('author') || 'Unknown',
    at: (Number(field('author-time')) || 0) * 1000,
    subject: field('summary'),
    committed: true
  }
}

/** The status bar's words for a line: "Jane Doe, 3 days ago · Fix the redirect", or "Not committed yet". */
export function blameLabel(b: LineBlame, now = Date.now()): string {
  if (!b.committed) return 'Not committed yet'
  const when = b.at > 0 ? `${b.author}, ${ago(b.at, now)}` : b.author
  return b.subject ? `${when} · ${b.subject}` : when
}
