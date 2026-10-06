import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionBook, type SavedSessions } from '../src/main/features/ade/sessions'
import { repoInfo } from '../src/main/features/ade/git'

/**
 * ADE sessions against a real git repository in a scratch folder: a new
 * session gets its own branch in its own worktree, the project folder is
 * never touched, removing never forces, and the list survives a restart.
 */

let tmp = ''
let repo = ''
let plain = ''
let worktrees = ''

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

before(() => {
  // Real paths: on a Mac /var is /private/var, and git reports the real one.
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ade-sessions-')))
  repo = path.join(tmp, 'acme-internal')
  plain = path.join(tmp, 'notes')
  worktrees = path.join(tmp, 'Eaon', 'worktrees')
  fs.mkdirSync(repo)
  fs.mkdirSync(plain)
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test'
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com'
  git(repo, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'first')
})

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function newBook(saved: { value: SavedSessions | null }): SessionBook {
  return new SessionBook({
    load: () => saved.value,
    save: (value) => {
      saved.value = structuredClone(value)
    },
    now: () => 1_000,
    worktreesRoot: () => worktrees
  })
}

test('a new session gets its own branch in its own worktree, and the project folder stays as it was', async () => {
  const saved = { value: null as SavedSessions | null }
  const book = newBook(saved)
  const made = await book.create({ project: repo, title: 'Fix CI checks detail link' })
  assert.ok(made.ok, made.ok ? '' : made.error)
  if (!made.ok) return
  const { session } = made
  assert.equal(session.branch, 'fix/ci-checks-detail-link')
  assert.equal(session.cwd, path.join(worktrees, 'acme-internal', 'ci-checks-detail-link'))
  assert.equal(session.project, repo)
  assert.equal(session.worktree, true)
  // The worktree is on the new branch; the project folder is still on main, with nothing changed.
  assert.equal(git(session.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'fix/ci-checks-detail-link')
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main')
  assert.equal(git(repo, 'status', '--porcelain'), '')
  // Git itself files the worktree under the repository it belongs to.
  assert.deepEqual(await repoInfo(session.cwd), { top: session.cwd, root: repo, branch: 'fix/ci-checks-detail-link' })

  // The same title again: the branch made from it just gets a number.
  const again = await book.create({ project: repo, title: 'Fix CI checks detail link' })
  assert.ok(again.ok)
  if (again.ok) {
    assert.equal(again.session.branch, 'fix/ci-checks-detail-link-2')
    assert.notEqual(again.session.cwd, session.cwd)
  }
  // A branch the user named that already exists is theirs to rename.
  const taken = await book.create({ project: repo, title: 'Anything', branch: 'fix/ci-checks-detail-link' })
  assert.equal(taken.ok, false)
  assert.match(taken.ok ? '' : taken.error, /already a branch called fix\/ci-checks-detail-link/)
  const bad = await book.create({ project: repo, title: 'Anything', branch: 'has space' })
  assert.equal(bad.ok, false)

  // Saved, and read back by the next launch.
  const reread = newBook(saved)
  assert.deepEqual(
    reread.list().map((s) => s.branch),
    ['fix/ci-checks-detail-link', 'fix/ci-checks-detail-link-2']
  )
})

test('a folder outside git has one session, the folder itself, and can’t get a branch', async () => {
  const book = newBook({ value: null })
  const made = await book.create({ project: plain, title: 'Anything' })
  assert.equal(made.ok, false)
  assert.match(made.ok ? '' : made.error, /isn’t a git repository/)
  const own = await book.ensureFolder(plain)
  assert.deepEqual([own.project, own.cwd, own.branch, own.worktree], [plain, plain, null, false])
  // Asking again gives the same session, not a second one.
  assert.equal((await book.ensureFolder(plain)).id, own.id)
})

test('a worktree another tool made is filed under its repository', async () => {
  const other = path.join(tmp, 'elsewhere', 'checkout-baseline')
  git(repo, 'worktree', 'add', '-q', '-b', 'feature/checkout-baseline', other)
  const book = newBook({ value: null })
  const session = await book.ensureFolder(other)
  assert.equal(session.project, repo)
  assert.equal(session.branch, 'feature/checkout-baseline')
  assert.equal(session.worktree, false, 'Eaon didn’t make it, so Eaon never offers to delete it')
})

test('removing a session never forces: a worktree with uncommitted work stays, a clean one goes, the branch always stays', async () => {
  const book = newBook({ value: null })
  const made = await book.create({ project: repo, title: 'Cart recovery email' })
  assert.ok(made.ok)
  if (!made.ok) return
  const { session } = made
  fs.writeFileSync(path.join(session.cwd, 'draft.txt'), 'not committed\n')

  const refused = await book.remove(session.id, { deleteWorktree: true })
  assert.equal(refused.ok, false)
  assert.match(refused.ok ? '' : refused.error, /^Git kept the worktree/)
  assert.ok(fs.existsSync(path.join(session.cwd, 'draft.txt')), 'the uncommitted file is still there')
  assert.ok(book.get(session.id), 'the session stays when its worktree does')

  // Off the list but the folder kept: what "Remove" without the box ticked does.
  fs.rmSync(path.join(session.cwd, 'draft.txt'))
  const kept = await book.remove(session.id, { deleteWorktree: false })
  assert.ok(kept.ok)
  assert.equal(book.get(session.id), null)
  assert.ok(fs.existsSync(session.cwd))

  // Clean, and asked to: the worktree goes, the branch stays.
  const second = await book.create({ project: repo, title: 'Auth session refresh' })
  assert.ok(second.ok)
  if (!second.ok) return
  assert.ok((await book.remove(second.session.id, { deleteWorktree: true })).ok)
  assert.equal(fs.existsSync(second.session.cwd), false)
  assert.equal(git(repo, 'branch', '--list', 'feature/auth-session-refresh'), 'feature/auth-session-refresh')
})

test('the folders that had terminals before sessions become sessions once; import adds folders with conversations', async () => {
  const saved = { value: null as SavedSessions | null }
  const book = newBook(saved)
  await book.adopt([repo, plain, path.join(tmp, 'gone')])
  assert.deepEqual(
    book
      .list()
      .map((s) => s.cwd)
      .sort(),
    [plain, repo].sort()
  )
  // Removing an adopted session sticks: adopting again (the next launch) doesn't bring it back.
  const notes = book.byCwd(plain)
  assert.ok(notes)
  await book.remove(notes!.id, { deleteWorktree: false })
  await newBook(saved).adopt([repo, plain])
  assert.equal(newBook(saved).byCwd(plain), null)

  const imported = await book.importFolders([
    { cwd: plain, at: 500 },
    { cwd: repo, at: 600 },
    { cwd: path.join(tmp, 'gone'), at: 700 }
  ])
  assert.deepEqual(
    imported.map((s) => [s.cwd, s.imported, s.createdAt]),
    [[plain, true, 500]],
    'only a folder that exists and has no session yet'
  )
})

test('refresh notices a branch switched in a terminal and a folder that went away', async () => {
  const book = newBook({ value: null })
  const made = await book.create({ project: repo, title: 'Switchable' })
  assert.ok(made.ok)
  if (!made.ok) return
  git(made.session.cwd, 'checkout', '-q', '-b', 'feature/renamed-in-terminal')
  let list = await book.refresh()
  assert.equal(list.find((s) => s.id === made.session.id)?.branch, 'feature/renamed-in-terminal')
  git(repo, 'worktree', 'remove', '--force', made.session.cwd)
  list = await book.refresh()
  assert.equal(list.find((s) => s.id === made.session.id)?.missing, true)
})

test('a project on a detached HEAD is still a repository: it has no branch, and can still have sessions', async () => {
  const detached = path.join(tmp, 'detached')
  git(repo, 'worktree', 'add', '-q', '--detach', detached)
  const book = newBook({ value: null })
  const own = await book.ensureFolder(detached)
  assert.equal(own.branch, null)
  assert.equal(own.repo, true)
  const plainOwn = await book.ensureFolder(plain)
  assert.equal(plainOwn.repo, false)
  // A folder that becomes a repository later is noticed.
  git(plain, 'init', '-q', '-b', 'trunk')
  const list = await book.refresh()
  assert.deepEqual(
    [list.find((s) => s.id === plainOwn.id)?.repo, list.find((s) => s.id === plainOwn.id)?.branch],
    [true, 'trunk']
  )
  fs.rmSync(path.join(plain, '.git'), { recursive: true, force: true })
})
