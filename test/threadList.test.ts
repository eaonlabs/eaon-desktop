import { test } from 'node:test'
import assert from 'node:assert/strict'
import { heldOrder, matchesSearch, threadOrder, workingFor } from '../src/shared/threadList'

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
