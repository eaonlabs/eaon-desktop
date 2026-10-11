import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseChanges,
  ageLabel,
  branchForTitle,
  branchNameProblem,
  groupSessions,
  homeRelative,
  sessionSubtitle,
  sessionTitle,
  taskFromTerminalTitle,
  worktreeFolderFor,
  type AdeSession
} from '../src/shared/adeSessions'

/** The pieces of ADE sessions that are plain functions: names, branches, titles, ages, order. */

test('a session’s branch comes from its title: fix/ for a fix, feature/ for the rest', () => {
  assert.equal(branchForTitle('Fix CI checks detail link'), 'fix/ci-checks-detail-link')
  assert.equal(branchForTitle('Improve agent handoff summary'), 'feature/improve-agent-handoff-summary')
  assert.equal(branchForTitle('  Café menu: résumé & “quotes”!  '), 'feature/cafe-menu-resume-quotes')
  assert.equal(branchForTitle('!!!'), 'feature/session')
  const long = branchForTitle('Make the checkout page remember the shipping address between visits and devices')
  assert.ok(long.length <= 'feature/'.length + 48, long)
  assert.ok(!long.endsWith('-'), long)
  assert.equal(branchNameProblem(long), null)
})

test('branch names git would refuse are caught before git is asked', () => {
  for (const ok of ['feature/x', 'fix/ci-checks-detail-link', 'release/2026.6.2']) assert.equal(branchNameProblem(ok), null, ok)
  for (const bad of ['', 'has space', 'a..b', 'a~b', 'end/', '/start', 'x.lock', 'a/.hidden', '-x', 'a@{b', 'a//b', 'x.']) {
    assert.ok(branchNameProblem(bad), `“${bad}” should be refused`)
  }
})

test('a session is called by its title, else a worktree by its branch’s last part, else by its folder', () => {
  assert.equal(sessionTitle({ title: 'Fix CI checks detail link', branch: 'fix/checks-detail-link', cwd: '/w/x', project: '/p' }), 'Fix CI checks detail link')
  assert.equal(sessionTitle({ title: null, branch: 'feature/checkout-baseline', cwd: '/w/x', project: '/p' }), 'checkout-baseline')
  // The project folder itself: its name, not "main" over "main".
  assert.equal(sessionTitle({ title: null, branch: 'main', cwd: '/p/acme-internal', project: '/p/acme-internal' }), 'acme-internal')
  assert.equal(sessionSubtitle({ branch: 'main', cwd: '/p/acme-internal', project: '/p/acme-internal' }), 'main · project folder')
  assert.equal(sessionSubtitle({ branch: null, cwd: '/p/notes', project: '/p/notes' }), 'project folder')
  assert.equal(sessionSubtitle({ branch: 'feature/x', cwd: '/w/x', project: '/p' }), 'feature/x')
  assert.equal(sessionSubtitle({ branch: 'feature/x', cwd: '/w/x', project: '/p', missing: true }), 'Folder not found')
  // A pull request checked out for review is on no branch: its folder, not its whole path.
  assert.equal(sessionSubtitle({ branch: null, cwd: '/w/acme/review-pr-7', project: '/p' }), 'review-pr-7 · no branch')
  assert.equal(sessionTitle({ title: '  ', branch: null, cwd: '/Users/ada/acme-internal', project: '/Users/ada/acme-internal' }), 'acme-internal')
  assert.equal(worktreeFolderFor('feature/checkout-baseline'), 'checkout-baseline')
  assert.equal(worktreeFolderFor('fix/.weird name'), 'weird-name')
})

test('a terminal title is a task only when it says what the agent is doing', () => {
  // Claude Code: the task behind a spinner glyph that turns while it works.
  assert.equal(taskFromTerminalTitle('✳ Fix checks detail link'), 'Fix checks detail link')
  assert.equal(taskFromTerminalTitle('⠂ Verifying CI panel deep link'), 'Verifying CI panel deep link')
  // A shell, or an agent naming itself, says nothing the pane's logo doesn't.
  for (const said of ['zsh', '✳ Claude Code', 'codex', '~/projects/acme', '/Users/ada/acme', 'ada@mac: ~/acme', 'ada@mac.local ~', '', '   ', null]) {
    assert.equal(taskFromTerminalTitle(said), null, String(said))
  }
  assert.ok((taskFromTerminalTitle(`✳ ${'word '.repeat(60)}`) ?? '').length <= 120)
})

test('ages are as short as the sidebar’s edge allows', () => {
  const now = Date.UTC(2026, 9, 6, 12)
  const ago = (ms: number): string => ageLabel(now - ms, now)
  assert.equal(ago(10_000), 'now')
  assert.equal(ago(5 * 60_000), '5m')
  assert.equal(ago(6 * 3_600_000), '6h')
  assert.equal(ago(3 * 86_400_000), '3d')
  assert.equal(ago(15 * 86_400_000), '2w')
  assert.equal(ago(100 * 86_400_000), '3mo')
  assert.equal(ago(800 * 86_400_000), '2y')
  assert.equal(ageLabel(now + 5000, now), 'now', 'a clock a little ahead is not "-1m"')
})

const session = (id: string, project: string, cwd: string, createdAt: number): AdeSession => ({
  id,
  title: null,
  project,
  cwd,
  branch: null,
  repo: true,
  worktree: cwd !== project,
  createdAt
})

test('the sidebar groups sessions by project: recent projects first, the project folder leading, then newest first', () => {
  const groups = groupSessions(
    [
      session('a1', '/p/acme', '/w/acme/old', 1),
      session('b1', '/p/blog', '/p/blog', 5),
      session('a0', '/p/acme', '/p/acme', 2),
      session('a2', '/p/acme', '/w/acme/new', 3),
      session('c1', '/p/imported', '/p/imported', 9)
    ],
    ['/p/blog', '/p/acme']
  )
  assert.deepEqual(
    groups.map((g) => [g.project, g.sessions.map((s) => s.id)]),
    [
      ['/p/blog', ['b1']],
      ['/p/acme', ['a0', 'a2', 'a1']],
      // Not opened recently (imported): after the recent ones.
      ['/p/imported', ['c1']]
    ]
  )
})

test('paths under the home folder read from ~, whatever the home folder is', () => {
  assert.equal(homeRelative('/Users/ada/Eaon/worktrees', '/Users/ada'), '~/Eaon/worktrees')
  assert.equal(homeRelative('/private/tmp/x/home/Eaon', '/private/tmp/x/home/'), '~/Eaon')
  assert.equal(homeRelative('/Users/adam/Eaon', '/Users/ada'), '/Users/adam/Eaon', 'a neighbour whose name starts the same is not home')
  assert.equal(homeRelative('/Users/ada', '/Users/ada'), '~')
  assert.equal(homeRelative('/srv/repo', null), '/srv/repo')
})

test('uncommitted changes add up git’s numstat, count a binary file without lines, and count new files', () => {
  const numstat = ['12\t3\tsrc/app.ts', '0\t7\tREADME.md', '-\t-\tassets/logo.png'].join('\n')
  assert.deepEqual(parseChanges(numstat, 'notes.md\nsrc/new.ts\n'), { added: 12, removed: 10, files: 5 })
  assert.deepEqual(parseChanges('', ''), { added: 0, removed: 0, files: 0 })
})
