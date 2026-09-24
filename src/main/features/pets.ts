import { app, BrowserWindow, screen, type Rectangle } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PET_PIXELS, type PetSize, type PetSnapshot } from '@shared/pets'
import type { Feature } from './types'

/**
 * Pets: the optional floating desktop pet.
 *
 * A transparent, frameless, always-on-top window that shows only the pet. It
 * ignores the mouse (clicks fall through to whatever is underneath) until the
 * pointer is over the pet itself, which the renderer reports on hover.
 *
 * The main window owns the pet's state — it is the only renderer that can see
 * the app's activity — and streams snapshots here; this relays them to the pet
 * window, so the two never have to know about each other.
 */

const here = join(fileURLToPath(import.meta.url), '..')
// Transparent pixels around the pet: room for its thought bubble, zZz and
// hearts above it and a little to either side for the name tag.
const WINDOW_SCALE = { w: 2.4, h: 2.1 }
/** Gap kept between the pet and the edge of the screen's work area. */
const MARGIN = 8

let petWindow: BrowserWindow | null = null
let snapshot: PetSnapshot | null = null
/** Owner window we have already hooked 'closed' on, so we only hook once. */
let hookedOwner: BrowserWindow | null = null
let dragFrom: Rectangle | null = null
/** Sub-pixel x while strolling — setPosition only takes integers. */
let walkX: number | null = null

const positionFile = (): string => join(app.getPath('userData'), 'pet-window.json')

function windowSize(size: PetSize): { width: number; height: number } {
  const px = PET_PIXELS[size] ?? PET_PIXELS.medium
  return { width: Math.round(px * WINDOW_SCALE.w), height: Math.round(px * WINDOW_SCALE.h) }
}

/** Where the window goes: its remembered spot if still on a screen, else bottom-right. */
function initialBounds(size: PetSize): Rectangle {
  const { width, height } = windowSize(size)
  try {
    const saved = JSON.parse(readFileSync(positionFile(), 'utf8')) as { x: number; y: number }
    const area = screen.getDisplayMatching({ x: saved.x, y: saved.y, width, height }).workArea
    const onScreen =
      saved.x + width > area.x && saved.x < area.x + area.width && saved.y + height > area.y && saved.y < area.y + area.height
    if (onScreen) return { x: saved.x, y: saved.y, width, height }
  } catch {
    /* first run, or the file is unreadable — fall through to the corner */
  }
  const area = screen.getPrimaryDisplay().workArea
  return { x: area.x + area.width - width - 24, y: area.y + area.height - height, width, height }
}

function savePosition(): void {
  if (!petWindow || petWindow.isDestroyed()) return
  const [x, y] = petWindow.getPosition()
  try {
    writeFileSync(positionFile(), JSON.stringify({ x, y }))
  } catch {
    /* losing the spot is harmless */
  }
}

/** Keep the pet (not the transparent window around it) on its display. */
function clampX(x: number, bounds: Rectangle, size: PetSize): number {
  const area = screen.getDisplayMatching(bounds).workArea
  const inset = (bounds.width - (PET_PIXELS[size] ?? PET_PIXELS.medium)) / 2
  return Math.min(area.x + area.width - bounds.width + inset - MARGIN, Math.max(area.x - inset + MARGIN, x))
}

function openWindow(owner: BrowserWindow | null): void {
  if (petWindow && !petWindow.isDestroyed()) return
  const size = snapshot?.size ?? 'medium'
  petWindow = new BrowserWindow({
    ...initialBounds(size),
    transparent: true,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    // Never takes focus: clicking the pet must not pull Eaon to the front or
    // steal the keyboard from the app you are typing in.
    focusable: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: join(here, '../preload/index.mjs'), sandbox: false }
  })
  petWindow.setAlwaysOnTop(true, 'floating')
  // skipTransformProcessType: without it macOS briefly turns the app into a
  // UI element to do this, and the Dock icon blinks out.
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  petWindow.setIgnoreMouseEvents(true, { forward: true })
  petWindow.once('ready-to-show', () => petWindow?.showInactive())
  petWindow.on('closed', () => {
    petWindow = null
  })

  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (devServer) void petWindow.loadURL(`${devServer}#pet`)
  else void petWindow.loadFile(join(here, '../renderer/index.html'), { hash: 'pet' })

  // The pet mirrors the main window, so it goes when that window goes — and
  // on macOS, where the app outlives its window, an orphaned pet would also
  // stop `activate` from reopening Eaon (it checks for zero windows).
  if (owner && owner !== hookedOwner) {
    hookedOwner = owner
    owner.once('closed', () => {
      hookedOwner = null
      closeWindow()
    })
  }
}

function closeWindow(): void {
  if (petWindow && !petWindow.isDestroyed()) {
    savePosition()
    petWindow.destroy()
  }
  petWindow = null
}

/** Resize for a new pet size, keeping the pet's feet where they were. */
function fitToSize(size: PetSize): void {
  if (!petWindow || petWindow.isDestroyed()) return
  const old = petWindow.getBounds()
  const next = windowSize(size)
  if (old.width === next.width && old.height === next.height) return
  petWindow.setBounds({
    x: Math.round(old.x + (old.width - next.width) / 2),
    y: old.y + old.height - next.height,
    ...next
  })
}

export const petsFeature: Feature = {
  id: 'pets',
  register: ({ ipcMain }) => {
    ipcMain.handle('pets:desktop', (event, on: boolean) => {
      if (on) openWindow(BrowserWindow.fromWebContents(event.sender))
      else closeWindow()
    })

    ipcMain.on('pets:sync', (_event, next: PetSnapshot) => {
      const resized = snapshot?.size !== next.size
      snapshot = next
      if (!petWindow || petWindow.isDestroyed()) return
      if (resized) fitToSize(next.size)
      petWindow.webContents.send('pets:snapshot', next)
    })

    ipcMain.handle('pets:current', () => snapshot)

    ipcMain.on('pets:interactive', (_event, on: boolean) => {
      if (!petWindow || petWindow.isDestroyed()) return
      if (on) petWindow.setIgnoreMouseEvents(false)
      else petWindow.setIgnoreMouseEvents(true, { forward: true })
    })

    ipcMain.on('pets:drag', (_event, dx: number, dy: number, phase: 'start' | 'move' | 'end') => {
      if (!petWindow || petWindow.isDestroyed()) return
      if (phase === 'start' || !dragFrom) dragFrom = petWindow.getBounds()
      petWindow.setPosition(Math.round(dragFrom.x + dx), Math.round(dragFrom.y + dy))
      if (phase === 'end') {
        dragFrom = null
        walkX = null
        savePosition()
      }
    })

    ipcMain.handle('pets:room', () => {
      if (!petWindow || petWindow.isDestroyed()) return { left: 0, right: 0 }
      const bounds = petWindow.getBounds()
      const size = snapshot?.size ?? 'medium'
      const min = clampX(-Infinity, bounds, size)
      const max = clampX(Infinity, bounds, size)
      return { left: bounds.x - min, right: max - bounds.x }
    })

    ipcMain.on('pets:walk', (_event, dx: number) => {
      if (!petWindow || petWindow.isDestroyed()) return
      const bounds = petWindow.getBounds()
      walkX = clampX((walkX ?? bounds.x) + dx, bounds, snapshot?.size ?? 'medium')
      petWindow.setPosition(Math.round(walkX), bounds.y)
    })

    ipcMain.on('pets:settle', () => {
      walkX = null
      savePosition()
    })

    ipcMain.on('pets:poke', () => {
      if (hookedOwner && !hookedOwner.isDestroyed()) hookedOwner.webContents.send('pets:poke')
    })
  },
  dispose: closeWindow
}
