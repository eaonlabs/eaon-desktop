import type { AdeChanges } from './adeSessions'
import type { PullRequestInfo, ReviewFile } from './adeReview'

/**
 * Chat's coding controls, the parts main does for them: where the chat's
 * folder stands in git (its branch, how far it is from its upstream, what is
 * uncommitted), switching and making branches, the editors on this computer
 * to open it in, finding text across the project, the project's files for
 * the composer's @ menu, and the project's own scripts.
 */

export interface ChatGitStatus {
  /** The folder is inside a git repository. */
  repo: boolean
  /** The branch checked out; null outside git or when HEAD is detached. */
  branch: string | null
  /** The commit HEAD is on, short, when no branch is checked out. */
  detached: string | null
  /** The branch it pushes to and pulls from (`origin/main`), when it has one. */
  upstream: string | null
  /** Commits here that the upstream doesn't have, and the other way round. */
  ahead: number
  behind: number
  /** Whether the repository has an `origin` to push to. */
  remote: boolean
  /** What is uncommitted: lines added and removed, files touched. */
  changes: AdeChanges | null
}

export interface ChatBranch {
  name: string
  /** When its last commit was made, in ms. */
  at: number
  /** Only on origin: switching to it makes a local branch that tracks it. */
  remoteOnly?: boolean
}

export interface ChatBranches {
  current: string | null
  branches: ChatBranch[]
}

export type ChatGitResult = { ok: true; message?: string } | { ok: false; error: string }

/** Everything not committed, new files included, as git's diff against HEAD. */
export type ChatDiffResult = { ok: true; files: ReviewFile[] } | { ok: false; error: string }

/** The branch's pull request on GitHub, or why GitHub can't be asked. */
export type ChatPullRequest = { ok: true; pr: PullRequestInfo | null } | { ok: false; problem: string }

export type OpenTargetKind = 'editor' | 'files' | 'terminal'

/** An app the chat's folder (or a file in it) can be opened in. */
export interface OpenTarget {
  id: string
  label: string
  kind: OpenTargetKind
  /** The app's own icon as a data URL, where the system gives one (macOS). */
  icon?: string
}

export interface SearchOptions {
  /** Match case exactly. */
  caseSensitive?: boolean
  /** The query is a regular expression. */
  regex?: boolean
  /** Whole words only. */
  word?: boolean
}

export interface SearchMatch {
  /** Relative to the folder searched. */
  path: string
  line: number
  text: string
}

export interface SearchResult {
  matches: SearchMatch[]
  /** Stopped at the cap: there are more. */
  truncated: boolean
  error?: string
}

/** A command saved for a project, run from the chat's header in its terminal. */
export interface ProjectScript {
  id: string
  name: string
  command: string
  icon: ScriptIcon
}

export type ScriptIcon = 'play' | 'test' | 'build' | 'lint' | 'debug' | 'terminal'

/** A script the project itself defines (package.json, a Makefile), offered when adding one. */
export interface ScriptSuggestion {
  name: string
  command: string
  icon: ScriptIcon
}

/** At most this many matches come back from one search. */
export const SEARCH_CAP = 500
/** At most this many files are listed for the @ menu. */
export const FILES_CAP = 20_000

/** A script's icon from what it does, by name: "test", "build", "lint"… */
export function scriptIcon(name: string): ScriptIcon {
  const n = name.toLowerCase()
  if (/lint|format|prettier|fmt|typecheck/.test(n)) return 'lint'
  if (/test|spec|e2e|check/.test(n)) return 'test'
  if (/build|compile|bundle|dist|package/.test(n)) return 'build'
  if (/debug|inspect/.test(n)) return 'debug'
  if (/dev|start|serve|run|watch|preview/.test(n)) return 'play'
  return 'terminal'
}

/** The package manager a project uses, from its lockfile. */
export function packageRunner(files: string[]): 'npm' | 'pnpm' | 'yarn' | 'bun' {
  if (files.includes('bun.lockb') || files.includes('bun.lock')) return 'bun'
  if (files.includes('pnpm-lock.yaml')) return 'pnpm'
  if (files.includes('yarn.lock')) return 'yarn'
  return 'npm'
}

/** The scripts in a package.json's text, as commands for `runner`; none when it can't be read. */
export function packageScripts(json: string, runner: ReturnType<typeof packageRunner>): ScriptSuggestion[] {
  let scripts: unknown
  try {
    scripts = (JSON.parse(json) as { scripts?: unknown }).scripts
  } catch {
    return []
  }
  if (!scripts || typeof scripts !== 'object') return []
  return Object.keys(scripts as Record<string, unknown>)
    .filter((name) => !/^(pre|post)/.test(name) || !(name.replace(/^(pre|post)/, '') in (scripts as object)))
    .slice(0, 40)
    .map((name) => ({ name, command: runner === 'npm' ? `npm run ${name}` : `${runner} ${name}`, icon: scriptIcon(name) }))
}

/** A Makefile's targets, as `make <target>`. */
export function makeTargets(text: string): ScriptSuggestion[] {
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z0-9][\w.-]*)\s*:(?!=)/.exec(line)
    if (m && !m[1].startsWith('.')) seen.add(m[1])
  }
  return [...seen].slice(0, 30).map((name) => ({ name, command: `make ${name}`, icon: scriptIcon(name) }))
}

/**
 * `git grep -n` output (`path\0line\0text`, one match a line) as matches.
 * Lines are cut at 400 characters: a minified file's one line is the file.
 */
export function parseGrep(out: string, cap = SEARCH_CAP): SearchResult {
  const matches: SearchMatch[] = []
  for (const row of out.split('\n')) {
    if (!row) continue
    const [path, line, ...rest] = row.split('\0')
    const n = Number(line)
    if (!path || !Number.isFinite(n)) continue
    if (matches.length >= cap) return { matches, truncated: true }
    matches.push({ path, line: n, text: rest.join('\0').slice(0, 400) })
  }
  return { matches, truncated: false }
}

/** `git for-each-ref` rows (`name\tunix time`) as branches, newest first, origin's own HEAD left out. */
export function parseBranches(local: string, remote: string): ChatBranch[] {
  const rows = (text: string): { name: string; at: number }[] =>
    text
      .split('\n')
      .map((row) => row.split('\t'))
      .filter(([name]) => Boolean(name))
      .map(([name, at]) => ({ name, at: (Number(at) || 0) * 1000 }))
  const mine = rows(local)
  const names = new Set(mine.map((b) => b.name))
  const theirs = rows(remote)
    .filter((b) => b.name.startsWith('origin/') && b.name !== 'origin/HEAD' && b.name !== 'origin')
    .map((b) => ({ ...b, name: b.name.slice('origin/'.length), remoteOnly: true as const }))
    .filter((b) => !names.has(b.name))
  return [...mine, ...theirs].sort((a, b) => b.at - a.at)
}

/* ---------------------------------------------------------------- checkpoints */

/** Where a coding chat's checkpoints live in its repository (main/features/chatCheckpoints.ts). */
export const CHECKPOINT_REF_ROOT = 'refs/eaon/checkpoints'

/** A reply's checkpoint ref: its folder before the reply started, or after it ended. */
export const checkpointRef = (replyId: string, side: 'before' | 'after'): string =>
  `${CHECKPOINT_REF_ROOT}/${replyId.replace(/[^\w-]/g, '_')}/${side}`

/** What a reply changed in its folder, read from its checkpoints. */
export interface TurnChanges {
  /** Whether there is something to undo: a repository, both checkpoints, and a difference between them. */
  available: boolean
  reason?: 'not-git' | 'no-checkpoint'
  /** Paths from the top of the repository. */
  files: string[]
}

/**
 * What replies changed on disk by their checkpoints, however the change was
 * made: an edit tool, a patch, a shell command, a script the agent ran.
 */
export interface CheckpointDiff {
  /** The replies these files are from: checkpoints on both sides (the running reply's compared with now). */
  covered: string[]
  /** Of those, the ones that changed something. */
  changed: string[]
  /** A file each, by full path; one changed and put back again isn't here. Hunks only when the patch was asked for. */
  files: ReviewFile[]
}

/** `git diff --raw --numstat -z` output as files with their status and line counts (renames are off). Hunks are left empty. */
export function parseRawNumstat(out: string): ReviewFile[] {
  const tokens = out.split('\0')
  const status = new Map<string, ReviewFile['status']>()
  const files: ReviewFile[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.startsWith(':')) {
      const letter = token.trim().slice(-1)
      const path = tokens[++i]
      if (path) status.set(path, letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified')
      continue
    }
    const row = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(token)
    if (!row) continue
    const binary = row[1] === '-'
    const path = row[3]
    files.push({ path, oldPath: null, status: status.get(path) ?? 'modified', added: binary ? 0 : Number(row[1]), removed: binary ? 0 : Number(row[2]), binary, hunks: [] })
  }
  return files
}

/** How an undo, redo or rewind went. `conflicts`: files changed since, left alone until confirmed. */
export type TurnRestore = { ok: true; files: string[] } | { ok: false; error?: string; conflicts?: string[] }

/** `git diff --name-status -z` output as paths with their status letter (renames are off, so one path each). */
export function parseNameStatus(out: string): { path: string; status: string }[] {
  const parts = out.split('\0')
  const rows: { path: string; status: string }[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i].trim()
    const path = parts[i + 1]
    if (status && path) rows.push({ path, status: status[0] })
  }
  return rows
}

/* ---------------------------------------------------------------- commits */

/** A recent commit on the folder's branch, for the Changes pane's scope menu. */
export interface ChatCommit {
  sha: string
  short: string
  subject: string
  /** Committed at, in ms. */
  at: number
  author: string
  /** Not on the upstream branch yet. False when there is no upstream to compare with. */
  local: boolean
}

export type ChatCommits = { ok: true; commits: ChatCommit[] } | { ok: false; error: string }

/** How many commits the scope menu offers. */
export const COMMITS_SHOWN = 10

/** `git log --format=%H%x00%h%x00%s%x00%ct%x00%an` rows as commits; `ahead` holds the shas not pushed. */
export function parseCommits(out: string, ahead: Set<string>): ChatCommit[] {
  const commits: ChatCommit[] = []
  for (const row of out.split('\n')) {
    const [sha, short, subject, at, author] = row.split('\0')
    if (!sha || !short) continue
    commits.push({ sha, short, subject: subject ?? '', at: (Number(at) || 0) * 1000, author: author ?? '', local: ahead.has(sha) })
  }
  return commits
}

/* ---------------------------------------------------------------- processes */

/** A process the agent started in the background in a chat's folder (a dev server, a watcher). */
export interface ChatProcess {
  pid: number
  command: string
  startedAt: number
  /** The first local address it printed, for opening it in the browser. */
  url: string | null
}

/** The first local web address in a process's output: a dev server's "Local: http://localhost:5173/". */
export function localUrl(output: string): string | null {
  const match = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[\w-]+\.localhost)(?::\d{2,5})?(?:\/[^\s'"<>)\]]*)?/i.exec(output.replace(/\x1b\[[0-9;]*m/g, ''))
  if (!match) return null
  return match[0].replace('0.0.0.0', 'localhost').replace(/[.,;]+$/, '')
}

/** A command's first words, as a row's name: `npm run dev`, `node -e`, `PORT=3000 pnpm dev` → `pnpm dev`. */
export function processName(command: string): string {
  const first = command.trim().split(/\s*(?:&&|\|\||;|\|)\s*/).find((part) => !/^cd\s/.test(part)) ?? command
  const words = first.split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w))
  const kept: string[] = []
  for (const word of words) {
    if (/^['"`]/.test(word) || kept.length === 3) break
    kept.push(word.includes('/') && kept.length === 0 ? word.split('/').pop()! : word)
  }
  return kept.join(' ') || command.slice(0, 24)
}

/* ---------------------------------------------------------------- the editor's git marks */

/** How git sees a file, for the editor's tree: changed, new, not tracked yet, gone, or in conflict. */
export type FileGitState = 'modified' | 'added' | 'untracked' | 'deleted' | 'conflict'

/**
 * `git status --porcelain=v1 -z` as each path's state, paths from the top of
 * the repository. A rename counts as its new path, added.
 */
export function parsePorcelain(out: string): Record<string, FileGitState> {
  const states: Record<string, FileGitState> = {}
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    const x = entry[0]
    const y = entry[1]
    const path = entry.slice(3)
    // A rename or copy is followed by the path it came from.
    if (x === 'R' || x === 'C') i++
    const code = `${x}${y}`
    states[path] =
      code === '??'
        ? 'untracked'
        : x === 'U' || y === 'U' || code === 'AA' || code === 'DD'
          ? 'conflict'
          : x === 'D' || y === 'D'
            ? 'deleted'
            : x === 'A' || x === 'R' || x === 'C'
              ? 'added'
              : 'modified'
  }
  return states
}

