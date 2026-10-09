import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  columnDividers,
  dividerValue,
  placement,
  resizeTracks,
  rowDividers,
  shapeFor,
  swapped,
  template,
  validSizes
} from '../src/renderer/src/components/code/terminal/gridLayout'

/**
 * The ADE's terminal grid: placing terminals on grid lines with a divider
 * track between each two, where the dividers run, and what dragging one does.
 */

test('terminals sit on the grid’s lines, with the last of a short row stretching to the end', () => {
  const three = shapeFor(3)
  assert.deepEqual(three, { cols: 2, rows: 2 })
  assert.deepEqual(
    [0, 1, 2].map((i) => placement(i, 3, three)),
    [
      { gridColumn: '1 / 2', gridRow: '1 / 2' },
      { gridColumn: '3 / 4', gridRow: '1 / 2' },
      // Row 2, from the first column to the end: over the divider track too.
      { gridColumn: '1 / 4', gridRow: '3 / 4' }
    ]
  )
  assert.deepEqual(placement(4, 5, shapeFor(5)), { gridColumn: '3 / 6', gridRow: '3 / 4' })
  assert.equal(template([1, 2]), 'minmax(0, 1fr) 8px minmax(0, 2fr)')
})

test('a column divider stops above a short last row where no terminal is on its right', () => {
  // Three terminals: two above, one stretched below. The one divider runs through the top row only.
  assert.deepEqual(columnDividers(3, shapeFor(3)), [{ index: 0, gridColumn: '2 / 3', gridRow: '1 / 3' }])
  // Four: the divider runs the whole height.
  assert.deepEqual(columnDividers(4, shapeFor(4)), [{ index: 0, gridColumn: '2 / 3', gridRow: '1 / -1' }])
  // Five on three columns: the first divider runs through both rows (two terminals below), the second stops above.
  assert.deepEqual(
    columnDividers(5, shapeFor(5)).map((d) => [d.index, d.gridRow]),
    [
      [0, '1 / -1'],
      [1, '1 / 3']
    ]
  )
  assert.deepEqual(columnDividers(1, shapeFor(1)), [])
  assert.deepEqual(rowDividers(shapeFor(1)), [])
  assert.deepEqual(rowDividers(shapeFor(5)), [{ index: 0, gridColumn: '1 / -1', gridRow: '2 / 3' }])
})

test('dragging a divider gives one neighbour what the other gives up, and neither gets too small', () => {
  // Two columns sharing 1000px: 500px each, one fr = 500px.
  assert.deepEqual(resizeTracks([1, 1], 0, 200, 1000, 160), [1.4, 0.6000000000000001])
  // Only the two around the divider change: 300px each, 100px moves from the middle one to the last.
  const three = resizeTracks([1, 1, 1], 1, -100, 900, 160)
  assert.equal(three[0], 1)
  assert.ok(Math.abs(three[1] - 2 / 3) < 1e-9 && Math.abs(three[2] - 4 / 3) < 1e-9, String(three))
  // 150px would leave it 150px wide, under the 160px minimum: it stops at 160px.
  const floor = resizeTracks([1, 1, 1], 1, -150, 900, 160)
  assert.ok(Math.abs(floor[1] - 160 / 300) < 1e-9, String(floor))
  // Past the minimum it stops: 160px of 1000px is 0.32fr.
  const squeezed = resizeTracks([1, 1], 0, 5000, 1000, 160)
  assert.ok(Math.abs(squeezed[1] - 0.32) < 1e-9, String(squeezed))
  const other = resizeTracks([1, 1], 0, -5000, 1000, 160)
  assert.ok(Math.abs(other[0] - 0.32) < 1e-9, String(other))
  // Not even room for both minimums: they stay even rather than one vanishing.
  assert.deepEqual(resizeTracks([1, 1], 0, 300, 200, 160), [1, 1])
  assert.deepEqual(resizeTracks([1, 1], 3, 50, 1000, 160), [1, 1], 'a divider that isn’t there changes nothing')
  assert.equal(dividerValue([1.4, 0.6], 0), 70)
})

test('sizes read back only when they fit the grid’s shape', () => {
  const shape = shapeFor(4)
  assert.deepEqual(validSizes({ cols: [1.5, 0.5], rows: [1, 1] }, shape), { cols: [1.5, 0.5], rows: [1, 1] })
  for (const bad of [null, {}, { cols: [1], rows: [1, 1] }, { cols: [1, -1], rows: [1, 1] }, { cols: [1, Number.NaN], rows: [1, 1] }, 'x']) {
    assert.deepEqual(validSizes(bad, shape), { cols: [1, 1], rows: [1, 1] }, JSON.stringify(bad))
  }
})

test('two terminals trade places; anything else leaves the order alone', () => {
  const panes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.deepEqual(
    swapped(panes, 'a', 'c').map((p) => p.id),
    ['c', 'b', 'a']
  )
  assert.equal(swapped(panes, 'a', 'a'), panes)
  assert.equal(swapped(panes, 'a', 'gone'), panes)
})
