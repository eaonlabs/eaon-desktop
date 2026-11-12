import { readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { Feature } from './types'
import { allowed } from './workspaceFiles'
import { isRemote } from '@shared/adeRemote'

/** Replace in files reads and writes this computer's disk; a project on another machine has the agent for that. */
const here = async (cwd: unknown): Promise<string> => {
  const folder = await allowed(cwd)
  if (isRemote(folder)) throw new Error('Replace in files works on this computer’s folders. For a project over SSH, ask the agent to make the change.')
  return folder
}
import { sshHosts } from './ade'
import { makeRunner, type Runner } from './ade/runner'
import { EDITABLE_LIMIT } from '@shared/workspaceFiles'
import { replaceInText, searchPattern, type ReplaceRequest, type ReplaceResult, type ReplacedFile, type UndoReplaceResult } from '@shared/searchReplace'

/**
 * Replace across the project: the files Find in project listed, written with
 * the replacement after the person has seen each line before and after and
 * pressed Replace. Only files inside the chat's folder, only text, never
 * what git ignores, and a line that no longer matches (the file changed
 * since the search) is left alone. The last replacement in a folder can be put
 * back, for as long as the files still read as it left them.
 */

const run = makeRunner(sshHosts)

const MAX_TARGETS = 500

/** What the last replacement in a folder wrote, to put back: each file's text before and after. */
interface Batch {
  files: { path: string; before: string; after: string }[]
}
const undoable = new Map<string, Batch>()

const isInside = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** The paths of `paths` that git doesn't ignore (all of them outside a repository). */
async function notIgnored(runGit: Runner, cwd: string, paths: string[]): Promise<Set<string>> {
  const inside = await runGit(cwd, 'git', ['rev-parse', '--is-inside-work-tree'], 5000)
  if (!inside.ok) return new Set(paths)
  const res = await runGit(cwd, 'git', ['ls-files', '-co', '--exclude-standard', '-z', '--', ...paths], 30_000)
  // If git can't say, nothing is written: better a replacement that didn't happen than one in an ignored file.
  return res.ok ? new Set(res.stdout.split('\0').filter(Boolean)) : new Set()
}

/** Replaces in the files `request` names, inside `root` (a folder Chat's agent works in). */
export async function replaceInFolder(root: string, request: ReplaceRequest, runGit: Runner = run): Promise<ReplaceResult> {
  const made = searchPattern(request.query, request.options)
  if ('error' in made) return { ok: false, error: made.error }
  if (request.targets.length === 0) return { ok: false, error: 'Choose at least one match to replace.' }
  if (request.targets.length > MAX_TARGETS) return { ok: false, error: `That is more than ${MAX_TARGETS} files at once. Narrow the search first.` }
  const realRoot = await realpath(root)
  const inFolder = (rel: string): boolean => Boolean(rel) && !isAbsolute(rel) && !rel.split(/[\\/]/).includes('..')
  const keep = await notIgnored(runGit, root, request.targets.map((t) => t.path).filter(inFolder))

  const files: ReplacedFile[] = []
  const skipped: { path: string; reason: string }[] = []
  const batch: Batch = { files: [] }
  for (const target of request.targets) {
    const rel = target.path
    if (!inFolder(rel)) {
      skipped.push({ path: rel, reason: 'not a file in this folder' })
      continue
    }
    try {
      const real = await allowed(join(root, rel)).catch(() => {
        throw new Error('it isn’t there any more')
      })
      if (!isInside(realRoot, real)) {
        skipped.push({ path: rel, reason: 'outside this folder' })
        continue
      }
      if (!keep.has(rel)) {
        skipped.push({ path: rel, reason: 'git ignores it' })
        continue
      }
      const info = await stat(real)
      if (!info.isFile()) {
        skipped.push({ path: rel, reason: 'not a file' })
        continue
      }
      if (info.size > EDITABLE_LIMIT) {
        skipped.push({ path: rel, reason: 'too large to edit from here' })
        continue
      }
      const buffer = await readFile(real)
      if (buffer.subarray(0, 8000).includes(0)) {
        skipped.push({ path: rel, reason: 'not a text file' })
        continue
      }
      const before = buffer.toString('utf8')
      const only = target.lines && target.lines.length > 0 ? new Set(target.lines.filter((n) => Number.isInteger(n) && n > 0)) : undefined
      const done = replaceInText(before, made.pattern, request.replacement, request.options.regex === true, only)
      if (done.replaced === 0) {
        skipped.push({ path: rel, reason: 'it changed since the search: no chosen line matches any more' })
        continue
      }
      // Changed under us between reading and writing: leave it for another search.
      if ((await stat(real)).mtimeMs !== info.mtimeMs) {
        skipped.push({ path: rel, reason: 'it changed while replacing' })
        continue
      }
      await writeFile(real, done.text, 'utf8')
      batch.files.push({ path: real, before, after: done.text })
      files.push({ path: rel, replaced: done.replaced, lines: done.lines })
      if (done.stale.length > 0) skipped.push({ path: rel, reason: `line${done.stale.length === 1 ? '' : 's'} ${done.stale.join(', ')} changed since the search and ${done.stale.length === 1 ? 'was' : 'were'} left as it is` })
    } catch (error) {
      skipped.push({ path: rel, reason: error instanceof Error ? error.message : 'couldn’t be read or written' })
    }
  }
  if (batch.files.length > 0) undoable.set(realRoot, batch)
  return { ok: true, files, skipped, undoable: undoable.has(realRoot) }
}

/** Puts back the folder's last replacement: each file whose text is still what that replacement left; the others are named and kept. */
export async function undoReplaceIn(root: string): Promise<UndoReplaceResult> {
  const realRoot = await realpath(root)
  const batch = undoable.get(realRoot)
  if (!batch) return { ok: false, error: 'There is no replacement to undo.' }
  const restored: string[] = []
  const conflicts: string[] = []
  for (const f of batch.files) {
    const name = relative(realRoot, f.path).split(sep).join('/')
    try {
      if ((await readFile(f.path, 'utf8')) !== f.after) {
        conflicts.push(name)
        continue
      }
      await writeFile(f.path, f.before, 'utf8')
      restored.push(name)
    } catch {
      conflicts.push(name)
    }
  }
  undoable.delete(realRoot)
  return { ok: true, restored, conflicts }
}

const textArg = (value: unknown, what: string, max: number): string => {
  if (typeof value !== 'string' || value.length > max) throw new Error(`Expected ${what}.`)
  return value
}

function requestOf(query: unknown, options: unknown, replacement: unknown, targets: unknown): ReplaceRequest {
  const o = (options ?? {}) as { caseSensitive?: unknown; regex?: unknown; word?: unknown }
  const list = Array.isArray(targets) ? targets : []
  return {
    query: textArg(query, 'something to find', 500),
    options: { caseSensitive: o.caseSensitive === true, regex: o.regex === true, word: o.word === true },
    replacement: textArg(replacement, 'the replacement', 20_000),
    targets: list
      .filter((t): t is { path: string; lines?: unknown } => typeof (t as { path?: unknown })?.path === 'string' && (t as { path: string }).path.length < 4096)
      .slice(0, MAX_TARGETS + 1)
      .map((t) => ({
        path: t.path,
        ...(Array.isArray(t.lines) ? { lines: t.lines.filter((n): n is number => typeof n === 'number').slice(0, 5000) } : {})
      }))
  }
}

export const searchReplaceFeature: Feature = {
  id: 'search-replace',
  register: ({ ipcMain }) => {
    ipcMain.handle('search-replace:replace', async (_e, cwd: unknown, query: unknown, options: unknown, replacement: unknown, targets: unknown) =>
      replaceInFolder(await here(cwd), requestOf(query, options, replacement, targets))
    )
    ipcMain.handle('search-replace:undo', async (_e, cwd: unknown) => undoReplaceIn(await here(cwd)))
  }
}
