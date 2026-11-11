import { relative, sep } from 'node:path'
import type { Feature } from './types'
import { sshHosts } from './ade'
import { allowed } from './workspaceFiles'
import { remoteLocation } from '@shared/adeRemote'
import { makeRunner } from './ade/runner'
import { fileCommits, lineBlame } from './ade/blame'

/**
 * The editor's git history for the open file: its commits, and who last
 * changed the line the caret is on. Read only, in the chat's folder, for a
 * file inside it.
 */

const run = makeRunner(sshHosts)

/** The folder and the file's path from it, both checked against what the agent may work in. */
async function place(cwd: unknown, file: unknown): Promise<{ folder: string; rel: string }> {
  const folder = await allowed(cwd)
  const path = await allowed(file)
  // On another machine both are `ssh://host/…`: the file's place is by the host's own path.
  const rf = remoteLocation(folder)
  const rp = remoteLocation(path)
  if (rf || rp) {
    const base = rf?.path.replace(/\/$/, '')
    if (!rf || !rp || rf.hostId !== rp.hostId || !rp.path.startsWith(`${base}/`)) throw new Error('That file isn’t in this folder.')
    return { folder, rel: rp.path.slice(base!.length + 1) }
  }
  const rel = relative(folder, path)
  if (!rel || rel.startsWith('..') || /^[a-z]:/i.test(rel)) throw new Error('That file isn’t in this folder.')
  return { folder, rel: rel.split(sep).join('/') }
}

export const gitHistoryFeature: Feature = {
  id: 'git-history',
  register: ({ ipcMain }) => {
    ipcMain.handle('git-history:file', async (_e, cwd: unknown, file: unknown) => {
      const { folder, rel } = await place(cwd, file)
      return fileCommits(run, folder, rel)
    })
    ipcMain.handle('git-history:blame', async (_e, cwd: unknown, file: unknown, line: unknown) => {
      const { folder, rel } = await place(cwd, file)
      if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) throw new Error('Expected a line number.')
      return lineBlame(run, folder, rel, line)
    })
  }
}
