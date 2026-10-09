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
import { projectRepo } from './ade/git'
import type { AdeConversation, AdeImportCandidate, AdeSession, NewSessionRequest } from '@shared/adeSessions'
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
      worktreesRoot
    })
  }
  return book
}

/** Makes `cwd` the folder the ADE reopens at launch, and its project a recent one. */
function remember(recents: RecentFolders, session: AdeSession): string[] {
  const list = recents.add(session.project)
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

    ipcMain.handle('ade:conversations', (_e, cwd: unknown) => conversationsIn(text(cwd, 'a folder')))
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
