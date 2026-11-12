import { test } from 'node:test'
import assert from 'node:assert/strict'
import { paletteScore, rankItems, withRecentsFirst, type PaletteItem } from '../src/shared/palette'
import { paletteActions, registerPaletteSource, searchPalette } from '../src/renderer/src/lib/commands'

/** The command palette's search and its registry. */

const item = (id: string, title: string, group = 'App', keywords = ''): PaletteItem => ({ id, title, group, keywords })

const ITEMS: PaletteItem[] = [
  item('a', 'Settings: Appearance', 'Settings', 'theme dark light mode'),
  item('b', 'Use the dark appearance', 'Appearance', 'theme mode dark light system'),
  item('c', 'New chat', 'Chat', 'conversation start'),
  item('d', 'Settings: Model providers', 'Settings', 'api key openai'),
  item('e', 'Theme: Dracula', 'Appearance', 'color colour theme'),
  item('f', 'Go to Chat', 'Go to', 'conversation')
]

test('a title that starts with the words ranks first, then words anywhere in it, then the group, then the keywords', () => {
  assert.equal(paletteScore(ITEMS[2], 'new'), 0)
  assert.equal(paletteScore(ITEMS[2], 'chat new'), 1, 'words in any order')
  assert.equal(paletteScore(ITEMS[2], 'chat'), 1)
  assert.equal(paletteScore(ITEMS[3], 'settings api'), 3)
  assert.equal(paletteScore(ITEMS[4], 'appearance dracula'), 2, 'the group counts as a word of the title')
  assert.equal(paletteScore(ITEMS[3], 'zebra'), null)
  assert.equal(paletteScore(ITEMS[3], ''), 0, 'nothing typed matches everything')
})

test('results come best first and, within a rank, in the order given', () => {
  assert.deepEqual(rankItems(ITEMS, 'chat').map((i) => i.id), ['c', 'f'], 'New chat before Go to Chat: same rank, listed order')
  assert.deepEqual(rankItems(ITEMS, 'dark').map((i) => i.id), ['b', 'a'], 'a title with it before a keyword')
  assert.deepEqual(rankItems(ITEMS, 'api key').map((i) => i.id), ['d'], 'what people call a page finds it')
  assert.deepEqual(rankItems(ITEMS, '').map((i) => i.id), ['a', 'b', 'c', 'd', 'e', 'f'])
  assert.equal(rankItems(ITEMS, '', 2).length, 2)
})

test('a word inside another word is not a match', () => {
  assert.deepEqual(rankItems([item('x', 'Report an issue'), item('y', 'Local server port')], 'port').map((i) => i.id), ['y'])
})

test('an action listed twice shows once', () => {
  assert.equal(rankItems([item('a', 'One'), item('a', 'One again')], '').length, 1)
})

test('before anything is typed the actions run last come first', () => {
  assert.deepEqual(withRecentsFirst(ITEMS, ['e', 'c']).map((i) => i.id), ['e', 'c', 'a', 'b', 'd', 'f'])
  assert.deepEqual(withRecentsFirst(ITEMS, ['gone', 'c']).map((i) => i.id).slice(0, 2), ['c', 'a'], 'an action that no longer exists is skipped')
  assert.equal(withRecentsFirst(ITEMS, [], 3).length, 3)
})

test('a feature can add actions and take them away', () => {
  let ran = 0
  const off = registerPaletteSource('test-feature', (query) => [
    { id: 'test:go', title: 'Frobnicate the widget', group: 'Test', keywords: 'gizmo', run: () => void (ran += 1) },
    ...(query === 'zz' ? [{ id: 'test:zz', title: 'Only for zz', group: 'Test', run: () => undefined }] : [])
  ])
  assert.ok(paletteActions('').some((a) => a.id === 'test:go'))
  assert.ok(!paletteActions('').some((a) => a.id === 'test:zz'), 'a source is given the query')
  assert.ok(paletteActions('zz').some((a) => a.id === 'test:zz'))
  const [found] = searchPalette('gizmo')
  assert.equal(found.id, 'test:go')
  found.run()
  assert.equal(ran, 1)
  off()
  assert.ok(!paletteActions('').some((a) => a.id === 'test:go'))
})

test('one source failing leaves the rest of the palette working', () => {
  const quiet = console.error
  console.error = () => undefined
  const off = registerPaletteSource('test-broken', () => {
    throw new Error('boom')
  })
  const offGood = registerPaletteSource('test-good', () => [{ id: 'test:ok', title: 'Still here', group: 'Test', run: () => undefined }])
  try {
    assert.ok(paletteActions('').some((a) => a.id === 'test:ok'))
  } finally {
    console.error = quiet
    off()
    offGood()
  }
})
