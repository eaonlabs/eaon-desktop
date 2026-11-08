import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contrastOf, legibleWash, LEGIBLE_CONTRAST, luminance, QUIET_CONTRAST, washed, type Legibility, type Rgb } from '../src/shared/seeThroughLegibility'

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
