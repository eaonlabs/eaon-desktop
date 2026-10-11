import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
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
import { isRemote } from '@shared/adeRemote'

/**
 * The ADE's sessions, kept in `ade-sessions.json`. See `shared/adeSessions.ts`
 * for what a session is.
 */

export interface SavedSessions {
  sessions: AdeSession[]
  /** The folders that had terminals before sessions existed have been made sessions (once). */
  adopted?: boolean
  /** Folders whose session the user removed: Import leaves them out until one is opened again on purpose. */
  closed?: string[]
}

export interface SessionBookDeps {
  load: () => unknown
  save: (value: SavedSessions) => void
  now: () => number
  /** Where new sessions' worktrees go, as `<root>/<project>/<branch>`. */
  worktreesRoot: () => string
  /** The home folder, whose own repository (if it is one) never makes a project of the folders in it. */
  home?: () => string
  /** The repository a session on an SSH host is in, asked over SSH; null when it isn't in one or the host can't be reached. */
  remoteRepo?: (cwd: string) => Promise<{ branch: string | null; repo: boolean } | null>
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
    ...(v.imported === true ? { imported: true } : {}),
    ...(str(v.host) ? { host: str(v.host) as string } : {})
  }
}

export class SessionBook {
  private sessions: AdeSession[] = []
  private adoptedOnce = false
  private closed = new Set<string>()

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
    for (const dir of Array.isArray(raw?.closed) ? raw.closed : []) if (str(dir)) this.closed.add(path.resolve(dir))
  }

  private repo(dir: string): Promise<git.RepoInfo | null> {
    return git.projectRepo(dir, (this.deps.home ?? os.homedir)())
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

  /** Whether the user removed this folder's session, so Import must not bring it back. */
  isClosed(cwd: string): boolean {
    return this.closed.has(path.resolve(cwd))
  }

  private commit(): void {
    this.deps.save({
      sessions: this.sessions.map(({ missing: _missing, ...rest }) => rest),
      adopted: this.adoptedOnce,
      ...(this.closed.size > 0 ? { closed: [...this.closed] } : {})
    })
  }

  /** Looks again at each session's folder: whether it is there, whether it is in git now, and on which branch. */
  async refresh(): Promise<AdeSession[]> {
    let changed = false
    await Promise.all(
      this.sessions.map(async (session) => {
        // On another machine: its branch is asked over SSH, and a host that can't be reached right now isn't "gone".
        if (isRemote(session.cwd)) {
          const info = await this.deps.remoteRepo?.(session.cwd).catch(() => null)
          if (info && (info.branch !== session.branch || info.repo !== session.repo)) {
            session.branch = info.branch
            session.repo = info.repo
            changed = true
          }
          return
        }
        const missing = !isDir(session.cwd)
        if (Boolean(session.missing) !== missing) {
          if (missing) session.missing = true
          else delete session.missing
        }
        if (missing) return
        const info = await this.repo(session.cwd)
        const branch = info?.branch ?? null
        // A session in the project folder itself follows the repository it's in now (filed
        // under a home-folder repository before, or a folder that has since become a repository).
        const project = session.worktree ? session.project : (info?.root ?? session.cwd)
        if (branch !== session.branch || Boolean(info) !== session.repo || project !== session.project) {
          session.branch = branch
          session.repo = Boolean(info)
          session.project = project
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
    // Opened again on purpose (the picker, a recent folder): it is no longer closed.
    if (!imported) this.closed.delete(cwd)
    const repo = await this.repo(cwd)
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
    const repo = await this.repo(project)
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
    // Claude Code and Codex keep its conversations, so Import would otherwise bring it straight back.
    this.closed.add(path.resolve(session.cwd))
    this.commit()
    return { ok: true }
  }

  /**
   * A folder Eaon set up for a session itself (a pull request's worktree,
   * a Linear issue's branch): its session, made or renamed, filed under its
   * repository. `worktree` lets removing the session remove the folder too.
   */
  async track(folder: string, title: string, worktree: boolean): Promise<AdeSession> {
    const cwd = path.resolve(folder)
    this.closed.delete(cwd)
    const made = await this.ensureFolder(cwd)
    const session = this.sessions.find((s) => s.id === made.id)!
    session.title = title.trim() || null
    if (worktree) session.worktree = true
    this.commit()
    return { ...session }
  }

  rename(id: string, title: string): AdeSession | null {
    const session = this.sessions.find((s) => s.id === id)
    if (!session) return null
    session.title = title.trim() || null
    this.commit()
    return { ...session }
  }

  /** A session in a folder on an SSH host (checked and resolved by the caller); the one there already if it has one. */
  addRemote(fields: { cwd: string; host: string; title: string | null; branch: string | null; repo: boolean }): AdeSession {
    const have = this.byCwd(fields.cwd)
    if (have) return have
    this.closed.delete(path.resolve(fields.cwd))
    const session: AdeSession = {
      id: `ses-${randomUUID()}`,
      title: fields.title,
      project: fields.cwd,
      cwd: fields.cwd,
      branch: fields.branch,
      repo: fields.repo,
      worktree: false,
      createdAt: this.deps.now(),
      host: fields.host
    }
    this.sessions.push(session)
    this.commit()
    return { ...session }
  }

  /** Sessions for the folders Import found conversations in (with when each was last used); returns the ones made. */
  async importFolders(folders: { cwd: string; at: number }[]): Promise<AdeSession[]> {
    const made: AdeSession[] = []
    for (const { cwd, at } of folders) {
      if (!isDir(cwd) || this.byCwd(cwd) || this.isClosed(cwd)) continue
      made.push(await this.ensureFolder(cwd, { at }))
    }
    return made
  }
}
