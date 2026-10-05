import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clipRect,
  displayIndexOf,
  displayUnchanged,
  frameFor,
  orderDisplays,
  regionToScreen,
  targetSize,
  toScreen,
  toShot,
  type Frame,
  type Rect
} from '../src/main/features/computer/geometry'

/**
 * The coordinate math behind every click, against injected display layouts:
 * a laptop on its own, a laptop with monitors on every side (negative
 * origins), mixed Retina and 1x, a rotated monitor, Windows' 150% scaling
 * and a 4K panel set to "looks like 1080p". The model speaks in screenshot
 * pixels; the pointer moves in screen points; nothing may assume the two
 * differ by a fixed scale factor.
 */

type D = { id: number; bounds: Rect; scaleFactor: number }
const d = (id: number, x: number, y: number, width: number, height: number, scaleFactor: number): D => ({ id, bounds: { x, y, width, height }, scaleFactor })

const laptop = d(1, 0, 0, 1512, 982, 2)
const layouts: Record<string, { primary: number; displays: D[] }> = {
  'laptop alone': { primary: 1, displays: [laptop] },
  'laptop with a 1080p monitor to the left and a 1440p one above-right': {
    primary: 1,
    displays: [laptop, d(2, -1920, 0, 1920, 1080, 1), d(3, 1512, -458, 2560, 1440, 1)]
  },
  'a portrait monitor left of and higher than the primary': { primary: 1, displays: [laptop, d(2, -1080, -938, 1080, 1920, 2)] },
  'Windows at 150% (points are DIP: 1920x1080 physical is 1280x720)': { primary: 1, displays: [d(1, 0, 0, 1280, 720, 1.5), d(2, 1280, 0, 1707, 960, 1.5)] },
  'a 4K panel set to "looks like 1080p"': { primary: 1, displays: [d(1, 0, 0, 1920, 1080, 2)] },
  'an ultrawide': { primary: 1, displays: [d(1, 0, 0, 3440, 1440, 1)] }
}

test('the primary display is 0, then left to right, then top to bottom — whatever order the system lists them', () => {
  const mess = [d(3, 1512, -458, 2560, 1440, 1), d(2, -1920, 0, 1920, 1080, 1), laptop, d(4, 1512, 982, 1920, 1080, 1)]
  assert.deepEqual(
    orderDisplays(1, mess).map((x) => x.id),
    [1, 2, 3, 4]
  )
  // Two monitors stacked at the same x: the upper one first.
  assert.deepEqual(
    orderDisplays(1, [d(5, -1920, 400, 1920, 1080, 1), d(6, -1920, -700, 1920, 1080, 1), laptop]).map((x) => x.id),
    [1, 6, 5]
  )
  // A primary that isn't listed (unplugged mid-call) falls back to the first one rather than dropping everything.
  assert.deepEqual(
    orderDisplays(99, [laptop]).map((x) => x.id),
    [1]
  )
  assert.deepEqual(orderDisplays(1, []), [])
})

test('a screenshot is never upscaled and its long edge is capped by quality', () => {
  assert.deepEqual(targetSize(1024, 768, 'balanced'), { width: 1024, height: 768 })
  assert.deepEqual(targetSize(3024, 1964, 'balanced'), { width: 1280, height: 831 })
  assert.deepEqual(targetSize(3024, 1964, 'sharp'), { width: 1600, height: 1039 })
  assert.deepEqual(targetSize(6880, 2880, 'balanced'), { width: 1280, height: 536 })
  assert.deepEqual(targetSize(1080 * 2, 1920 * 2, 'balanced'), { width: 720, height: 1280 }, 'portrait: the tall edge is the long one')
  assert.deepEqual(targetSize(1, 1, 'balanced'), { width: 1, height: 1 })
})

for (const [name, layout] of Object.entries(layouts)) {
  test(`every screenshot pixel maps back inside its own display: ${name}`, () => {
    for (const display of layout.displays) {
      const frame = frameFor(display, 'balanced')
      const { x, y, width, height } = display.bounds
      for (const [px, py] of [
        [0, 0],
        [frame.width - 1, 0],
        [0, frame.height - 1],
        [frame.width - 1, frame.height - 1],
        [Math.floor(frame.width / 2), Math.floor(frame.height / 2)]
      ]) {
        const point = toScreen(frame, px, py)
        assert.ok(point.x >= x && point.x < x + width, `x ${point.x} is inside [${x}, ${x + width})`)
        assert.ok(point.y >= y && point.y < y + height, `y ${point.y} is inside [${y}, ${y + height})`)
        // …and it is that display, not a neighbour, that holds the point.
        assert.equal(displayIndexOf({ x: point.x, y: point.y, width: 0, height: 0 }, layout.displays), layout.displays.indexOf(display))
        const back = toShot(frame, point)!
        assert.ok(Math.abs(back.x - px) <= 1 && Math.abs(back.y - py) <= 1, `round trip (${px}, ${py}) → (${back.x}, ${back.y})`)
      }
    }
  })
}

test('the scale factor never enters a click: two displays with the same points but different scales click the same place', () => {
  const retina = frameFor(d(1, 0, 0, 1440, 900, 2), 'balanced')
  const plain = frameFor(d(1, 0, 0, 1440, 900, 1), 'balanced')
  assert.deepEqual([retina.width, retina.height], [plain.width, plain.height], 'both are capped to the same size')
  assert.deepEqual(toScreen(retina, 640, 400), toScreen(plain, 640, 400))
  // A display that is smaller than the cap keeps its pixels: 1 screenshot pixel is 1 point on a 1x display…
  const small = frameFor(d(1, 0, 0, 1024, 768, 1), 'balanced')
  assert.deepEqual(toScreen(small, 100, 50), { x: 100, y: 50 })
  // …and 2 pixels per point on a Retina one, where the downscale hides that.
  const dense = frameFor(d(1, 0, 0, 640, 360, 2), 'balanced')
  assert.deepEqual([dense.width, dense.height], [1280, 720])
  assert.deepEqual(toScreen(dense, 200, 100), { x: 100, y: 50 })
})

test('Windows at 150%: physical pixels are bounds × 1.5, and clicks still land in DIP points', () => {
  const frame = frameFor(d(1, 0, 0, 1280, 720, 1.5), 'balanced')
  assert.deepEqual([frame.width, frame.height], [1280, 720], '1920×1080 physical, downscaled to the cap')
  const point = toScreen(frame, 640, 360)
  assert.deepEqual(point, { x: 640, y: 360 })
  const second = frameFor(d(2, 1280, 0, 1707, 960, 1.5), 'balanced')
  assert.ok(toScreen(second, 0, 0).x === 1280, 'the second monitor starts where the first ends')
})

test('a click outside the screenshot is an error, not the nearest edge', () => {
  const frame = frameFor(laptop, 'balanced')
  for (const [x, y] of [
    [-1, 0],
    [0, -1],
    [frame.width, 0],
    [0, frame.height],
    [frame.width + 500, 10]
  ]) {
    assert.throws(() => toScreen(frame, x, y), /outside the screenshot, which is 1280×831 px/)
  }
  assert.throws(() => toScreen(frame, Number.NaN, 5), /must be numbers/)
  assert.throws(() => toScreen(frame, 5, Number.POSITIVE_INFINITY), /must be numbers/)
})

test('a point on another display is "not on this screenshot", including negative coordinates', () => {
  const left = frameFor(d(2, -1920, 0, 1920, 1080, 1), 'balanced')
  assert.equal(toShot(left, { x: 100, y: 100 }), null, 'the primary is to the right of it')
  assert.deepEqual(toShot(left, { x: -1920, y: 0 }), { x: 0, y: 0 })
  assert.equal(toShot(left, { x: 0, y: 0 }), null, 'the left edge of the next display is not this one')
  assert.ok(toShot(left, { x: -0.5, y: 1079.5 }))
  assert.equal(toShot(left, { x: -0.5, y: 1080 }), null)
})

test('rearranging or resizing displays invalidates the screenshot the model is looking at', () => {
  const display = d(2, -1920, 0, 1920, 1080, 1)
  const frame = frameFor(display, 'balanced')
  assert.equal(displayUnchanged(frame, display), true)
  // Dragged to the other side in System Settings → Displays.
  assert.equal(displayUnchanged(frame, { ...display, bounds: { ...display.bounds, x: 1512 } }), false)
  // Moved up by a pixel: still wrong for every click.
  assert.equal(displayUnchanged(frame, { ...display, bounds: { ...display.bounds, y: -1 } }), false)
  // A resolution change.
  assert.equal(displayUnchanged(frame, { ...display, bounds: { ...display.bounds, width: 1280, height: 720 } }), false)
  // A different monitor now has the id (replugged).
  assert.equal(displayUnchanged(frame, { id: 7, bounds: display.bounds }), false)
})

test('a zoomed screenshot (one app window) still validates against the whole display, and maps clicks into the window', () => {
  const display = d(2, -1920, 0, 1920, 1080, 1)
  const zoomed: Frame = {
    displayId: 2,
    bounds: { x: -1500, y: 100, width: 400, height: 800 },
    display: { ...display.bounds },
    width: 400,
    height: 800
  }
  assert.equal(displayUnchanged(zoomed, display), true)
  assert.equal(displayUnchanged(zoomed, { ...display, bounds: { ...display.bounds, x: 0 } }), false)
  assert.deepEqual(toScreen(zoomed, 0, 0), { x: -1500, y: 100 })
  assert.deepEqual(toScreen(zoomed, 399, 799), { x: -1101, y: 899 })
  // An iPhone-sized window on a Retina display: 2 px per point, shown at half the pixels.
  const phone: Frame = { displayId: 1, bounds: { x: 600, y: 80, width: 340, height: 740 }, display: { ...laptop.bounds }, width: 340, height: 740 }
  assert.deepEqual(toScreen(phone, 170, 370), { x: 770, y: 450 })
})

test('zooming into part of a screenshot yields the screen rect it covers, in points, on any display', () => {
  const frame = frameFor(d(2, -1920, 0, 1920, 1080, 1), 'balanced') // 1280×720 for 1920×1080 points: 1.5 points per pixel
  assert.deepEqual(regionToScreen(frame, [0, 0, 640, 360]), { x: -1920, y: 0, width: 960, height: 540 })
  assert.deepEqual(regionToScreen(frame, [640, 360, 640, 360]).x, -960)
  // A region that runs to the last pixel is cut at the edge rather than rejected.
  const edge = regionToScreen(frame, [1000, 600, 500, 500])
  assert.ok(edge.x + edge.width <= 0 && edge.y + edge.height <= 1080)
  assert.throws(() => regionToScreen(frame, [0, 0, 0, 10]), /width and height at least 1/)
  assert.throws(() => regionToScreen(frame, [Number.NaN, 0, 10, 10]), /\[x, y, width, height\]/)
  assert.throws(() => regionToScreen(frame, [1300, 0, 10, 10]), /outside the screenshot/)
})

test('a window partly off its display is clipped to it; one entirely off screen is refused', () => {
  const display = laptop.bounds
  assert.deepEqual(clipRect({ x: -200, y: 100, width: 600, height: 400 }, display), { x: 0, y: 100, width: 400, height: 400 })
  assert.deepEqual(clipRect({ x: 1400, y: 900, width: 400, height: 400 }, display), { x: 1400, y: 900, width: 112, height: 82 })
  assert.equal(clipRect({ x: 1512, y: 0, width: 300, height: 300 }, display), null, 'touching is not overlapping')
  assert.equal(clipRect({ x: -500, y: 0, width: 400, height: 400 }, display), null)
  // Less than a point of overlap would capture nothing.
  assert.equal(clipRect({ x: -399.5, y: 0, width: 400, height: 400 }, display), null)
  // Fractional window bounds round to whole points, as screencapture wants.
  assert.deepEqual(clipRect({ x: 10.4, y: 20.6, width: 100.2, height: 50.3 }, display), { x: 10, y: 21, width: 100, height: 50 })
})

test('a window belongs to the display its centre is on, so a window dragged across two is captured from one', () => {
  const displays = layouts['laptop with a 1080p monitor to the left and a 1440p one above-right'].displays
  assert.equal(displayIndexOf({ x: -1000, y: 100, width: 800, height: 600 }, displays), 1, 'wholly on the left monitor')
  assert.equal(displayIndexOf({ x: -300, y: 100, width: 800, height: 600 }, displays), 0, 'centre at x=100: the laptop')
  assert.equal(displayIndexOf({ x: -500, y: 100, width: 800, height: 600 }, displays), 1, 'centre at x=-100: the left monitor')
  assert.equal(displayIndexOf({ x: 1500, y: -400, width: 800, height: 600 }, displays), 2, 'above-right monitor, negative y')
  assert.equal(displayIndexOf({ x: 5000, y: 5000, width: 100, height: 100 }, displays), -1, 'off every display')
  // The gap above the laptop and beside the upper-right monitor belongs to nobody.
  assert.equal(displayIndexOf({ x: 1600, y: 1200, width: 10, height: 10 }, displays), -1)
})

test('a full-screen app window is exactly its display, so a click in it maps as it would on the display', () => {
  const display = laptop
  const fullscreen: Rect = { ...display.bounds }
  assert.deepEqual(clipRect(fullscreen, display.bounds), fullscreen)
  const whole = frameFor(display, 'balanced')
  const zoomed: Frame = { ...whole, bounds: fullscreen, display: { ...display.bounds } }
  assert.deepEqual(toScreen(zoomed, 400, 300), toScreen(whole, 400, 300))
})
