import type { Combo } from './keys'
import type { Point } from './geometry'

/**
 * What every platform's input backend offers. Points are screen points (DIP),
 * the space Electron's `screen` module and macOS CoreGraphics share; a
 * backend whose native API wants physical pixels converts them itself.
 */

export type MouseButton = 'left' | 'right' | 'middle'

/** An app the agent was working in, so keyboard focus can be handed back to it. */
export interface AppRef {
  name: string
  pid: number
  bundleId: string | null
  /** Platform window handle where apps are addressed by window (Windows, X11). */
  window?: string
}

export interface BackendCheck {
  available: boolean
  detail?: string
  /** macOS: whether the process that posts events is trusted for Accessibility. */
  trusted?: boolean
  /** macOS: whether the session is on the lock screen. */
  locked?: boolean
  /** macOS: whether the main display is asleep (screenshots come back black, clicks land on nothing anyone sees). */
  asleep?: boolean
}

/** An on-screen app window, bounds in screen points. */
export interface WindowInfo {
  app: string
  pid: number
  title: string
  x: number
  y: number
  width: number
  height: number
}

export interface InputBackend {
  readonly name: string
  check(): Promise<BackendCheck>
  move(point: Point): Promise<void>
  click(point: Point, button: MouseButton, clicks: number): Promise<void>
  drag(from: Point, to: Point): Promise<void>
  /** dx/dy in wheel clicks; positive dy scrolls down, positive dx scrolls right. */
  scroll(point: Point, dx: number, dy: number): Promise<void>
  type(text: string): Promise<void>
  key(combo: Combo): Promise<void>
  cursor(): Promise<Point>
  frontmost(): Promise<AppRef | null>
  activate(app: AppRef): Promise<void>
  /** True while the lock screen is up (macOS); false where it cannot be told. */
  locked(): Promise<boolean>
  openApp(name: string): Promise<void>
  /** On-screen app windows, front to back. Only macOS has it so far. */
  windows?(): Promise<WindowInfo[]>
  dispose(): void
}
