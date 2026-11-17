/**
 * Keeping text readable over a see-through picture (components/SeeThrough.tsx
 * measures the picture and applies what this decides).
 *
 * First the picture itself is adjusted, as little as it needs: softened in
 * proportion to how busy it is (fine texture and hard edges are what fight
 * letters, more than brightness), its strongest colour calmed, and its
 * brightest parts brought down on a dark theme (or its darkest lifted on a
 * light one), so it keeps its colour rather than going grey. Then the theme's
 * colour is washed over what is left, again only as much as the text needs.
 * The Tint setting is the wash's floor.
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

/**
 * The part of the picture that decides the wash: its brightest tenth where
 * the text is lighter than the page, its darkest where darker. With the
 * picture adjusted first (`readable`), the wash answers for all but its
 * brightest (or darkest) few spots: softened, those are no longer lone
 * specks but whole patches text could sit on.
 */
const WORST_SHARE = 0.1
export const READABLE_WORST_SHARE = 0.03

/** The share of a text's contrast on the theme's own page that is asked of it over the picture. */
const ON_PAGE = 0.9

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
function washFor(text: Legibility, canvas: Rgb, ordered: readonly Rgb[], start: number, worst: number): number {
  const textY = luminance(text.colour)
  // Light text needs the picture dark; dark text needs it light. The wash
  // moves the spot towards the theme's colour, so contrast only grows with it.
  const lighter = textY > luminance(canvas)
  const share = lighter ? 1 - worst : worst
  const spot = ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * share))]
  // Never more than the text has on the theme's own page, near enough: the
  // quietest greys are softer than the target even there, and asking more of
  // the picture than the page itself gives washed it out to the page's colour.
  const target = Math.min(text.contrast, contrastOf(textY, luminance(canvas)) * ON_PAGE)
  const passes = (wash: number): boolean => contrastOf(textY, luminance(washed(wash, canvas, spot))) >= target
  for (let wash = start; wash < 1; wash = Math.min(1, +(wash + STEP).toFixed(2))) if (passes(wash)) return wash
  return 1
}

/**
 * The wash that keeps every text in `texts` readable over `picture`: the
 * floor when that already does, otherwise the largest of the least washes
 * each one needs. `picture` is the sampled colours of what lies behind the
 * window. With none, the floor stands.
 */
export function legibleWash(floor: number, canvas: Rgb, picture: readonly Rgb[], texts: readonly Legibility[], worst = WORST_SHARE): number {
  const start = clamp(floor)
  if (picture.length === 0) return start
  const ordered = [...picture].sort((a, b) => luminance(a) - luminance(b))
  return texts.reduce((wash, text) => Math.max(wash, washFor(text, canvas, ordered, start, worst)), start)
}

/* ------------------------------------------------- adjusting the picture */

/** What makes a picture hard to read text over, beyond its brightness. */
export interface PictureStats {
  /** How busy it is: the mean change in luminance from one spot to the next, 0 (flat) to about 0.3 (stripes). */
  busy: number
  /** How strong its colour is: mean saturation, weighted by how bright each spot is (0–1). */
  saturation: number
}

/** A picture's stats from its pixels (RGBA, row by row), read small: a spot is several points of the screen across. */
export function statsOf(rgba: ArrayLike<number>, width: number, height: number): PictureStats {
  const lum = new Float32Array(width * height)
  let saturation = 0
  let weight = 0
  for (let i = 0; i < width * height; i++) {
    const r = rgba[i * 4]
    const g = rgba[i * 4 + 1]
    const b = rgba[i * 4 + 2]
    lum[i] = luminance([r, g, b])
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const value = max / 255
    saturation += (max === 0 ? 0 : (max - min) / max) * value
    weight += value
  }
  let change = 0
  let pairs = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const here = lum[y * width + x]
      // Changes in perceived lightness, not in linear light, so a busy dark picture counts too.
      const perceived = (v: number): number => Math.cbrt(v)
      if (x + 1 < width) {
        change += Math.abs(perceived(here) - perceived(lum[y * width + x + 1]))
        pairs++
      }
      if (y + 1 < height) {
        change += Math.abs(perceived(here) - perceived(lum[(y + 1) * width + x]))
        pairs++
      }
    }
  }
  return { busy: pairs ? change / pairs : 0, saturation: weight ? saturation / weight : 0 }
}

/**
 * How the picture is drawn behind the text: softened (a blur, in screen
 * points), its colour calmed, its contrast eased (lifting a dark picture
 * under a light theme: its darks come up towards the middle first, so it
 * pales rather than vanishing under the wash), and dimmed or lifted.
 */
export interface Adjustment {
  blur: number
  saturate: number
  contrast: number
  brightness: number
}

export const UNADJUSTED: Adjustment = { blur: 0, saturate: 1, contrast: 1, brightness: 1 }

/** How far a dark picture's contrast is eased before it is lifted under a light theme. */
export const LIFT_CONTRAST = 0.5

/** Below this much change from spot to spot a picture reads as calm (gradients, skies, soft photos), and isn't softened. */
const CALM = 0.02
/** Softening per unit of busyness past calm, in points of blur, and the most it gets. */
const BLUR_PER_BUSY = 220
const MOST_BLUR = 24
/** Colour above this strength is calmed, down to at most this much of it. */
const VIVID = 0.42
const LEAST_SATURATE = 0.72

/** The softening and the calmer colour a picture needs, from its stats (its brightness is decided once these are applied). */
export function softening(stats: PictureStats): Pick<Adjustment, 'blur' | 'saturate'> {
  const blur = Math.min(MOST_BLUR, Math.max(0, (stats.busy - CALM) * BLUR_PER_BUSY))
  const saturate = stats.saturation > VIVID ? Math.max(LEAST_SATURATE, 1 - (stats.saturation - VIVID) * 0.9) : 1
  return { blur: Math.round(blur * 2) / 2, saturate: Math.round(saturate * 100) / 100 }
}

/**
 * Where the picture's bright end should sit under light text (a dark theme),
 * and its dark end under dark text (a light theme), as relative luminance:
 * still plainly the picture, with only a little wash to go.
 */
export const DIM_TO = 0.16
export const LIFT_TO = 0.22
/**
 * The furthest a picture is dimmed or lifted. Dimming keeps a picture's
 * colour where the wash greys it, so a bright one goes a long way down
 * (a sunlit sky turns dusk blue) before the wash takes over.
 */
export const MOST_DIM = 0.28
export const MOST_LIFT = 1.8

/** The luminance at `share` of the way from a picture's darkest spot to its brightest. */
export function luminanceAt(picture: readonly Rgb[], share: number): number {
  if (picture.length === 0) return 0
  const ordered = picture.map(luminance).sort((a, b) => a - b)
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.floor(ordered.length * share)))]
}

/** The CSS (and canvas) filter for an adjustment, with the blur in pixels of what it is drawn on (`pxPerPoint`). */
export function filterOf(adjust: Adjustment, pxPerPoint = 1): string {
  const parts: string[] = []
  if (adjust.blur > 0) parts.push(`blur(${(adjust.blur * pxPerPoint).toFixed(2)}px)`)
  if (adjust.saturate !== 1) parts.push(`saturate(${adjust.saturate})`)
  if (adjust.contrast !== 1) parts.push(`contrast(${adjust.contrast})`)
  if (adjust.brightness !== 1) parts.push(`brightness(${adjust.brightness})`)
  return parts.length ? parts.join(' ') : 'none'
}
