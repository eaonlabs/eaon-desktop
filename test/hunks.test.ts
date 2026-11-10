import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { hunkBody, hunkFingerprint, hunkPatch, isRepoRelative, splitFileDiff, type RawHunk } from '../src/shared/hunks'
import { parseUnifiedDiff } from '../src/shared/adeReview'
import { applyHunk } from '../src/main/features/chatCode'

/**
 * Accepting or rejecting one hunk: the split of a file's diff into hunks, the
 * paths git is asked about, and the real thing in a scratch repository (the
 * file after a reject, the index after a keep, a stale diff refused).
 */

let dir = ''
const git = (...args: string[]): string => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
const lines = (n: number, tweak: Record<number, string> = {}): string => Array.from({ length: n }, (_, i) => tweak[i + 1] ?? `line ${i + 1}`).join('\n') + '\n'
const fp = (h: RawHunk): string => hunkFingerprint(hunkBody(h))
const diffOf = (): string => git('diff', 'HEAD', '--no-color', '--no-ext-diff', '--no-renames', '-U3', '--', 'app.txt')

before(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hunks-')))
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.com')
  fs.writeFileSync(path.join(dir, 'app.txt'), lines(40))
  git('add', '.')
  git('commit', '-q', '-m', 'first')
})
after(() => fs.rmSync(dir, { recursive: true, force: true }))

test('a file’s diff is split into its head and each hunk, and one hunk makes a patch of its own', () => {
  fs.writeFileSync(path.join(dir, 'app.txt'), lines(40, { 3: 'top changed', 38: 'bottom changed' }))
  const split = splitFileDiff(diffOf())!
  assert.equal(split.hunks.length, 2)
  assert.match(split.head, /^diff --git a\/app\.txt b\/app\.txt\n/)
  assert.match(split.head, /\+\+\+ b\/app\.txt\n$/)
  assert.match(split.hunks[0].header, /^@@ -1,6 \+1,6 @@/)
  assert.match(split.hunks[1].text, /\+bottom changed/)
  assert.doesNotMatch(split.hunks[1].text, /top changed/)
  assert.equal(hunkPatch(split, 1), split.head + split.hunks[1].text)
  assert.equal(hunkPatch(split, 2), null)
  assert.equal(hunkPatch(split, -1), null)
  git('checkout', '--', 'app.txt')
})

test('nothing to split: no change, or more than one file', () => {
  assert.equal(splitFileDiff(''), null)
  assert.equal(splitFileDiff('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/b b/b\n--- a/b\n+++ b/b\n@@ -1 +1 @@\n-x\n+y\n'), null)
})

test('paths git is asked about stay inside the folder', () => {
  for (const ok of ['app.txt', 'src/a/b.ts', 'dir with space/f.txt']) assert.ok(isRepoRelative(ok), ok)
  for (const bad of ['', '/etc/passwd', '../x', 'a/../../x', 'C:\\x', '\\\\server\\share', '-rf', 'a\0b', null, 5]) assert.ok(!isRepoRelative(bad), String(bad))
})

test('rejecting a hunk undoes just that hunk in the file and leaves the other change', async () => {
  fs.writeFileSync(path.join(dir, 'app.txt'), lines(40, { 3: 'top changed', 38: 'bottom changed' }))
  const split = splitFileDiff(diffOf())!
  const res = await applyHunk(dir, 'app.txt', 0, split.hunks[0].header, fp(split.hunks[0]), 'reject')
  assert.deepEqual(res, { ok: true })
  const text = fs.readFileSync(path.join(dir, 'app.txt'), 'utf8')
  assert.equal(text, lines(40, { 38: 'bottom changed' }), 'the top is back, the bottom change stays')
  assert.equal(splitFileDiff(diffOf())!.hunks.length, 1)
  git('checkout', '--', 'app.txt')
})

test('keeping a hunk stages just that hunk; keeping it again says it was already staged', async () => {
  fs.writeFileSync(path.join(dir, 'app.txt'), lines(40, { 3: 'top changed', 38: 'bottom changed' }))
  const split = splitFileDiff(diffOf())!
  assert.deepEqual(await applyHunk(dir, 'app.txt', 1, split.hunks[1].header, fp(split.hunks[1]), 'keep'), { ok: true })
  const staged = git('diff', '--cached', '--no-color', '-U0')
  assert.match(staged, /\+bottom changed/)
  assert.doesNotMatch(staged, /top changed/)
  assert.equal(fs.readFileSync(path.join(dir, 'app.txt'), 'utf8'), lines(40, { 3: 'top changed', 38: 'bottom changed' }), 'the file itself is untouched')
  const again = await applyHunk(dir, 'app.txt', 1, split.hunks[1].header, fp(split.hunks[1]), 'keep')
  assert.deepEqual(again, { ok: true, note: 'That hunk was already staged.' })
  git('reset', '-q', '--hard')
})

test('a hunk named by a diff that has since changed is refused, and nothing is touched', async () => {
  fs.writeFileSync(path.join(dir, 'app.txt'), lines(40, { 3: 'top changed' }))
  const drawn = splitFileDiff(diffOf())!.hunks[0]
  // Reworded under the same @@ line: the counts don't change, the lines do.
  fs.writeFileSync(path.join(dir, 'app.txt'), lines(40, { 3: 'top changed', 2: 'new line above' }))
  assert.equal(splitFileDiff(diffOf())!.hunks[0].header, drawn.header, 'the header alone would not notice')
  const stale = await applyHunk(dir, 'app.txt', 0, drawn.header, fp(drawn), 'reject')
  assert.ok(!stale.ok && /changed since this diff was drawn/.test(stale.error))
  assert.equal(fs.readFileSync(path.join(dir, 'app.txt'), 'utf8'), lines(40, { 3: 'top changed', 2: 'new line above' }))
  const wrongIndex = await applyHunk(dir, 'app.txt', 5, drawn.header, fp(drawn), 'reject')
  assert.ok(!wrongIndex.ok)
  git('checkout', '--', 'app.txt')
})

test('bad requests are refused before git is asked: paths outside the folder, unknown actions, new files, SSH folders', async () => {
  assert.ok(!(await applyHunk(dir, '../outside', 0, '@@', 'x', 'reject')).ok)
  assert.ok(!(await applyHunk(dir, '/etc/passwd', 0, '@@', 'x', 'reject')).ok)
  assert.ok(!(await applyHunk(dir, 'app.txt', 0, '@@ -1 +1 @@', 'x', 'delete')).ok)
  assert.ok(!(await applyHunk(dir, 'app.txt', '0', '@@ -1 +1 @@', 'x', 'reject')).ok)
  fs.writeFileSync(path.join(dir, 'brand-new.txt'), 'x\n')
  const fresh = await applyHunk(dir, 'brand-new.txt', 0, '@@ -0,0 +1 @@', 'x', 'reject')
  assert.ok(!fresh.ok && /new or binary file/.test(fresh.error))
  fs.rmSync(path.join(dir, 'brand-new.txt'))
  const remote = await applyHunk('ssh://host/home/x', 'app.txt', 0, '@@', 'x', 'reject')
  assert.ok(!remote.ok)
})

test('the fingerprint the screen makes from its rows is the one main makes from git’s text, even for CRLF files and files with no final newline', () => {
  fs.writeFileSync(path.join(dir, 'crlf.txt'), 'a\r\nb\r\nc')
  git('add', '.')
  git('-c', 'core.autocrlf=false', 'commit', '-q', '-m', 'crlf')
  fs.writeFileSync(path.join(dir, 'crlf.txt'), 'a\r\nB changed\r\nc')
  const raw = git('diff', 'HEAD', '--no-color', '--no-ext-diff', '--no-renames', '-U3', '--', 'crlf.txt')
  const split = splitFileDiff(raw)!
  const shown = parseUnifiedDiff(raw)[0].hunks[0].lines.map((l) => (l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ') + l.text)
  assert.equal(hunkFingerprint(shown), hunkFingerprint(hunkBody(split.hunks[0])))
  // The same for an ordinary file.
  fs.writeFileSync(path.join(dir, 'app.txt'), lines(40, { 10: 'ten changed' }))
  const raw2 = diffOf()
  const shown2 = parseUnifiedDiff(raw2)[0].hunks[0].lines.map((l) => (l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ') + l.text)
  assert.equal(hunkFingerprint(shown2), hunkFingerprint(hunkBody(splitFileDiff(raw2)!.hunks[0])))
  assert.notEqual(hunkFingerprint(shown2), hunkFingerprint(shown))
  git('checkout', '--', 'app.txt')
})
