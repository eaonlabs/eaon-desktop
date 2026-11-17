import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  contrastOf,
  filterOf,
  legibleWash,
  LEGIBLE_CONTRAST,
  luminance,
  luminanceAt,
  QUIET_CONTRAST,
  READABLE_WORST_SHARE,
  softening,
  statsOf,
  UNADJUSTED,
  washed,
  type Legibility,
  type Rgb
} from '../src/shared/seeThroughLegibility'

const WHITE: Rgb = [255, 255, 255]
const BLACK: Rgb = [0, 0, 0]
const DARK_CANVAS: Rgb = [13, 13, 13]
const LIGHT_TEXT: Rgb = [252, 252, 252]
/** The page's quietest grey on the dark theme (its labels and placeholders). */
const QUIET_TEXT: Rgb = [134, 134, 134]
const LIGHT_CANVAS: Rgb = [255, 255, 255]
const DARK_TEXT: Rgb = [26, 28, 31]

const primary = (colour: Rgb): Legibility => ({ colour, contrast: LEGIBLE_CONTRAST })
const quiet = (colour: Rgb): Legibility => ({ colour, contrast: QUIET_CONTRAST })

/** A picture of `count` spots of one colour. */
const flat = (colour: Rgb, count = 100): Rgb[] => Array.from({ length: count }, () => colour)

test('luminance runs from black to white, and contrast from 1 to 21', () => {
  assert.equal(luminance(BLACK), 0)
  assert.ok(Math.abs(luminance(WHITE) - 1) < 1e-9)
  assert.ok(Math.abs(contrastOf(0, 1) - 21) < 1e-9)
  assert.equal(contrastOf(0.2, 0.2), 1)
})

test('washed blends the theme colour over the picture by the wash, as the browser does', () => {
  assert.deepEqual(washed(1, DARK_CANVAS, WHITE), DARK_CANVAS)
  assert.deepEqual(washed(0, DARK_CANVAS, WHITE), WHITE)
  const half = washed(0.5, BLACK, WHITE)
  assert.ok(Math.abs(half[0] - 127.5) < 1e-9)
})

test('a dark picture keeps the Tint setting as it is', () => {
  const picture = flat([30, 40, 30])
  assert.equal(legibleWash(0.55, DARK_CANVAS, picture, [primary(LIGHT_TEXT), quiet(QUIET_TEXT)]), 0.55)
})

test('a bright picture gets more wash, enough to keep the primary text at its contrast', () => {
  const wash = legibleWash(0.55, DARK_CANVAS, flat(WHITE), [primary(LIGHT_TEXT)])
  assert.ok(wash > 0.55, `wash ${wash} should rise above the floor`)
  assert.ok(contrastOf(luminance(LIGHT_TEXT), luminance(washed(wash, DARK_CANVAS, WHITE))) >= LEGIBLE_CONTRAST)
  // Least that will do: a step less fails.
  assert.ok(contrastOf(luminance(LIGHT_TEXT), luminance(washed(wash - 0.01, DARK_CANVAS, WHITE))) < LEGIBLE_CONTRAST)
})

test('the quiet grey of the labels needs more wash than the primary text', () => {
  const picture = flat(WHITE)
  const primaryOnly = legibleWash(0.55, DARK_CANVAS, picture, [primary(LIGHT_TEXT)])
  const withQuiet = legibleWash(0.55, DARK_CANVAS, picture, [primary(LIGHT_TEXT), quiet(QUIET_TEXT)])
  assert.ok(withQuiet > primaryOnly, `quiet text should raise ${primaryOnly} to ${withQuiet}`)
  assert.ok(contrastOf(luminance(QUIET_TEXT), luminance(washed(withQuiet, DARK_CANVAS, WHITE))) >= QUIET_CONTRAST)
})

test('the light theme keeps dark text readable over a dark picture by raising its wash', () => {
  const dark = flat([12, 14, 10])
  assert.ok(legibleWash(0.3, LIGHT_CANVAS, dark, [primary(DARK_TEXT)]) > 0.3)
})

test('the light theme over a light picture keeps its floor', () => {
  assert.equal(legibleWash(0.3, LIGHT_CANVAS, flat(WHITE), [primary(DARK_TEXT)]), 0.3)
})

test('a small bright patch does not raise the wash for the whole window', () => {
  // 95 dark spots and 5 white ones: the brightest tenth is still dark.
  const picture = [...flat([30, 40, 30], 95), ...flat(WHITE, 5)]
  assert.equal(legibleWash(0.55, DARK_CANVAS, picture, [primary(LIGHT_TEXT)]), 0.55)
})

test('a picture bright over a fifth of its spots does raise the wash', () => {
  const picture = [...flat([30, 40, 30], 80), ...flat(WHITE, 20)]
  assert.ok(legibleWash(0.55, DARK_CANVAS, picture, [primary(LIGHT_TEXT)]) > 0.55)
})

test('no sample means no change, and the wash stays between 0 and 1', () => {
  assert.equal(legibleWash(0.4, DARK_CANVAS, [], [primary(LIGHT_TEXT)]), 0.4)
  assert.equal(legibleWash(1.4, DARK_CANVAS, flat(WHITE), [primary(LIGHT_TEXT)]), 1)
  assert.equal(legibleWash(-0.2, DARK_CANVAS, flat([30, 40, 30]), [primary(LIGHT_TEXT)]), 0)
})

/* ------------------------------------------------- adjusting the picture */

/** A w × h picture as RGBA, each pixel from `at(x, y)`. */
function pixels(w: number, h: number, at: (x: number, y: number) => Rgb): number[] {
  const out: number[] = []
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.push(...at(x, y), 255)
  return out
}

test('a flat or gently shaded picture is calm; a checkerboard of light and dark is as busy as it gets', () => {
  const flatStats = statsOf(pixels(20, 20, () => [120, 140, 200]), 20, 20)
  const gradient = statsOf(pixels(20, 20, (x) => [x * 12, x * 12, x * 12]), 20, 20)
  const checker = statsOf(pixels(20, 20, (x, y) => ((x + y) % 2 ? WHITE : BLACK)), 20, 20)
  assert.equal(flatStats.busy, 0)
  assert.ok(gradient.busy < 0.05, `a gradient is calm (${gradient.busy})`)
  assert.ok(checker.busy > 0.9, `a checkerboard is busy (${checker.busy})`)
})

test('colour strength counts bright vivid colour, not grey', () => {
  assert.equal(statsOf(pixels(4, 4, () => [128, 128, 128]), 4, 4).saturation, 0)
  assert.ok(statsOf(pixels(4, 4, () => [255, 20, 60]), 4, 4).saturation > 0.9)
})

test('a calm picture is left sharp and its colour alone; a busy one is softened, a loud one calmed', () => {
  assert.deepEqual(softening({ busy: 0.01, saturation: 0.3 }), { blur: 0, saturate: 1 })
  const busy = softening({ busy: 0.08, saturation: 0.3 })
  assert.ok(busy.blur > 8, `softened (${busy.blur})`)
  assert.ok(softening({ busy: 0.5, saturation: 0.3 }).blur <= 24, 'never past the most blur')
  assert.ok(softening({ busy: 0.01, saturation: 0.9 }).saturate < 1)
  assert.ok(softening({ busy: 0.01, saturation: 1 }).saturate >= 0.72)
})

test('the filter lists only what changes, with the blur in the pixels it is drawn at', () => {
  assert.equal(filterOf(UNADJUSTED), 'none')
  assert.equal(filterOf({ blur: 10, saturate: 0.9, contrast: 1, brightness: 0.5 }, 2), 'blur(20.00px) saturate(0.9) brightness(0.5)')
  assert.equal(filterOf({ blur: 0, saturate: 1, contrast: 0.5, brightness: 1.4 }), 'contrast(0.5) brightness(1.4)')
})

test('luminanceAt reads a picture from its darkest spot to its brightest', () => {
  const picture: Rgb[] = [BLACK, [128, 128, 128], WHITE]
  assert.equal(luminanceAt(picture, 0), 0)
  assert.equal(luminanceAt(picture, 0.99), 1)
  assert.equal(luminanceAt([], 0.5), 0)
})

test('text is never asked for more contrast over the picture than it has on the page itself', () => {
  // A light theme's palest grey is softer than 3:1 even on white: it no longer pushes the wash to the top.
  const pale: Rgb = [150, 150, 150]
  assert.ok(contrastOf(luminance(pale), luminance(LIGHT_CANVAS)) < QUIET_CONTRAST)
  const wash = legibleWash(0.3, LIGHT_CANVAS, flat([200, 200, 200]), [quiet(pale)])
  assert.ok(wash < 1, `the wash stays under full (${wash})`)
})

test('with the picture adjusted, the wash answers for all but its brightest few spots', () => {
  // A twentieth of the picture is white: the old reading let it pass, the stricter one doesn't.
  const picture = [...flat([20, 20, 20], 95), ...flat(WHITE, 5)]
  const loose = legibleWash(0.2, DARK_CANVAS, picture, [primary(LIGHT_TEXT)])
  const strict = legibleWash(0.2, DARK_CANVAS, picture, [primary(LIGHT_TEXT)], READABLE_WORST_SHARE)
  assert.ok(strict > loose, `${loose} → ${strict}`)
})
