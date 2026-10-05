import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { desktopCapturer, nativeImage, screen, systemPreferences, type Display, type NativeImage } from 'electron'
import { orderDisplays, targetSize, type Frame, type Quality, type Rect } from './geometry'
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
  /** The capture at native resolution, when asked for (saving it to a file). */
  full?: NativeImage
  /** Set when the capture worked but probably shows less than the real screen. */
  warning?: string
}

export interface CaptureOptions {
  /** Only this part of the display, in screen points (an app's window, a zoomed region). */
  region?: Rect
  /** Keep the native-resolution image on the shot. */
  keepFull?: boolean
}

/** Displays in a stable order: the primary first, then left to right, top to bottom. */
export function orderedDisplays(): Display[] {
  return orderDisplays(screen.getPrimaryDisplay().id, screen.getAllDisplays())
}

export class ScreenCaptureDenied extends Error {}

async function captureMac(display: Display, primary: boolean, region?: Rect): Promise<NativeImage> {
  // PNG for a region: it is small, and saved files and zoomed-in text stay crisp.
  const type = region ? 'png' : 'jpg'
  const file = join(tmpdir(), `eaon-shot-${randomUUID()}.${type}`)
  const { x, y, width, height } = region ?? display.bounds
  // -m is the documented way to get the main display; other displays are
  // captured by their rect in global points, which avoids guessing how
  // screencapture numbers displays for -D.
  const target = primary && !region ? ['-m'] : ['-R', `${x},${y},${width},${height}`]
  try {
    await run('/usr/sbin/screencapture', ['-x', '-t', type, ...target, file], { timeout: 20_000 })
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

/** Cuts `region` (screen points) out of a whole-display capture. */
function cropTo(image: NativeImage, display: Display, region: Rect): NativeImage {
  const size = image.getSize()
  const sx = size.width / display.bounds.width
  const sy = size.height / display.bounds.height
  return image.crop({
    x: Math.round((region.x - display.bounds.x) * sx),
    y: Math.round((region.y - display.bounds.y) * sy),
    width: Math.max(1, Math.round(region.width * sx)),
    height: Math.max(1, Math.round(region.height * sy))
  })
}

/** Captures `display` (or part of it), downscales it for the model, and describes the geometry it was sent at. */
export async function captureDisplay(display: Display, quality: Quality, options: CaptureOptions = {}): Promise<Shot> {
  const primary = display.id === screen.getPrimaryDisplay().id
  const { region } = options
  const image =
    process.platform === 'darwin'
      ? await captureMac(display, primary, region)
      : region
        ? cropTo(await captureDesktop(display), display, region)
        : await captureDesktop(display)
  const size = image.getSize()
  const target = targetSize(size.width, size.height, quality)
  const scaled = target.width === size.width && target.height === size.height ? image : image.resize({ ...target, quality: 'best' })
  const jpeg = scaled.toJPEG(JPEG_QUALITY)
  const frame: Frame = {
    displayId: display.id,
    bounds: { ...(region ?? display.bounds) },
    display: { ...display.bounds },
    width: target.width,
    height: target.height
  }
  // Older macOS versions return the desktop without other apps' windows
  // instead of failing when Screen Recording is off.
  const warning =
    process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted'
      ? 'macOS reports Screen Recording as not granted for Eaon, so this image may show only the desktop and Eaon itself.'
      : undefined
  return { frame, jpeg, ...(options.keepFull ? { full: image } : {}), ...(warning ? { warning } : {}) }
}
