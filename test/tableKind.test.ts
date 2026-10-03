import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cellMark, tableKind } from '../src/renderer/src/components/agent/tableKind'
import { numberRows, tokenize } from '../src/renderer/src/components/agent/FileDiff'

test('cells that are only a yes or a no are marks, with or without emphasis', () => {
  for (const yes of ['✓', '✔', '✅', 'Yes', 'yes', '**Yes**', ' true ', 'Included']) assert.equal(cellMark(yes), 'yes', yes)
  for (const no of ['✗', '❌', 'No', '—', '-', '_no_', 'false', 'None']) assert.equal(cellMark(no), 'no', no)
  for (const other of ['', 'Yes, with a plugin', '128k', '$5.00', 'x', 'Maybe']) assert.equal(cellMark(other), null, other)
})

test('mostly ticks and dashes, or a blank first header cell, is a comparison', () => {
  assert.equal(tableKind(['Feature', 'Personal', 'Team'], [['Projects', '✓', '✓'], ['Team use', '—', '✓']]), 'comparison')
  assert.equal(tableKind(['', 'Free', 'Pro'], [['Seats', '1', '10'], ['Price', '$0', '$89']]), 'comparison')
  assert.equal(tableKind(['Model', 'Context', '$/1M in'], [['gpt-4o', '128k', '$5.00'], ['claude', '200k', '$3.00']]), 'data')
  // One dash among numbers is still data.
  assert.equal(tableKind(['Model', 'Context', 'Price'], [['a', '128k', '—'], ['b', '200k', '$3.00']]), 'data')
  assert.equal(tableKind(['Only'], [['one column']]), 'data')
  assert.equal(tableKind(['A', 'B'], []), 'data')
})

test('diff line numbers count each side from its start, and a side with no start has none', () => {
  const rows = numberRows(
    [
      { kind: 'ctx', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'c' },
      { kind: 'add', text: 'd' },
      { kind: 'ctx', text: 'e' }
    ],
    12,
    12
  )
  assert.deepEqual(rows.map((r) => [r.old, r.cur]), [[12, 12], [13, null], [null, 13], [null, 14], [14, 15]])
  assert.deepEqual(numberRows([{ kind: 'add', text: 'x' }], null, 1).map((r) => [r.old, r.cur]), [[null, 1]])
  assert.deepEqual(numberRows([{ kind: 'ctx', text: 'x' }], null, null).map((r) => [r.old, r.cur]), [[null, null]])
})

test('diff colouring: keywords, strings, numbers, calls and comments', () => {
  const kinds = (line: string): string => tokenize(line).filter((t) => t.t !== 'txt').map((t) => `${t.t}:${t.v}`).join(' ')
  assert.equal(kinds('const t = cookies.get("session");'), 'kw:const fn:get str:"session"')
  assert.equal(kinds('  return 42 // done'), 'kw:return num:42 cm:// done')
  assert.equal(kinds('def f(x):  # note'), 'kw:def fn:f cm:# note')
  assert.equal(kinds('color: #fff;'), '', 'a CSS colour is not a comment')
})
