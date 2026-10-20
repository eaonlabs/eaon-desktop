import { app, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppIcon } from '@shared/types'

/**
 * The app icon the user picked in Settings → Appearance: the Disc E, the
 * agent face on the same tile, or the Disc E on another background. All are
 * built from Icon Composer documents by scripts/make-icon.py.
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
  if (where.platform === 'darwin' && where.packaged && icon === 'default') return null
  const ext = where.platform === 'win32' ? 'ico' : 'png'
  if (where.packaged) return join(where.resourcesPath, 'icons', `${icon}.${ext}`)
  // Dev runs: the Disc E and the agent beside the other icons in resources/, the backgrounds in resources/app-icons/.
  if (icon === 'default') return join(where.devResources, `icon.${ext}`)
  if (icon === 'agent') return join(where.devResources, `icon-agent.${ext}`)
  return join(where.devResources, 'app-icons', `${icon}.${ext}`)
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
