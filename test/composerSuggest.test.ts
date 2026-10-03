import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findTrigger, rankItems, removeMention, replaceTrigger } from '../src/renderer/src/components/composer/suggest'

test('a trigger opens only at the start of a word, and reads the word up to the caret', () => {
  assert.deepEqual(findTrigger('/pl', 3), { char: '/', query: 'pl', start: 0, end: 3 })
  assert.deepEqual(findTrigger('ask @no about it', 7), { char: '@', query: 'no', start: 4, end: 7 })
  assert.deepEqual(findTrigger('@', 1), { char: '@', query: '', start: 0, end: 1 })
  assert.equal(findTrigger('and/or', 4), null, 'mid-word')
  assert.equal(findTrigger('me@example.com', 3), null, 'an email address')
  assert.equal(findTrigger('/usr/bin', 8), null, 'a path')
  assert.equal(findTrigger('@a@b', 4), null)
  assert.equal(findTrigger('/plan', 0), null, 'the caret before the trigger')
  assert.equal(findTrigger('/plan fix it', 9), null, 'the caret in a later word')
  assert.equal(findTrigger('@notion', 7, ['/']), null, 'a trigger the menu does not offer')
  assert.equal(findTrigger(`/${'x'.repeat(41)}`, 42), null, 'too long to be a lookup')
})

test('ranking puts title prefixes first, then word starts, keywords, then anywhere', () => {
  const items = [
    { title: 'Swarm', keywords: 'parallel helpers' },
    { title: 'Plan first', keywords: 'plan' },
    { title: 'Full autonomy', keywords: 'permissions' },
    { title: 'Explain plan', keywords: '' },
    { title: 'Airplane mode' }
  ]
  assert.deepEqual(
    rankItems(items, 'pla').map((i) => i.title),
    ['Plan first', 'Explain plan', 'Airplane mode']
  )
  assert.deepEqual(rankItems(items, 'perm').map((i) => i.title), ['Full autonomy'], 'a keyword')
  assert.deepEqual(rankItems(items, 'help').map((i) => i.title), ['Swarm'])
  assert.deepEqual(rankItems(items, '').map((i) => i.title), items.map((i) => i.title), 'empty keeps the menu order')
  assert.deepEqual(rankItems(items, 'zzz'), [])
})

test('picking replaces the trigger word, spaces the insert, and drops a command cleanly', () => {
  assert.deepEqual(replaceTrigger('ask @no', { start: 4, end: 7 }, '@Notion'), { text: 'ask @Notion ', caret: 12 })
  assert.deepEqual(replaceTrigger('ask @no about', { start: 4, end: 7 }, '@Notion'), { text: 'ask @Notion about', caret: 12 })
  assert.deepEqual(replaceTrigger('/plan fix it', { start: 0, end: 5 }, ''), { text: 'fix it', caret: 0 })
  assert.deepEqual(replaceTrigger('fix it /plan', { start: 7, end: 12 }, ''), { text: 'fix it ', caret: 7 })
})

test('removing a mention takes its word and one space, wherever it is', () => {
  assert.equal(removeMention('@Notion find my notes', 'Notion'), 'find my notes')
  assert.equal(removeMention('find @notion notes', 'Notion'), 'find notes')
  assert.equal(removeMention('use @Google Drive and @Notion', 'Google Drive'), 'use and @Notion')
  assert.equal(removeMention('@Notionary stays', 'Notion'), '@Notionary stays')
})
