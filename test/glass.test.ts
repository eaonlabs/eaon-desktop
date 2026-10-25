import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GLASS_CLEAR_BLUR, GLASS_DEFAULT, glassFactors } from '../src/shared/glass'

/** Appearance → Glass: the two sliders, as the factors tokens.css scales frosted glass by. */

test('glass: the defaults are the design’s own, and each slider runs from none to twice it', () => {
  assert.deepEqual(glassFactors(GLASS_DEFAULT), { blur: 1, clear: 1 })
  assert.deepEqual(glassFactors({ blur: 100, transparency: 100 }), { blur: 2, clear: 2 })
  assert.deepEqual(glassFactors({ blur: 100, transparency: 0 }), { blur: 2, clear: 0 })
  assert.deepEqual(glassFactors({ blur: 75, transparency: 25 }), { blur: 1.5, clear: 0.5 })
})

test('glass: without blur it lets nothing through, so the page’s text never shows sharp under a menu’s', () => {
  assert.equal(glassFactors({ blur: 0, transparency: 100 }).clear, 0)
  assert.equal(glassFactors({ blur: GLASS_CLEAR_BLUR / 2, transparency: 100 }).clear, 1)
  assert.equal(glassFactors({ blur: GLASS_CLEAR_BLUR, transparency: 100 }).clear, 2)
  assert.equal(glassFactors({ blur: 0, transparency: 100 }).blur, 0)
})

test('glass: the system’s Reduce transparency makes it solid; a value out of range is held to the slider', () => {
  assert.deepEqual(glassFactors({ blur: 80, transparency: 90 }, true), { blur: 1.6, clear: 0 })
  assert.deepEqual(glassFactors({ blur: 400, transparency: -20 }), { blur: 2, clear: 0 })
  assert.deepEqual(glassFactors({ blur: Number.NaN, transparency: Number.NaN }), { blur: 1, clear: 1 })
})
