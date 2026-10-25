import type { Glass } from './types'

/** Appearance → Glass as Eaon comes: the design's own blur and transparency. */
export const GLASS_DEFAULT: Glass = { blur: 50, transparency: 50 }

/** Below this much blur, glass lets less through as the blur goes (see glassFactors). */
export const GLASS_CLEAR_BLUR = 25

const slider = (value: number): number => (Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 50)

/**
 * The two factors tokens.css scales frosted glass by (--glass-blur-k and
 * --glass-clear-k): 1 is the design's own, 0 no blur or solid, 2 the most.
 * Glass that lets the page through without blurring it lays the page's text
 * sharp under its own, so under GLASS_CLEAR_BLUR it lets less through the
 * less it blurs, and none with no blur. The system's Reduce transparency
 * makes it solid, as it does the system's own menus.
 */
export function glassFactors(glass: Glass, reducedTransparency = false): { blur: number; clear: number } {
  const blur = slider(glass.blur)
  const clear = reducedTransparency ? 0 : (slider(glass.transparency) / GLASS_DEFAULT.transparency) * Math.min(1, blur / GLASS_CLEAR_BLUR)
  return { blur: blur / GLASS_DEFAULT.blur, clear }
}
