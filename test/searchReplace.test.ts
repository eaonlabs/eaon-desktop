import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { replaceInText, replaceLine, replacedSummary, searchPattern } from '../src/shared/searchReplace'
import { HostBook } from '../src/main/features/ade/hosts'
import { makeRunner } from '../src/main/features/ade/runner'
import { replaceInFolder, undoReplaceIn } from '../src/main/features/searchReplace'
import { allowFolders } from '../src/main/features/workspaceFiles'

/**
 * Replace across the project (shared/searchReplace.ts, main/features/searchReplace.ts):
 * the rules the preview and the write share, and the write itself in a real
 * repository: chosen lines only, ignored files and stale lines left alone,
 * line endings kept, and the last replacement put back.
 */

const pattern = (query: string, options: { caseSensitive?: boolean; regex?: boolean; word?: boolean } = {}): RegExp => {
  const made = searchPattern(query, options)
  assert.ok('pattern' in made, 'error' in made ? made.error : '')
  return 'pattern' in made ? made.pattern : /x/
}

test('a plain search takes the replacement as typed, a regular expression expands $1 and the like', () => {
  assert.equal(replaceLine('a.b a.b', pattern('a.b'), '$1[x]', false).text, '$1[x] $1[x]')
  assert.equal(replaceLine('axb a.b', pattern('a.b'), 'Z', false).text, 'axb Z')
  assert.equal(replaceLine('foo(1, 2)', pattern('foo\\((\\d), (\\d)\\)', { regex: true }), 'bar($2, $1)', true).text, 'bar(2, 1)')
  assert.equal(replaceLine('cost', pattern('cost', { regex: true }), '$&$&|$$|$`|$\'', true).text, 'costcost|$||')
  assert.equal(replaceLine('ab', pattern('(?<first>a)', { regex: true }), '<$<first>>', true).text, '<a>b')
  // `$12` with fewer than twelve groups is the first group then a "2".
  assert.equal(replaceLine('a', pattern('(a)', { regex: true }), '$12', true).text, 'a2')
  assert.equal(replaceLine('a', pattern('(a)', { regex: true }), '$5', true).text, '$5')
})

test('case and whole words follow the search, and the parts say which pieces were replaced', () => {
  assert.equal(replaceLine('Foo foo FOO', pattern('foo'), 'x', false).count, 3)
  assert.equal(replaceLine('Foo foo FOO', pattern('foo', { caseSensitive: true }), 'x', false).text, 'Foo x FOO')
  assert.equal(replaceLine('cat concat cat.', pattern('cat', { word: true }), 'dog', false).text, 'dog concat dog.')
  const r = replaceLine('let a = 1', pattern('a'), 'b', false)
  assert.deepEqual(r.parts, [{ text: 'let ', hit: false }, { text: 'b', hit: true }, { text: ' = 1', hit: false }])
  assert.equal(replaceLine('abc', pattern('b'), '', false).text, 'ac')
})

test('a search that is not a pattern, or matches nothing in particular, says why', () => {
  assert.ok('error' in searchPattern('', {}))
  assert.match((searchPattern('(', { regex: true }) as { error: string }).error, /.+/)
  assert.match((searchPattern('a*', { regex: true }) as { error: string }).error, /empty string/)
  assert.ok('pattern' in searchPattern('(', {}), 'brackets are only special in a regular expression')
})

test('only the chosen lines change, line endings stay, and a chosen line that no longer matches is reported', () => {
  const text = 'one foo\ntwo\r\nthree foo\r\nfour foo\n'
  const all = replaceInText(text, pattern('foo'), 'bar', false)
  assert.equal(all.text, 'one bar\ntwo\r\nthree bar\r\nfour bar\n')
  assert.deepEqual(all.lines, [1, 3, 4])
  assert.equal(all.replaced, 3)
  const some = replaceInText(text, pattern('foo'), 'bar', false, new Set([3, 2]))
  assert.equal(some.text, 'one foo\ntwo\r\nthree bar\r\nfour foo\n')
  assert.deepEqual(some.lines, [3])
  assert.deepEqual(some.stale, [2])
  assert.equal(replaceInText('x', pattern('foo'), 'bar', false).replaced, 0)
  assert.equal(replacedSummary([{ path: 'a', replaced: 1, lines: [1] }]), 'Replaced 1 match in 1 file.')
  assert.equal(replacedSummary([{ path: 'a', replaced: 2, lines: [1] }, { path: 'b', replaced: 3, lines: [1, 2] }]), 'Replaced 5 matches in 2 files.')
  assert.equal(replacedSummary([]), 'Nothing was replaced.')
})

/* ------------------------------------------------------------------ in a repository */

let tmp = ''
let repo = ''
const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.com' }
const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' }).trim()
const run = makeRunner(new HostBook({ load: () => [], save: () => undefined, readConfig: async () => [] }))
const read = (name: string): string => fs.readFileSync(path.join(repo, name), 'utf8')
const write = (name: string, text: string | Buffer): void => {
  fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true })
  fs.writeFileSync(path.join(repo, name), text)
}

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'search-replace-')))
  repo = path.join(tmp, 'acme')
  fs.mkdirSync(repo)
  // The folder is one the dock may look inside, as a chat's project is.
  allowFolders(() => [repo])
  git('init', '-q', '-b', 'main')
  write('.gitignore', 'dist/\n*.log\n')
  write('src/a.ts', 'const oldName = 1\nuse(oldName)\nnothing here\n')
  write('src/b.ts', 'import { oldName } from "./a"\r\nexport const x = oldName\r\n')
  write('dist/out.js', 'var oldName = 1\n')
  write('debug.log', 'oldName logged\n')
  write('bin.dat', Buffer.from([0x6f, 0x6c, 0x64, 0x4e, 0x61, 0x6d, 0x65, 0x00, 0x01]))
  git('add', '.gitignore', 'src', 'bin.dat')
  git('commit', '-q', '-m', 'init')
})

after(() => fs.rmSync(tmp, { recursive: true, force: true }))

const request = (targets: { path: string; lines?: number[] }[], over: Partial<{ query: string; replacement: string }> = {}) => ({
  query: over.query ?? 'oldName',
  options: { caseSensitive: true },
  replacement: over.replacement ?? 'newName',
  targets
})

test('replaces the chosen lines of the chosen files and leaves the rest as they were', async () => {
  const res = await replaceInFolder(repo, request([{ path: 'src/a.ts', lines: [2] }, { path: 'src/b.ts' }]), run)
  assert.ok(res.ok, res.ok ? '' : res.error)
  if (!res.ok) return
  assert.deepEqual(res.files, [
    { path: 'src/a.ts', replaced: 1, lines: [2] },
    { path: 'src/b.ts', replaced: 2, lines: [1, 2] }
  ])
  assert.equal(read('src/a.ts'), 'const oldName = 1\nuse(newName)\nnothing here\n', 'line 1 was not chosen')
  assert.equal(read('src/b.ts'), 'import { newName } from "./a"\r\nexport const x = newName\r\n', 'CRLF line endings kept')
  assert.equal(res.undoable, true)
  assert.deepEqual(res.skipped, [])
})

test('ignored files, binaries, other folders and made-up paths are left alone and named', async () => {
  const res = await replaceInFolder(
    repo,
    request([{ path: 'dist/out.js' }, { path: 'debug.log' }, { path: 'bin.dat' }, { path: '../outside.txt' }, { path: '/etc/hosts' }, { path: 'src/missing.ts' }]),
    run
  )
  assert.ok(res.ok)
  if (!res.ok) return
  assert.deepEqual(res.files, [])
  const why = Object.fromEntries(res.skipped.map((s) => [s.path, s.reason]))
  assert.equal(why['dist/out.js'], 'git ignores it')
  assert.equal(why['debug.log'], 'git ignores it')
  assert.match(why['bin.dat'], /not a text file/)
  assert.equal(why['../outside.txt'], 'not a file in this folder')
  assert.equal(why['/etc/hosts'], 'not a file in this folder')
  assert.equal(why['src/missing.ts'], 'it isn’t there any more')
  assert.equal(read('dist/out.js'), 'var oldName = 1\n')
  assert.equal(read('debug.log'), 'oldName logged\n')
})

test('a file edited since the search is not written from the old answer', async () => {
  const res = await replaceInFolder(repo, request([{ path: 'src/a.ts', lines: [3] }], { query: 'oldName' }), run)
  assert.ok(res.ok)
  if (!res.ok) return
  assert.deepEqual(res.files, [])
  assert.match(res.skipped[0].reason, /changed since the search/)
  assert.equal(read('src/a.ts'), 'const oldName = 1\nuse(newName)\nnothing here\n')
})

test('a replacement that would land everywhere, and nothing chosen, are refused', async () => {
  const wide = await replaceInFolder(repo, { ...request([{ path: 'src/a.ts' }]), query: 'x*', options: { regex: true } }, run)
  assert.ok(!wide.ok && /empty string/.test(wide.error))
  const none = await replaceInFolder(repo, request([]), run)
  assert.deepEqual(none, { ok: false, error: 'Choose at least one match to replace.' })
})

test('the last replacement is put back in the files still as it left them', async () => {
  write('src/c.ts', 'oldName\n')
  write('src/d.ts', 'oldName\n')
  git('add', 'src/c.ts', 'src/d.ts')
  const res = await replaceInFolder(repo, request([{ path: 'src/c.ts' }, { path: 'src/d.ts' }]), run)
  assert.ok(res.ok && res.files.length === 2)
  assert.equal(read('src/c.ts'), 'newName\n')
  // d.ts is edited by hand afterwards: undo leaves it alone.
  write('src/d.ts', 'newName\nmy own edit\n')
  const undone = await undoReplaceIn(repo)
  assert.deepEqual(undone, { ok: true, restored: ['src/c.ts'], conflicts: ['src/d.ts'] })
  assert.equal(read('src/c.ts'), 'oldName\n')
  assert.equal(read('src/d.ts'), 'newName\nmy own edit\n')
  assert.deepEqual(await undoReplaceIn(repo), { ok: false, error: 'There is no replacement to undo.' })
})

test('a regular expression replacement expands its groups in the file', async () => {
  write('src/e.ts', 'call(1, 2)\ncall(3, 4)\n')
  git('add', 'src/e.ts')
  const res = await replaceInFolder(repo, { query: 'call\\((\\d), (\\d)\\)', options: { regex: true }, replacement: 'call($2, $1)', targets: [{ path: 'src/e.ts', lines: [1, 2] }] }, run)
  assert.ok(res.ok && res.files[0].replaced === 2)
  assert.equal(read('src/e.ts'), 'call(2, 1)\ncall(4, 3)\n')
})
