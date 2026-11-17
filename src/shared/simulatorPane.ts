/**
 * Eaon's Device pane: an iOS simulator shown and used inside the app, in the
 * dock beside a conversation, instead of in Xcode's own Simulator (or, from
 * Xcode 27, DeviceHub) window. Main boots it with simctl and runs serve-sim
 * on it (main/features/simulatorPane.ts) for its screen and its input; the
 * dock's Device surface draws the device around the frames it sends.
 */

export type HardwareButton = 'home' | 'lock' | 'volume-up' | 'volume-down' | 'action'

/** How the device is turned, in serve-sim's (UIKit interface orientation) names. */
export type SimOrientation = 'portrait' | 'landscape_left' | 'portrait_upside_down' | 'landscape_right'

/** One touch: begin, move, end. In fractions (0–1) of the screen in its native portrait frame. */
export interface TouchFrame {
  type: 'begin' | 'move' | 'end'
  x: number
  y: number
  /** A touch from a screen edge: 3 is the bottom, for the swipe home. */
  edge?: number
}

export interface PaneDevice {
  udid: string
  name: string
  /** "iOS 26.1". */
  runtime: string
  /** simctl's: Booted, Booting, Shutdown, Shutting Down. */
  state: string
}

export interface PaneProblem {
  /** No Mac; no (usable) Xcode; Xcode but no iOS runtime or device; anything else. */
  kind: 'platform' | 'xcode' | 'devices' | 'other'
  message: string
}

export interface PaneState {
  problem: PaneProblem | null
  devices: PaneDevice[]
}

/** A device's session in the pane: whether touches reach it, and if not why; how it is turned. */
export interface PaneSession {
  udid: string
  /** Touches, keys and buttons go in. False until serve-sim is up, and while something blocks it. */
  live: boolean
  /** Why it only shows (screenshots instead of the live stream, or input taken by Device Hub). */
  problem: string | null
  orientation: SimOrientation
}

/** One of a frame's pieces, drawn: a PNG data URL, and its size in the device's points. */
export interface FramePiece {
  src: string
  width: number
  height: number
}

/** A button on the device's edge, as Xcode's frame places it. */
export interface DeviceButton {
  /** The frame's name for it: action, volume-up, volume-down, power, home, mute. */
  name: string
  /** What pressing it sends; null for one with no press (the ringer switch). */
  press: HardwareButton | null
  /** The edge it is on. Left and right: x from that edge (it sticks out by the image's width minus x), y from the top. Top: x from the left, or from the right when negative. Bottom: x from the centre, y up from the bottom. */
  anchor: 'left' | 'right' | 'top' | 'bottom'
  x: number
  y: number
  /** Drawn over the frame (a home button) rather than tucked under its edge. */
  onTop: boolean
  image: FramePiece
  down: FramePiece | null
}

/**
 * How a device looks, read from the Mac's Xcode (main/features/simulatorLook.ts):
 * its screen in points with each corner's radius (top left, top right, bottom
 * right, bottom left), and the frame Simulator draws around it — how far it
 * reaches past the screen on each side, room beyond that for the buttons,
 * and its nine pieces. No frame when Xcode has none for the device.
 */
export interface DeviceLook {
  screen: { width: number; height: number; scale: number; corners: [number, number, number, number] }
  frame: {
    border: { top: number; left: number; bottom: number; right: number }
    pad: { top: number; left: number; bottom: number; right: number }
    pieces: Record<'topLeft' | 'top' | 'topRight' | 'right' | 'bottomRight' | 'bottom' | 'bottomLeft' | 'left', FramePiece>
  } | null
  buttons: DeviceButton[]
}

export interface PaneFrame {
  udid: string
  /** A JPEG of the whole screen, at the device's resolution. */
  data: Uint8Array
  width: number
  height: number
}

/** Turning the device a quarter: clockwise ("right") or back. */
const TURNS: SimOrientation[] = ['portrait', 'landscape_left', 'portrait_upside_down', 'landscape_right']

export function turned(now: SimOrientation, way: 'left' | 'right'): SimOrientation {
  const at = TURNS.indexOf(now)
  return TURNS[(at + (way === 'right' ? 1 : 3)) % 4]
}

/**
 * How far the device is turned from its native portrait, clockwise in
 * degrees: the pane turns the whole device — frame, buttons and screen —
 * by this. The screen's pixels stay in the native frame.
 */
export function deviceTurn(orientation: SimOrientation): 0 | 90 | -90 | 180 {
  if (orientation === 'landscape_left') return 90
  if (orientation === 'landscape_right') return -90
  if (orientation === 'portrait_upside_down') return 180
  return 0
}

/** A point on the picture as shown (fractions of what the viewer sees) to the screen's native frame. */
export function toNative(point: { x: number; y: number }, turn: 0 | 90 | -90 | 180): { x: number; y: number } {
  const { x, y } = point
  if (turn === 90) return { x: y, y: 1 - x }
  if (turn === -90) return { x: 1 - y, y: x }
  if (turn === 180) return { x: 1 - x, y: 1 - y }
  return { x, y }
}

/** A touch that starts this close to the bottom (as shown) is the home indicator's: the swipe home. */
export const HOME_BAND = 0.93

/** The screen's corner radius as a share of its width: rounder on the newer iPhones, square on the home-button ones. */
export function screenCorner(name: string): number {
  if (/iPad/i.test(name)) return /iPad (\(|mini \(5|Air \(3)/i.test(name) ? 0 : 0.035
  if (/iPhone (SE|8|7|6)/i.test(name)) return 0
  return 0.13
}

/** Puts a message written for the agent ("Ask the user to …, then try again.") in words for the person reading the pane. */
export function forPeople(message: string): string {
  return message
    .replace(/Ask the user to (\w)/g, (_m, c: string) => c.toUpperCase())
    .replace(/, or to (\w)/g, ', or $1')
    .replace(/`([^`]+)`/g, '“$1”')
    .replace(/,? then try again\.?/gi, '.')
    .replace(/Eaon's Simulator tool/g, "Eaon's Device pane")
}
