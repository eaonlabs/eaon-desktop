import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keepMatch, patternFor, readRows, searchRows, stepIndex, type SearchRow } from '../src/shared/terminalSearch'

/**
 * Find in a terminal's output: the search over a buffer's rows (matches,
 * wrapped lines, wide characters, case, whole words, regular expressions),
 * and stepping through the matches. The last test runs it over a real xterm
 * buffer, the parser the app draws with.
 */

const rows = (...lines: string[]): SearchRow[] => lines.map((text) => ({ text, wrapped: false }))

test('every match is found, oldest first, with where it is', () => {
  const found = searchRows(rows('error: one', 'fine', 'an error and another error'), 'error')
  assert.deepEqual(
    found.matches.map((m) => [m.row, m.col]),
    [
      [0, 0],
      [2, 3],
      [2, 21]
    ]
  )
  assert.equal(found.truncated, false)
  assert.deepEqual(found.matches[1].segments, [{ row: 2, col: 3, width: 5 }])
})

test('a search ignores case unless asked, and finds whole words only when asked', () => {
  const lines = rows('Error', 'terror', 'ERROR')
  assert.equal(searchRows(lines, 'error').matches.length, 3)
  assert.deepEqual(
    searchRows(lines, 'error', { caseSensitive: true }).matches.map((m) => m.row),
    [1]
  )
  assert.equal(searchRows(lines, 'Error', { caseSensitive: true }).matches.length, 1)
  assert.deepEqual(
    searchRows(lines, 'error', { word: true }).matches.map((m) => m.row),
    [0, 2]
  )
})

test('text is searched as text unless it is a regular expression', () => {
  const lines = rows('a.b', 'axb', 'build 12 ok')
  assert.deepEqual(
    searchRows(lines, 'a.b').matches.map((m) => m.row),
    [0]
  )
  assert.deepEqual(
    searchRows(lines, 'a.b', { regex: true }).matches.map((m) => m.row),
    [0, 1]
  )
  const digits = searchRows(lines, '\\d+', { regex: true })
  assert.deepEqual(digits.matches[0].segments, [{ row: 2, col: 6, width: 2 }])
  // A word search with a pattern keeps its boundaries.
  assert.equal(searchRows(rows('cat concat'), 'cat', { word: true }).matches.length, 1)
})

test('a pattern that does not parse says so instead of throwing, and an empty query finds nothing', () => {
  const bad = searchRows(rows('x'), '(', { regex: true })
  assert.equal(bad.matches.length, 0)
  assert.ok(bad.error && bad.error.length > 0)
  assert.equal(patternFor('', {}) instanceof RegExp, false)
  assert.deepEqual(searchRows(rows('x'), ''), { matches: [], truncated: false })
  // Matching nothing (a* against b) is no match, and does not loop.
  assert.equal(searchRows(rows('bbb'), 'a*', { regex: true }).matches.length, 0)
})

test('a line the terminal wrapped is one line: a word split across rows is found, as a piece on each', () => {
  const wrapped: SearchRow[] = [
    { text: 'see src/app', wrapped: false },
    { text: '.ts for it', wrapped: true },
    { text: 'next line', wrapped: false }
  ]
  const found = searchRows(wrapped, 'app.ts')
  assert.equal(found.matches.length, 1)
  assert.deepEqual(found.matches[0].segments, [
    { row: 0, col: 8, width: 3 },
    { row: 1, col: 0, width: 3 }
  ])
  assert.equal(found.matches[0].row, 0)
  // Nothing is found across a row that is not a continuation.
  assert.equal(searchRows(wrapped, 'for itnext').matches.length, 0)
})

test('wide characters take two cells: a match after one starts in the right column', () => {
  // 日本 is four cells; "ok" starts at column 5 although it is the fourth character.
  const wide: SearchRow = { text: '日本 ok', wrapped: false, cols: [0, 2, 4, 5, 6, 7] }
  const found = searchRows([wide], 'ok')
  assert.deepEqual(found.matches[0].segments, [{ row: 0, col: 5, width: 2 }])
  const onWide = searchRows([wide], '本')
  assert.deepEqual(onWide.matches[0].segments, [{ row: 0, col: 2, width: 2 }])
})

test('a log with more matches than the limit stops there and says so', () => {
  const many = rows(...Array.from({ length: 50 }, () => 'x x x'))
  const found = searchRows(many, 'x', {}, 120)
  assert.equal(found.matches.length, 120)
  assert.equal(found.truncated, true)
  assert.equal(searchRows(many, 'x').truncated, false)
})

test('stepping starts at the newest match and goes older with Enter, newer with Shift+Enter, wrapping round', () => {
  // No current match: the newest.
  assert.equal(stepIndex(-1, 5, 1), 4)
  assert.equal(stepIndex(4, 5, 1), 3)
  assert.equal(stepIndex(0, 5, 1), 4)
  assert.equal(stepIndex(4, 5, -1), 0)
  assert.equal(stepIndex(1, 5, -1), 2)
  assert.equal(stepIndex(0, 0, 1), -1)
})

test('after new output the match on show is the one at the same place, else the nearest index', () => {
  const at = (row: number, col = 0) => ({ row, col, segments: [] })
  const before = at(4)
  assert.equal(keepMatch(before, [at(1), at(4), at(9)], 0), 1)
  assert.equal(keepMatch(before, [at(1), at(2)], 7), 1)
  assert.equal(keepMatch(null, [at(1), at(2), at(3)], 1), 1)
  assert.equal(keepMatch(before, [], 3), -1)
})

test('over a real xterm buffer: wrapped lines and wide characters give the columns the screen has', async () => {
  const xterm = (await import('@xterm/headless')) as unknown as { default: typeof import('@xterm/headless') }
  const { Terminal } = xterm.default
  const term = new Terminal({ cols: 20, rows: 6, allowProposedApi: true })
  const write = (text: string): Promise<void> => new Promise((resolve) => term.write(text, resolve))
  // 28 characters on 20 columns wrap onto a second row, through the middle of "needle"; then wide characters, then a plain line.
  await write('0123456789012345 needle tail\r\n')
  await write('日本語 needle\r\n')
  await write('x needle\r\n')
  const read = readRows(term.buffer.active as unknown as Parameters<typeof readRows>[0])
  assert.equal(read[1].wrapped, true)
  const found = searchRows(read, 'needle')
  assert.equal(found.matches.length, 3)
  // The word the terminal broke across two rows is one match, a piece on each.
  assert.deepEqual(found.matches[0].segments, [
    { row: 0, col: 17, width: 3 },
    { row: 1, col: 0, width: 3 }
  ])
  // After three wide characters (six cells) and a space: column 7, not column 4.
  assert.deepEqual(found.matches[1].segments, [{ row: 2, col: 7, width: 6 }])
  assert.deepEqual(found.matches[2].segments, [{ row: 3, col: 2, width: 6 }])
  term.dispose()
})
