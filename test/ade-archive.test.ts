import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionBook, type SavedSessions } from '../src/main/features/ade/sessions'
import { groupSessions, splitArchived, visibleSessions } from '../src/shared/adeSessions'

/**
 * Archiving a session: out of the list into an Archived group, nothing on
 * disk touched (its worktree and branch stay), restorable, and remembered
 * across a restart. Against real folders and a real worktree.
 */

let tmp = ''
let repo = ''
let worktrees = ''
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ade-archive-')))
  repo = path.join(tmp, 'shop')
  worktrees = path.join(tmp, 'Eaon', 'worktrees')
  fs.mkdirSync(repo)
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

function newBook(saved: { value: SavedSessions | null }, at = { now: 1_000 }): SessionBook {
  return new SessionBook({
    load: () => saved.value,
    save: (value) => {
      saved.value = structuredClone(value)
    },
    now: () => at.now,
    worktreesRoot: () => worktrees
  })
}

test('archiving keeps the session, its worktree and its branch; restoring brings it back', async () => {
  const saved = { value: null as SavedSessions | null }
  const clock = { now: 5_000 }
  const book = newBook(saved, clock)
  const made = await book.create({ project: repo, title: 'Old experiment' })
  assert.ok(made.ok)
  if (!made.ok) return
  const { session } = made
  clock.now = 9_000
  const archived = book.archive(session.id)
  assert.equal(archived?.archivedAt, 9_000)
  // Nothing on disk changed: the folder and the branch are there.
  assert.ok(fs.existsSync(session.cwd))
  assert.equal(git(repo, 'branch', '--list', session.branch ?? ''), `+ ${session.branch}`)
  // Still in the book (the Archived group lists it), marked.
  assert.equal(book.get(session.id)?.archivedAt, 9_000)
  assert.deepEqual(splitArchived(book.list()).archived.map((s) => s.id), [session.id])
  assert.ok(!splitArchived(book.list()).live.some((s) => s.id === session.id))

  const back = book.restore(session.id)
  assert.equal(back?.archivedAt, undefined)
  assert.equal(book.get(session.id)?.archivedAt, undefined)
  assert.equal(splitArchived(book.list()).archived.length, 0)
})

test('archiving is remembered across a restart, and archiving twice keeps the first time', async () => {
  const saved = { value: null as SavedSessions | null }
  const clock = { now: 100 }
  const book = newBook(saved, clock)
  const folder = await book.ensureFolder(repo)
  clock.now = 200
  book.archive(folder.id)
  clock.now = 300
  book.archive(folder.id)
  assert.equal(book.get(folder.id)?.archivedAt, 200)
  const again = newBook(saved)
  assert.equal(again.get(folder.id)?.archivedAt, 200)
  assert.equal(again.restore(folder.id)?.archivedAt, undefined)
  assert.equal(newBook(saved).get(folder.id)?.archivedAt, undefined)
})

test('archiving or restoring a session that is gone is not an error', () => {
  const saved = { value: null as SavedSessions | null }
  const book = newBook(saved)
  assert.equal(book.archive('nope'), null)
  assert.equal(book.restore('nope'), null)
})

test('opening an archived session’s folder again on purpose restores it; an import does not', async () => {
  const saved = { value: null as SavedSessions | null }
  const book = newBook(saved)
  const folder = await book.ensureFolder(repo)
  book.archive(folder.id)
  // Import brings back folders that have no session; an archived one is a session, and stays archived.
  assert.deepEqual(await book.importFolders([{ cwd: repo, at: 1 }]), [])
  assert.ok(book.get(folder.id)?.archivedAt !== undefined)
  // Picked from the folder picker, or started from an issue or a pull request: it comes back, as itself.
  const opened = await book.ensureFolder(repo)
  assert.equal(opened.id, folder.id)
  assert.equal(opened.archivedAt, undefined)
  assert.equal(book.get(folder.id)?.archivedAt, undefined)
})

test('an archived session can still be removed, and the sidebar’s tree leaves archived ones out', async () => {
  const saved = { value: null as SavedSessions | null }
  const book = newBook(saved)
  const main = await book.ensureFolder(repo)
  const made = await book.create({ project: repo, title: 'Side quest' })
  assert.ok(made.ok)
  if (!made.ok) return
  book.archive(made.session.id)
  const { live, archived } = splitArchived(book.list())
  assert.deepEqual(live.map((s) => s.id), [main.id])
  assert.deepEqual(archived.map((s) => s.id), [made.session.id])
  // The tree is built from the live ones: the archived session's row is not in it, and "session 2" is not it.
  assert.deepEqual(visibleSessions(groupSessions(live, [repo]), {}).map((s) => s.id), [main.id])
  const removed = await book.remove(made.session.id, { deleteWorktree: true })
  assert.deepEqual(removed, { ok: true })
  assert.equal(book.get(made.session.id), null)
  assert.equal(fs.existsSync(made.session.cwd), false)
})

test('the newest archived comes first in the group', () => {
  const at = (id: string, archivedAt?: number) => ({ id, title: null, project: '/p', cwd: `/p/${id}`, branch: null, repo: true, worktree: true, createdAt: 1, ...(archivedAt ? { archivedAt } : {}) })
  const { archived } = splitArchived([at('a', 10), at('b'), at('c', 30), at('d', 20)])
  assert.deepEqual(archived.map((s) => s.id), ['c', 'd', 'a'])
})
