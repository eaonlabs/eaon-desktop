import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReasoningEffort } from '../src/renderer/src/components/composer/ReasoningEffort'

/** The effort slider takes whatever levels the model has, not a fixed four. */
const html = (labels: string[], value: number): string =>
  renderToStaticMarkup(createElement(ReasoningEffort, { labels, value, model: 'Opus 4.7', onChange: () => {} }))

test('four levels: the original stops, ticks rising from 4.8 to 9.6px', () => {
  const out = html(['Low', 'Medium', 'High', 'Extra high'], 1)
  assert.match(out, /role="slider"/)
  assert.match(out, /aria-valuemax="3"/)
  assert.match(out, /aria-valuenow="1"/)
  assert.match(out, /aria-valuetext="Opus 4.7 Medium"/)
  const heights = [...out.matchAll(/height:(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]))
  assert.deepEqual(heights.filter((h) => h < 10), [4.8, 6.4, 8, 9.6])
})

test('a model with two or seven levels gets that many stops', () => {
  assert.match(html(['Off', 'High'], 0), /aria-valuemax="1"/)
  const seven = html(['Off', 'Minimal', 'Low', 'Medium', 'High', 'Extra high', 'Max'], 6)
  assert.match(seven, /aria-valuemax="6"/)
  assert.match(seven, /aria-valuetext="Opus 4.7 Max"/)
})
