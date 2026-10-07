import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionBook, type SavedSessions } from '../src/main/features/ade/sessions'
import { homeRepoFor } from '../src/main/features/ade/git'
import { groupSessions, isSoloProject, keepOrder, type AdeSession } from '@shared/adeSessions'

/**
 * A home folder that is itself a git repository (an empty `git init` in ~, as
 * on a tester's Mac) filed every folder in it that isn't a repository of its
 * own under one project named after the home folder, on its branch: two
 * sessions called "main" under the home folder’s own name. Each folder is its own
 * project; a real repository inside the home folder is unaffected.
 */

let home = ''
let downloads = ''
let site = ''
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

before(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ade-home-')))
  downloads = path.join(home, 'Downloads')
  site = path.join(downloads, 'eaon-website')
  fs.mkdirSync(site, { recursive: true })
  git(home, 'init', '-q', '-b', 'main') // no commits, as found
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test'
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com'
  git(site, 'init', '-q', '-b', 'redesign')
  fs.writeFileSync(path.join(site, 'index.html'), '<p>hi</p>\n')
  git(site, 'add', '.')
  git(site, 'commit', '-q', '-m', 'first')
})

after(() => fs.rmSync(home, { recursive: true, force: true }))

function newBook(saved: { value: SavedSessions | null }): SessionBook {
  return new SessionBook({
    load: () => saved.value,
    save: (value) => void (saved.value = structuredClone(value)),
    now: () => 1_000,
    worktreesRoot: () => path.join(home, 'Eaon', 'worktrees'),
    home: () => home
  })
}

test('a folder in a home-folder repository is its own project, not the home folder on its branch', async () => {
  const book = newBook({ value: null })
  const folder = await book.ensureFolder(downloads)
  assert.equal(folder.project, downloads)
  assert.equal(folder.branch, null)
  assert.equal(folder.repo, false)
  // A real repository in the home folder is its own project, on its own branch.
  const repo = await book.ensureFolder(site)
  assert.equal(repo.project, site)
  assert.equal(repo.branch, 'redesign')
  // The home folder itself is still the repository it is.
  const itself = await book.ensureFolder(home)
  assert.equal(itself.project, home)
  assert.equal(itself.repo, true)
  // A new session needs a repository of the folder's own.
  const made = await book.create({ project: downloads, title: 'Tidy up' })
  assert.equal(made.ok, false)
})

test('sessions saved under the home folder’s repository are filed again by their own folders', async () => {
  const saved = {
    value: {
      adopted: true,
      sessions: [
        { id: 'a', title: null, project: home, cwd: downloads, branch: 'main', repo: true, worktree: false, createdAt: 1 },
        { id: 'b', title: null, project: site, cwd: site, branch: null, repo: false, worktree: false, createdAt: 2 }
      ]
    } as SavedSessions | null
  }
  const list = await newBook(saved).refresh()
  const a = list.find((s) => s.id === 'a')!
  assert.deepEqual([a.project, a.branch, a.repo], [downloads, null, false])
  const b = list.find((s) => s.id === 'b')!
  assert.deepEqual([b.project, b.branch, b.repo], [site, 'redesign', true])
  assert.equal(saved.value?.sessions.find((s) => s.id === 'a')?.project, downloads, 'and it is saved')
})

test('only a repository holding the home folder is set aside, and only for the folders inside it', () => {
  assert.equal(homeRepoFor('/Users/al', '/Users/al/Downloads', '/Users/al'), true)
  assert.equal(homeRepoFor('/', '/Users/al/Downloads', '/Users/al'), true, 'a repository above the home folder too')
  assert.equal(homeRepoFor('/Users/al', '/Users/al', '/Users/al'), false, 'the home folder itself')
  assert.equal(homeRepoFor('/Users/al/site', '/Users/al/site/src', '/Users/al'), false, 'an ordinary repository')
  assert.equal(homeRepoFor('/Users/alex', '/Users/alex/x', '/Users/al'), false, 'a neighbour whose name starts the same')
})

const session = (id: string, project: string, cwd = project, createdAt = 1): AdeSession => ({ id, title: null, project, cwd, branch: null, repo: false, worktree: false, createdAt })

test('the sidebar keeps its order while it is on screen; a project not shown yet goes first', () => {
  const sessions = [session('a', '/p/a'), session('b', '/p/b'), session('c', '/p/c')]
  const first = keepOrder(groupSessions(sessions, ['/p/a', '/p/b', '/p/c']), [])
  assert.deepEqual(first.map((g) => g.project), ['/p/a', '/p/b', '/p/c'])
  // Opening c makes it the most recent; the list doesn't move under the pointer.
  const after = keepOrder(groupSessions(sessions, ['/p/c', '/p/a', '/p/b']), first.map((g) => g.project))
  assert.deepEqual(after.map((g) => g.project), ['/p/a', '/p/b', '/p/c'])
  const added = keepOrder(groupSessions([...sessions, session('d', '/p/d')], ['/p/d', '/p/c']), after.map((g) => g.project))
  assert.deepEqual(added.map((g) => g.project), ['/p/d', '/p/a', '/p/b', '/p/c'])
})

test('a project that is just its own folder is one row; one with sessions of its own keeps its heading', () => {
  const groups = groupSessions([session('a', '/p/a'), session('b', '/p/b'), session('w', '/p/b', '/wt/b-fix', 2)], [])
  const solo = groups.find((g) => g.project === '/p/a')!
  const withWorktree = groups.find((g) => g.project === '/p/b')!
  assert.equal(isSoloProject(solo), true)
  assert.equal(isSoloProject(withWorktree), false)
  // A worktree on its own, without the project folder's session, keeps the heading that names its project.
  assert.equal(isSoloProject({ project: '/p/c', sessions: [session('x', '/p/c', '/wt/c-x')] }), false)
})
