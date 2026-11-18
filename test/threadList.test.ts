import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BADGE_HUES, heldOrder, hueOf, initialsOf, matchesSearch, threadOrder, workingFor } from '../src/shared/threadList'

test('a project tag takes its first two words’ initials, or a one-word name’s first two letters', () => {
  assert.equal(initialsOf('Acme Web'), 'AW')
  assert.equal(initialsOf('pixel-quest'), 'PQ')
  assert.equal(initialsOf('skin_gallery'), 'SG')
  assert.equal(initialsOf('PixelQuest'), 'PQ')
  assert.equal(initialsOf('Notes'), 'NO')
  assert.equal(initialsOf('x'), 'X')
  assert.equal(initialsOf('  '), '?')
  assert.equal(initialsOf('🚀 launch'), '🚀L')
})

test('a project keeps its tint, and tints spread over the palette', () => {
  assert.equal(hueOf('acme-web'), hueOf('acme-web'))
  const hues = new Set(['acme-web', 'pixel-quest', 'notes', 'skin-gallery', 'eaon-desktop', 'tokn', 'website', 'gateway', 'api', 'docs'].map(hueOf))
  assert.ok(hues.size >= 4, `only ${hues.size} tints for ten names`)
  for (const hue of hues) assert.ok(hue >= 0 && hue < BADGE_HUES)
})

test('working time reads in seconds, then minutes, then hours and minutes', () => {
  assert.equal(workingFor(-5), '0s')
  assert.equal(workingFor(31_400), '31s')
  assert.equal(workingFor(5 * 60_000 + 10_000), '5m')
  assert.equal(workingFor(65 * 60_000), '1h 5m')
  assert.equal(workingFor(120 * 60_000), '2h')
})

test('pinned threads lead, then the most recently active; ties keep their order', () => {
  const items = [
    { id: 'a', at: 10, pinned: false },
    { id: 'b', at: 30, pinned: false },
    { id: 'c', at: 5, pinned: true },
    { id: 'd', at: 30, pinned: false }
  ]
  assert.deepEqual(
    threadOrder(items, (i) => i.at, (i) => i.pinned).map((i) => i.id),
    ['c', 'b', 'd', 'a']
  )
})

test('rows already shown hold their places under the pointer; new ones go first', () => {
  assert.deepEqual(heldOrder(['c', 'a', 'b'], ['a', 'b', 'c']), ['a', 'b', 'c'])
  assert.deepEqual(heldOrder(['n', 'c', 'a'], ['a', 'b', 'c']), ['n', 'a', 'c'])
})

test('a search matches any of a thread’s texts, case aside', () => {
  assert.ok(matchesSearch('', ['anything']))
  assert.ok(matchesSearch('  DARK ', ['Add dark mode', null]))
  assert.ok(matchesSearch('develop', [null, 'feature/develop']))
  assert.ok(!matchesSearch('sprite', ['Add dark mode', undefined]))
})
