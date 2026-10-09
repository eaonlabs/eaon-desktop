/**
 * ADE sessions: a piece of work in a project, in a folder of its own.
 *
 * A session is a folder its agents run in. In a git repository a new session
 * gets its own branch, checked out in its own worktree, so agents working on
 * two things never edit the same files; the project folder itself is a
 * session too (whatever branch it is on). Outside git a folder has one
 * session, the folder.
 *
 * Its agents are the terminal panes open in that folder (the ADE's grid is
 * kept per folder) and the Claude Code and Codex conversations filed for it,
 * which can be reopened. Sessions are grouped in the sidebar by project: the
 * repository's main folder.
 */

/** The agent CLIs whose past conversations the ADE can list and reopen. */
export type ConversationAgent = 'claude' | 'codex'

export interface AdeSession {
  id: string
  /** What the user called it; null names it after its branch (or folder). */
  title: string | null
  /** The project it is filed under: the repository's main folder, or the folder itself outside git. */
  project: string
  /** Where its agents run: a worktree made for it, or the project folder itself. */
  cwd: string
  /** The branch checked out in `cwd` when last looked at; null outside git or on a detached HEAD. */
  branch: string | null
  /** `cwd` is in a git repository (it can be on no branch, so `branch` doesn't say). */
  repo: boolean
  /** Eaon made `cwd` as a git worktree for this session (removing the session can remove it). */
  worktree: boolean
  createdAt: number
  /** Brought in from Claude Code or Codex (Settings → ADE). */
  imported?: boolean
  /** `cwd` was not there when last looked at (deleted or on a disk that isn't mounted). */
  missing?: boolean
}

/** A Claude Code or Codex conversation filed on this computer. */
export interface AdeConversation {
  agent: ConversationAgent
  id: string
  /** The folder it ran in. */
  cwd: string
  /** Its title: the agent's own, else the first thing asked. */
  title: string
  born: number
  touched: number
}

/** A folder Import found conversations for, before anything is imported. */
export interface AdeImportCandidate {
  cwd: string
  /** The project it would be filed under. */
  project: string
  branch: string | null
  /** Newest first. */
  conversations: AdeConversation[]
  /** A session for this folder is already in the ADE. */
  already: boolean
}

export interface NewSessionRequest {
  /** The project folder (a repository's main folder, or any folder). */
  project: string
  title: string
  /** The branch to make; from the title when left out. */
  branch?: string
}

export type NewSessionResult = { ok: true; session: AdeSession } | { ok: false; error: string }

/** What happens to a session's worktree when the session is removed. */
export interface RemoveSessionOptions {
  /** Remove the worktree folder too (git refuses when it has uncommitted changes). */
  deleteWorktree: boolean
}

/** Resuming a conversation in a new pane. */
export interface ResumeRequest {
  agent: ConversationAgent
  id: string
}

/* ------------------------------------------------------------------ helpers */

export const folderName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/** A path under the home folder written from ~, for reading. */
export function homeRelative(path: string, home: string | null | undefined): string {
  if (!home) return path
  const h = home.replace(/[\\/]+$/, '')
  return path === h ? '~' : path.startsWith(`${h}/`) || path.startsWith(`${h}\\`) ? `~${path.slice(h.length)}` : path
}

/** The last part of a branch name: `feature/checkout-baseline` → `checkout-baseline`. */
export const branchLeaf = (branch: string): string => branch.split('/').filter(Boolean).pop() ?? branch

/**
 * What a session is called in the sidebar: its title; else, for a worktree,
 * its branch's last part (`feature/checkout-baseline` → `checkout-baseline`);
 * else its folder's name (the project folder itself goes by the project's).
 */
export function sessionTitle(session: Pick<AdeSession, 'title' | 'branch' | 'cwd' | 'project'>): string {
  if (session.title?.trim()) return session.title.trim()
  if (session.branch && session.cwd !== session.project) return branchLeaf(session.branch)
  return folderName(session.cwd)
}

/**
 * The line under a session's title: its branch, and "project folder" for the
 * project's own. A checkout on no branch (a pull request being reviewed) says
 * so, by its folder's name rather than its whole path.
 */
export function sessionSubtitle(session: Pick<AdeSession, 'branch' | 'cwd' | 'project' | 'missing'>): string {
  if (session.missing) return 'Folder not found'
  if (session.cwd === session.project) return [session.branch, 'project folder'].filter(Boolean).join(' · ')
  return session.branch ?? `${folderName(session.cwd)} · no branch`
}

/**
 * A branch name for a session's title. "Fix …" and "Bug …" titles get `fix/`,
 * anything else `feature/`; the rest is lower-case words joined by dashes,
 * short enough to read in a sidebar.
 */
export function branchForTitle(title: string): string {
  const words = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  const fix = words[0] === 'fix' || words[0] === 'bug' || words[0] === 'bugfix' || words[0] === 'hotfix'
  const rest = (fix ? words.slice(1) : words).join('-')
  let slug = rest.length > 48 ? rest.slice(0, 48).replace(/-[^-]*$/, '') || rest.slice(0, 48) : rest
  slug = slug.replace(/^-+|-+$/g, '')
  return `${fix ? 'fix' : 'feature'}/${slug || 'session'}`
}

/**
 * Whether git would take `name` as a branch name — the rules of
 * `git check-ref-format --branch`, which main also asks git itself.
 */
export function branchNameProblem(name: string): string | null {
  const n = name.trim()
  if (!n) return 'Give the branch a name.'
  if (/\s/.test(n)) return 'A branch name can’t have spaces.'
  if (/[~^:?*[\\\x00-\x1f\x7f]/.test(n)) return 'A branch name can’t have ~ ^ : ? * [ or \\ in it.'
  if (n.includes('..') || n.includes('@{') || n.includes('//')) return 'A branch name can’t have “..”, “@{” or “//” in it.'
  if (n.startsWith('/') || n.endsWith('/') || n.startsWith('-') || n.endsWith('.') || n === '@') return 'That isn’t a branch name git accepts.'
  if (n.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))) return 'No part of a branch name can start with “.” or end with “.lock”.'
  return null
}

/** A folder name for a branch's worktree: `feature/checkout-baseline` → `checkout-baseline`. */
export function worktreeFolderFor(branch: string): string {
  return branchLeaf(branch).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '') || 'session'
}

/**
 * A terminal's title as a description of what its agent is doing, or null when
 * it says nothing useful. Claude Code titles its terminal with the task at
 * hand behind a spinner glyph ("✳ Fix checks detail link"); a shell titles it
 * with its own name or the folder, which says nothing a pane's logo doesn't.
 */
export function taskFromTerminalTitle(raw: string | null | undefined): string | null {
  if (!raw) return null
  const text = raw
    .replace(/[\x00-\x1f\x7f]/g, '')
    // Spinner and status glyphs in front: braille dots, stars, bullets, arrows,
    // emoji. Not ~ or /, which start a path (the shell naming its folder).
    .replace(/^[^\p{L}\p{N}"'“‘(\[~/]+/u, '')
    .trim()
  if (!text) return null
  const lower = text.toLowerCase()
  if (GENERIC_TITLES.has(lower)) return null
  // A path, a user@host prompt or a bare command line is the shell talking.
  if (/^[~/]/.test(text) || /^[\w.-]+@[\w.-]+[: ]/.test(text) || /^[\w.-]+:\s*[~/]/.test(text)) return null
  return text.length > 120 ? `${text.slice(0, 119)}…` : text
}

const GENERIC_TITLES = new Set([
  'claude',
  'claude code',
  'codex',
  'openai codex',
  'opencode',
  'antigravity',
  'agy',
  'eaon code',
  'eaon-code',
  'zsh',
  'bash',
  'fish',
  'sh',
  'pwsh',
  'powershell',
  'cmd',
  'shell',
  'terminal',
  'node'
])

/** How long ago, as short as the sidebar's right edge allows: now, 5m, 6h, 3d, 2w, 4mo, 1y. */
export function ageLabel(at: number, now: number): string {
  const s = Math.max(0, now - at) / 1000
  if (s < 60) return 'now'
  const m = s / 60
  if (m < 60) return `${Math.floor(m)}m`
  const h = m / 60
  if (h < 24) return `${Math.floor(h)}h`
  const d = h / 24
  if (d < 7) return `${Math.floor(d)}d`
  if (d < 35) return `${Math.floor(d / 7)}w`
  if (d < 365) return `${Math.floor(d / 30)}mo`
  return `${Math.floor(d / 365)}y`
}

export interface ProjectGroup {
  project: string
  sessions: AdeSession[]
}

/**
 * Sessions grouped by project for the sidebar: the projects opened recently
 * first, in that order, then the rest (imported ones) newest first. Within a
 * project the project folder's own session leads, then the others newest
 * first — an order that doesn't move while agents work.
 */
export function groupSessions(sessions: AdeSession[], recentProjects: string[]): ProjectGroup[] {
  const byProject = new Map<string, AdeSession[]>()
  for (const session of sessions) {
    const list = byProject.get(session.project) ?? []
    list.push(session)
    byProject.set(session.project, list)
  }
  for (const list of byProject.values()) {
    list.sort((a, b) => Number(b.cwd === b.project) - Number(a.cwd === a.project) || b.createdAt - a.createdAt)
  }
  const newest = (list: AdeSession[]): number => Math.max(...list.map((s) => s.createdAt))
  const recentIndex = new Map(recentProjects.map((p, i) => [p, i]))
  return [...byProject.entries()]
    .sort(([a, la], [b, lb]) => {
      const ra = recentIndex.get(a)
      const rb = recentIndex.get(b)
      if (ra !== undefined || rb !== undefined) return (ra ?? Infinity) - (rb ?? Infinity)
      return newest(lb) - newest(la)
    })
    .map(([project, list]) => ({ project, sessions: list }))
}

/**
 * The sidebar's projects in an order that stays put while it is on screen:
 * the ones already shown keep their places, and a project that wasn't shown
 * yet goes first. Opening a session makes its project a recent one, and
 * re-sorting by that moved the list under the pointer, so the next click
 * landed on a different project.
 */
export function keepOrder(groups: ProjectGroup[], shown: readonly string[]): ProjectGroup[] {
  const place = new Map(shown.map((project, i) => [project, i]))
  const fresh = groups.filter((g) => !place.has(g.project))
  const known = groups.filter((g) => place.has(g.project)).sort((a, b) => place.get(a.project)! - place.get(b.project)!)
  return [...fresh, ...known]
}

/** A project that is just its own folder: shown as one row, not a heading over a row repeating it. */
export const isSoloProject = (group: ProjectGroup): boolean => group.sessions.length === 1 && group.sessions[0].cwd === group.project
