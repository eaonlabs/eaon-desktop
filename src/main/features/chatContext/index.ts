import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { app, shell } from 'electron'
import { isBranchName, isCommitId, type GitMention, type MentionAttachment } from '@shared/chatContext'
import type { ProjectRules } from '@shared/projectRules'
import type { PromptCommand } from '@shared/promptCommands'
import type { Feature } from '../types'
import { allowed } from '../workspaceFiles'
import { makeRunner } from '../ade/runner'
import { sshHosts } from '../ade'
import { gitMentionText, gitRefs } from './git'
import { loadPromptCommands } from './commands'
import { loadProjectRules, withProjectRules } from './rules'
import { saveMention } from './save'

/**
 * What Chat's message box can pull in beside typed text: the git changes,
 * branches and commits, terminal output and earlier conversations the "@"
 * menu offers (shared/chatContext.ts), the project's rules files and
 * prompt-file commands, and what a chat's tokens cost.
 *
 * Channels (all `chat-context:`): `refs`, `git`, `save`, `rules`, `commands`, `commands-folder`.
 */

const run = makeRunner(sshHosts)

/** A Chat turn's instructions with the project's rules files added (rules.ts), as main/index.ts's `chat:stream` sends them. */
export const instructionsWithRules = (request: Parameters<typeof withProjectRules>[1]): Promise<string> => withProjectRules(run, request)

/** Eaon's own folder of prompt files: under its data folder, so no other app's settings are read. */
const userCommandsFolder = (): string => join(app.getPath('userData'), 'commands')

/** A mention as the renderer sent it, checked: a git mention names a branch or a commit git would accept. */
function gitMention(value: unknown): GitMention {
  const m = value as { kind?: unknown; name?: unknown; sha?: unknown } | null
  if (m?.kind === 'uncommitted') return { kind: 'uncommitted' }
  if (m?.kind === 'branch' && isBranchName(m.name)) return { kind: 'branch', name: m.name }
  if (m?.kind === 'commit' && isCommitId(m.sha)) return { kind: 'commit', sha: m.sha }
  throw new Error('That isn’t something git can show.')
}

export const chatContextFeature: Feature = {
  id: 'chat-context',
  register: ({ ipcMain }) => {
    // Which commits and branches the "@" menu offers, and what changes are compared with.
    ipcMain.handle('chat-context:refs', async (_e, cwd: unknown) => gitRefs(run, await allowed(cwd)))
    // A git mention picked: its diff read, saved, and the file handed back to attach.
    ipcMain.handle('chat-context:git', async (_e, cwd: unknown, mention: unknown): Promise<MentionAttachment> => {
      const folder = await allowed(cwd)
      const text = await gitMentionText(run, folder, gitMention(mention))
      if (!text.ok) return { ok: false, error: text.error }
      const path = await saveMention(text.label, 'diff', text.text)
      return {
        ok: true,
        path,
        label: text.label,
        ...(text.truncated ? { note: 'The diff was long, so the end is cut. The agent can run git for the rest.' } : {})
      }
    })
    // Which rules files the agent is given in this folder, for the workspace card.
    ipcMain.handle('chat-context:rules', async (_e, cwd: unknown): Promise<Pick<ProjectRules, 'files' | 'skipped'>> => {
      const { files, skipped } = await loadProjectRules(run, await allowed(cwd))
      return { files, skipped }
    })
    // The "/" commands made from prompt files: the project's (when there is a folder) and the user's own.
    ipcMain.handle('chat-context:commands', async (_e, cwd: unknown): Promise<PromptCommand[]> =>
      loadPromptCommands(typeof cwd === 'string' && cwd ? await allowed(cwd) : null, userCommandsFolder())
    )
    // Opens the user's commands folder (made if it isn't there yet) for adding a prompt file.
    ipcMain.handle('chat-context:commands-folder', async (): Promise<string> => {
      const folder = userCommandsFolder()
      await mkdir(folder, { recursive: true })
      const problem = await shell.openPath(folder)
      if (problem) throw new Error(problem)
      return folder
    })
    // Text the renderer read itself (a terminal's screen, an earlier chat), saved to attach.
    ipcMain.handle('chat-context:save', async (_e, label: unknown, text: unknown): Promise<string> => {
      if (typeof label !== 'string' || typeof text !== 'string') throw new Error('Expected text to attach.')
      return saveMention(label, 'txt', text)
    })
  }
}
