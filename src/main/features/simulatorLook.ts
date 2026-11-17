import { existsSync } from 'node:fs'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { DeviceButton, DeviceLook, FramePiece, HardwareButton } from '@shared/simulatorPane'
import { ensureEnvironment, runProgram, simctl, type SimDevice } from './simulator'

/**
 * How a device looks, from the Xcode on the Mac rather than guessed: its
 * screen's size, scale and corner radii from its device type's
 * capabilities, and its frame — the bezel and the side buttons Simulator
 * draws — from the DeviceKit "chrome" that device type names. A chrome is a
 * frame in nine pieces (four corners, four edges that stretch) around the
 * screen, how far it reaches past the screen on each side, and each
 * button's art and place. The pieces are PDFs, drawn once to PNGs in Eaon's
 * own folder; nothing of Xcode's is shipped with Eaon.
 */

const SIPS = '/usr/bin/sips'
const PLUTIL = '/usr/bin/plutil'
/** Pixels per point the frame's pieces are drawn at: sharp on a Retina screen at any size the pane shows. */
const DRAW_SCALE = 3

interface Chrome {
  images?: Record<string, string | Record<string, number>> & {
    sizing?: { leftWidth: number; rightWidth: number; topHeight: number; bottomHeight: number }
    devicePadding?: { top: number; left: number; bottom: number; right: number }
  }
  inputs?: {
    name: string
    image?: string
    imageDown?: string
    onTop?: boolean
    anchor: 'left' | 'right' | 'top' | 'bottom'
    offsets?: { normal?: { x: number; y: number } }
  }[]
}

/** A device type's bundle, by its identifier (simctl knows where each is). */
const bundles = new Map<string, string>()

async function typeBundle(type: string): Promise<string | null> {
  if (bundles.has(type)) return bundles.get(type) ?? null
  const listed = JSON.parse(await simctl(['list', 'devicetypes', '-j'])) as { devicetypes?: { identifier?: string; bundlePath?: string }[] }
  for (const t of listed.devicetypes ?? []) if (t.identifier && t.bundlePath) bundles.set(t.identifier, t.bundlePath)
  return bundles.get(type) ?? null
}

/** A plist as JSON (plutil can read the binary ones too). */
async function plist<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse((await runProgram(PLUTIL, ['-convert', 'json', '-o', '-', file], { timeout: 10_000 })).stdout) as T
  } catch {
    return null
  }
}

/** Where a chrome lives: DeviceKit's (Xcode 26 on), or a simulator chrome inside older Xcodes. */
async function chromeFolder(identifier: string): Promise<string | null> {
  const name = identifier.split('.').pop()
  if (!name) return null
  const developer = await ensureEnvironment().catch(() => null)
  const places = [
    join('/Library/Developer/DeviceKit/Chrome', `${name}.devicechrome`, 'Contents/Resources'),
    ...(developer ? [join(developer, 'Platforms/iPhoneOS.platform/Library/Developer/CoreSimulator/Profiles/Chrome', `${name}.simdevicechrome`, 'Contents/Resources')] : []),
    join('/Library/Developer/CoreSimulator/Profiles/Chrome', `${name}.simdevicechrome`, 'Contents/Resources')
  ]
  return places.find((place) => existsSync(join(place, 'chrome.json'))) ?? null
}

/** A PDF piece's size in points, as sips reads it. */
async function pdfSize(file: string): Promise<{ width: number; height: number } | null> {
  try {
    const { stdout } = await runProgram(SIPS, ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { timeout: 10_000 })
    const width = Number(/pixelWidth:\s*([\d.]+)/.exec(stdout)?.[1])
    const height = Number(/pixelHeight:\s*([\d.]+)/.exec(stdout)?.[1])
    return width > 0 && height > 0 ? { width, height } : null
  } catch {
    return null
  }
}

/** A piece drawn to a PNG (once, kept with the chrome's version) as a data URL, with its size in points. */
async function piece(folder: string, name: string, cache: string): Promise<FramePiece | null> {
  const pdf = join(folder, `${name}.pdf`)
  if (!existsSync(pdf)) return null
  const size = await pdfSize(pdf)
  if (!size) return null
  const png = join(cache, `${name}.png`)
  if (!existsSync(png)) {
    try {
      await runProgram(SIPS, ['-s', 'format', 'png', '-Z', String(Math.ceil(Math.max(size.width, size.height) * DRAW_SCALE)), pdf, '--out', png], { timeout: 20_000 })
    } catch {
      return null
    }
  }
  try {
    return { src: `data:image/png;base64,${(await readFile(png)).toString('base64')}`, width: size.width, height: size.height }
  } catch {
    return null
  }
}

/** The pane's names for the buttons a chrome has (the ringer switch has no press). */
const BUTTON: Record<string, HardwareButton> = { home: 'home', power: 'lock', 'volume-up': 'volume-up', 'volume-down': 'volume-down', action: 'action' }

const PIECES = ['topLeft', 'top', 'topRight', 'right', 'bottomRight', 'bottom', 'bottomLeft', 'left'] as const

const looks = new Map<string, Promise<DeviceLook | null>>()

/** How `target` looks; null when its device type says nothing usable (the pane then draws its own frame). */
export function deviceLook(target: SimDevice): Promise<DeviceLook | null> {
  const key = target.type ?? target.udid
  let look = looks.get(key)
  if (!look) {
    look = readLook(target).catch(() => null)
    looks.set(key, look)
    // A failure is asked again next time (Xcode may have been fixed meanwhile).
    void look.then((found) => !found && looks.delete(key))
  }
  return look
}

async function readLook(target: SimDevice): Promise<DeviceLook | null> {
  if (!target.type) return null
  const bundle = await typeBundle(target.type)
  if (!bundle) return null
  const capabilities = await plist<{ capabilities?: { displays?: Record<string, unknown>[]; DeviceCornerRadius?: number } }>(join(bundle, 'Contents/Resources/capabilities.plist'))
  const display = capabilities?.capabilities?.displays?.find((d) => d.displayType === 'integrated') as
    | { width?: number; height?: number; scale?: number; chromeIdentifier?: string; cornerRadiusUL?: number; cornerRadiusUR?: number; cornerRadiusLR?: number; cornerRadiusLL?: number }
    | undefined
  if (!display?.width || !display.height || !display.scale) return null
  const radius = capabilities?.capabilities?.DeviceCornerRadius ?? 0
  const look: DeviceLook = {
    screen: {
      width: display.width / display.scale,
      height: display.height / display.scale,
      scale: display.scale,
      corners: [display.cornerRadiusUL ?? radius, display.cornerRadiusUR ?? radius, display.cornerRadiusLR ?? radius, display.cornerRadiusLL ?? radius]
    },
    frame: null,
    buttons: []
  }

  const folder = display.chromeIdentifier ? await chromeFolder(display.chromeIdentifier) : null
  if (!folder) return look
  const chrome = JSON.parse(await readFile(join(folder, 'chrome.json'), 'utf8')) as Chrome
  const sizing = chrome.images?.sizing
  if (!chrome.images || !sizing) return look
  const version = Math.round((await stat(join(folder, 'chrome.json'))).mtimeMs)
  const cache = join(app.getPath('userData'), 'simulator-chrome', `${folder.split('/').slice(-3, -2)[0]}-${version}`)
  await mkdir(cache, { recursive: true })

  const pieces = {} as NonNullable<DeviceLook['frame']>['pieces']
  for (const name of PIECES) {
    const file = chrome.images[name]
    const drawn = typeof file === 'string' ? await piece(folder, file, cache) : null
    if (!drawn) return look
    pieces[name] = drawn
  }
  const pad = chrome.images.devicePadding ?? { top: 0, left: 0, bottom: 0, right: 0 }
  look.frame = {
    border: { top: sizing.topHeight, left: sizing.leftWidth, bottom: sizing.bottomHeight, right: sizing.rightWidth },
    pad,
    pieces
  }
  for (const input of chrome.inputs ?? []) {
    if (!input.image) continue
    const up = await piece(folder, input.image, cache)
    if (!up) continue
    const down = input.imageDown ? await piece(folder, input.imageDown, cache) : null
    const button: DeviceButton = {
      name: input.name,
      press: BUTTON[input.name] ?? null,
      anchor: input.anchor,
      x: input.offsets?.normal?.x ?? 0,
      y: input.offsets?.normal?.y ?? 0,
      onTop: input.onTop ?? false,
      image: up,
      down
    }
    look.buttons.push(button)
  }
  return look
}
