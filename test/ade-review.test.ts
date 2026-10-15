import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  actionsRunOf,
  cleanRunLog,
  conflictCount,
  formatCheckFailure,
  formatReviewComments,
  hasConflictMarkers,
  parseConflicts,
  parseUnifiedDiff,
  prFromGh,
  pullRequestFromCommits,
  resolveConflicts,
  runsFromGh
} from '../src/shared/adeReview'
import { HostBook } from '../src/main/features/ade/hosts'
import { makeRunner } from '../src/main/features/ade/runner'
import {
  abortMerge,
  baseBranches,
  checkLog,
  commitAll,
  finishMerge,
  markResolved,
  pullRequestText,
  readConflictFile,
  reviewState,
  updateFromBase,
  writeConflictFile
} from '../src/main/features/ade/review'

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

test('each check keeps its name, status, conclusion, link and workflow, failing ones first', () => {
  const pr = prFromGh({
    number: 7,
    url: 'https://github.com/octo-org/demo/pull/7',
    mergeable: 'CONFLICTING',
    baseRefName: 'main',
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'build', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/octo-org/demo/actions/runs/1/job/11' },
      { __typename: 'StatusContext', context: 'deploy/preview', state: 'PENDING', targetUrl: 'https://preview.example.com/7' },
      { __typename: 'CheckRun', name: 'test', workflowName: 'CI', status: 'COMPLETED', conclusion: 'TIMED_OUT', detailsUrl: 'https://github.com/octo-org/demo/actions/runs/1/job/12' }
    ]
  })
  assert.equal(pr?.mergeable, 'CONFLICTING')
  assert.equal(pr?.baseRef, 'main')
  assert.deepEqual(pr?.checkRuns, [
    { name: 'test', status: 'failed', conclusion: 'TIMED_OUT', url: 'https://github.com/octo-org/demo/actions/runs/1/job/12', workflow: 'CI' },
    { name: 'deploy/preview', status: 'pending', conclusion: '', url: 'https://preview.example.com/7', workflow: '' },
    { name: 'build', status: 'passed', conclusion: 'SUCCESS', url: 'https://github.com/octo-org/demo/actions/runs/1/job/11', workflow: 'CI' }
  ])
  // An older record without the new fields still reads.
  const old = prFromGh({ number: 1, url: 'https://github.com/octo-org/demo/pull/1' })
  assert.deepEqual([old?.mergeable, old?.baseRef, old?.checkRuns], ['UNKNOWN', '', []])
})

test('a branch’s workflow runs read as checks; an Actions link gives its run and job', () => {
  assert.deepEqual(
    runsFromGh([
      { databaseId: 5, name: 'Fix it', workflowName: 'CI', status: 'completed', conclusion: 'failure', url: 'https://github.com/octo-org/demo/actions/runs/5' },
      { databaseId: 6, name: 'Fix it', workflowName: 'Lint', status: 'in_progress', conclusion: '', url: 'https://github.com/octo-org/demo/actions/runs/6' }
    ]),
    [
      { name: 'CI', status: 'failed', conclusion: 'FAILURE', url: 'https://github.com/octo-org/demo/actions/runs/5', workflow: 'CI' },
      { name: 'Lint', status: 'pending', conclusion: '', url: 'https://github.com/octo-org/demo/actions/runs/6', workflow: 'Lint' }
    ]
  )
  assert.deepEqual(runsFromGh('nope'), [])
  assert.deepEqual(actionsRunOf('https://github.com/octo-org/demo/actions/runs/123/job/456'), { run: '123', job: '456' })
  assert.deepEqual(actionsRunOf('https://github.com/octo-org/demo/actions/runs/123'), { run: '123', job: null })
  assert.equal(actionsRunOf('https://ci.example.com/build/9'), null)
  assert.equal(actionsRunOf(null), null)
})

test('a failed run’s log is cut to its end, one header per step, without timestamps or colours', () => {
  const raw = [
    'test\tSet up job\t2026-10-01T10:00:00.1234567Z Starting',
    'test\tRun npm test\t2026-10-01T10:00:01.0000000Z \u001b[31mnot ok 1\u001b[0m - adds',
    'test\tRun npm test\t2026-10-01T10:00:02.0000000Z ##[error]Process completed with exit code 1.',
    ''
  ].join('\n')
  assert.deepEqual(cleanRunLog(raw), {
    log: '── test › Set up job\nStarting\n── test › Run npm test\nnot ok 1 - adds\n##[error]Process completed with exit code 1.',
    truncated: false
  })
  const long = Array.from({ length: 450 }, (_, i) => `line ${i + 1}`).join('\n')
  const cut = cleanRunLog(long)
  assert.equal(cut.truncated, true)
  assert.equal(cut.log.split('\n').length, 200)
  assert.ok(cut.log.startsWith('line 251\n') && cut.log.endsWith('line 450'))
})

test('a failed check goes to the agent with its link and its log in a fence the log can’t close', () => {
  const text = formatCheckFailure({ name: 'test', url: 'https://github.com/octo-org/demo/actions/runs/1/job/2', conclusion: 'FAILURE' }, 'expected ```a```\nnot ok 1', true)
  assert.equal(
    text,
    'The CI check "test" failed on this branch.\nhttps://github.com/octo-org/demo/actions/runs/1/job/2\n\n' +
      'The end of its log:\n\n````text\nexpected ```a```\nnot ok 1\n````\n\n' +
      'Please find the cause, fix it, and run the relevant tests before you finish.'
  )
  assert.match(formatCheckFailure({ name: 'e2e', url: null, conclusion: 'TIMED_OUT' }, ''), /^The CI check "e2e" failed \(timed out\) on this branch\.\n\nPlease/)
})

test('a range comment names its lines and quotes them all, without their shared indent', () => {
  const text = formatReviewComments([
    { id: '1', path: 'src/a.ts', line: 12, endLine: 10, side: 'new', quote: '  if (x) {\n    run()\n  }', body: 'Use **early return**.' },
    { id: '2', path: 'src/a.ts', line: 3, endLine: 3, side: 'new', quote: 'const y = 2', body: 'Rename.' }
  ])
  assert.equal(
    text,
    'I reviewed your changes and left 2 comments. Please address each one:\n\n' +
      'src/a.ts:3\n> const y = 2\nRename.\n\n' +
      'src/a.ts:10-12\n> if (x) {\n>   run()\n> }\nUse **early return**.'
  )
  assert.match(formatReviewComments([{ id: '3', path: 'b.ts', line: 4, endLine: 6, side: 'old', quote: 'a\n\nb', body: 'Why?' }]), /b\.ts:4-6 \(removed lines\)\n> a\n>\n> b\nWhy\?$/)
})

test('conflict markers become blocks, diff3’s base included, and resolve to the side chosen', () => {
  const file = [
    'top',
    '<<<<<<< HEAD',
    'ours 1',
    '||||||| merged common ancestors',
    'base 1',
    '=======',
    'theirs 1',
    '>>>>>>> main',
    'middle',
    '<<<<<<< HEAD',
    'ours 2',
    '=======',
    'theirs 2a',
    'theirs 2b',
    '>>>>>>> main',
    'end',
    ''
  ].join('\n')
  const segments = parseConflicts(file)
  assert.equal(conflictCount(segments), 2)
  assert.deepEqual(segments[1], { kind: 'conflict', oursLabel: 'HEAD', theirsLabel: 'main', ours: ['ours 1'], base: ['base 1'], baseLabel: 'merged common ancestors', theirs: ['theirs 1'] })
  assert.deepEqual(segments[3], { kind: 'conflict', oursLabel: 'HEAD', theirsLabel: 'main', ours: ['ours 2'], base: null, baseLabel: '', theirs: ['theirs 2a', 'theirs 2b'] })
  // Nothing chosen gives the file back as it was.
  assert.equal(resolveConflicts(segments, []), file)
  assert.equal(resolveConflicts(segments, ['ours', 'theirs']), 'top\nours 1\nmiddle\ntheirs 2a\ntheirs 2b\nend\n')
  assert.equal(resolveConflicts(segments, ['both', undefined]).split('<<<<<<<').length, 2)
  assert.equal(resolveConflicts(segments, ['both', 'both']), 'top\nours 1\ntheirs 1\nmiddle\nours 2\ntheirs 2a\ntheirs 2b\nend\n')
  assert.equal(hasConflictMarkers(file), true)
  // A marker that never closes is text, not a conflict.
  const open = 'a\n<<<<<<< HEAD\nb\n=======\nc\n'
  assert.equal(conflictCount(parseConflicts(open)), 0)
  assert.equal(resolveConflicts(parseConflicts(open), []), open)
})

test('a pull request’s title and description come from the branch’s commits', () => {
  assert.deepEqual(pullRequestFromCommits(['Fix the CI link'], 'fix/ci-link'), { title: 'Fix the CI link', body: '' })
  assert.deepEqual(pullRequestFromCommits(['Add a meter', 'Show it in the header'], 'feature/usage_meter'), {
    title: 'Usage meter',
    body: '- Add a meter\n- Show it in the header'
  })
  assert.deepEqual(pullRequestFromCommits(['One', 'Two'], null), { title: 'One', body: '- One\n- Two' })
})

let tmp = ''
let repo = ''
const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.com' }
const git = (...args: string[]): string => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' }).trim()
const run = makeRunner(new HostBook({ load: () => [], save: () => undefined, readConfig: async () => [] }))

let ghLog = ''

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ade-review-')))
  // A stand-in GitHub CLI, so no test reaches GitHub or the user's gh sign-in:
  // signed out, except for the run log the CI test asks for.
  ghLog = path.join(tmp, 'gh.log')
  const gh = path.join(tmp, 'gh')
  fs.writeFileSync(
    gh,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${ghLog}'`,
      'if [ "$1 $2" = "run view" ]; then printf "test\\tRun npm test\\t2026-10-01T10:00:00.0Z not ok 1 - adds\\n"; exit 0; fi',
      'echo "To get started with GitHub CLI, please run:  gh auth login" >&2',
      'exit 4'
    ].join('\n')
  )
  fs.chmodSync(gh, 0o755)
  process.env.EAON_GH_BIN = gh
  repo = path.join(tmp, 'acme')
  fs.mkdirSync(repo)
  Object.assign(process.env, { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.com' })
  git('init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'app.ts'), 'one\ntwo\nthree\n')
  git('add', '.')
  git('commit', '-q', '-m', 'first')
})

after(() => {
  delete process.env.EAON_GH_BIN
  fs.rmSync(tmp, { recursive: true, force: true })
})

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

test('gh signed out inside GitHub Actions reads as signed out, not as its GH_TOKEN example', async () => {
  const actionsGh = path.join(tmp, 'gh-actions')
  fs.writeFileSync(
    actionsGh,
    [
      '#!/bin/sh',
      'echo "gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable. Example:" >&2',
      'echo "  env:" >&2',
      'echo "    GH_TOKEN: \\${{ github.token }}" >&2',
      'exit 4'
    ].join('\n')
  )
  fs.chmodSync(actionsGh, 0o755)
  const was = process.env.EAON_GH_BIN
  process.env.EAON_GH_BIN = actionsGh
  try {
    const res = await reviewState(run, repo)
    assert.ok(res.ok)
    if (!res.ok) return
    assert.equal(res.state.github, null)
    assert.equal(res.state.githubProblem, 'Sign in to the GitHub CLI first: run gh auth login in a terminal.')
  } finally {
    process.env.EAON_GH_BIN = was
  }
})

test('a failed check’s log comes from gh run view, for the job its link names', async () => {
  const res = await checkLog(run, repo, { url: 'https://github.com/octo-org/demo/actions/runs/31/job/32', name: 'test', workflow: 'CI' })
  assert.deepEqual(res, { ok: true, log: '── test › Run npm test\nnot ok 1 - adds', truncated: false })
  assert.match(fs.readFileSync(ghLog, 'utf8'), /^run view --job 32 --log-failed$/m)
  const other = await checkLog(run, repo, { url: 'https://ci.example.com/9', name: 'deploy', workflow: '' })
  assert.ok(!other.ok && /GitHub Actions/.test(other.error))
})

test('updating from main merges it in; conflicts are found, resolved here, and the merge finished', async () => {
  git('checkout', '-q', '-b', 'feature/clash', 'main')
  fs.writeFileSync(path.join(repo, 'app.ts'), 'one\nfeature two\nthree\n')
  git('commit', '-q', '-am', 'feature edit')
  git('checkout', '-q', 'main')
  fs.writeFileSync(path.join(repo, 'app.ts'), 'one\nmain two\nthree\n')
  git('commit', '-q', '-am', 'main edit')
  git('checkout', '-q', 'feature/clash')

  const before = await reviewState(run, repo)
  assert.ok(before.ok && before.state.behindBase === 1 && before.state.merging === null && before.state.conflicted.length === 0)

  const updated = await updateFromBase(run, repo)
  assert.ok(!updated.ok && /left conflicts in a file/.test(updated.error))
  const during = await reviewState(run, repo)
  assert.ok(during.ok)
  if (!during.ok) return
  assert.equal(during.state.merging, 'merge')
  assert.deepEqual(during.state.conflicted, ['app.ts'])

  // Only conflicted files can be read or written, and nothing outside the repository.
  assert.equal((await readConflictFile(run, repo, 'nope.ts')).ok, false)
  assert.equal((await writeConflictFile(run, repo, 'nope.ts', 'x')).ok, false)
  const read = await readConflictFile(run, repo, 'app.ts')
  assert.ok(read.ok)
  if (!read.ok) return
  const segments = parseConflicts(read.text)
  assert.equal(conflictCount(segments), 1)
  assert.equal((await finishMerge(run, repo)).ok, false)
  assert.ok(!(await markResolved(run, repo, 'app.ts')).ok, 'markers still there')

  assert.ok((await writeConflictFile(run, repo, 'app.ts', resolveConflicts(segments, ['theirs']))).ok)
  assert.ok((await markResolved(run, repo, 'app.ts')).ok)
  const done = await finishMerge(run, repo)
  assert.ok(done.ok, done.ok ? '' : done.error)
  assert.equal(fs.readFileSync(path.join(repo, 'app.ts'), 'utf8'), 'one\nmain two\nthree\n')
  assert.equal(git('rev-list', '--count', '--merges', 'main..HEAD'), '1')
  const after = await reviewState(run, repo)
  assert.ok(after.ok && after.state.merging === null && after.state.behindBase === 0)
})

test('a merge can be abandoned; branches and commits fill in a pull request', async () => {
  git('checkout', '-q', 'main')
  fs.writeFileSync(path.join(repo, 'app.ts'), 'one\nmain again\nthree\n')
  git('commit', '-q', '-am', 'main again')
  git('checkout', '-q', 'feature/clash')
  fs.writeFileSync(path.join(repo, 'app.ts'), 'one\nclash again\nthree\n')
  git('commit', '-q', '-am', 'clash again')
  assert.equal((await updateFromBase(run, repo)).ok, false)
  const aborted = await abortMerge(run, repo)
  assert.ok(aborted.ok)
  assert.equal(fs.readFileSync(path.join(repo, 'app.ts'), 'utf8'), 'one\nclash again\nthree\n')
  assert.equal((await abortMerge(run, repo)).ok, false)

  const branches = await baseBranches(run, repo)
  assert.equal(branches.default, 'main')
  assert.equal(branches.branches[0], 'main')
  assert.ok(branches.branches.includes('feature/clash'))
  const text = await pullRequestText(run, repo, 'main')
  assert.deepEqual(text, { title: 'Clash', body: '- feature edit\n- clash again' })
  assert.ok('error' in (await pullRequestText(run, repo, 'feature/clash')))
})
