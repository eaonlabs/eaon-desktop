/**
 * How much of the theme's colour must lie over a see-through picture so the
 * text stays readable where the picture is most in the way. The Tint setting
 * is the floor: a dark picture keeps it, and a bright one gets more wash, only
 * as much as its text needs (components/SeeThrough.tsx measures the picture).
 */

export type Rgb = readonly [number, number, number]

/** A piece of text to keep readable, and the contrast it needs against what lies behind it. */
export interface Legibility {
  colour: Rgb
  contrast: number
}

/** The contrast body text needs against what lies behind it (WCAG AA). */
export const LEGIBLE_CONTRAST = 4.5

/** The contrast quiet text needs (its labels and placeholders), the WCAG floor for text that is not body copy. */
export const QUIET_CONTRAST = 3

/** The part of the picture that decides it: its brightest tenth where the text is lighter than the page, its darkest where darker. */
const WORST_SHARE = 0.1

/** How finely the wash is raised past the floor. */
const STEP = 0.01

const clamp = (n: number): number => Math.min(1, Math.max(0, n))

/** WCAG relative luminance of an sRGB colour (0–255 per channel). */
export function luminance([r, g, b]: Rgb): number {
  const linear = (channel: number): number => {
    const v = channel / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

/** WCAG contrast ratio between two relative luminances. */
export function contrastOf(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** The colour the page shows over one spot of the picture at this wash: the browser blends opacity in sRGB. */
export function washed(wash: number, colour: Rgb, spot: Rgb): Rgb {
  const mix = (i: 0 | 1 | 2): number => wash * colour[i] + (1 - wash) * spot[i]
  return [mix(0), mix(1), mix(2)]
}

/** The least wash, from `start` in steps of STEP, at which `text` reaches its contrast over the picture's worst spot. */
function washFor(text: Legibility, canvas: Rgb, ordered: readonly Rgb[], start: number): number {
  const textY = luminance(text.colour)
  // Light text needs the picture dark; dark text needs it light. The wash
  // moves the spot towards the theme's colour, so contrast only grows with it.
  const lighter = textY > luminance(canvas)
  const share = lighter ? 1 - WORST_SHARE : WORST_SHARE
  const spot = ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * share))]
  const passes = (wash: number): boolean => contrastOf(textY, luminance(washed(wash, canvas, spot))) >= text.contrast
  for (let wash = start; wash < 1; wash = Math.min(1, +(wash + STEP).toFixed(2))) if (passes(wash)) return wash
  return 1
}

/**
 * The wash that keeps every text in `texts` readable over `picture`: the
 * floor when that already does, otherwise the largest of the least washes
 * each one needs. `picture` is the sampled colours of what lies behind the
 * window. With none, the floor stands.
 */
export function legibleWash(floor: number, canvas: Rgb, picture: readonly Rgb[], texts: readonly Legibility[]): number {
  const start = clamp(floor)
  if (picture.length === 0) return start
  const ordered = [...picture].sort((a, b) => luminance(a) - luminance(b))
  return texts.reduce((wash, text) => Math.max(wash, washFor(text, canvas, ordered, start)), start)
}
