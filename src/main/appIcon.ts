import { app, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppIcon } from '@shared/types'

/**
 * The app icon the user picked in Settings → Appearance: the Disc E, or the
 * agent face on the same tile. Both are built from Icon Composer documents
 * by scripts/make-icon.py.
 *
 * Only the running app changes: the Dock tile on macOS, the window and
 * taskbar icon on Windows and Linux. The Finder, Launchpad, the installer
 * and the Start menu always show the Disc E, since swapping the bundle's own
 * icon would break the app's code signature.
 */

const here = join(fileURLToPath(import.meta.url), '..')

interface Where {
  platform: NodeJS.Platform
  packaged: boolean
  /** Contents/Resources (process.resourcesPath) in a packaged app. */
  resourcesPath: string
  /** The repo's resources/ folder, for dev runs. */
  devResources: string
}

/**
 * The image for an icon, or null for "the app's own". A packaged Mac app's
 * own icon is the Liquid Glass one in Assets.car, with its dark, clear and
 * tinted looks; any image set on the Dock would freeze it in one look, so
 * the default sets none. Packaged builds ship the images under icons/
 * (extraResources in electron-builder.yml); dev runs read resources/.
 */
export function appIconFile(icon: AppIcon, where: Where): string | null {
  const agent = icon === 'agent'
  if (where.platform === 'darwin' && where.packaged && !agent) return null
  const ext = where.platform === 'win32' ? 'ico' : 'png'
  return where.packaged
    ? join(where.resourcesPath, 'icons', `${agent ? 'agent' : 'default'}.${ext}`)
    : join(where.devResources, `${agent ? 'icon-agent' : 'icon'}.${ext}`)
}

export function currentAppIconFile(icon: AppIcon): string | null {
  return appIconFile(icon, {
    platform: process.platform,
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    devResources: join(here, '../../resources')
  })
}

/** Shows the chosen icon now: on the Dock, or on every open window. New windows take it from createWindow. */
export function applyAppIcon(icon: AppIcon, windows: Iterable<BrowserWindow>): void {
  const file = currentAppIconFile(icon)
  try {
    if (process.platform === 'darwin') {
      // null hands the Dock back the bundle's own icon; Electron accepts it
      // though its typings don't say so.
      app.dock?.setIcon(file as string)
      return
    }
    if (!file) return
    for (const window of windows) if (!window.isDestroyed()) window.setIcon(file)
  } catch (error) {
    console.error('[app-icon] could not set the app icon:', error)
  }
}
