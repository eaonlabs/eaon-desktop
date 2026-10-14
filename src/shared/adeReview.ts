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

/** One CI check on a pull request, or one workflow run on a branch that has no pull request yet. */
export interface ReviewCheck {
  name: string
  status: 'passed' | 'failed' | 'pending' | 'skipped'
  /** GitHub's own word for how it ended (FAILURE, TIMED_OUT, …), or '' while it runs. */
  conclusion: string
  /** Its page: a GitHub Actions job or run, or another service's. */
  url: string | null
  /** The GitHub Actions workflow it belongs to, when gh says. */
  workflow: string
}

export interface PullRequestInfo {
  number: number
  title: string
  url: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  draft: boolean
  /** GitHub's own word on whether it can merge: CLEAN, BLOCKED, BEHIND, DIRTY (conflicts), UNSTABLE, … */
  mergeState: string
  /** MERGEABLE, CONFLICTING or UNKNOWN (GitHub hasn't worked it out yet). */
  mergeable: string
  /** The branch it merges into, e.g. main. */
  baseRef: string
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or '' */
  reviewDecision: string
  checks: { passed: number; failed: number; pending: number }
  /** Each check, failing ones first. */
  checkRuns: ReviewCheck[]
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
  /** Commits on the base that this branch doesn't have yet (as last fetched). */
  behindBase: number
  /** A merge, rebase or cherry-pick stopped part way, waiting on the user; null when none is. */
  merging: 'merge' | 'rebase' | 'cherry-pick' | null
  /** Files with unresolved conflicts. */
  conflicted: string[]
  files: ReviewFile[]
  /**
   * Null when the GitHub CLI isn't there or isn't signed in, so pull requests
   * can't be shown. `runs` are the branch's latest workflow runs, looked up
   * only when there is no pull request to carry its checks.
   */
  github: { pr: PullRequestInfo | null; runs?: ReviewCheck[] } | null
  /** Why GitHub can't be used, when `github` is null. */
  githubProblem?: string
}

export type ReviewResult = { ok: true; state: ReviewState } | { ok: false; error: string }
export type ReviewAction = { ok: true; message?: string; url?: string } | { ok: false; error: string }
/** A failed check's log, the end of it. */
export type ReviewLog = { ok: true; log: string; truncated: boolean } | { ok: false; error: string }
/** A conflicted file's text as it is on disk, markers and all. */
export type ReviewFileText = { ok: true; text: string } | { ok: false; error: string }

/**
 * A comment on one line of the diff, or on a run of lines, before it is sent
 * to an agent. Markdown, written by the user.
 */
export interface ReviewComment {
  id: string
  path: string
  /** The line it is on: its number in the new file, or the old one for a removed line. */
  line: number
  /** The last line of a range comment (on the same side); absent for one line. */
  endLine?: number
  side: 'new' | 'old'
  /** The line's text (the lines', for a range), quoted to the agent so it knows which ones are meant. */
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

/** Lines without the indent they all share, and without blank lines at either end. */
function dedent(text: string): string[] {
  const lines = text.split('\n').map((l) => l.trimEnd())
  while (lines.length && !lines[0]) lines.shift()
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  const indent = Math.min(...lines.filter(Boolean).map((l) => /^\s*/.exec(l)![0].length))
  return lines.map((l) => l.slice(Number.isFinite(indent) ? indent : 0))
}

/** Whether a comment covers more than one line. */
export const isRange = (c: Pick<ReviewComment, 'line' | 'endLine'>): boolean => typeof c.endLine === 'number' && c.endLine !== c.line

/**
 * The comments as one message for the agent that made the changes: each
 * file and line (or lines), quoted, then what to do about it.
 */
export function formatReviewComments(comments: ReviewComment[]): string {
  const sorted = [...comments].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  const parts = sorted.map((c) => {
    const lines = isRange(c) ? `${Math.min(c.line, c.endLine!)}-${Math.max(c.line, c.endLine!)}` : String(c.line)
    const removed = c.side === 'old' ? (isRange(c) ? ' (removed lines)' : ' (a removed line)') : ''
    const quoted = dedent(c.quote)
    const quote = quoted.length ? `\n${quoted.map((l) => (l ? `> ${l}` : '>')).join('\n')}` : ''
    return `${c.path}:${lines}${removed}${quote}\n${c.body.trim()}`
  })
  const count = sorted.length === 1 ? 'a comment' : `${sorted.length} comments`
  return `I reviewed your changes and left ${count}. Please address ${sorted.length === 1 ? 'it' : 'each one'}:\n\n${parts.join('\n\n')}`
}

const FAILED = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']
const CHECK_ORDER: Record<ReviewCheck['status'], number> = { failed: 0, pending: 1, passed: 2, skipped: 3 }

/** What a check's (or a run's) conclusion, or a commit status's state, comes to. */
function checkStatus(word: string): ReviewCheck['status'] {
  if (word === 'SUCCESS' || word === 'NEUTRAL') return 'passed'
  if (word === 'SKIPPED') return 'skipped'
  if (FAILED.includes(word)) return 'failed'
  return 'pending'
}

const byStatus = (a: ReviewCheck, b: ReviewCheck): number => CHECK_ORDER[a.status] - CHECK_ORDER[b.status]

/**
 * A pull request as `gh pr view --json
 * number,title,url,state,isDraft,mergeable,mergeStateStatus,baseRefName,reviewDecision,statusCheckRollup`
 * gives it.
 */
export function prFromGh(raw: unknown): PullRequestInfo | null {
  const v = raw as Record<string, unknown> | null
  if (!v || typeof v.number !== 'number' || typeof v.url !== 'string') return null
  const checks = { passed: 0, failed: 0, pending: 0 }
  const checkRuns: ReviewCheck[] = []
  for (const c of Array.isArray(v.statusCheckRollup) ? (v.statusCheckRollup as Record<string, unknown>[]) : []) {
    // A check run has a status and (once done) a conclusion; a commit status has a state.
    const word = String(c.conclusion || c.state || '').toUpperCase()
    const status = checkStatus(word)
    if (status === 'failed') checks.failed++
    else if (status === 'pending') checks.pending++
    else checks.passed++
    checkRuns.push({
      name: String(c.name || c.context || 'Check'),
      status,
      conclusion: status === 'pending' ? '' : word,
      url: typeof c.detailsUrl === 'string' && c.detailsUrl ? c.detailsUrl : typeof c.targetUrl === 'string' && c.targetUrl ? c.targetUrl : null,
      workflow: typeof c.workflowName === 'string' ? c.workflowName : ''
    })
  }
  const state = String(v.state ?? 'OPEN').toUpperCase()
  return {
    number: v.number,
    title: String(v.title ?? ''),
    url: v.url,
    state: state === 'MERGED' || state === 'CLOSED' ? state : 'OPEN',
    draft: v.isDraft === true,
    mergeState: String(v.mergeStateStatus ?? ''),
    mergeable: String(v.mergeable ?? 'UNKNOWN'),
    baseRef: String(v.baseRefName ?? ''),
    reviewDecision: String(v.reviewDecision ?? ''),
    checks,
    checkRuns: checkRuns.sort(byStatus)
  }
}

/** A branch's workflow runs as `gh run list --json databaseId,name,workflowName,status,conclusion,url` gives them. */
export function runsFromGh(raw: unknown): ReviewCheck[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object')
    .map((r) => {
      const done = String(r.status ?? '').toUpperCase() === 'COMPLETED'
      const word = done ? String(r.conclusion ?? '').toUpperCase() : ''
      const status = done ? checkStatus(word) : 'pending'
      return {
        name: String(r.workflowName || r.name || 'Workflow'),
        status,
        conclusion: status === 'pending' ? '' : word,
        url: typeof r.url === 'string' && r.url ? r.url : null,
        workflow: String(r.workflowName ?? '')
      }
    })
}

/**
 * The GitHub Actions run (and job) behind a check's link:
 * `…/actions/runs/123/job/456` → `{ run: '123', job: '456' }`. Null for
 * another service's link, whose log only its own page has.
 */
export function actionsRunOf(url: string | null): { run: string; job: string | null } | null {
  const m = url ? /\/actions\/runs\/(\d+)(?:\/(?:job|jobs)\/(\d+))?/.exec(url) : null
  return m ? { run: m[1], job: m[2] ?? null } : null
}

/** A failed check's log is cut to its end: where the failure is. */
export const LOG_LINES = 200

/**
 * `gh run view --log-failed` output made readable: each line comes as
 * `job<TAB>step<TAB>timestamp text`; this keeps the text, says each step once
 * as it starts, drops terminal colours, and keeps the last `max` lines.
 */
export function cleanRunLog(raw: string, max = LOG_LINES): { log: string; truncated: boolean } {
  const out: string[] = []
  let step = ''
  // eslint-disable-next-line no-control-regex
  const ansi = /\u001b\[[0-9;]*[A-Za-z]/g
  for (const line of raw.replace(/\r/g, '').split('\n')) {
    const parts = line.split('\t')
    let text = line
    if (parts.length >= 3) {
      const at = `${parts[0]} › ${parts[1]}`
      if (at !== step) {
        step = at
        out.push(`── ${at}`)
      }
      text = parts.slice(2).join('\t')
    }
    out.push(text.replace(/^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/, '').replace(ansi, ''))
  }
  while (out.length && !out[out.length - 1].trim()) out.pop()
  return { log: out.slice(-max).join('\n'), truncated: out.length > max }
}

/** A fence that the text inside can't close early: longer than any run of backticks in it. */
function fence(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length))
  return '`'.repeat(Math.max(3, longest + 1))
}

/** A failed check as a message for the agent: which check, where it ran, and the end of its log. */
export function formatCheckFailure(check: Pick<ReviewCheck, 'name' | 'url' | 'conclusion'>, log: string, truncated = false): string {
  const how = check.conclusion && check.conclusion !== 'FAILURE' ? ` (${check.conclusion.replace(/_/g, ' ').toLowerCase()})` : ''
  const where = check.url ? `\n${check.url}` : ''
  const tick = fence(log)
  const tail = log.trim() ? `\n\n${truncated ? 'The end of its log' : 'Its log'}:\n\n${tick}text\n${log.trimEnd()}\n${tick}` : ''
  return `The CI check "${check.name}" failed${how} on this branch.${where}${tail}\n\nPlease find the cause, fix it, and run the relevant tests before you finish.`
}

/** The message that hands conflicted files to an agent. */
export function formatConflictRequest(files: string[], base: string, merging: ReviewState['merging']): string {
  const what = merging === 'rebase' ? 'A rebase' : merging === 'cherry-pick' ? 'A cherry-pick' : `Merging ${base}`
  const list = files.map((f) => `- ${f}`).join('\n')
  return (
    `${what} left conflicts in ${files.length === 1 ? 'this file' : `these ${files.length} files`}:\n\n${list}\n\n` +
    'Please resolve every conflict marker (<<<<<<<, =======, >>>>>>>), keeping what both sides meant to do, ' +
    'run the relevant tests, then stage each file with git add. Don’t commit or abort the merge; I’ll finish it.'
  )
}

/** One stretch of a conflicted file: text both sides agree on, or a conflict between them. */
export type ConflictSegment =
  | { kind: 'text'; lines: string[] }
  | {
      kind: 'conflict'
      /** What follows the markers: usually HEAD and the branch merged in. */
      oursLabel: string
      theirsLabel: string
      ours: string[]
      /** The common ancestor's lines, with diff3 or zdiff3 conflict style; null otherwise. */
      base: string[] | null
      baseLabel: string
      theirs: string[]
    }

export type ConflictChoice = 'ours' | 'theirs' | 'both'

/**
 * A file with conflict markers in segments, in order. Markers that don't
 * close (a `<<<<<<<` with no `>>>>>>>`) are left as ordinary text: guessing
 * would lose lines.
 */
export function parseConflicts(text: string): ConflictSegment[] {
  const lines = text.split('\n')
  const out: ConflictSegment[] = []
  const pushText = (chunk: string[]): void => {
    if (chunk.length === 0) return
    const last = out[out.length - 1]
    if (last?.kind === 'text') last.lines.push(...chunk)
    else out.push({ kind: 'text', lines: [...chunk] })
  }
  let i = 0
  while (i < lines.length) {
    if (!lines[i].startsWith('<<<<<<<')) {
      pushText([lines[i++]])
      continue
    }
    const start = i
    const block: Extract<ConflictSegment, { kind: 'conflict' }> = { kind: 'conflict', oursLabel: lines[i].slice(7).trim(), theirsLabel: '', ours: [], base: null, baseLabel: '', theirs: [] }
    let part: 'ours' | 'base' | 'theirs' = 'ours'
    let closed = false
    for (i++; i < lines.length; i++) {
      const line = lines[i]
      if (part === 'ours' && line.startsWith('|||||||')) {
        part = 'base'
        block.base = []
        block.baseLabel = line.slice(7).trim()
      } else if (part !== 'theirs' && /^=======\s*$/.test(line)) part = 'theirs'
      else if (part === 'theirs' && line.startsWith('>>>>>>>')) {
        block.theirsLabel = line.slice(7).trim()
        closed = true
        i++
        break
      } else if (part === 'ours' && line.startsWith('<<<<<<<')) break
      else (part === 'base' ? block.base! : block[part]).push(line)
    }
    if (closed) out.push(block)
    else {
      // Not a conflict after all: its first line is text, and the rest is read again.
      pushText([lines[start]])
      i = start + 1
    }
  }
  return out
}

/** How many conflicts a file has. */
export const conflictCount = (segments: ConflictSegment[]): number => segments.filter((s) => s.kind === 'conflict').length

/**
 * The file again, with each conflict the user chose for replaced by that
 * side (or both, ours first) and the others left with their markers.
 * `choices[n]` is for the n-th conflict.
 */
export function resolveConflicts(segments: ConflictSegment[], choices: (ConflictChoice | undefined)[]): string {
  const lines: string[] = []
  let n = 0
  for (const seg of segments) {
    if (seg.kind === 'text') {
      lines.push(...seg.lines)
      continue
    }
    const choice = choices[n++]
    if (choice === 'ours') lines.push(...seg.ours)
    else if (choice === 'theirs') lines.push(...seg.theirs)
    else if (choice === 'both') lines.push(...seg.ours, ...seg.theirs)
    else {
      lines.push(`<<<<<<< ${seg.oursLabel}`.trimEnd(), ...seg.ours)
      if (seg.base) lines.push(`||||||| ${seg.baseLabel}`.trimEnd(), ...seg.base)
      lines.push('=======', ...seg.theirs, `>>>>>>> ${seg.theirsLabel}`.trimEnd())
    }
  }
  return lines.join('\n')
}

/** Whether text still has a conflict in it. */
export const hasConflictMarkers = (text: string): boolean => conflictCount(parseConflicts(text)) > 0

/**
 * A pull request's title and description from the branch's commits, oldest
 * first: one commit gives its subject as the title, more give the branch's
 * name in words; the description lists every subject.
 */
export function pullRequestFromCommits(subjects: string[], branch: string | null): { title: string; body: string } {
  const list = subjects.map((s) => s.trim()).filter(Boolean)
  const name = (branch ?? '').split('/').pop() ?? ''
  const words = name.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
  const fromBranch = words ? words[0].toUpperCase() + words.slice(1) : ''
  const title = list.length === 1 ? list[0] : fromBranch || list[0] || ''
  return { title, body: list.length > 1 ? list.map((s) => `- ${s}`).join('\n') : '' }
}
