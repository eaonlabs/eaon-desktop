import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { formatReviewComments, parseUnifiedDiff, prFromGh } from '../src/shared/adeReview'
import { HostBook } from '../src/main/features/ade/hosts'
import { makeRunner } from '../src/main/features/ade/runner'
import { commitAll, reviewState } from '../src/main/features/ade/review'

/**
 * Review in the ADE (shared/adeReview.ts, main/features/ade/review.ts): git's
 * diff read into files and lines with true numbers, comments as one message
 * for an agent, gh's pull request status, and the review of a real branch.
 */

const DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -10,4 +10,5 @@ export function main() {',
  '   const a = 1',
  '-  const b = 2',
  '+  const b = 3',
  '+  const c = 4',
  '   return a + b',
  '\\ No newline at end of file',
  'diff --git a/old name.md b/docs/new name.md',
  'similarity index 90%',
  'rename from old name.md',
  'rename to docs/new name.md',
  'diff --git a/gone.txt b/gone.txt',
  'deleted file mode 100644',
  '--- a/gone.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
  'diff --git a/logo.png b/logo.png',
  'new file mode 100644',
  'Binary files /dev/null and b/logo.png differ',
  ''
].join('\n')

test('git’s diff becomes files and hunks with the true line numbers on both sides', () => {
  const files = parseUnifiedDiff(DIFF)
  assert.deepEqual(
    files.map((f) => [f.path, f.status, f.added, f.removed, f.binary, f.oldPath]),
    [
      ['src/app.ts', 'modified', 2, 1, false, null],
      ['docs/new name.md', 'renamed', 0, 0, false, 'old name.md'],
      ['gone.txt', 'deleted', 0, 1, false, null],
      ['logo.png', 'added', 0, 0, true, null]
    ]
  )
  assert.deepEqual(
    files[0].hunks[0].lines.map((l) => [l.kind, l.old, l.cur, l.text]),
    [
      ['ctx', 10, 10, '  const a = 1'],
      ['del', 11, null, '  const b = 2'],
      ['add', null, 11, '  const b = 3'],
      ['add', null, 12, '  const c = 4'],
      ['ctx', 12, 13, '  return a + b']
    ]
  )
})

test('comments go to the agent as one message: each file and line, the line quoted, sorted', () => {
  const text = formatReviewComments([
    { id: '2', path: 'src/b.ts', line: 3, side: 'new', quote: 'let x = 1', body: 'Use const.' },
    { id: '1', path: 'src/a.ts', line: 40, side: 'old', quote: '  check()', body: 'Why was this removed?' }
  ])
  assert.equal(
    text,
    'I reviewed your changes and left 2 comments. Please address each one:\n\n' +
      'src/a.ts:40 (a removed line)\n> check()\nWhy was this removed?\n\n' +
      'src/b.ts:3\n> let x = 1\nUse const.'
  )
})

test('a pull request’s checks are counted from what gh reports, check runs and statuses alike', () => {
  const pr = prFromGh({
    number: 42,
    title: 'Fix CI link',
    url: 'https://github.com/o/r/pull/42',
    state: 'OPEN',
    isDraft: false,
    mergeStateStatus: 'BLOCKED',
    reviewDecision: 'REVIEW_REQUIRED',
    statusCheckRollup: [
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
      { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' },
      { __typename: 'StatusContext', state: 'SUCCESS' },
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' }
    ]
  })
  assert.deepEqual(pr?.checks, { passed: 3, failed: 1, pending: 1 })
  assert.equal(pr?.mergeState, 'BLOCKED')
  assert.equal(prFromGh({ nope: true }), null)
})

let tmp = ''
let repo = ''
const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.com' }
const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' }).trim()
const run = makeRunner(new HostBook({ load: () => [], save: () => undefined, readConfig: async () => [] }))

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ade-review-')))
  repo = path.join(tmp, 'acme')
  fs.mkdirSync(repo)
  Object.assign(process.env, { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.com' })
  git('init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'app.ts'), 'one\ntwo\nthree\n')
  git('add', '.')
  git('commit', '-q', '-m', 'first')
})

after(() => fs.rmSync(tmp, { recursive: true, force: true }))

test('a branch’s review holds what it committed since main and what it hasn’t yet, new files included', async () => {
  git('checkout', '-q', '-b', 'feature/thing')
  fs.writeFileSync(path.join(repo, 'app.ts'), 'one\nTWO\nthree\n')
  git('commit', '-q', '-am', 'shout two')
  fs.writeFileSync(path.join(repo, 'app.ts'), 'one\nTWO\nthree\nfour\n')
  fs.writeFileSync(path.join(repo, 'new file.ts'), 'hello\n')

  const res = await reviewState(run, repo)
  assert.ok(res.ok, res.ok ? '' : res.error)
  if (!res.ok) return
  const s = res.state
  assert.equal(s.branch, 'feature/thing')
  assert.equal(s.base, 'main')
  assert.equal(s.ahead, 1)
  assert.equal(s.uncommitted, 2)
  assert.equal(s.upstream, null)
  assert.deepEqual(
    s.files.map((f) => [f.path, f.status, f.added, f.removed]),
    [
      ['app.ts', 'modified', 2, 1],
      ['new file.ts', 'added', 1, 0]
    ]
  )
  // No GitHub remote here, so no pull request: said, not thrown.
  assert.equal(s.github, null)
  assert.ok(s.githubProblem)

  assert.deepEqual(await commitAll(run, repo, '  '), { ok: false, error: 'Write a commit message first.' })
  const made = await commitAll(run, repo, 'Add four and a new file')
  assert.ok(made.ok)
  assert.equal(git('status', '--porcelain'), '')
  assert.equal(git('log', '-1', '--format=%s'), 'Add four and a new file')
  const again = await reviewState(run, repo)
  assert.ok(again.ok && again.state.ahead === 2 && again.state.uncommitted === 0 && again.state.files.length === 2)
})

test('on the default branch only what isn’t committed is under review', async () => {
  git('checkout', '-q', 'main')
  fs.writeFileSync(path.join(repo, 'app.ts'), 'one\ntwo\nthree\nmain edit\n')
  const res = await reviewState(run, repo)
  assert.ok(res.ok)
  if (!res.ok) return
  assert.equal(res.state.base, 'HEAD')
  assert.equal(res.state.ahead, 0)
  assert.deepEqual(res.state.files.map((f) => [f.path, f.added, f.removed]), [['app.ts', 1, 0]])
  git('checkout', '-q', '--', 'app.ts')
})

test('a folder outside git, or with no commits, says so instead of failing', async () => {
  const plain = path.join(tmp, 'plain')
  fs.mkdirSync(plain)
  const res = await reviewState(run, plain)
  assert.equal(res.ok, false)
  const empty = path.join(tmp, 'empty')
  fs.mkdirSync(empty)
  execFileSync('git', ['-C', empty, 'init', '-q'])
  const none = await reviewState(run, empty)
  assert.ok(!none.ok && /no commits yet/.test(none.error))
})
