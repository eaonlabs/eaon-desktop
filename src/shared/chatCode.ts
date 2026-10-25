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
