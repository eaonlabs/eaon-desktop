import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EffortTrack } from '../src/renderer/src/components/composer/EffortTrack'

/** The effort slider takes whatever levels the model has, not a fixed four. */
const html = (labels: string[], value: number): string =>
  renderToStaticMarkup(createElement(EffortTrack, { labels, value, model: 'Opus 4.7', onChange: () => {} }))

test('it names the chosen level under its label, and reads as a slider', () => {
  const out = html(['Low', 'Medium', 'High', 'Extra high'], 1)
  assert.match(out, /role="slider"/)
  assert.match(out, /aria-valuemax="3"/)
  assert.match(out, /aria-valuenow="1"/)
  assert.match(out, /aria-valuetext="Opus 4.7 Medium"/)
  assert.match(out, /effort-track__eyebrow">Reasoning</)
  assert.match(out, /effort-track__level">Medium</)
})

test('a model with two or seven levels gets that many', () => {
  assert.match(html(['Off', 'High'], 0), /aria-valuemax="1"/)
  const seven = html(['Off', 'Minimal', 'Low', 'Medium', 'High', 'Extra high', 'Max'], 6)
  assert.match(seven, /aria-valuemax="6"/)
  assert.match(seven, /aria-valuetext="Opus 4.7 Max"/)
  // The top level is marked, for its characters to stir.
  assert.match(seven, /data-top="true"/)
  assert.doesNotMatch(html(['Off', 'High'], 0), /data-top/)
})
