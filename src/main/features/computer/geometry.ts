/**
 * Coordinate mapping between the screenshots the model sees and the screen
 * the pointer moves on. Pure functions, so they can be unit tested.
 *
 * Three spaces are involved:
 * - screen points (Electron's DIP; the same as CoreGraphics' global
 *   coordinates on macOS): what `display.bounds` is in and what input uses;
 * - physical pixels: points × scale factor, what a screen capture returns;
 * - screenshot pixels: the downscaled image the model is sent.
 *
 * The model only ever speaks in screenshot pixels. Mapping straight from
 * those to points through the display's bounds (never through an assumed
 * scale factor) keeps clicks right on Retina and non-Retina displays alike.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

export type Quality = 'balanced' | 'sharp'

/**
 * Long edge of the image sent to the model. Balanced matches the resolution
 * computer-use models are most accurate at; Sharp keeps small text legible on
 * large displays at roughly 1.6× the tokens.
 */
export const LONG_EDGE: Record<Quality, number> = { balanced: 1280, sharp: 1600 }

/** What one screenshot covered: the display it showed and the size it was sent at. */
export interface Frame {
  displayId: number
  /**
   * What the screenshot shows, in screen points: the whole display, or part
   * of it (one app's window, a zoomed-in region).
   */
  bounds: Rect
  /** The whole display's bounds when it was captured; absent means `bounds` is the whole display. */
  display?: Rect
  /** Screenshot size in pixels. */
  width: number
  height: number
}

export function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** The part of `rect` inside `within`, or null when they don't overlap. Rounded to whole points, as screencapture wants. */
export function clipRect(rect: Rect, within: Rect): Rect | null {
  const x = Math.max(rect.x, within.x)
  const y = Math.max(rect.y, within.y)
  const right = Math.min(rect.x + rect.width, within.x + within.width)
  const bottom = Math.min(rect.y + rect.height, within.y + within.height)
  if (right - x < 1 || bottom - y < 1) return null
  return { x: Math.round(x), y: Math.round(y), width: Math.round(right - x), height: Math.round(bottom - y) }
}

/**
 * Screenshot pixels [x, y, width, height] of `frame` → the screen-point rect
 * they cover, for zooming into part of the latest screenshot.
 */
export function regionToScreen(frame: Frame, region: [number, number, number, number]): Rect {
  const [x, y, w, h] = region
  if (![x, y, w, h].every(Number.isFinite) || w < 1 || h < 1) throw new Error('"region" is [x, y, width, height] in screenshot pixels, width and height at least 1.')
  const topLeft = toScreen(frame, x, y)
  const bottomRight = toScreen(frame, Math.min(frame.width - 1, x + w), Math.min(frame.height - 1, y + h))
  return { x: topLeft.x, y: topLeft.y, width: bottomRight.x - topLeft.x, height: bottomRight.y - topLeft.y }
}

/** Downscaled size for a capture of `width`×`height` pixels. Never upscales. */
export function targetSize(width: number, height: number, quality: Quality): { width: number; height: number } {
  const longEdge = Math.max(width, height)
  const scale = Math.min(1, LONG_EDGE[quality] / longEdge)
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/**
 * The frame a display would be captured at, before any screenshot exists —
 * so coordinates still mean something if the model acts before looking.
 */
export function frameFor(display: { id: number; bounds: Rect; scaleFactor: number }, quality: Quality): Frame {
  const physical = {
    width: Math.round(display.bounds.width * display.scaleFactor),
    height: Math.round(display.bounds.height * display.scaleFactor)
  }
  return { displayId: display.id, bounds: { ...display.bounds }, display: { ...display.bounds }, ...targetSize(physical.width, physical.height, quality) }
}

/**
 * Screenshot pixel → screen point. Out-of-range coordinates are an error
 * rather than clamped: clamping would click the nearest edge, which is almost
 * never what a model that misread the image size meant.
 */
export function toScreen(frame: Frame, x: number, y: number): Point {
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x and y must be numbers.')
  if (x < 0 || y < 0 || x > frame.width - 1 || y > frame.height - 1) {
    throw new Error(
      `(${x}, ${y}) is outside the screenshot, which is ${frame.width}×${frame.height} px. Use coordinates from the latest screenshot.`
    )
  }
  return {
    x: frame.bounds.x + (x * frame.bounds.width) / frame.width,
    y: frame.bounds.y + (y * frame.bounds.height) / frame.height
  }
}

/** Screen point → screenshot pixel, or null when the point is on another display. */
export function toShot(frame: Frame, point: Point): Point | null {
  const { bounds } = frame
  if (point.x < bounds.x || point.y < bounds.y || point.x >= bounds.x + bounds.width || point.y >= bounds.y + bounds.height) {
    return null
  }
  // Clamped: the last point row rounds to one past the last pixel row, which
  // toScreen would then reject if the model echoed it back.
  return {
    x: Math.min(frame.width - 1, Math.round(((point.x - bounds.x) * frame.width) / bounds.width)),
    y: Math.min(frame.height - 1, Math.round(((point.y - bounds.y) * frame.height) / bounds.height))
  }
}

/** True when two frames describe the same capture geometry. */
export function sameFrame(a: Frame, b: Frame): boolean {
  return a.displayId === b.displayId && a.width === b.width && a.height === b.height && sameRect(a.bounds, b.bounds)
}

/** True while the display a frame was taken on still has the same bounds. */
export function displayUnchanged(frame: Frame, display: { id: number; bounds: Rect }): boolean {
  return frame.displayId === display.id && sameRect(frame.display ?? frame.bounds, display.bounds)
}

/**
 * Which display holds the centre of `rect` (a window, or a point as a rect of
 * size 0): its index in `displays`, or -1 when the centre is on none (the
 * window is off every screen). A window spanning two displays belongs to the
 * one its centre is on; the screenshot is then clipped to that display.
 */
export function displayIndexOf(rect: Rect, displays: { bounds: Rect }[]): number {
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  return displays.findIndex((d) => cx >= d.bounds.x && cy >= d.bounds.y && cx < d.bounds.x + d.bounds.width && cy < d.bounds.y + d.bounds.height)
}

/**
 * Displays in the order the model numbers them: the primary is 0, then the
 * rest left to right and, at the same x, top to bottom. Stable for a given
 * arrangement, so "display 1" means the same monitor until it is rearranged.
 */
export function orderDisplays<T extends { id: number; bounds: Rect }>(primaryId: number, all: T[]): T[] {
  const primary = all.find((d) => d.id === primaryId) ?? all[0]
  const rest = all.filter((d) => d !== primary).sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
  return primary ? [primary, ...rest] : []
}
