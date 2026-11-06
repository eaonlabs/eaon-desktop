import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { capture, dropCheckpoints, restoreTurn, rewindTurns, turnChanges } from '../src/main/features/chatCheckpoints'
import { checkpointRef, parseNameStatus } from '../src/shared/chatCode'
import { repliesAfter } from '../src/renderer/src/state/chatEdits'
import type { ChatMessage } from '../src/shared/types'

/** Undoing a coding reply's changes: checkpoints around each reply, in a real repository. */

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'eaon-ckpt-test-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 't@t')
  git(dir, 'config', 'user.name', 't')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src/a.js'), 'one\n')
  writeFileSync(join(dir, 'keep.txt'), 'mine\n')
  writeFileSync(join(dir, '.gitignore'), 'ignored/\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  return dir
}
const read = (dir: string, path: string): string => readFileSync(join(dir, path), 'utf8')

test('git name-status output becomes paths', () => {
  assert.deepEqual(parseNameStatus('M\0src/a.js\0A\0b c.txt\0D\0gone\0'), [
    { path: 'src/a.js', status: 'M' },
    { path: 'b c.txt', status: 'A' },
    { path: 'gone', status: 'D' }
  ])
  assert.deepEqual(parseNameStatus(''), [])
  assert.equal(checkpointRef('a/b', 'before'), 'refs/eaon/checkpoints/a_b/before')
})

test('a reply is undone and redone; the index and the files it never touched are left alone', async () => {
  const dir = repo()
  try {
    git(dir, 'add', 'keep.txt') // nothing staged changes, but the index must stay as it was
    const indexBefore = git(dir, 'diff', '--cached', '--name-only')
    assert.equal(await capture(dir, 'r1', 'before'), true)
    writeFileSync(join(dir, 'src/a.js'), 'two\n')
    writeFileSync(join(dir, 'src/new.js'), 'new\n')
    mkdirSync(join(dir, 'ignored'))
    writeFileSync(join(dir, 'ignored/cache'), 'x')
    assert.equal(await capture(dir, 'r1', 'after'), true)
    // The user's own edit after the reply, to a file the reply didn't touch.
    writeFileSync(join(dir, 'keep.txt'), 'mine, edited\n')

    const changes = await turnChanges(dir, 'r1')
    assert.equal(changes.available, true)
    assert.deepEqual(changes.files.sort(), ['src/a.js', 'src/new.js'])

    const undo = await restoreTurn(dir, 'r1', 'undo')
    assert.equal(undo.ok, true)
    assert.equal(read(dir, 'src/a.js'), 'one\n')
    assert.equal(existsSync(join(dir, 'src/new.js')), false)
    assert.equal(read(dir, 'keep.txt'), 'mine, edited\n')
    assert.equal(existsSync(join(dir, 'ignored/cache')), true)
    assert.equal(git(dir, 'diff', '--cached', '--name-only'), indexBefore)

    const redo = await restoreTurn(dir, 'r1', 'redo')
    assert.equal(redo.ok, true)
    assert.equal(read(dir, 'src/a.js'), 'two\n')
    assert.equal(read(dir, 'src/new.js'), 'new\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a file changed since the reply is named, and only overwritten when forced', async () => {
  const dir = repo()
  try {
    await capture(dir, 'r1', 'before')
    writeFileSync(join(dir, 'src/a.js'), 'two\n')
    await capture(dir, 'r1', 'after')
    writeFileSync(join(dir, 'src/a.js'), 'two, then mine\n')

    const blocked = await restoreTurn(dir, 'r1', 'undo')
    assert.equal(blocked.ok, false)
    assert.deepEqual(!blocked.ok && blocked.conflicts, ['src/a.js'])
    assert.equal(read(dir, 'src/a.js'), 'two, then mine\n')

    const forced = await restoreTurn(dir, 'r1', 'undo', true)
    assert.equal(forced.ok, true)
    assert.equal(read(dir, 'src/a.js'), 'one\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Edit from here puts back what every later reply changed, and only that', async () => {
  const dir = repo()
  try {
    await capture(dir, 'r1', 'before')
    writeFileSync(join(dir, 'src/a.js'), 'two\n')
    await capture(dir, 'r1', 'after')
    await capture(dir, 'r2', 'before')
    writeFileSync(join(dir, 'src/b.js'), 'b\n')
    await capture(dir, 'r2', 'after')
    writeFileSync(join(dir, 'keep.txt'), 'mine, edited\n')

    const result = await rewindTurns(dir, ['r1', 'r2'])
    assert.equal(result.ok, true)
    assert.equal(read(dir, 'src/a.js'), 'one\n')
    assert.equal(existsSync(join(dir, 'src/b.js')), false)
    assert.equal(read(dir, 'keep.txt'), 'mine, edited\n')

    await dropCheckpoints(dir, ['r1', 'r2'])
    assert.equal(git(dir, 'for-each-ref', 'refs/eaon/'), '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a folder outside git, or a reply without checkpoints, has nothing to undo', async () => {
  const plain = mkdtempSync(join(tmpdir(), 'eaon-ckpt-plain-'))
  const dir = repo()
  try {
    assert.equal(await capture(plain, 'r1', 'before'), false)
    assert.deepEqual(await turnChanges(plain, 'r1'), { available: false, reason: 'not-git', files: [] })
    assert.deepEqual(await turnChanges(dir, 'missing'), { available: false, reason: 'no-checkpoint', files: [] })
    const undo = await restoreTurn(dir, 'missing', 'undo')
    assert.equal(undo.ok, false)
  } finally {
    rmSync(plain, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a repository with no commits yet is checkpointed too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eaon-ckpt-empty-'))
  try {
    git(dir, 'init', '-q')
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    await capture(dir, 'r1', 'before')
    writeFileSync(join(dir, 'a.txt'), 'b\n')
    await capture(dir, 'r1', 'after')
    assert.equal((await restoreTurn(dir, 'r1', 'undo')).ok, true)
    assert.equal(read(dir, 'a.txt'), 'a\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the replies after a message are the ones Edit from here drops', () => {
  const m = (id: string, role: ChatMessage['role']): ChatMessage => ({ id, role, parts: [], createdAt: 0 })
  const messages = [m('u1', 'user'), m('a1', 'assistant'), m('u2', 'user'), m('a2', 'assistant'), m('u3', 'user'), m('a3', 'assistant')]
  assert.deepEqual(repliesAfter(messages, 'u2'), ['a2', 'a3'])
  assert.deepEqual(repliesAfter(messages, 'nope'), [])
})
