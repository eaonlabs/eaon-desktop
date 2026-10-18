import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { store } from '../store'
import type { Feature } from './types'
import { EDITABLE_LIMIT, type WorkspaceEntry, type WorkspaceFile } from '@shared/workspaceFiles'

/**
 * Chat's code panel: the agent's folder as a file tree and an editor. The
 * renderer asks for folders and files by path; every path must sit inside a
 * folder the agent works in (a workspace's folder, or the default one), so
 * the panel cannot be pointed at the rest of the disk.
 */

/** Never listed: noise every project has, which no one opens from here. */
const HIDDEN = new Set(['.DS_Store', 'Thumbs.db'])

/** The folder Chat's agent runs in, as `ensureWorkFolder` in agent/loop.ts picks it. */
async function chatFolder(): Promise<string> {
  const workspaces = store.getWorkspaces()
  const chat = workspaces.find((w) => w.kind === 'chat') ?? workspaces.find((w) => w.kind === 'work')
  const folder = chat?.cwd || store.getSettings().work.defaultFolder || join(homedir(), 'Eaon')
  await mkdir(folder, { recursive: true })
  return folder
}

/** Every folder the panel may look inside, symlinks resolved. */
async function roots(): Promise<string[]> {
  const settings = store.getSettings()
  const candidates = [
    ...store.getWorkspaces().map((w) => w.cwd),
    settings.work.defaultFolder,
    join(homedir(), 'Eaon')
  ].filter((p): p is string => typeof p === 'string' && p.length > 0)
  const resolved = await Promise.all(candidates.map((p) => realpath(p).catch(() => null)))
  return [...new Set(resolved.filter((p): p is string => p !== null))]
}

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** `path`, symlinks resolved, if it lies inside an allowed folder; otherwise it throws. */
async function allowed(path: unknown): Promise<string> {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Not an absolute path.')
  const real = await realpath(resolve(path))
  const ok = (await roots()).some((root) => inside(root, real))
  if (!ok) throw new Error('That file is outside the work folder.')
  return real
}

/** A NUL in the first few kilobytes: not text. */
const isBinary = (buffer: Buffer): boolean => buffer.subarray(0, 8000).includes(0)

export const workspaceFilesFeature: Feature = {
  id: 'workspace-files',
  register: ({ ipcMain }) => {
    ipcMain.handle('workspace-files:root', () => chatFolder())

    // The composer's project picker: the folders in the home folder, by name,
    // as places to start. Picking one is the user's choice of where the agent
    // works, the same as choosing it in the open dialog; nothing is read.
    ipcMain.handle('workspace-files:places', async (): Promise<WorkspaceEntry[]> => {
      const home = homedir()
      const entries = await readdir(home, { withFileTypes: true }).catch(() => [])
      return entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => ({ name: entry.name, path: join(home, entry.name), directory: true }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
        .slice(0, 60)
    })

    ipcMain.handle('workspace-files:list', async (_e, path: unknown): Promise<WorkspaceEntry[]> => {
      const dir = await allowed(path)
      const entries = await readdir(dir, { withFileTypes: true })
      return entries
        .filter((entry) => !HIDDEN.has(entry.name))
        .slice(0, 5000)
        .map((entry) => ({
          name: entry.name,
          path: dir.endsWith(sep) ? dir + entry.name : dir + sep + entry.name,
          directory: entry.isDirectory()
        }))
        .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    })

    ipcMain.handle('workspace-files:read', async (_e, path: unknown): Promise<WorkspaceFile> => {
      const file = await allowed(path)
      const info = await stat(file)
      if (info.isDirectory()) throw new Error('That is a folder.')
      if (info.size > EDITABLE_LIMIT) return { kind: 'too-large', path: file, size: info.size, modified: info.mtimeMs }
      const buffer = await readFile(file)
      if (isBinary(buffer)) return { kind: 'binary', path: file, size: info.size, modified: info.mtimeMs }
      return { kind: 'text', path: file, text: buffer.toString('utf8'), modified: info.mtimeMs }
    })

    // Saves over a file that is already there; the panel does not create files.
    ipcMain.handle('workspace-files:write', async (_e, path: unknown, text: unknown): Promise<number> => {
      if (typeof text !== 'string') throw new Error('Nothing to save.')
      if (Buffer.byteLength(text) > EDITABLE_LIMIT) throw new Error('That file is too large to save from here.')
      const file = await allowed(path)
      if ((await stat(file)).isDirectory()) throw new Error('That is a folder.')
      await writeFile(file, text, 'utf8')
      return (await stat(file)).mtimeMs
    })
  }
}
