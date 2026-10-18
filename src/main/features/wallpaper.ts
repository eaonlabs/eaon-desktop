import { app, BrowserWindow, dialog, nativeImage, screen, systemPreferences, type Display, type WebContents } from 'electron'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, relative, isAbsolute } from 'node:path'
import type { WallpaperFrame } from '@shared/types'
import { store } from '../store'
import type { Feature } from './types'

/**
 * See-through windows (Settings → Appearance): the desktop's wallpaper, for
 * the window to draw behind itself lined up with the screen, so the app reads
 * as glass over the desktop with its panels frosted over it.
 *
 * The OS will not let a window see what is under it without screen-recording
 * permission, but it will say which picture the desktop shows: macOS through
 * NSWorkspace (asked with a JavaScript-for-Automation one-liner, which talks
 * to AppKit directly rather than to another app, so it needs no permission),
 * Windows through the registry. Only that file is read — never the screen.
 * Or the user picks a picture of their own: Eaon keeps a copy of it in its
 * own folder, and that copy is the only custom file it will ever read, so the
 * page can't point it anywhere else on the disk.
 *
 * A window that has the effect on asks to be told where it is; it then hears
 * its position as it moves and resizes, and which display it is on, since
 * each display can have a picture of its own.
 */

/** Each screen's frame (AppKit's coordinates, from the primary's bottom-left) and its picture. */
const MAC_SCREENS = `ObjC.import("AppKit");
const screens = $.NSScreen.screens;
const out = [];
for (let i = 0; i < screens.count; i++) {
  const s = screens.objectAtIndex(i);
  const f = s.frame;
  const url = $.NSWorkspace.sharedWorkspace.desktopImageURLForScreen(s);
  out.push({ x: f.origin.x, y: f.origin.y, w: f.size.width, h: f.size.height, path: url.isNil() ? null : url.path.js });
}
JSON.stringify(out);`

interface MacScreen {
  x: number
  y: number
  w: number
  h: number
  path: string | null
}

const run = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile(file, args, { timeout: 5000, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))))
  )

/** Where Eaon keeps the user's own wallpaper. */
const customDir = (): string => join(app.getPath('userData'), 'wallpapers')

/** `path`, if it is Eaon's own copy of a chosen picture and still there. */
async function customPath(path: string | null): Promise<string | null> {
  if (!path) return null
  const rel = relative(customDir(), path)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return (await stat(path).then((s) => s.isFile()).catch(() => false)) ? path : null
}

const IMAGE_TYPES = ['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif', 'bmp', 'tif', 'tiff']

/**
 * Asks for a picture, keeps a copy of it, and drops the one it replaces.
 * Resolves to the copy and a small preview of it, or null if nothing was
 * picked; rejects when the file isn't a picture Eaon can open.
 */
async function chooseCustom(window: BrowserWindow | null): Promise<{ path: string; preview: string } | null> {
  const options = { title: 'Choose a wallpaper', properties: ['openFile' as const], filters: [{ name: 'Images', extensions: IMAGE_TYPES }] }
  const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  const source = picked.filePaths[0]
  if (picked.canceled || !source) return null
  const dir = customDir()
  await mkdir(dir, { recursive: true })
  const path = join(dir, `wallpaper-${Date.now()}${extname(source).toLowerCase() || '.jpg'}`)
  await copyFile(source, path)
  const preview = await previewOf(path)
  if (!preview) {
    await rm(path, { force: true })
    throw new Error('That file isn’t a picture Eaon can open.')
  }
  for (const name of await readdir(dir)) if (join(dir, name) !== path) await rm(join(dir, name), { force: true })
  return { path, preview }
}

/** A picture as an image Electron can resize: HEIC through `sips` on macOS. */
async function openImage(path: string): Promise<Electron.NativeImage> {
  let image = nativeImage.createFromPath(path)
  if (image.isEmpty() && process.platform === 'darwin') {
    const dir = await mkdtemp(join(tmpdir(), 'eaon-wallpaper-'))
    const out = join(dir, 'wallpaper.jpg')
    await run('sips', ['-s', 'format', 'jpeg', path, '--out', out])
    image = nativeImage.createFromPath(out)
    await rm(dir, { recursive: true, force: true })
  }
  return image
}

/** A thumbnail for Settings, as a data URL. */
async function previewOf(path: string): Promise<string | null> {
  const image = await openImage(path).catch(() => null)
  if (!image || image.isEmpty()) return null
  return `data:image/jpeg;base64,${image.resize({ width: 320, quality: 'good' }).toJPEG(80).toString('base64')}`
}

/** The picture behind the window on `display`: the user's own when they chose one, else the desktop's. */
async function wallpaperPath(display: Display): Promise<string | null> {
  const see = store.getSettings().appearance.seeThrough
  if (see.source === 'custom') {
    const own = await customPath(see.custom)
    if (own) return own
  }
  return desktopPath(display)
}

/** The picture on `display`, or null when the OS won't say. */
async function desktopPath(display: Display): Promise<string | null> {
  if (process.platform === 'darwin') {
    const screens = JSON.parse(await run('osascript', ['-l', 'JavaScript', '-e', MAC_SCREENS])) as MacScreen[]
    // AppKit measures up from the primary screen's bottom; Electron, down from its top.
    const primaryHeight = screens[0]?.h ?? 0
    const { x, y, width, height } = display.bounds
    const match = screens.find((s) => Math.round(s.x) === x && Math.round(primaryHeight - (s.y + s.h)) === y && Math.round(s.w) === width && Math.round(s.h) === height)
    return (match ?? screens[0])?.path ?? null
  }
  if (process.platform === 'win32') {
    const out = await run('reg', ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'WallPaper'])
    const path = /WallPaper\s+REG_SZ\s+(.+)/i.exec(out)?.[1]?.trim()
    return path || null
  }
  return null
}

/**
 * The picture as the display shows it — filling the screen, cropped to its
 * shape — at up to twice its point size, as a JPEG data URL. HEIC (macOS's
 * own pictures) is converted with `sips` when the image loader can't read it.
 */
async function loadPicture(path: string, display: Display): Promise<string | null> {
  const image = await openImage(path)
  if (image.isEmpty()) return null
  const scale = Math.min(2, display.scaleFactor || 1)
  const target = { width: Math.round(display.bounds.width * scale), height: Math.round(display.bounds.height * scale) }
  const size = image.getSize()
  const cover = Math.max(target.width / size.width, target.height / size.height)
  const resized = image.resize({ width: Math.ceil(size.width * cover), height: Math.ceil(size.height * cover), quality: 'good' })
  const got = resized.getSize()
  const cropped = resized.crop({
    x: Math.max(0, Math.floor((got.width - target.width) / 2)),
    y: Math.max(0, Math.floor((got.height - target.height) / 2)),
    width: Math.min(target.width, got.width),
    height: Math.min(target.height, got.height)
  })
  return `data:image/jpeg;base64,${cropped.toJPEG(86).toString('base64')}`
}

/** One picture per display and file version: re-reading a 4K HEIC on every focus would show. */
const cache = new Map<string, Promise<string | null>>()

async function pictureFor(display: Display): Promise<string | null> {
  const path = await wallpaperPath(display).catch(() => null)
  if (!path) return null
  const modified = await stat(path).then((s) => s.mtimeMs).catch(() => 0)
  const key = `${display.id}:${display.bounds.width}x${display.bounds.height}:${path}:${modified}`
  let picture = cache.get(key)
  if (!picture) {
    picture = loadPicture(path, display).catch(() => null)
    cache.set(key, picture)
    // A few displays' worth is plenty; older versions go.
    while (cache.size > 4) cache.delete(cache.keys().next().value as string)
  }
  return picture
}

function frameOf(window: BrowserWindow): WallpaperFrame {
  const content = window.getContentBounds()
  const display = screen.getDisplayMatching(content)
  return { display: { id: display.id, ...display.bounds }, content }
}

/** Windows whose page draws the wallpaper, so their moves are worth sending. */
const watching = new Set<number>()

/**
 * Moving the window by hand while it is see-through. macOS drags a window in
 * the window server and only tells the app where it ended up, so a window
 * dragged the usual way had its wallpaper catch up only once let go. Here
 * the app moves the window itself: every frame it reads the pointer, puts the
 * window under it, and tells the page where the window now is, so the
 * picture moves with the window instead of after it.
 */
interface Drag {
  window: BrowserWindow
  /** The pointer's offset from the window's corner when the drag began. */
  dx: number
  dy: number
  timer: ReturnType<typeof setInterval>
}
const drags = new Map<number, Drag>()

function endDrag(id: number): void {
  const drag = drags.get(id)
  if (!drag) return
  clearInterval(drag.timer)
  drags.delete(id)
  // Where it settled, and on which display, in case it crossed to another.
  if (!drag.window.isDestroyed()) drag.window.webContents.send('wallpaper:frame', frameOf(drag.window))
}

function startDrag(window: BrowserWindow): void {
  const id = window.webContents.id
  endDrag(id)
  const cursor = screen.getCursorScreenPoint()
  const [x, y] = window.getPosition()
  const drag: Drag = {
    window,
    dx: cursor.x - x,
    dy: cursor.y - y,
    timer: setInterval(() => {
      if (window.isDestroyed()) return endDrag(id)
      const at = screen.getCursorScreenPoint()
      const nx = at.x - drag.dx
      const ny = at.y - drag.dy
      const [cx, cy] = window.getPosition()
      if (nx === cx && ny === cy) return
      window.setPosition(nx, ny)
      if (watching.has(id)) window.webContents.send('wallpaper:frame', frameOf(window))
    }, 8)
  }
  drags.set(id, drag)
}

function track(window: BrowserWindow): void {
  const send = (): void => {
    if (window.isDestroyed() || !watching.has(window.webContents.id)) return
    // A drag reports its own frames, every tick; this would only repeat them.
    if (drags.has(window.webContents.id)) return
    window.webContents.send('wallpaper:frame', frameOf(window))
  }
  for (const event of ['move', 'moved', 'resize', 'enter-full-screen', 'leave-full-screen', 'show', 'restore', 'focus'] as const) {
    window.on(event as 'move', send)
  }
}

export const wallpaperFeature: Feature = {
  id: 'wallpaper',
  register: ({ ipcMain, getWindows }) => {
    for (const window of getWindows()) track(window)
    app.on('browser-window-created', (_e, window) => track(window))
    // Displays rearranged, or a picture changed on one: every watching window looks again.
    const changed = (): void => {
      for (const window of getWindows()) if (watching.has(window.webContents.id)) window.webContents.send('wallpaper:frame', frameOf(window))
    }
    screen.on('display-metrics-changed', changed)
    screen.on('display-added', changed)
    screen.on('display-removed', changed)

    ipcMain.handle('wallpaper:watch', (event, on: unknown): WallpaperFrame | null => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) return null
      const contents: WebContents = event.sender
      if (on === true) {
        watching.add(contents.id)
        contents.once('destroyed', () => {
          watching.delete(contents.id)
          endDrag(contents.id)
        })
        return frameOf(window)
      }
      watching.delete(contents.id)
      endDrag(contents.id)
      return null
    })

    // The page saw a press on a title bar (while see-through, on macOS) and
    // hands the drag to main, which knows where the pointer really is.
    ipcMain.on('wallpaper:drag', (event, phase: unknown) => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) return
      if (phase === 'start') startDrag(window)
      else endDrag(event.sender.id)
    })
    // A double-click on a title bar does what the system's setting says.
    ipcMain.on('wallpaper:title-double-click', (event) => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) return
      const action = process.platform === 'darwin' ? systemPreferences.getUserDefault('AppleActionOnDoubleClick', 'string') : 'Maximize'
      if (action === 'None') return
      if (action === 'Minimize') return window.minimize()
      if (window.isMaximized()) window.unmaximize()
      else window.maximize()
    })

    ipcMain.handle('wallpaper:choose', (event) => chooseCustom(BrowserWindow.fromWebContents(event.sender)))
    ipcMain.handle('wallpaper:preview', async (): Promise<string | null> => {
      const own = await customPath(store.getSettings().appearance.seeThrough.custom)
      return own ? previewOf(own) : null
    })

    ipcMain.handle('wallpaper:picture', async (_event, displayId: unknown): Promise<string | null> => {
      const display = screen.getAllDisplays().find((d) => d.id === displayId) ?? screen.getPrimaryDisplay()
      return pictureFor(display)
    })
  }
}
