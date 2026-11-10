import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { blameLabel, parseBlame } from '../src/shared/fileHistory'
import { HostBook } from '../src/main/features/ade/hosts'
import { makeRunner } from '../src/main/features/ade/runner'
import { fileCommits, lineBlame } from '../src/main/features/ade/blame'

/**
 * The editor's git history (shared/fileHistory.ts, main/features/ade/blame.ts):
 * blame read into who, when and why, and a file's commits, followed across a
 * rename, from a real repository.
 */

test('a blamed line is read into who, when and why, and an uncommitted one says so', () => {
  const out = [
    '3f2a9c1d8e7b6a5f4e3d2c1b0a99887766554433 4 4 1',
    'author Jane Doe',
    'author-mail <jane@example.com>',
    'author-time 1700000000',
    'author-tz +0000',
    'committer Jane Doe',
    'summary Fix the login redirect',
    'filename src/login.ts',
    '\tconst next = params.get("next")'
  ].join('\n')
  const blame = parseBlame(out)!
  assert.deepEqual(blame, { sha: '3f2a9c1d8e7b6a5f4e3d2c1b0a99887766554433', short: '3f2a9c1', author: 'Jane Doe', at: 1_700_000_000_000, subject: 'Fix the login redirect', committed: true })
  assert.equal(blameLabel(blame, 1_700_000_000_000 + 3 * 86_400_000), 'Jane Doe, 3 days ago · Fix the login redirect')
  assert.equal(blameLabel({ ...blame, subject: '' }, 1_700_000_000_000 + 60_000), 'Jane Doe, 1 min ago')

  const fresh = parseBlame(`${'0'.repeat(40)} 4 4 1\nauthor Not Committed Yet\nsummary Version of x.ts\n\tcode`)!
  assert.equal(fresh.committed, false)
  assert.equal(blameLabel(fresh), 'Not committed yet')
  assert.equal(parseBlame('fatal: no such path'), null)
  assert.equal(parseBlame(''), null)
})

let tmp = ''
let repo = ''
const env = { ...process.env, GIT_AUTHOR_NAME: 'Ada', GIT_AUTHOR_EMAIL: 'ada@e.com', GIT_COMMITTER_NAME: 'Ada', GIT_COMMITTER_EMAIL: 'ada@e.com' }
const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' }).trim()
const run = makeRunner(new HostBook({ load: () => [], save: () => undefined, readConfig: async () => [] }))

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-history-')))
  repo = path.join(tmp, 'acme')
  fs.mkdirSync(repo)
  git('init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'old.ts'), 'one\ntwo\nthree\n')
  git('add', '.')
  git('commit', '-q', '-m', 'Add the file')
  git('mv', 'old.ts', 'new.ts')
  git('commit', '-q', '-m', 'Rename it')
  fs.writeFileSync(path.join(repo, 'new.ts'), 'one\nTWO\nthree\n')
  git('commit', '-q', '-am', 'Shout two')
  fs.writeFileSync(path.join(repo, 'other.ts'), 'unrelated\n')
  git('add', 'other.ts')
  git('commit', '-q', '-m', 'Something else')
})

after(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('a file’s history is its own commits, newest first, followed back across a rename', async () => {
  const res = await fileCommits(run, repo, 'new.ts')
  assert.ok(res.ok, res.ok ? '' : res.error)
  if (!res.ok) return
  assert.deepEqual(
    res.commits.map((c) => c.subject),
    ['Shout two', 'Rename it', 'Add the file']
  )
  assert.equal(res.commits[0].author, 'Ada')
  assert.equal(res.commits[0].short.length >= 7, true)
  // No upstream here, so none is marked as not pushed.
  assert.ok(res.commits.every((c) => !c.local))
  const other = await fileCommits(run, repo, 'other.ts')
  assert.ok(other.ok && other.commits.length === 1)
  const none = await fileCommits(run, repo, 'untracked.ts')
  assert.ok(none.ok && none.commits.length === 0)
})

test('the commits a branch has that its upstream doesn’t are marked', async () => {
  const bare = path.join(tmp, 'origin.git')
  execFileSync('git', ['init', '-q', '--bare', bare], { env })
  git('remote', 'add', 'origin', bare)
  git('push', '-q', '-u', 'origin', 'main')
  fs.writeFileSync(path.join(repo, 'new.ts'), 'one\nTWO\nthree\nfour\n')
  git('commit', '-q', '-am', 'Add four')
  const res = await fileCommits(run, repo, 'new.ts')
  assert.ok(res.ok)
  if (!res.ok) return
  assert.deepEqual(res.commits.map((c) => [c.subject, c.local]), [['Add four', true], ['Shout two', false], ['Rename it', false], ['Add the file', false]])
})

test('blame says which commit last changed a line, and a changed line is not committed yet', async () => {
  const two = await lineBlame(run, repo, 'new.ts', 2)
  assert.ok(two.ok, two.ok ? '' : two.error)
  if (!two.ok) return
  assert.equal(two.blame.subject, 'Shout two')
  assert.equal(two.blame.author, 'Ada')
  assert.equal(two.blame.committed, true)
  const one = await lineBlame(run, repo, 'new.ts', 1)
  assert.ok(one.ok && one.blame.subject === 'Add the file', 'a line that came through the rename is blamed on the commit that wrote it')

  fs.writeFileSync(path.join(repo, 'new.ts'), 'one\nTWO\nthree\nfour\nfive\n')
  const five = await lineBlame(run, repo, 'new.ts', 5)
  assert.ok(five.ok && !five.blame.committed)
  assert.equal(blameLabel(five.ok ? five.blame : (null as never)), 'Not committed yet')
})

test('a file git has never seen, or a line past the end, has no blame to show', async () => {
  fs.writeFileSync(path.join(repo, 'brand-new.ts'), 'x\n')
  const fresh = await lineBlame(run, repo, 'brand-new.ts', 1)
  assert.ok(!fresh.ok && fresh.error.length > 0)
  const past = await lineBlame(run, repo, 'other.ts', 99)
  assert.ok(!past.ok)
})
