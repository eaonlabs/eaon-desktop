import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, rm, stat, utimes } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { isRemote } from '@shared/adeRemote'
import { parseUnifiedDiff, type ReviewFile } from '@shared/adeReview'
import { CHECKPOINT_REF_ROOT, checkpointRef, parseNameStatus, parseRawNumstat, type CheckpointDiff, type TurnChanges, type TurnRestore } from '@shared/chatCode'

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
 * The repository's top as the chat's folder spells it, so the full paths
 * given back match the folder's: git names the real one, and a folder
 * reached through a link (or /tmp, which is /private/tmp) is spelled otherwise.
 */
async function spelledTop(cwd: string, top: string): Promise<string> {
  const res = await git(cwd, ['rev-parse', '--show-prefix'], {}, 5000)
  if (!res.ok) return top
  const depth = res.stdout.trim().split('/').filter(Boolean).length
  return resolve(cwd, ...new Array<string>(depth).fill('..'))
}

/** Every checkpoint ref in the repository and the commit it points at, in one call. */
async function checkpointRefs(top: string): Promise<Map<string, string>> {
  const res = await git(top, ['for-each-ref', '--format=%(objectname) %(refname)', CHECKPOINT_REF_ROOT], {}, 5000)
  const refs = new Map<string, string>()
  if (!res.ok) return refs
  for (const line of res.stdout.split('\n')) {
    const at = line.indexOf(' ')
    if (at > 0) refs.set(line.slice(at + 1), line.slice(0, at))
  }
  return refs
}

/** Paths given to git are names, not patterns: a file can be called `*.ts`. */
const LITERAL = { GIT_LITERAL_PATHSPECS: '1' }

/** Two commits never change, so what changed between them is asked once. Paths from the top of the repository. */
const counted = new Map<string, ReviewFile[]>()
const COUNTED_KEPT = 2000

async function countBetween(top: string, from: string, to: string, keep: boolean): Promise<ReviewFile[] | null> {
  const key = `${from}..${to}`
  const known = counted.get(key)
  if (known) return known
  const res = await git(top, ['diff', '--raw', '--numstat', '-z', '--no-renames', from, to])
  if (!res.ok) return null
  const files = parseRawNumstat(res.stdout)
  if (keep) {
    if (counted.size >= COUNTED_KEPT) counted.delete(counted.keys().next().value as string)
    counted.set(key, files)
  }
  return files
}

/** The reply's checkpoints; the running reply's end is the folder now, taken once by `now`. */
async function endsOf(
  refs: Map<string, string>,
  replyId: string,
  live: string | null,
  now: () => Promise<string | null>
): Promise<{ before: string; after: string; done: boolean } | null> {
  const before = refs.get(checkpointRef(replyId, 'before'))
  if (!before) return null
  const after = refs.get(checkpointRef(replyId, 'after'))
  if (after) return { before, after, done: true }
  const current = replyId === live ? await now() : null
  return current ? { before, after: current, done: false } : null
}

/**
 * What a chat's replies changed, from their checkpoints: whatever changed
 * the files, an edit tool or a command, and nothing the agent only read.
 * Each file runs from before the first of these replies that changed it to
 * after the last, so one written by two replies counts once. `live` is the
 * reply still running, compared with the folder as it is now; `patch` adds
 * each file's hunks.
 */
export async function checkpointDiff(cwd: string, replyIds: string[], options: { patch?: boolean; live?: string | null } = {}): Promise<CheckpointDiff> {
  const top = await topOf(cwd)
  if (!top || replyIds.length === 0) return { covered: [], changed: [], files: [] }
  const [refs, base] = await Promise.all([checkpointRefs(top), spelledTop(cwd, top)])
  let taken: Promise<string | null> | null = null
  const now = (): Promise<string | null> => (taken ??= snapshot(top))
  const covered: string[] = []
  const changed: string[] = []
  const spans = new Map<string, { from: string; to: string; done: boolean }>()
  for (const id of replyIds) {
    const ends = await endsOf(refs, id, options.live ?? null, now)
    const files = ends ? await countBetween(top, ends.before, ends.after, ends.done) : null
    if (!ends || !files) continue
    covered.push(id)
    if (files.length) changed.push(id)
    for (const { path } of files) spans.set(path, { from: spans.get(path)?.from ?? ends.before, to: ends.after, done: ends.done })
  }
  const groups = new Map<string, { from: string; to: string; done: boolean; paths: string[] }>()
  for (const [path, span] of spans) {
    const key = `${span.from}..${span.to}`
    const group = groups.get(key)
    if (group) group.paths.push(path)
    else groups.set(key, { ...span, paths: [path] })
  }
  const files: ReviewFile[] = []
  for (const { from, to, done, paths } of groups.values()) {
    if (!options.patch) {
      const wanted = new Set(paths)
      for (const file of (await countBetween(top, from, to, done)) ?? []) if (wanted.has(file.path)) files.push({ ...file, path: join(base, file.path) })
      continue
    }
    for (let i = 0; i < paths.length; i += 200) {
      const res = await git(top, ['diff', '--no-color', '--no-ext-diff', '--no-renames', '-U3', from, to, '--', ...paths.slice(i, i + 200)], LITERAL, 30_000)
      if (res.ok) for (const file of parseUnifiedDiff(res.stdout)) files.push({ ...file, path: join(base, file.path), oldPath: null })
    }
  }
  return { covered, changed, files: files.sort((a, b) => a.path.localeCompare(b.path)) }
}

/** Each finished reply's own changes by its checkpoints, counted, for its changed-files card. Replies without both are left out. */
export async function replyDiffs(cwd: string, replyIds: string[]): Promise<Record<string, ReviewFile[]>> {
  const top = await topOf(cwd)
  const out: Record<string, ReviewFile[]> = {}
  if (!top || replyIds.length === 0) return out
  const [refs, base] = await Promise.all([checkpointRefs(top), spelledTop(cwd, top)])
  const never = async (): Promise<null> => null
  for (const id of replyIds) {
    const ends = await endsOf(refs, id, null, never)
    const files = ends ? await countBetween(top, ends.before, ends.after, true) : null
    if (files) out[id] = files.map((file) => ({ ...file, path: join(base, file.path) }))
  }
  return out
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
