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
  /** The captured display's bounds in screen points. */
  bounds: Rect
  /** Screenshot size in pixels. */
  width: number
  height: number
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
  return { displayId: display.id, bounds: { ...display.bounds }, ...targetSize(physical.width, physical.height, quality) }
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
  return (
    a.displayId === b.displayId &&
    a.width === b.width &&
    a.height === b.height &&
    a.bounds.x === b.bounds.x &&
    a.bounds.y === b.bounds.y &&
    a.bounds.width === b.bounds.width &&
    a.bounds.height === b.bounds.height
  )
}
