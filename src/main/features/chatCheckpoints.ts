import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, rm, stat, utimes } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { isRemote } from '@shared/adeRemote'
import { CHECKPOINT_REF_ROOT, checkpointRef, parseNameStatus, type TurnChanges, type TurnRestore } from '@shared/chatCode'

/**
 * Checkpoints: a coding chat's folder as it was when a reply started and
 * when it ended, so the reply's changes can be undone (and redone), and
 * Edit from here can put the files back too.
 *
 * Each is a commit under refs/eaon/checkpoints/<reply>/{before,after} made
 * from a scratch copy of the index, so the user's own index, branch and
 * stash are never touched. Ignored files aren't in it. Undo writes only the
 * files the reply changed, and only after checking nobody changed them since.
 */

interface Git {
  ok: boolean
  stdout: string
  stderr: string
}

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Eaon',
  GIT_AUTHOR_EMAIL: 'checkpoints@eaon.invalid',
  GIT_COMMITTER_NAME: 'Eaon',
  GIT_COMMITTER_EMAIL: 'checkpoints@eaon.invalid'
}

function git(cwd: string, args: string[], env: Record<string, string> = {}, timeout = 20_000): Promise<Git> {
  return new Promise((done) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...IDENTITY, ...env }
      },
      (error, stdout, stderr) => done({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr || (error ? error.message : '')) })
    )
  })
}

/** The repository's top folder, or null when the folder isn't in one (or is on another machine). */
async function topOf(cwd: string): Promise<string | null> {
  if (isRemote(cwd) || !existsSync(cwd)) return null
  const top = await git(cwd, ['rev-parse', '--show-toplevel'], {}, 5000)
  return top.ok ? top.stdout.trim() || null : null
}

/**
 * The working tree as a commit, without touching the user's index: a copy of
 * it takes `git add -A`, so only files that changed are read again.
 */
async function snapshot(top: string): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), 'eaon-checkpoint-'))
  const index = join(dir, 'index')
  try {
    const indexPath = await git(top, ['rev-parse', '--git-path', 'index'], {}, 5000)
    const real = indexPath.ok ? resolve(top, indexPath.stdout.trim()) : ''
    const head = await git(top, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], {}, 5000)
    const env = { GIT_INDEX_FILE: index }
    if (real && existsSync(real)) {
      await copyFile(real, index)
      // The copy keeps the index's own time: git re-reads a file whose time is
      // as new as the index (racy git), and a copy dated now hid same-size
      // edits made in the same second as the last commit.
      const { atime, mtime } = await stat(real)
      await utimes(index, atime, mtime)
    } else if (head.ok && !(await git(top, ['read-tree', 'HEAD'], env)).ok) return null
    if (!(await git(top, ['add', '-A', '--', '.'], env, 60_000)).ok) return null
    const tree = await git(top, ['write-tree'], env)
    if (!tree.ok) return null
    const parent = head.ok ? ['-p', head.stdout.trim()] : []
    const commit = await git(top, ['commit-tree', tree.stdout.trim(), ...parent, '-m', 'Eaon checkpoint'])
    return commit.ok ? commit.stdout.trim() : null
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Records the folder as it is now, for this reply. False when there's nothing
 * to record it in, or it took past `deadline`: a before checkpoint finished
 * after the reply began could hold the reply's first edits.
 */
export async function capture(cwd: string, replyId: string, side: 'before' | 'after', deadline = Infinity): Promise<boolean> {
  const top = await topOf(cwd)
  if (!top) return false
  const commit = await snapshot(top)
  if (!commit || Date.now() > deadline) return false
  return (await git(top, ['update-ref', checkpointRef(replyId, side), commit], {}, 5000)).ok
}

/** How long a reply waits for its before checkpoint; a folder slower than that goes without. */
const BEFORE_WAIT_MS = 6000

/** Takes the before checkpoint, waiting at most BEFORE_WAIT_MS. Never throws. */
export async function captureBefore(cwd: string, replyId: string): Promise<boolean> {
  const deadline = Date.now() + BEFORE_WAIT_MS
  const late = new Promise<boolean>((done) => setTimeout(() => done(false), BEFORE_WAIT_MS).unref?.())
  return Promise.race([capture(cwd, replyId, 'before', deadline).catch(() => false), late])
}

async function refOf(top: string, replyId: string, side: 'before' | 'after'): Promise<string | null> {
  const res = await git(top, ['rev-parse', '--verify', '--quiet', `${checkpointRef(replyId, side)}^{commit}`], {}, 5000)
  return res.ok ? res.stdout.trim() || null : null
}

/** Paths that differ between two commits, from the top of the repository, renames as a delete and an add. */
async function changedPaths(top: string, from: string, to: string, paths: string[] = []): Promise<{ path: string; status: string }[] | null> {
  const res = await git(top, ['diff', '--name-status', '-z', '--no-renames', from, to, '--', ...paths])
  return res.ok ? parseNameStatus(res.stdout) : null
}

/** What a reply changed in its folder, by its checkpoints. */
export async function turnChanges(cwd: string, replyId: string): Promise<TurnChanges> {
  const top = await topOf(cwd)
  if (!top) return { available: false, reason: 'not-git', files: [] }
  const [before, after] = await Promise.all([refOf(top, replyId, 'before'), refOf(top, replyId, 'after')])
  if (!before || !after) return { available: false, reason: 'no-checkpoint', files: [] }
  const files = await changedPaths(top, before, after)
  if (!files) return { available: false, reason: 'no-checkpoint', files: [] }
  return { available: files.length > 0, files: files.map((f) => f.path) }
}

/**
 * Puts the files a reply changed back as they were before it (`undo`), or
 * as it left them (`redo`). Files changed since are named and left alone
 * unless `force`.
 */
export async function restoreTurn(cwd: string, replyId: string, direction: 'undo' | 'redo', force = false): Promise<TurnRestore> {
  const top = await topOf(cwd)
  if (!top) return { ok: false, error: 'This folder isn’t in a git repository, so there’s nothing to undo from.' }
  const [before, after] = await Promise.all([refOf(top, replyId, 'before'), refOf(top, replyId, 'after')])
  if (!before || !after) return { ok: false, error: 'This reply has no checkpoint to undo from.' }
  const [target, expected] = direction === 'undo' ? [before, after] : [after, before]
  const files = await changedPaths(top, before, after)
  if (!files) return { ok: false, error: 'git couldn’t compare the checkpoints.' }
  if (files.length === 0) return { ok: true, files: [] }
  const paths = files.map((f) => f.path)
  if (!force) {
    const now = await snapshot(top)
    if (!now) return { ok: false, error: 'git couldn’t read the folder as it is now.' }
    const moved = await changedPaths(top, expected, now, paths)
    if (!moved) return { ok: false, error: 'git couldn’t compare the folder with the checkpoint.' }
    if (moved.length > 0) return { ok: false, conflicts: moved.map((f) => f.path) }
  }
  return writeTree(top, target, paths)
}

/**
 * Edit from here, files too: everything the replies from `replyIds[0]` on
 * changed goes back to how it was before the first of them. Files they
 * didn't touch, and ignored ones, stay as they are.
 */
export async function rewindTurns(cwd: string, replyIds: string[]): Promise<TurnRestore> {
  const top = await topOf(cwd)
  if (!top) return { ok: false, error: 'This folder isn’t in a git repository.' }
  const first = replyIds.length ? await refOf(top, replyIds[0], 'before') : null
  if (!first) return { ok: false, error: 'This message has no checkpoint to go back to.' }
  const paths = new Set<string>()
  for (const id of replyIds) {
    const [before, after] = await Promise.all([refOf(top, id, 'before'), refOf(top, id, 'after')])
    if (!before) continue
    // A reply still without an after checkpoint (stopped mid-write) is compared with now.
    const end = after ?? (await snapshot(top))
    if (!end) continue
    for (const f of (await changedPaths(top, before, end)) ?? []) paths.add(f.path)
  }
  if (paths.size === 0) return { ok: true, files: [] }
  return writeTree(top, first, [...paths])
}

/** Writes `paths` as they are in `commit`; ones it doesn't have are removed. Never the index. */
async function writeTree(top: string, commit: string, paths: string[]): Promise<TurnRestore> {
  const listed = await git(top, ['ls-tree', '-r', '-z', '--name-only', commit, '--', ...paths])
  if (!listed.ok) return { ok: false, error: 'git couldn’t read the checkpoint.' }
  const present = new Set(listed.stdout.split('\0').filter(Boolean))
  const keep = paths.filter((p) => present.has(p))
  const drop = paths.filter((p) => !present.has(p))
  for (let i = 0; i < keep.length; i += 200) {
    const res = await git(top, ['restore', `--source=${commit}`, '--worktree', '--', ...keep.slice(i, i + 200)])
    if (!res.ok) return { ok: false, error: res.stderr.trim().split('\n').pop() || 'git couldn’t write the files back.' }
  }
  const root = resolve(top) + sep
  for (const p of drop) {
    const full = resolve(top, p)
    if (full.startsWith(root)) await rm(full, { force: true }).catch(() => {})
  }
  return { ok: true, files: paths }
}

/** Removes a deleted chat's checkpoints. */
export async function dropCheckpoints(cwd: string, replyIds: string[]): Promise<void> {
  const top = await topOf(cwd)
  if (!top || replyIds.length === 0) return
  const refs = replyIds.flatMap((id) => [checkpointRef(id, 'before'), checkpointRef(id, 'after')])
  const listed = await git(top, ['for-each-ref', '--format=%(refname)', CHECKPOINT_REF_ROOT])
  if (!listed.ok) return
  const existing = new Set(listed.stdout.split('\n').filter(Boolean))
  const stdin = refs.filter((r) => existing.has(r)).map((r) => `delete ${r}\n`).join('')
  if (!stdin) return
  await new Promise<void>((done) => {
    const child = execFile('git', ['update-ref', '--stdin'], { cwd: top, timeout: 10_000, windowsHide: true }, () => done())
    child.stdin?.end(stdin)
  })
}
