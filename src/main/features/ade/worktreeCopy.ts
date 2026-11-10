import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { NEVER_COPIED, planCopy, type CopyCandidate, type CopyPlan, type CopyReport } from '@shared/worktreeCopy'

const exec = promisify(execFile)

/**
 * Copying a project's ignored files into a new worktree (rules and limits in
 * shared/worktreeCopy.ts). Git says which files it ignores; only those that a
 * pattern names are looked at further, and only plain files are copied (no
 * symlinks, nothing outside the project, nothing already there).
 */

/** Past this many entries in an ignored folder, the rest isn't looked at. */
const WALK_LIMIT = 2000
const WALK_DEPTH = 6

/** What git ignores under `root`, as it lists it: files, and folders that are ignored as a whole (with a trailing slash). */
async function ignoredEntries(root: string): Promise<string[]> {
  const { stdout } = await exec('git', ['-C', root, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], {
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
  return stdout.split('\0').filter(Boolean)
}

/** The plain files in an ignored folder, relative to the project: dependency and build folders are not entered, and nothing is followed through a link. */
function filesIn(root: string, folder: string, budget: { left: number }, depth = 0): string[] {
  const out: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(path.join(root, folder), { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (budget.left <= 0) break
    budget.left--
    const rel = `${folder}/${entry.name}`
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      if (depth < WALK_DEPTH && !NEVER_COPIED.has(entry.name)) out.push(...filesIn(root, rel, budget, depth + 1))
    } else if (entry.isFile()) out.push(rel)
  }
  return out
}

/** Every ignored plain file in `root` with its size, relative to it. */
export async function ignoredFiles(root: string): Promise<CopyCandidate[]> {
  const budget = { left: WALK_LIMIT }
  // A set: git lists a folder of ignored files and the files in it both.
  const paths = new Set<string>()
  for (const entry of await ignoredEntries(root)) {
    if (!entry.endsWith('/')) paths.add(entry)
    else {
      const folder = entry.slice(0, -1)
      // A folder git ignores as a whole: looked into unless it is a dependency or build folder.
      if (!folder.split('/').some((part) => NEVER_COPIED.has(part))) for (const file of filesIn(root, folder, budget)) paths.add(file)
    }
  }
  const out: CopyCandidate[] = []
  for (const rel of paths) {
    try {
      const info = fs.lstatSync(path.join(root, rel))
      if (info.isFile()) out.push({ path: rel, size: info.size })
    } catch {
      /* gone since git listed it */
    }
  }
  return out
}

/** What would be copied from `root` for `patterns`, without copying anything. */
export async function previewCopy(root: string, patterns: string[]): Promise<CopyPlan> {
  return planCopy(await ignoredFiles(root), patterns)
}

/**
 * Copies the files `patterns` name from `root` into the worktree `dir`. A file
 * that can't be copied is reported, not fatal: the session is made either way.
 */
export async function copyIgnored(root: string, dir: string, patterns: string[]): Promise<CopyReport> {
  const plan = await previewCopy(root, patterns)
  const report: CopyReport = { copied: [], skipped: [...plan.skipped] }
  const target = path.resolve(dir)
  for (const file of plan.copy) {
    const from = path.resolve(root, file.path)
    const to = path.resolve(target, file.path)
    // Git's paths never climb out; this holds even if something odd gets through.
    if (!to.startsWith(target + path.sep) || !from.startsWith(path.resolve(root) + path.sep)) {
      report.skipped.push({ path: file.path, reason: 'outside the project' })
      continue
    }
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true })
      // Never over a file that is there already.
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL)
      report.copied.push(file.path)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      report.skipped.push({ path: file.path, reason: code === 'EEXIST' ? 'already in the worktree' : `couldn’t be copied (${code ?? 'error'})` })
    }
  }
  return report
}
