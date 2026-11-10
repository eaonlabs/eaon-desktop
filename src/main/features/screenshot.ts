import { desktopCapturer, screen, systemPreferences } from 'electron'
import type { CaptureChoice, CaptureChoices } from '@shared/library'
import { requestScreenAccess } from './computer/capture'
import { withEaonHidden } from './computer/session'

/**
 * Attaching a screenshot from the message box: pick a screen or a window, and
 * the picture becomes an attachment like a pasted one.
 *
 * Nothing is captured until the button is clicked, nothing is written until a
 * picture is chosen, and the only file left behind is the attachment itself
 * (library.ts saves it). The previews in the picker are small, live only in the
 * window that asked, and are never stored.
 */

export type CaptureResult = { ok: true; png: Buffer; name: string } | { ok: false; permission: boolean; message: string }

/** The slice of Electron's NativeImage that is used, so tests can stand in for it. */
export interface Picture {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(options: { width?: number; height?: number; quality?: 'good' | 'better' | 'best' }): Picture
  toPNG(): Buffer
  toJPEG(quality: number): Buffer
}

export interface CapturerSource {
  id: string
  name: string
  thumbnail: Picture
}

export interface CaptureDeps {
  getSources(options: { types: ('screen' | 'window')[]; thumbnailSize: { width: number; height: number }; fetchWindowIcons: boolean }): Promise<CapturerSource[]>
  /** macOS's answer for Screen Recording; 'not-needed' elsewhere. */
  access(): string
  /** Asks macOS for it, which is what puts Eaon in its list (and may show its prompt). */
  askAccess(): Promise<void>
  /** The long edge to capture a screen at, in pixels. */
  screenEdge(): number
  /** Runs `fn` with Eaon's own windows out of the way, so a screen capture shows the other apps. */
  hideApp<T>(fn: () => Promise<T>): Promise<T>
}

/** The picker's thumbnails: large enough to tell windows apart, small enough to be cheap. */
const PREVIEW_WIDTH = 320
const PREVIEW_SIZE = { width: PREVIEW_WIDTH, height: 200 }
/** A window is captured at up to this long edge: a model reads no more than about that, and every window is captured in the one call. */
const WINDOW_EDGE = 1600
/** A screen is captured at up to this long edge (a Retina display's own is larger). */
const SCREEN_EDGE = 2560

export const SCREEN_DENIED =
  'Eaon doesn’t have permission to see the screen. Turn on Screen Recording for Eaon in System Settings → Privacy & Security → Screen & System Audio Recording, then quit and reopen Eaon.'
export const SCREEN_RESTRICTED = 'Screen recording is blocked on this Mac by a device policy, so Eaon can’t take a screenshot.'
const CAPTURE_FAILED = 'The screen couldn’t be captured.'

/** Whether Eaon may capture the screen, and the plain-words reason when not. On a Mac that has never been asked, asking is what shows the system prompt. */
export async function checkAccess(deps: CaptureDeps): Promise<{ ok: true } | { ok: false; message: string }> {
  let status = deps.access()
  if (status === 'not-determined') {
    await deps.askAccess()
    status = deps.access()
  }
  // 'unknown' is a system that can't say: try, and a blank picture is reported as a failed capture.
  if (status === 'granted' || status === 'not-needed' || status === 'unknown') return { ok: true }
  return { ok: false, message: status === 'restricted' ? SCREEN_RESTRICTED : SCREEN_DENIED }
}

/** The screens and windows that can be captured, with previews. Windows with no name or nothing in them (menu bar items, helpers) are left out. */
export async function listCaptureChoices(deps: CaptureDeps): Promise<CaptureChoices> {
  const access = await checkAccess(deps)
  if (!access.ok) return { ok: false, permission: true, message: access.message }
  let sources: CapturerSource[]
  try {
    sources = await deps.getSources({ types: ['screen', 'window'], thumbnailSize: PREVIEW_SIZE, fetchWindowIcons: false })
  } catch {
    return { ok: false, permission: false, message: CAPTURE_FAILED }
  }
  const choices: CaptureChoice[] = []
  let screens = 0
  for (const source of sources) {
    const kind = source.id.startsWith('screen:') ? 'screen' : source.id.startsWith('window:') ? 'window' : null
    if (!kind || source.thumbnail.isEmpty()) continue
    if (kind === 'window' && !source.name.trim()) continue
    if (kind === 'screen') screens++
    const small = source.thumbnail.getSize().width > PREVIEW_WIDTH ? source.thumbnail.resize({ width: PREVIEW_WIDTH, quality: 'good' }) : source.thumbnail
    const name = kind === 'screen' && source.name.trim() === '' ? `Screen ${screens}` : source.name.trim()
    choices.push({ id: source.id, name, kind, preview: `data:image/jpeg;base64,${small.toJPEG(70).toString('base64')}` })
  }
  // Screens first, then windows, each in the order the system gave them.
  choices.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'screen' ? -1 : 1))
  if (choices.length === 0) return { ok: false, permission: false, message: CAPTURE_FAILED }
  return { ok: true, choices }
}

/**
 * The picture of one choice from the list, as PNG bytes. It is captured now,
 * not when the list was made, so it shows the screen or window as it is; a
 * screen is captured with Eaon out of the way.
 */
export async function captureChoice(id: unknown, deps: CaptureDeps): Promise<CaptureResult> {
  const kind = typeof id === 'string' ? (id.startsWith('screen:') ? 'screen' : id.startsWith('window:') ? 'window' : null) : null
  if (!kind || typeof id !== 'string') return { ok: false, permission: false, message: 'That can’t be captured.' }
  const access = await checkAccess(deps)
  if (!access.ok) return { ok: false, permission: true, message: access.message }
  const edge = kind === 'screen' ? deps.screenEdge() : WINDOW_EDGE
  const take = (): Promise<CapturerSource[]> => deps.getSources({ types: [kind], thumbnailSize: { width: edge, height: edge }, fetchWindowIcons: false })
  try {
    const sources = await (kind === 'screen' ? deps.hideApp(take) : take())
    const source = sources.find((s) => s.id === id)
    if (!source || source.thumbnail.isEmpty()) {
      return { ok: false, permission: false, message: kind === 'window' ? 'That window is gone or can’t be captured. Pick again.' : CAPTURE_FAILED }
    }
    return { ok: true, png: source.thumbnail.toPNG(), name: source.name.trim() }
  } catch {
    return { ok: false, permission: false, message: CAPTURE_FAILED }
  }
}

/** The real thing: Electron's capturer, macOS's permission and Eaon's own windows hidden for a screen. */
export function electronCapture(): CaptureDeps {
  return {
    getSources: (options) => desktopCapturer.getSources(options) as Promise<CapturerSource[]>,
    access: () => {
      if (process.platform !== 'darwin') return 'not-needed'
      try {
        return systemPreferences.getMediaAccessStatus('screen')
      } catch {
        return 'unknown'
      }
    },
    askAccess: requestScreenAccess,
    screenEdge: () => {
      const longest = Math.max(...screen.getAllDisplays().map((d) => Math.max(d.bounds.width, d.bounds.height) * d.scaleFactor), 0)
      return Math.round(Math.min(SCREEN_EDGE, longest || SCREEN_EDGE))
    },
    hideApp: withEaonHidden
  }
}
