import os from 'node:os'
import path from 'node:path'
import { isRemote } from '@shared/adeRemote'
import type { AdeSession } from '@shared/adeSessions'
import { cleanCopySettings, type CopyPlan, type CopyReport, type WorktreeCopySettings } from '@shared/worktreeCopy'
import type { Feature } from './types'
import { adeSessions } from './ade'
import { copyIgnored, previewCopy } from './ade/worktreeCopy'
import { existingFiles } from './ade/pathLinks'
import { store } from '../store'

/**
 * What the ADE does around a session beyond making it: the files copied into
 * a new worktree, and (below) its scripts and archiving. Kept apart from
 * `ade.ts`, which makes and lists the sessions.
 */

const COPY_FILE = 'ade-worktree-copy.json'

const text = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw new Error(`Expected ${what}.`)
  return value
}

const copySettings = (): WorktreeCopySettings => cleanCopySettings(store.getJson<unknown>(COPY_FILE, null))

export const adeToolsFeature: Feature = {
  id: 'ade-tools',
  register: ({ ipcMain }) => {
    /* ------------------------------------------- files copied into new worktrees */

    ipcMain.handle('ade-tools:copy-settings', (): WorktreeCopySettings => copySettings())
    ipcMain.handle('ade-tools:save-copy-settings', (_e, value: unknown): WorktreeCopySettings => {
      const clean = cleanCopySettings(value)
      store.setJson(COPY_FILE, clean)
      return clean
    })
    // What a new session in this project would get: the files its patterns name, and the ones refused. Nothing is copied.
    ipcMain.handle('ade-tools:preview-copy', async (_e, project: unknown): Promise<CopyPlan | null> => {
      const dir = text(project, 'a project folder')
      if (isRemote(dir) || !adeSessions().list().some((s) => s.project === dir && s.repo)) return null
      return previewCopy(dir, copySettings().patterns).catch(() => null)
    })
    // Right after a session's worktree was made, when the dialog asked for it.
    ipcMain.handle('ade-tools:copy-ignored', async (_e, id: unknown): Promise<CopyReport> => {
      const session = adeSessions().get(text(id, 'a session'))
      if (!session?.worktree || isRemote(session.cwd)) throw new Error('Files are only copied into a worktree Eaon made for a session.')
      return copyIgnored(session.project, session.cwd, copySettings().patterns)
    })

    /* ------------------------------------------------------------ archive */

    // Out of the list into the Archived group; nothing on disk changes. The window ends the session's terminals.
    ipcMain.handle('ade-tools:archive', (_e, id: unknown): AdeSession | null => {
      const session = adeSessions().archive(text(id, 'a session'))
      // The ADE reopens its last folder at launch, which would show an archived session again.
      const settings = store.getSettings().eaonCode
      if (session && settings.lastCwd && path.resolve(settings.lastCwd) === path.resolve(session.cwd)) {
        store.patchSettings({ eaonCode: { ...settings, lastCwd: null } })
      }
      return session
    })
    ipcMain.handle('ade-tools:restore', (_e, id: unknown): AdeSession | null => adeSessions().restore(text(id, 'a session')))

    /* ------------------------------------------------- paths in a terminal */

    // Which printed paths are files in the session's folder, for the terminal's links. Only a session's own folder, on this computer.
    ipcMain.handle('ade-tools:existing-files', async (_e, folder: unknown, refs: unknown): Promise<(string | null)[]> => {
      const dir = text(folder, 'a folder')
      const list = (Array.isArray(refs) ? refs : []).filter((r): r is string => typeof r === 'string')
      if (isRemote(dir) || !adeSessions().byCwd(dir)) return list.map(() => null)
      return existingFiles(dir, list, os.homedir())
    })
  }
}
