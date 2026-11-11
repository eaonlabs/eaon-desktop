import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deleteRows, findTable, matchRows, MAX_COLUMNS, MAX_ROWS, normalizeTables, tableCsv, tableText, writeRows, type WorkerTable } from '@shared/workerTables'

/** A worker's tables as pure rules: make, add, update by key, filter, remove, and stay within limits. */

const NOW = 1_000

test('writing makes the table, with the columns the rows bring', () => {
  const { tables, added, updated, newColumns } = writeRows([], 'Leads', [{ Name: 'Ada', Email: 'ada@x.dev' }, { name: 'Bo', Stage: 'new' }], { now: NOW })
  assert.equal(added, 2)
  assert.equal(updated, 0)
  assert.deepEqual(tables[0].columns, ['Name', 'Email', 'Stage'], 'a column is the same whatever its case')
  assert.deepEqual(newColumns, ['Name', 'Email', 'Stage'])
  assert.deepEqual(tables[0].rows[0], { Name: 'Ada', Email: 'ada@x.dev', Stage: '' })
  assert.deepEqual(tables[0].rows[1], { Name: 'Bo', Email: '', Stage: 'new' })
})

test('a key column updates the row it matches instead of adding another', () => {
  const first = writeRows([], 'Leads', [{ Email: 'a@x.dev', Stage: 'new' }], { now: NOW }).tables
  const next = writeRows(first, 'leads', [{ Email: 'a@x.dev', Stage: 'won' }, { Email: 'b@x.dev', Stage: 'new' }], { key: 'email', now: NOW + 1 })
  assert.equal(next.updated, 1)
  assert.equal(next.added, 1)
  assert.deepEqual(next.tables[0].rows.map((r) => r.Stage), ['won', 'new'])
  assert.equal(first[0].rows[0].Stage, 'new', 'the list it was given is not changed')
  assert.throws(() => writeRows(first, 'Leads', [{ Email: 'c' }], { key: 'phone', now: NOW }), /no column called phone/)
})

test('rows are found by exact values, case ignored, and removed the same way', () => {
  const { tables } = writeRows([], 'Orders', [{ Id: '1', State: 'Open' }, { Id: '2', State: 'open' }, { Id: '3', State: 'Shipped' }], { now: NOW })
  const table = findTable(tables, ' ORDERS ')!
  assert.equal(matchRows(table, { state: 'OPEN' }).length, 2)
  assert.equal(matchRows(table, undefined).length, 3)
  assert.throws(() => matchRows(table, { colour: 'red' }), /no column called colour/)
  const { tables: after, removed } = deleteRows(tables, 'Orders', { State: 'open' }, NOW + 5)
  assert.equal(removed, 2)
  assert.deepEqual(after[0].rows.map((r) => r.Id), ['3'])
  assert.throws(() => deleteRows(tables, 'Orders', {}, NOW), /Say which rows/)
  assert.throws(() => deleteRows(tables, 'Nope', { a: 'b' }, NOW), /no table called Nope/)
})

test('limits hold: columns, rows and the number of tables', () => {
  const wide = Object.fromEntries(Array.from({ length: MAX_COLUMNS + 1 }, (_, i) => [`c${i}`, 'x']))
  assert.throws(() => writeRows([], 'Wide', [wide], { now: NOW }), /up to 30 columns/)
  const many = Array.from({ length: MAX_ROWS }, (_, i) => ({ n: String(i) }))
  const full = writeRows([], 'Big', many, { now: NOW }).tables
  assert.throws(() => writeRows(full, 'Big', [{ n: 'more' }], { now: NOW }), /up to 5000 rows/)
  let tables: WorkerTable[] = []
  for (let i = 0; i < 20; i++) tables = writeRows(tables, `T${i}`, [{ a: '1' }], { now: NOW }).tables
  assert.throws(() => writeRows(tables, 'One more', [{ a: '1' }], { now: NOW }), /up to 20 tables/)
  assert.throws(() => writeRows([], '  ', [{ a: '1' }], { now: NOW }), /Name the table/)
  assert.throws(() => writeRows([], 'T', [], { now: NOW }), /at least one row/)
})

test('numbers are kept as text, and damaged saved tables are repaired on reading', () => {
  const { tables } = writeRows([], 'Prices', [{ Item: 'Tea', Price: 4.5, InStock: true }], { now: NOW })
  assert.deepEqual(tables[0].rows[0], { Item: 'Tea', Price: '4.5', InStock: 'true' })
  const repaired = normalizeTables([{ name: 'A', columns: ['x', 'X', 'y'], rows: [{ x: 1, y: 'k', z: 'dropped' }, 'junk'], updatedAt: 'bad' }, { name: 'a' }, null, { columns: [] }])
  assert.equal(repaired.length, 1)
  assert.deepEqual(repaired[0].columns, ['x', 'y'])
  assert.deepEqual(repaired[0].rows, [{ x: '1', y: 'k' }])
  assert.equal(repaired[0].updatedAt, 0)
})

test('a table reads as text for the worker and as CSV for the page', () => {
  const { tables } = writeRows([], 'Leads', [{ Name: 'Ada | Lovelace', Note: 'says "hi"\nthen left' }], { now: NOW })
  const text = tableText(tables[0], tables[0].rows, 3)
  assert.match(text, /^Leads: 3 rows/)
  assert.match(text, /Ada \\\| Lovelace/)
  assert.match(text, /\(1 of 3 rows shown\)/)
  assert.equal(tableCsv(tables[0]), 'Name,Note\nAda | Lovelace,"says ""hi""\nthen left"')
})
