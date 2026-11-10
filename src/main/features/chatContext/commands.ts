import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { mergeCommands, parseCommandFile, PROJECT_COMMAND_FOLDERS, type CommandSource, type PromptCommand } from '@shared/promptCommands'

/**
 * Finds the prompt files that become "/" commands (shared/promptCommands.ts):
 * Markdown files in the project's `.eaon/commands`, `.claude/commands` and
 * `.cursor/commands`, and in Eaon's own commands folder (under its data
 * folder, so no other app's settings are read). A file in a subfolder is
 * named with a colon, "frontend/test.md" → "frontend:test".
 */

/** At most this many commands from one folder. */
const MAX_PER_FOLDER = 100
/** A prompt file bigger than this (100 KB) is not one. */
const MAX_BYTES = 100_000
/** Subfolders below a commands folder that are looked in. */
const MAX_DEPTH = 1

async function readFolder(root: string, source: CommandSource): Promise<PromptCommand[]> {
  const out: PromptCommand[] = []
  const walk = async (rel: string, depth: number): Promise<void> => {
    const entries = await readdir(join(root, rel), { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= MAX_PER_FOLDER) return
      const next = rel ? `${rel}/${entry.name}` : entry.name
      const path = join(root, next)
      // A link is followed to what it points at, so a folder of shared prompts can be linked in.
      const info = entry.isSymbolicLink() ? await stat(path).catch(() => null) : null
      const isDir = entry.isDirectory() || Boolean(info?.isDirectory())
      const isFile = entry.isFile() || Boolean(info?.isFile())
      if (isDir) {
        if (depth < MAX_DEPTH && !entry.name.startsWith('.')) await walk(next, depth + 1)
      } else if (isFile && /\.md$/i.test(entry.name)) {
        const size = (info ?? (await stat(path).catch(() => null)))?.size ?? Infinity
        if (size > MAX_BYTES) continue
        const text = await readFile(path, 'utf8').catch(() => null)
        const command = text === null ? null : parseCommandFile(next, text, source, path)
        if (command) out.push(command)
      }
    }
  }
  await walk('', 0)
  return out
}

/** The commands for a project folder (none when `folder` is null) and the user's own folder. */
export async function loadPromptCommands(folder: string | null, userFolder: string): Promise<PromptCommand[]> {
  const project = folder ? await Promise.all(PROJECT_COMMAND_FOLDERS.map((rel) => readFolder(join(folder, rel), 'project'))) : []
  return mergeCommands(project, await readFolder(userFolder, 'mine'))
}
