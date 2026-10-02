import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { desktopCapturer, nativeImage, screen, systemPreferences, type Display, type NativeImage } from 'electron'
import { targetSize, type Frame, type Quality } from './geometry'
import { permissionOwnerLabel } from './mac'

const run = promisify(execFile)

/**
 * Screenshots for the model.
 *
 * macOS uses Apple's `screencapture` rather than `desktopCapturer`: it
 * captures one display at native resolution straight to a JPEG file, needs no
 * window or renderer, runs the same from a test script as from the app, and
 * fails loudly ("could not create image from display") when Screen Recording
 * is missing instead of handing back a wallpaper-only image. `desktopCapturer`
 * is used on Windows and Linux, which have no equivalent tool.
 */

export const JPEG_QUALITY = 70

export interface Shot {
  frame: Frame
  jpeg: Buffer
  /** Set when the capture worked but probably shows less than the real screen. */
  warning?: string
}

/** Displays in a stable order: the primary first, then left to right, top to bottom. */
export function orderedDisplays(): Display[] {
  const primary = screen.getPrimaryDisplay()
  const rest = screen
    .getAllDisplays()
    .filter((d) => d.id !== primary.id)
    .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
  return [primary, ...rest]
}

export class ScreenCaptureDenied extends Error {}

async function captureMac(display: Display, primary: boolean): Promise<NativeImage> {
  const file = join(tmpdir(), `eaon-shot-${randomUUID()}.jpg`)
  const { x, y, width, height } = display.bounds
  // -m is the documented way to get the main display; other displays are
  // captured by their rect in global points, which avoids guessing how
  // screencapture numbers displays for -D.
  const target = primary ? ['-m'] : ['-R', `${x},${y},${width},${height}`]
  try {
    await run('/usr/sbin/screencapture', ['-x', '-t', 'jpg', ...target, file], { timeout: 20_000 })
    const image = nativeImage.createFromBuffer(await readFile(file))
    if (image.isEmpty()) throw new Error('screencapture produced an empty image.')
    return image
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? '').trim()
    if (/could not create image/i.test(stderr)) {
      const who = await permissionOwnerLabel()
      throw new ScreenCaptureDenied(
        `macOS refused the screenshot: Screen Recording is off for ${who}. Tell the user to open Settings → Computer use in Eaon, which walks through it step by step, or to switch on ${who} in System Settings → Privacy & Security → Screen & System Audio Recording ("Screen Recording" before macOS 15) and then quit and reopen Eaon, since macOS applies it only after a restart. Retry only after they have.`
      )
    }
    throw new Error(stderr || (error as Error).message)
  } finally {
    await rm(file, { force: true })
  }
}

/**
 * Puts Eaon in System Settings' Screen Recording list, so the user has a
 * switch to flip rather than a "+" to hunt with. Only an actual capture
 * request does that; on a Mac never asked before, macOS also shows its own
 * prompt here. From Eaon's own process rather than a screencapture child, so
 * the request is Eaon's beyond doubt. The thumbnail is 1×1 because at 0×0
 * Electron skips the capture, and with it the request. Capped, since the
 * pane should open even if the capture hangs.
 */
export async function requestScreenAccess(): Promise<void> {
  if (process.platform !== 'darwin') return
  await Promise.race([
    desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => []),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ])
}

async function captureDesktop(display: Display): Promise<NativeImage> {
  const size = {
    width: Math.round(display.bounds.width * display.scaleFactor),
    height: Math.round(display.bounds.height * display.scaleFactor)
  }
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
  const source = sources.find((s) => s.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined)
  if (!source || source.thumbnail.isEmpty()) throw new Error('The screen could not be captured.')
  return source.thumbnail
}

/** Captures `display`, downscales it for the model, and describes the geometry it was sent at. */
export async function captureDisplay(display: Display, quality: Quality): Promise<Shot> {
  const primary = display.id === screen.getPrimaryDisplay().id
  const image = process.platform === 'darwin' ? await captureMac(display, primary) : await captureDesktop(display)
  const size = image.getSize()
  const target = targetSize(size.width, size.height, quality)
  const scaled = target.width === size.width && target.height === size.height ? image : image.resize({ ...target, quality: 'best' })
  const jpeg = scaled.toJPEG(JPEG_QUALITY)
  const frame: Frame = { displayId: display.id, bounds: { ...display.bounds }, width: target.width, height: target.height }
  // Older macOS versions return the desktop without other apps' windows
  // instead of failing when Screen Recording is off.
  const warning =
    process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted'
      ? 'macOS reports Screen Recording as not granted for Eaon, so this image may show only the desktop and Eaon itself.'
      : undefined
  return { frame, jpeg, ...(warning ? { warning } : {}) }
}
