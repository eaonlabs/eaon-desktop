import { shell } from 'electron'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { Feature } from './types'
import type { LibraryFileStat } from '@shared/library'

/**
 * The Library page: everything the user has attached to chats and workers.
 * The renderer already knows the paths (they live in the transcripts); this
 * only answers what the page cannot find out itself — whether each file is
 * still there and how big it is — and opens them.
 */

/**
 * Opened with the default app on a click. Anything that could run code (an
 * app bundle, a script, an installer) is revealed in Finder instead: a
 * transcript path is not a reason to execute something.
 */
const RUNNABLE = new Set([
  '.app', '.command', '.sh', '.zsh', '.bash', '.tool', '.exe', '.bat', '.cmd', '.com', '.msi', '.ps1',
  '.pkg', '.mpkg', '.scpt', '.applescript', '.workflow', '.jar', '.terminal', '.url', '.webloc', '.lnk',
  // macOS: settings panes, links and bundles that load code.
  '.prefpane', '.fileloc', '.inetloc', '.action', '.kext', '.plugin', '.service', '.saver', '.qlgenerator', '.osax', '.scptd',
  // Windows: script hosts and their kin, which run on a double-click.
  '.js', '.jse', '.vbs', '.vbe', '.wsf', '.wsh', '.hta', '.scr', '.pif', '.reg', '.cpl', '.msc', '.msp', '.appref-ms', '.vb',
  // Linux.
  '.desktop', '.appimage', '.run', '.deb', '.rpm'
])

/**
 * Whether opening `path` with its default app could run it: a runnable
 * extension, or a file with no extension that is marked executable (Finder
 * runs those in Terminal).
 */
export async function couldRun(path: string): Promise<boolean> {
  if (RUNNABLE.has(extname(path).toLowerCase())) return true
  try {
    const info = await stat(path)
    return info.isFile() && (info.mode & 0o111) !== 0
  } catch {
    return false
  }
}

export const libraryFeature: Feature = {
  id: 'library',
  register: ({ ipcMain }) => {
    ipcMain.handle('library:stat', async (_e, paths: string[]): Promise<LibraryFileStat[]> => {
      const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string').slice(0, 5000) : []
      return Promise.all(
        list.map(async (path) => {
          try {
            const info = await stat(path)
            return { path, exists: true, size: info.size, modified: info.mtimeMs, directory: info.isDirectory() }
          } catch {
            return { path, exists: false, size: 0, modified: 0, directory: false }
          }
        })
      )
    })
    ipcMain.handle('library:open', async (_e, path: string) => {
      if (typeof path !== 'string' || !path) return
      if (!existsSync(path)) throw new Error(`${basename(path)} isn't there any more. It may have been moved or deleted.`)
      if (await couldRun(path)) {
        shell.showItemInFolder(path)
        return
      }
      const error = await shell.openPath(path)
      if (error) throw new Error(error)
    })
    ipcMain.handle('library:reveal', (_e, path: string) => {
      if (typeof path === 'string' && path) shell.showItemInFolder(path)
    })
  }
}
