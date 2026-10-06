import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  branchForTitle,
  branchNameProblem,
  folderName,
  worktreeFolderFor,
  type AdeSession,
  type NewSessionRequest,
  type NewSessionResult,
  type RemoveSessionOptions
} from '@shared/adeSessions'
import * as git from './git'

/**
 * The ADE's sessions, kept in `ade-sessions.json`. See `shared/adeSessions.ts`
 * for what a session is.
 */

export interface SavedSessions {
  sessions: AdeSession[]
  /** The folders that had terminals before sessions existed have been made sessions (once). */
  adopted?: boolean
}

export interface SessionBookDeps {
  load: () => unknown
  save: (value: SavedSessions) => void
  now: () => number
  /** Where new sessions' worktrees go, as `<root>/<project>/<branch>`. */
  worktreesRoot: () => string
}

const isDir = (dir: string): boolean => {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

/** A saved session, repaired; null for anything that isn't one. */
function normalize(raw: unknown): AdeSession | null {
  const v = raw as Partial<AdeSession> | null
  if (!v || typeof v !== 'object') return null
  const id = str(v.id)
  const cwd = str(v.cwd)
  if (!id || !cwd) return null
  return {
    id,
    title: str(v.title),
    project: str(v.project) ?? cwd,
    cwd,
    branch: str(v.branch),
    // Saved before this was recorded: a branch or a worktree means a repository.
    repo: v.repo === true || Boolean(str(v.branch)) || v.worktree === true,
    worktree: v.worktree === true,
    createdAt: typeof v.createdAt === 'number' && Number.isFinite(v.createdAt) ? v.createdAt : 0,
    ...(v.imported === true ? { imported: true } : {})
  }
}

export class SessionBook {
  private sessions: AdeSession[] = []
  private adoptedOnce = false

  constructor(private readonly deps: SessionBookDeps) {
    const raw = deps.load() as Partial<SavedSessions> | null
    const seenIds = new Set<string>()
    const seenDirs = new Set<string>()
    for (const entry of Array.isArray(raw?.sessions) ? raw.sessions : []) {
      const session = normalize(entry)
      // One session per folder: the grid of terminals is kept per folder.
      if (!session || seenIds.has(session.id) || seenDirs.has(path.resolve(session.cwd))) continue
      seenIds.add(session.id)
      seenDirs.add(path.resolve(session.cwd))
      this.sessions.push(session)
    }
    this.adoptedOnce = raw?.adopted === true
  }

  get adopted(): boolean {
    return this.adoptedOnce
  }

  list(): AdeSession[] {
    return this.sessions.map((s) => ({ ...s }))
  }

  get(id: string): AdeSession | null {
    const found = this.sessions.find((s) => s.id === id)
    return found ? { ...found } : null
  }

  byCwd(cwd: string): AdeSession | null {
    const want = path.resolve(cwd)
    const found = this.sessions.find((s) => path.resolve(s.cwd) === want)
    return found ? { ...found } : null
  }

  private commit(): void {
    this.deps.save({ sessions: this.sessions.map(({ missing: _missing, ...rest }) => rest), adopted: this.adoptedOnce })
  }

  /** Looks again at each session's folder: whether it is there, whether it is in git now, and on which branch. */
  async refresh(): Promise<AdeSession[]> {
    let changed = false
    await Promise.all(
      this.sessions.map(async (session) => {
        const missing = !isDir(session.cwd)
        if (Boolean(session.missing) !== missing) {
          if (missing) session.missing = true
          else delete session.missing
        }
        if (missing) return
        const info = await git.repoInfo(session.cwd)
        const branch = info?.branch ?? null
        if (branch !== session.branch || Boolean(info) !== session.repo) {
          session.branch = branch
          session.repo = Boolean(info)
          changed = true
        }
      })
    )
    if (changed) this.commit()
    return this.list()
  }

  /**
   * The session for a folder, made when it has none. Its project is the
   * repository's main folder, so a worktree made by another tool is filed
   * with the repository it belongs to.
   */
  async ensureFolder(folder: string, imported?: { at: number }): Promise<AdeSession> {
    const cwd = path.resolve(folder)
    const have = this.byCwd(cwd)
    if (have) return have
    const repo = await git.repoInfo(cwd)
    const session: AdeSession = {
      id: `ses-${randomUUID()}`,
      title: null,
      project: repo ? repo.root : cwd,
      cwd,
      branch: repo?.branch ?? null,
      repo: Boolean(repo),
      worktree: false,
      // An imported folder sorts by when its conversations were last used, not by when it was imported.
      createdAt: imported?.at ?? this.deps.now(),
      ...(imported ? { imported: true } : {})
    }
    this.sessions.push(session)
    this.commit()
    return { ...session }
  }

  /**
   * Before sessions, the ADE kept terminals per folder. Each folder that had
   * any becomes a session the first time, so nothing that was open is lost.
   */
  async adopt(folders: string[]): Promise<void> {
    if (this.adoptedOnce) return
    for (const folder of folders) if (isDir(folder)) await this.ensureFolder(folder)
    this.adoptedOnce = true
    this.commit()
  }

  /** A new session on a branch of its own, checked out in a new worktree. */
  async create(req: NewSessionRequest): Promise<NewSessionResult> {
    const title = req.title.trim()
    if (!title) return { ok: false, error: 'Give the session a name.' }
    const project = path.resolve(req.project)
    if (!isDir(project)) return { ok: false, error: `${folderName(project)} isn’t there any more.` }
    const repo = await git.repoInfo(project)
    if (!repo) {
      return {
        ok: false,
        error: `${folderName(project)} isn’t a git repository, so a session there can’t have a branch of its own. Its agents run in the folder itself.`
      }
    }

    const asked = req.branch?.trim()
    let branch = asked || branchForTitle(title)
    const problem = branchNameProblem(branch)
    if (problem) return { ok: false, error: problem }
    try {
      branch = await git.checkBranchName(repo.root, branch)
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
    if (await git.branchExists(repo.root, branch)) {
      // A branch the user named is theirs to rename; one made from the title just gets a number.
      if (asked) return { ok: false, error: `There’s already a branch called ${branch}. Pick another name.` }
      branch = await this.freeBranch(repo.root, branch)
    }

    const dir = this.freeDir(path.join(this.deps.worktreesRoot(), worktreeFolderFor(folderName(repo.root)), worktreeFolderFor(branch)))
    try {
      fs.mkdirSync(path.dirname(dir), { recursive: true })
      await git.addWorktree(repo.root, dir, branch)
    } catch (error) {
      return { ok: false, error: `Git couldn’t make the worktree: ${(error as Error).message}` }
    }
    const session: AdeSession = {
      id: `ses-${randomUUID()}`,
      title,
      project: repo.root,
      cwd: dir,
      branch,
      repo: true,
      worktree: true,
      createdAt: this.deps.now()
    }
    this.sessions.push(session)
    this.commit()
    return { ok: true, session: { ...session } }
  }

  private async freeBranch(root: string, branch: string): Promise<string> {
    for (let n = 2; n < 100; n++) {
      const next = `${branch}-${n}`
      if (!(await git.branchExists(root, next))) return next
    }
    return `${branch}-${Date.now().toString(36)}`
  }

  private freeDir(dir: string): string {
    if (!fs.existsSync(dir)) return dir
    for (let n = 2; n < 100; n++) if (!fs.existsSync(`${dir}-${n}`)) return `${dir}-${n}`
    return `${dir}-${Date.now().toString(36)}`
  }

  /**
   * Takes a session off the list. Its worktree goes too only when asked, and
   * never forced: git refuses to remove one with uncommitted changes, and then
   * the session stays and the user is told why. The branch always stays.
   */
  async remove(id: string, options: RemoveSessionOptions): Promise<{ ok: true } | { ok: false; error: string }> {
    const session = this.sessions.find((s) => s.id === id)
    if (!session) return { ok: true }
    if (session.worktree && options.deleteWorktree && isDir(session.cwd)) {
      try {
        await git.removeWorktree(session.project, session.cwd)
      } catch (error) {
        return { ok: false, error: `Git kept the worktree: ${(error as Error).message}` }
      }
    }
    this.sessions = this.sessions.filter((s) => s.id !== id)
    this.commit()
    return { ok: true }
  }

  rename(id: string, title: string): AdeSession | null {
    const session = this.sessions.find((s) => s.id === id)
    if (!session) return null
    session.title = title.trim() || null
    this.commit()
    return { ...session }
  }

  /** Sessions for the folders Import found conversations in (with when each was last used); returns the ones made. */
  async importFolders(folders: { cwd: string; at: number }[]): Promise<AdeSession[]> {
    const made: AdeSession[] = []
    for (const { cwd, at } of folders) {
      if (!isDir(cwd) || this.byCwd(cwd)) continue
      made.push(await this.ensureFolder(cwd, { at }))
    }
    return made
  }
}
