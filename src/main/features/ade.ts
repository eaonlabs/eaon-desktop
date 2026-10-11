import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import type { Feature } from './types'
import { store } from '../store'
import { RecentFolders } from './eaonCode/recents'
import { SessionBook, type SavedSessions } from './ade/sessions'
import { allConversations, conversationsIn } from './ade/conversations'
import { adeHistory } from './ade/history'
import { changes, projectRepo } from './ade/git'
import { HostBook } from './ade/hosts'
import { makeRunner } from './ade/runner'
import { resolveRemoteFolder } from './ade/ssh'
import { commitAll, createPullRequest, mergePullRequest, push, reviewState } from './ade/review'
import { parseChanges, type AdeChanges, type AdeConversation, type AdeImportCandidate, type AdeSession, type NewSessionRequest } from '@shared/adeSessions'
import { hostLabel, isRemote, remoteCwd, type ManualHostInput, type NewRemoteSessionRequest, type NewRemoteSessionResult } from '@shared/adeRemote'
import type { TerminalLayout } from '@shared/terminals'

/**
 * The ADE's sessions (see `shared/adeSessions.ts`): the list, making one on a
 * branch of its own, opening one, the conversations filed for its folder, and
 * importing the folders Claude Code and Codex have conversations in.
 */

const FILE = 'ade-sessions.json'
/** The terminals feature's saved grid, per folder: the folders that had terminals before sessions. */
const LAYOUT_FILE = 'ade-terminals.json'

/** Where new sessions' worktrees go: Eaon's own folder in the home folder, where the user can find them. */
export const worktreesRoot = (): string => path.join(os.homedir(), 'Eaon', 'worktrees')

const text = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw new Error(`Expected ${what}.`)
  return value
}

const isDir = (dir: string): boolean => {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** SSH hosts: ~/.ssh/config's, then the ones added in Eaon. */
export const sshHosts = new HostBook({
  load: () => store.getJson<unknown>('ade-ssh-hosts.json', []),
  save: (list) => store.setJson('ade-ssh-hosts.json', list)
})
/** git and gh in a session's folder, here or over SSH. */
const run = makeRunner(sshHosts)

/** The branch of a folder on an SSH host, and whether it is in a repository; null when the host can't say. */
async function remoteRepo(cwd: string): Promise<{ branch: string | null; repo: boolean } | null> {
  const inside = await run(cwd, 'git', ['rev-parse', '--is-inside-work-tree'], 15_000)
  if (inside.code === null) return null
  if (!inside.ok) return { branch: null, repo: false }
  const branch = await run(cwd, 'git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], 15_000)
  return { branch: branch.ok ? branch.stdout.trim() || null : null, repo: true }
}

/** Uncommitted changes in a session's folder, here or on its host. */
async function changesIn(cwd: string): Promise<AdeChanges | null> {
  if (!isRemote(cwd)) return changes(cwd)
  const [numstat, untracked] = await Promise.all([
    run(cwd, 'git', ['diff', 'HEAD', '--numstat', '--no-renames'], 15_000),
    run(cwd, 'git', ['ls-files', '--others', '--exclude-standard'], 15_000)
  ])
  return numstat.ok && untracked.ok ? parseChanges(numstat.stdout, untracked.stdout) : null
}

let book: SessionBook | null = null

/** The ADE's sessions, for the features that make them (pull request reviews, Linear issues). */
export function adeSessions(): SessionBook {
  return sessions()
}

/** Folders the ADE knows: every session's project, then the recent ones. */
export function knownProjects(): string[] {
  const recents = RecentFolders.at(app.getPath('userData')).list()
  return [...new Set([...sessions().list().map((s) => s.project), ...recents])]
}

function sessions(): SessionBook {
  if (!book) {
    book = new SessionBook({
      load: () => store.getJson<SavedSessions>(FILE, { sessions: [] }),
      save: (value) => store.setJson(FILE, value),
      now: Date.now,
      worktreesRoot,
      remoteRepo
    })
  }
  return book
}

/** Makes `cwd` the folder the ADE reopens at launch, and its project a recent one. */
function remember(recents: RecentFolders, session: AdeSession): string[] {
  // Recents are folders the folder picker can open here; a folder on another machine isn't one.
  const list = isRemote(session.cwd) ? recents.list() : recents.add(session.project)
  const settings = store.getSettings().eaonCode
  if (settings.lastCwd !== session.cwd) store.patchSettings({ eaonCode: { ...settings, lastCwd: session.cwd } })
  return list
}

/**
 * What Import found: the folders of the conversations that ran in the ADE's
 * own terminals (ade/history.ts), with their project and branch, newest
 * first. Not every folder Claude Code or Codex was ever used in: that brought
 * back sessions long closed, for work that was never in the ADE.
 */
async function importCandidates(): Promise<AdeImportCandidate[]> {
  const history = await adeHistory()
  const byFolder = new Map<string, AdeConversation[]>()
  for (const conversation of await allConversations()) {
    if (!history.has(conversation.agent, conversation.id)) continue
    const cwd = path.resolve(conversation.cwd)
    const list = byFolder.get(cwd) ?? []
    list.push(conversation)
    byFolder.set(cwd, list)
  }
  const out: AdeImportCandidate[] = []
  for (const [cwd, conversations] of byFolder) {
    // A folder deleted since (a temporary checkout, an old worktree) has nothing to open.
    if (!isDir(cwd)) continue
    // A session the user removed stays removed.
    if (sessions().isClosed(cwd)) continue
    const repo = await projectRepo(cwd, os.homedir())
    out.push({ cwd, project: repo ? repo.root : cwd, branch: repo?.branch ?? null, conversations, already: Boolean(sessions().byCwd(cwd)) })
  }
  return out.sort((a, b) => (b.conversations[0]?.touched ?? 0) - (a.conversations[0]?.touched ?? 0))
}

export const adeFeature: Feature = {
  id: 'ade-sessions',
  register: ({ ipcMain }) => {
    const recents = RecentFolders.at(app.getPath('userData'))

    ipcMain.handle('ade:sessions', async () => {
      const book = sessions()
      if (!book.adopted) {
        const layout = store.getJson<TerminalLayout>(LAYOUT_FILE, {})
        const withPanes = Object.entries(layout ?? {})
          .filter(([, panes]) => Array.isArray(panes) && panes.length > 0)
          .map(([cwd]) => cwd)
        const last = store.getSettings().eaonCode.lastCwd
        await book.adopt([...new Set([...(last ? [last] : []), ...withPanes, ...recents.list()])])
      }
      return book.refresh()
    })

    ipcMain.handle('ade:create', (_e, req: NewSessionRequest) =>
      sessions().create({
        project: text(req?.project, 'a project folder'),
        title: text(req?.title, 'a name'),
        ...(typeof req?.branch === 'string' && req.branch.trim() ? { branch: req.branch } : {})
      })
    )

    ipcMain.handle('ade:remove', async (_e, id: unknown, options?: { deleteWorktree?: unknown }) => {
      const removed = sessions().get(text(id, 'a session'))
      const result = await sessions().remove(text(id, 'a session'), { deleteWorktree: options?.deleteWorktree === true })
      // The ADE reopens its last folder at launch, which would make the session again.
      const settings = store.getSettings().eaonCode
      if (result.ok && removed && settings.lastCwd && path.resolve(settings.lastCwd) === path.resolve(removed.cwd)) {
        store.patchSettings({ eaonCode: { ...settings, lastCwd: null } })
      }
      return result
    })

    ipcMain.handle('ade:rename', (_e, id: unknown, title: unknown) => sessions().rename(text(id, 'a session'), typeof title === 'string' ? title.slice(0, 200) : ''))

    // Opening a session: its folder is the ADE's, and its project is a recent one.
    ipcMain.handle('ade:open', (_e, id: unknown) => {
      const session = sessions().get(text(id, 'a session'))
      if (!session) throw new Error('That session isn’t in the ADE any more.')
      return remember(recents, session)
    })

    // A folder opened from the picker or the recents: its own session, made if it has none.
    ipcMain.handle('ade:open-folder', async (_e, folder: unknown) => {
      const dir = path.resolve(text(folder, 'a folder'))
      if (!isDir(dir)) throw new Error(`${dir} isn’t a folder Eaon can open.`)
      const session = await sessions().ensureFolder(dir)
      return { session, recents: remember(recents, session) }
    })

    // Claude Code and Codex file conversations on the machine they ran on; a remote session's aren't here.
    ipcMain.handle('ade:conversations', (_e, cwd: unknown) => (isRemote(text(cwd, 'a folder')) ? [] : conversationsIn(text(cwd, 'a folder'))))
    ipcMain.handle('ade:changes', (_e, cwd: unknown) => changesIn(text(cwd, 'a folder')))

    // SSH hosts and sessions on them.
    ipcMain.handle('ade:hosts', () => sshHosts.list())
    ipcMain.handle('ade:add-host', (_e, input: ManualHostInput) => sshHosts.add(input ?? { hostname: '' }))
    ipcMain.handle('ade:remove-host', (_e, id: unknown) => sshHosts.remove(text(id, 'a host')))
    ipcMain.handle('ade:create-remote', async (_e, req: NewRemoteSessionRequest): Promise<NewRemoteSessionResult> => {
      const host = await sshHosts.find(text(req?.hostId, 'a host'))
      if (!host) return { ok: false, error: 'Pick a host first.' }
      const folder = await resolveRemoteFolder(host, typeof req.path === 'string' ? req.path : '~')
      if (!folder.ok) return folder
      const cwd = remoteCwd(host.id, folder.path)
      const repo = await remoteRepo(cwd)
      const title = typeof req.title === 'string' && req.title.trim() ? req.title.trim().slice(0, 200) : null
      return { ok: true, session: sessions().addRemote({ cwd, host: hostLabel(host), title, branch: repo?.branch ?? null, repo: repo?.repo ?? false }) }
    })

    // Review: only ever in a session's own folder.
    const sessionCwd = (cwd: unknown): string => {
      const dir = text(cwd, 'a folder')
      if (!sessions().byCwd(dir)) throw new Error('That folder isn’t one of the ADE’s sessions.')
      return dir
    }
    ipcMain.handle('ade:review', (_e, cwd: unknown) => reviewState(run, sessionCwd(cwd)))
    ipcMain.handle('ade:commit', (_e, cwd: unknown, message: unknown) => commitAll(run, sessionCwd(cwd), typeof message === 'string' ? message.slice(0, 20_000) : ''))
    ipcMain.handle('ade:push', (_e, cwd: unknown) => push(run, sessionCwd(cwd)))
    ipcMain.handle('ade:create-pr', (_e, cwd: unknown, req: { title?: unknown; body?: unknown; draft?: unknown }) =>
      createPullRequest(run, sessionCwd(cwd), {
        title: typeof req?.title === 'string' ? req.title.slice(0, 500) : '',
        body: typeof req?.body === 'string' ? req.body.slice(0, 60_000) : '',
        draft: req?.draft === true
      })
    )
    ipcMain.handle('ade:merge', (_e, cwd: unknown, method: unknown) =>
      mergePullRequest(run, sessionCwd(cwd), method === 'merge' || method === 'rebase' ? method : 'squash')
    )
    ipcMain.handle('ade:import-scan', () => importCandidates())
    ipcMain.handle('ade:import', (_e, folders: unknown) => {
      const list = (Array.isArray(folders) ? folders : [])
        .filter((f): f is { cwd: string; at: number } => typeof f?.cwd === 'string' && typeof f?.at === 'number')
        .slice(0, 500)
      return sessions().importFolders(list)
    })
    // With the home folder as ~, for reading: the same paths the session's folders get.
    ipcMain.handle('ade:worktrees-root', () => ({ path: worktreesRoot(), home: os.homedir() }))
  }
}

/** What Eaon Remote (features/rc) reads about the ADE's sessions. */
export const adeForRemote = {
  list: (): AdeSession[] => sessions().list(),
  changes: changesIn
}
