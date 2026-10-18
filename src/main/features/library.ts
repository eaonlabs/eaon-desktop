import { app, shell } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
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
  // Windows runs these on open: Windows Script Host takes .js and .vbs, and
  // the rest are scripts, screensavers, control panels, registry imports,
  // help files that can carry script, and app installers.
  '.js', '.jse', '.vbs', '.vbe', '.wsf', '.wsh', '.ws', '.hta', '.scr', '.pif', '.cpl', '.msc', '.msp', '.mst',
  '.reg', '.inf', '.chm', '.psm1', '.psd1', '.msix', '.msixbundle', '.appx', '.appxbundle', '.appinstaller',
  '.application', '.gadget', '.settingcontent-ms', '.library-ms', '.search-ms', '.scf', '.appref-ms', '.vb',
  // Python's launchers run a script on open, on Windows and macOS alike.
  '.py', '.pyw', '.pyz',
  // Linux launchers and packages.
  '.desktop', '.appimage', '.run', '.deb', '.rpm', '.snap', '.flatpakref'
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

/** Image types the clipboard hands over, and the extension each is saved under. */
const PASTED_TYPES: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }
/** Larger than any screenshot; what a model takes is capped lower when it is sent (agent/context.ts). */
const PASTED_MAX_BYTES = 50 * 1024 * 1024

/**
 * An image pasted into a message box (a screenshot, an image copied in a
 * browser) has no file behind it, and attachments are paths. It is saved
 * under the app's data rather than a temp folder, so the chat that shows it
 * can still show it after the system clears temp files.
 */
export async function savePastedImage(data: unknown, type: unknown, folder = join(app.getPath('userData'), 'Pasted')): Promise<string> {
  const ext = typeof type === 'string' ? PASTED_TYPES[type] : undefined
  if (!ext) throw new Error('Only PNG, JPEG, GIF and WebP images can be pasted.')
  const bytes = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null
  if (!bytes || bytes.byteLength === 0) throw new Error('The pasted image was empty.')
  if (bytes.byteLength > PASTED_MAX_BYTES) throw new Error('The pasted image is too large to attach.')
  await mkdir(folder, { recursive: true })
  // Readable in the attachment chip, and unique without asking the disk.
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '.')
  const path = join(folder, `Pasted image ${stamp} ${Math.random().toString(36).slice(2, 6)}${ext}`)
  await writeFile(path, bytes)
  return path
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
    ipcMain.handle('library:save-pasted', (_e, data: unknown, type: unknown) => savePastedImage(data, type))
    ipcMain.handle('library:reveal', (_e, path: string) => {
      if (typeof path === 'string' && path) shell.showItemInFolder(path)
    })
  }
}
