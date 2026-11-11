import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { store } from '../store'
import type { Feature } from './types'
import { EDITABLE_LIMIT, type WorkspaceEntry, type WorkspaceFile } from '@shared/workspaceFiles'
import { remoteCwd, remoteLocation } from '@shared/adeRemote'
import { posixNormalize, remoteInside } from '@shared/remotePath'
import { openRemote, remoteList, remoteRead, remoteWrite } from '../remoteWork'

/**
 * The dock's files, in Chat and the ADE: a folder as a file tree and an
 * editor. The renderer asks for folders and files by path; every path must
 * sit inside a folder an agent works in (a workspace's folder, the default
 * one, or an ADE session's), so the dock cannot be pointed at the rest of the
 * disk.
 */

/** Never listed: noise every project has, which no one opens from here. */
const HIDDEN = new Set(['.DS_Store', 'Thumbs.db'])

/** The folder Chat's agent runs in, as `ensureWorkFolder` in agent/loop.ts picks it. */
export async function chatFolder(): Promise<string> {
  const workspaces = store.getWorkspaces()
  const chat = workspaces.find((w) => w.kind === 'chat') ?? workspaces.find((w) => w.kind === 'work')
  const folder = chat?.cwd || store.getSettings().work.defaultFolder || join(homedir(), 'Eaon')
  await mkdir(folder, { recursive: true })
  return folder
}

/** Other features' folders the dock may look inside too (the ADE's sessions). */
const moreRoots: (() => string[])[] = []

/** Lets the dock into the folders `list` names, as they are at the time of asking. */
export function allowFolders(list: () => string[]): void {
  moreRoots.push(list)
}

/** Every folder the panel may look inside, as written: this computer's, and `ssh://` folders on other machines. */
function folders(): string[] {
  const settings = store.getSettings()
  return [
    ...store.getWorkspaces().map((w) => w.cwd),
    ...store.getProjects().map((p) => p.folder),
    settings.work.defaultFolder,
    join(homedir(), 'Eaon'),
    ...moreRoots.flatMap((list) => list())
  ].filter((p): p is string => typeof p === 'string' && p.length > 0)
}

/** The folders on this computer the panel may look inside, symlinks resolved. */
async function roots(): Promise<string[]> {
  const candidates = folders().filter((p) => !remoteLocation(p))
  const resolved = await Promise.all(candidates.map((p) => realpath(p).catch(() => null)))
  return [...new Set(resolved.filter((p): p is string => p !== null))]
}

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * The remote project folder an `ssh://` path lies in: one a project or an ADE
 * session on that host has, never a folder only named here. Null when there's none.
 */
function remoteRootOf(path: string): string | null {
  return folders().find((folder) => remoteInside(folder, path)) ?? null
}

/** `path`, symlinks resolved, if it lies inside an allowed folder; otherwise it throws. */
export async function allowed(path: unknown): Promise<string> {
  // A folder or file on another machine: judged by its words (the host checks where it really leads).
  if (typeof path === 'string' && remoteLocation(path)) {
    if (!remoteRootOf(path)) throw new Error('That file is outside the work folder.')
    const place = remoteLocation(path)!
    return remoteCwd(place.hostId, posixNormalize(place.path))
  }
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
      const remote = remoteLocation(dir)
      if (remote) {
        const project = { ...(await openRemote(dir)), root: remoteLocation(remoteRootOf(dir)!)!.path }
        const { entries } = await remoteList(project, remote.path, 5000)
        return entries
          .filter((entry) => !HIDDEN.has(entry.name))
          .map((entry) => ({ name: entry.name, path: remoteCwd(remote.hostId, posixNormalize(`${remote.path}/${entry.name}`)), directory: entry.directory }))
          .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
      }
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
      const remote = remoteLocation(file)
      if (remote) {
        const project = { ...(await openRemote(file)), root: remoteLocation(remoteRootOf(file)!)!.path }
        const read = await remoteRead(project, remote.path, EDITABLE_LIMIT + 1)
        if (read.size > EDITABLE_LIMIT) return { kind: 'too-large', path: file, size: read.size, modified: read.modified }
        if (isBinary(read.bytes)) return { kind: 'binary', path: file, size: read.size, modified: read.modified }
        return { kind: 'text', path: file, text: read.bytes.toString('utf8'), modified: read.modified }
      }
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
      const remote = remoteLocation(file)
      if (remote) {
        const project = { ...(await openRemote(file)), root: remoteLocation(remoteRootOf(file)!)!.path }
        return remoteWrite(project, remote.path, Buffer.from(text, 'utf8'))
      }
      if ((await stat(file)).isDirectory()) throw new Error('That is a folder.')
      await writeFile(file, text, 'utf8')
      return (await stat(file)).mtimeMs
    })
  }
}
