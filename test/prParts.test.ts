import { test } from 'node:test'
import assert from 'node:assert/strict'
import { associationLabel, ghTime, stateKey } from '../src/renderer/src/components/pullRequests/parts'

/** The Pull requests page's small pieces (components/pullRequests/parts.tsx), written as GitHub writes them. */

const NOW = new Date('2026-11-19T12:00:00Z').getTime()
const ago = (ms: number): string => new Date(NOW - ms).toISOString()
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

test('times read as GitHub writes them', () => {
  assert.equal(ghTime(ago(20_000), NOW), 'now')
  assert.equal(ghTime(ago(MIN), NOW), 'a minute ago')
  assert.equal(ghTime(ago(5 * MIN), NOW), '5 minutes ago')
  assert.equal(ghTime(ago(HOUR), NOW), 'an hour ago')
  assert.equal(ghTime(ago(8 * HOUR), NOW), '8 hours ago')
  assert.equal(ghTime(ago(DAY + HOUR), NOW), 'yesterday')
  assert.equal(ghTime(ago(3 * DAY), NOW), '3 days ago')
  assert.match(ghTime('2026-10-03T12:00:00Z', NOW), /^on Oct [34]$/, 'a month back: the date, no year')
  assert.match(ghTime('2025-10-03T12:00:00Z', NOW), /^on Oct [34], 2025$/, 'another year: with it')
  assert.equal(ghTime('not a date', NOW), '')
})

test('a state gh spells in any case is known; one it never sent reads as open', () => {
  assert.equal(stateKey('MERGED'), 'merged')
  assert.equal(stateKey('draft'), 'draft')
  assert.equal(stateKey('LOCKED'), 'open')
})

test('how someone relates to the repository, in GitHub’s words, and nothing for none', () => {
  assert.equal(associationLabel('OWNER'), 'Owner')
  assert.equal(associationLabel('FIRST_TIME_CONTRIBUTOR'), 'First-time contributor')
  assert.equal(associationLabel('NONE'), null)
})
