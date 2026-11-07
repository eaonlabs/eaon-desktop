import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findPathRefs, pathLinksIn } from '../src/shared/terminalLinks'
import { readRows } from '../src/shared/terminalSearch'
import { existingFiles, pathInFolder } from '../src/main/features/ade/pathLinks'

/**
 * File paths in a terminal's output as links: which text is a path (and which
 * only looks like one), the line and column read from it, where it sits on a
 * wrapped line, and which paths are files in the session's folder.
 */

const texts = (line: string): string[] => findPathRefs(line).map((r) => r.text)

test('a path with a line and column is found whole, in the shapes agents and tools print them', () => {
  const found = findPathRefs('Edited src/app.ts:42 and ./lib/x.py')
  assert.deepEqual(
    found.map((r) => [r.text, r.path, r.line]),
    [
      ['src/app.ts:42', 'src/app.ts', 42],
      ['./lib/x.py', './lib/x.py', null]
    ]
  )
  const stack = findPathRefs('    at run (src/a.ts:10:5)')[0]
  assert.deepEqual([stack.text, stack.path, stack.line, stack.col], ['src/a.ts:10:5', 'src/a.ts', 10, 5])
  // TypeScript's own form.
  const tsc = findPathRefs('src/a.ts(42,7): error TS2322: Type')[0]
  assert.deepEqual([tsc.text, tsc.line, tsc.col], ['src/a.ts(42,7)', 42, 7])
  const abs = findPathRefs('Wrote /Users/me/app/src/a.ts:3')[0]
  assert.deepEqual([abs.path, abs.line], ['/Users/me/app/src/a.ts', 3])
  const home = findPathRefs('see ~/notes/todo.md')[0]
  assert.equal(home.path, '~/notes/todo.md')
  const win = findPathRefs('C:\\proj\\src\\a.ts:7')[0]
  assert.deepEqual([win.path, win.line], ['C:\\proj\\src\\a.ts', 7])
})

test('where a path starts and ends in the line is what the text says', () => {
  const line = 'x  (src/app.ts:42:7) y'
  const [ref] = findPathRefs(line)
  assert.equal(line.slice(ref.start, ref.end), 'src/app.ts:42:7')
  // A sentence's full stop, or a colon after it, is not part of the path.
  assert.deepEqual(texts('see src/app.ts.'), ['src/app.ts'])
  assert.deepEqual(texts('src/app.ts: not found'), ['src/app.ts'])
  assert.deepEqual(texts('src/app.ts:42: warning'), ['src/app.ts:42'])
  // A line number of 0 is no line.
  assert.equal(findPathRefs('a/b.ts:0')[0].line, null)
})

test('words with a dot, versions, addresses and URLs are not paths', () => {
  assert.deepEqual(texts('console.log(value) and process.env.HOME'), [])
  assert.deepEqual(texts('upgraded to v1.2.3 from 1.2.2'), [])
  assert.deepEqual(texts('GET https://example.com/a/b.ts:5 200'), [])
  assert.deepEqual(texts('see http://localhost:5173/src/main.ts for it'), [])
  assert.deepEqual(texts('a.b and Math.max'), [])
  // A bare .env is as often a property as a file; with a folder it is a file.
  assert.deepEqual(texts('set .env now'), [])
  assert.deepEqual(texts('copy apps/web/.env'), ['apps/web/.env'])
  // A name files have, with no folder, is one.
  assert.deepEqual(texts('open package.json and README.md'), ['package.json', 'README.md'])
  // Not read out of the middle of a longer word.
  assert.deepEqual(texts('prefix_src/app.ts'), ['prefix_src/app.ts'])
})

test('on a screen: a path the terminal wrapped onto two rows is one link from its first cell to its last', async () => {
  const xterm = (await import('@xterm/headless')) as unknown as { default: typeof import('@xterm/headless') }
  const { Terminal } = xterm.default
  const term = new Terminal({ cols: 24, rows: 6, allowProposedApi: true })
  const write = (text: string): Promise<void> => new Promise((resolve) => term.write(text, resolve))
  // 31 characters on 24 columns: the path breaks after "src/compo".
  await write('error in src/components/Header.tsx:42:5 now\r\n')
  await write('日本語 src/a.ts:9\r\n')
  const buffer = term.buffer.active as unknown as Parameters<typeof readRows>[0]
  const rows = readRows(buffer)
  // The first line is rows 0 and 1; the second is row 2.
  const first = pathLinksIn(rows.slice(0, 2))
  assert.equal(first.length, 1)
  assert.equal(first[0].ref.text, 'src/components/Header.tsx:42:5')
  assert.equal(first[0].ref.line, 42)
  // Starts at cell 10 of the first row (1-based), ends in the second row.
  assert.deepEqual(first[0].start, { x: 10, y: 1 })
  assert.equal(first[0].end.y, 2)
  assert.equal(first[0].end.x, 'src/components/Header.tsx:42:5'.length - (24 - 9))
  // After three wide characters (six cells) and a space the path starts at cell 8, not cell 5.
  const wide = pathLinksIn(rows.slice(2, 3))
  assert.deepEqual(wide[0].start, { x: 8, y: 1 })
  assert.equal(wide[0].end.x, 8 + 'src/a.ts:9'.length - 1)
  term.dispose()
})

let tmp = ''
before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ade-links-')))
  fs.mkdirSync(path.join(tmp, 'app', 'src'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'app', 'src', 'a.ts'), 'x\n')
  fs.writeFileSync(path.join(tmp, 'outside.txt'), 'x\n')
})
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('a printed path is a link only when it is a file inside the session’s folder', async () => {
  const folder = path.join(tmp, 'app')
  const found = await existingFiles(
    folder,
    ['src/a.ts', './src/a.ts', path.join(folder, 'src', 'a.ts'), 'src/missing.ts', 'src', '../outside.txt', path.join(tmp, 'outside.txt'), '~/app/src/a.ts'],
    tmp
  )
  const a = path.join(folder, 'src', 'a.ts')
  assert.deepEqual(found, [a, a, a, null, null, null, null, a])
})

test('a path is resolved against the folder, and one that climbs out of it names nothing', () => {
  assert.equal(pathInFolder('/work/app', 'src/a.ts', '/home/me'), path.join('/work/app', 'src', 'a.ts'))
  assert.equal(pathInFolder('/work/app', '../other/a.ts', '/home/me'), null)
  assert.equal(pathInFolder('/work/app', 'src/../../x.ts', '/home/me'), null)
  assert.equal(pathInFolder('/work/app', '/etc/passwd', '/home/me'), null)
  assert.equal(pathInFolder('/work/app', '.', '/home/me'), null)
  assert.equal(pathInFolder('/home/me/app', '~/app/x.ts', '/home/me'), path.join('/home/me/app', 'x.ts'))
})
