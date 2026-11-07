import type { Feature } from './types'
import { adeSessions, sshHosts } from './ade'
import { allowed } from './workspaceFiles'
import { makeRunner } from './ade/runner'
import { reviewLocalChanges, writeCommitMessage, writePullRequestText } from './ade/assist'
import { askModel } from '../agent/askModel'
import type { GitAssistModel } from '@shared/gitAssist'

/**
 * The model's help with git (ade/assist.ts): a commit message, a pull
 * request's title and description, a review of the uncommitted changes. Asked
 * from Chat's Git menu and the ADE's review panel, in a folder Chat's agent
 * works in or an ADE session's, with the model the person has picked: what is
 * sent is a bounded diff, said in the UI, and nothing is written anywhere.
 */

const run = makeRunner(sshHosts)

/** A folder one of Chat's workspaces or an ADE session works in, here or over SSH: the same rule as the ADE's review. */
async function folderOf(cwd: unknown): Promise<string> {
  if (typeof cwd !== 'string' || !cwd.trim() || cwd.length > 4096) throw new Error('Expected a folder.')
  if (adeSessions().byCwd(cwd)) return cwd
  if (await allowed(cwd).then(() => true, () => false)) return cwd
  throw new Error('That folder isn’t one the agent works in.')
}

function modelOf(value: unknown): GitAssistModel {
  const v = value as { providerId?: unknown; modelId?: unknown } | null
  if (typeof v?.providerId !== 'string' || typeof v?.modelId !== 'string' || !v.providerId || !v.modelId || v.providerId.length > 200 || v.modelId.length > 300)
    throw new Error('Pick a model first.')
  return { providerId: v.providerId, modelId: v.modelId }
}

/** A branch name to hand git: never something it would read as an option or a range. */
function branchOf(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w.][\w./-]{0,250}$/.test(value) || value.includes('..')) throw new Error('Pick a branch to compare with.')
  return value
}

export const gitAssistFeature: Feature = {
  id: 'git-assist',
  register: ({ ipcMain }) => {
    ipcMain.handle('git-assist:commit-message', async (_e, cwd: unknown, model: unknown) => writeCommitMessage(run, await folderOf(cwd), modelOf(model), askModel))
    ipcMain.handle('git-assist:pull-request', async (_e, cwd: unknown, base: unknown, model: unknown) =>
      writePullRequestText(run, await folderOf(cwd), branchOf(base), modelOf(model), askModel)
    )
    ipcMain.handle('git-assist:review', async (_e, cwd: unknown, model: unknown) => reviewLocalChanges(run, await folderOf(cwd), modelOf(model), askModel))
  }
}
