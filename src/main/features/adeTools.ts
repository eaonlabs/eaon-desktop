import { isRemote } from '@shared/adeRemote'
import { cleanCopySettings, type CopyPlan, type CopyReport, type WorktreeCopySettings } from '@shared/worktreeCopy'
import type { Feature } from './types'
import { adeSessions } from './ade'
import { copyIgnored, previewCopy } from './ade/worktreeCopy'
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
  }
}
