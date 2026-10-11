/**
 * Reviewing a session's work in the ADE: what its agents changed against the
 * branch it started from, line comments sent back to an agent, and the
 * commit → push → pull request → merge steps (main/features/ade/review.ts).
 */

export type ReviewLineKind = 'add' | 'del' | 'ctx'

export interface ReviewLine {
  kind: ReviewLineKind
  /** Line number in the old file; null for an added line. */
  old: number | null
  /** Line number in the new file; null for a removed line. */
  cur: number | null
  text: string
}

export interface ReviewHunk {
  /** `@@ -12,6 +12,8 @@ function name` as git wrote it. */
  header: string
  lines: ReviewLine[]
}

export interface ReviewFile {
  path: string
  /** The path before a rename. */
  oldPath: string | null
  status: 'added' | 'deleted' | 'modified' | 'renamed'
  added: number
  removed: number
  binary: boolean
  hunks: ReviewHunk[]
}

export interface PullRequestInfo {
  number: number
  title: string
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  draft: boolean
  /** GitHub's own word on whether it can merge: CLEAN, BLOCKED, BEHIND, DIRTY (conflicts), UNSTABLE, … */
  mergeState: string
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or '' */
  reviewDecision: string
  checks: { passed: number; failed: number; pending: number }
}

export interface ReviewState {
  /** The branch checked out; null on a detached HEAD. */
  branch: string | null
  /** What the changes are measured against: the default branch (e.g. origin/main), or HEAD when on it. */
  base: string
  /** Commits on this branch that the base doesn't have. */
  ahead: number
  /** Files changed and not committed (new ones included). */
  uncommitted: number
  /** Pushed state against the upstream: null when the branch has never been pushed. */
  upstream: { ahead: number; behind: number } | null
  files: ReviewFile[]
  /** Null when the GitHub CLI isn't there or isn't signed in, so pull requests can't be shown. */
  github: { pr: PullRequestInfo | null } | null
  /** Why GitHub can't be used, when `github` is null. */
  githubProblem?: string
}

export type ReviewResult = { ok: true; state: ReviewState } | { ok: false; error: string }
export type ReviewAction = { ok: true; message?: string; url?: string } | { ok: false; error: string }

/** A comment on one line of the diff, before it is sent to an agent. */
export interface ReviewComment {
  id: string
  path: string
  /** The line it is on: its number in the new file, or the old one for a removed line. */
  line: number
  side: 'new' | 'old'
  /** The line's text, quoted to the agent so it knows which one is meant. */
  quote: string
  body: string
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** Unquotes a path git wrote in C style ("a\tb.txt"), for names with odd characters. */
function gitPath(raw: string): string {
  if (!raw.startsWith('"')) return raw
  try {
    return JSON.parse(raw) as string
  } catch {
    return raw.slice(1, -1)
  }
}

/** `a/src/x.ts` → `src/x.ts`; `/dev/null` stays as it is. */
const strip = (p: string): string => (p === '/dev/null' ? p : p.replace(/^[ab]\//, ''))

/**
 * Parses `git diff` output (unified, any number of files) into files and
 * hunks with true line numbers. Also reads `git diff --no-index /dev/null x`,
 * which is how a new, untracked file is shown.
 */
export function parseUnifiedDiff(text: string): ReviewFile[] {
  const files: ReviewFile[] = []
  let file: ReviewFile | null = null
  let hunk: ReviewHunk | null = null
  let old = 0
  let cur = 0

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git (".*?"|\S+) (".*?"|\S+)$/.exec(line)
      const path = m ? strip(gitPath(m[2])) : line.slice(11)
      file = { path, oldPath: null, status: 'modified', added: 0, removed: 0, binary: false, hunks: [] }
      files.push(file)
      hunk = null
      continue
    }
    if (!file) continue
    if (!hunk) {
      if (line.startsWith('new file mode')) file.status = 'added'
      else if (line.startsWith('deleted file mode')) file.status = 'deleted'
      else if (line.startsWith('rename from ')) {
        file.status = 'renamed'
        file.oldPath = gitPath(line.slice(12))
      } else if (line.startsWith('rename to ')) file.path = gitPath(line.slice(10))
      else if (line.startsWith('Binary files ')) file.binary = true
      else if (line.startsWith('--- ')) {
        if (strip(gitPath(line.slice(4))) === '/dev/null') file.status = 'added'
      } else if (line.startsWith('+++ ')) {
        const to = strip(gitPath(line.slice(4)))
        if (to === '/dev/null') file.status = 'deleted'
        else file.path = to
      }
    }
    const h = HUNK.exec(line)
    if (h) {
      hunk = { header: line, lines: [] }
      file.hunks.push(hunk)
      old = Number(h[1])
      cur = Number(h[2])
      continue
    }
    if (!hunk) continue
    if (line.startsWith('+')) {
      hunk.lines.push({ kind: 'add', old: null, cur: cur++, text: line.slice(1) })
      file.added++
    } else if (line.startsWith('-')) {
      hunk.lines.push({ kind: 'del', old: old++, cur: null, text: line.slice(1) })
      file.removed++
    } else if (line.startsWith(' ')) {
      hunk.lines.push({ kind: 'ctx', old: old++, cur: cur++, text: line.slice(1) })
    }
    // "\ No newline at end of file" and the trailing empty line say nothing about content.
  }
  return files
}

/**
 * The comments as one message for the agent that made the changes: each
 * file and line, the line itself quoted, then what to do about it.
 */
export function formatReviewComments(comments: ReviewComment[]): string {
  const sorted = [...comments].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  const parts = sorted.map((c) => {
    const where = `${c.path}:${c.line}${c.side === 'old' ? ' (a removed line)' : ''}`
    const quote = c.quote.trim() ? `\n> ${c.quote.trim()}` : ''
    return `${where}${quote}\n${c.body.trim()}`
  })
  const count = sorted.length === 1 ? 'a comment' : `${sorted.length} comments`
  return `I reviewed your changes and left ${count}. Please address ${sorted.length === 1 ? 'it' : 'each one'}:\n\n${parts.join('\n\n')}`
}

/** A pull request as `gh pr view --json number,title,url,state,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup` gives it. */
export function prFromGh(raw: unknown): PullRequestInfo | null {
  const v = raw as Record<string, unknown> | null
  if (!v || typeof v.number !== 'number' || typeof v.url !== 'string') return null
  const checks = { passed: 0, failed: 0, pending: 0 }
  for (const c of Array.isArray(v.statusCheckRollup) ? (v.statusCheckRollup as Record<string, unknown>[]) : []) {
    // A check run has a status and (once done) a conclusion; a commit status has a state.
    const word = String(c.conclusion || c.state || '').toUpperCase()
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(word)) checks.passed++
    else if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(word)) checks.failed++
    else checks.pending++
  }
  const state = String(v.state ?? 'OPEN').toUpperCase()
  return {
    number: v.number,
    title: String(v.title ?? ''),
    url: v.url,
    state: state === 'MERGED' || state === 'CLOSED' ? state : 'OPEN',
    draft: v.isDraft === true,
    mergeState: String(v.mergeStateStatus ?? ''),
    reviewDecision: String(v.reviewDecision ?? ''),
    checks
  }
}
