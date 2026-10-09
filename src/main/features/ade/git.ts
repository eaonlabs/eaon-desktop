import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/**
 * The little git an ADE session needs: which repository a folder is in and on
 * which branch, and making or removing a worktree for a new branch. Run as
 * the user's own `git`, so their config, hooks and credentials apply as they
 * would in a terminal.
 */

export class GitError extends Error {}

/** Runs git in `cwd`. Its own message (the last line it printed) on failure. */
async function git(cwd: string, args: string[], timeout = 15_000): Promise<string> {
  try {
    const { stdout } = await exec('git', ['-C', cwd, ...args], {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      // Never stop to ask for a password or an editor: there is no terminal to answer in.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' }
    })
    return stdout.trim()
  } catch (error) {
    const e = error as { stderr?: string; message?: string; code?: unknown }
    if (e.code === 'ENOENT') throw new GitError('Git isn’t installed on this computer.')
    const said = (e.stderr ?? '').trim().split('\n').filter(Boolean)
    const line = said.find((l) => /^(fatal|error):/.test(l)) ?? said.pop() ?? e.message ?? 'git failed'
    throw new GitError(line.replace(/^(fatal|error):\s*/, ''))
  }
}

export interface RepoInfo {
  /** The working tree `dir` is in (a worktree's own folder, for a worktree). */
  top: string
  /** The repository's main folder: where its `.git` folder is. */
  root: string
  /** The branch checked out there; null when HEAD is detached. */
  branch: string | null
}

/** The repository `dir` is in, or null when it isn't in one (or git isn't there). */
export async function repoInfo(dir: string): Promise<RepoInfo | null> {
  let top: string
  let common: string
  try {
    ;[top, common] = (await git(dir, ['rev-parse', '--show-toplevel', '--path-format=absolute', '--git-common-dir'], 5000)).split('\n')
  } catch {
    return null
  }
  if (!top || !common) return null
  // `<main>/.git` for a normal repository, whichever worktree asked; a bare one is its own root.
  const root = path.basename(common) === '.git' ? path.dirname(common) : common
  const branch = await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 5000).catch(() => null)
  return { top: path.resolve(top), root: path.resolve(root), branch: branch || null }
}

export async function branchExists(root: string, branch: string): Promise<boolean> {
  try {
    await git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], 5000)
    return true
  } catch {
    return false
  }
}

/** Git's own verdict on a branch name: its normalised form, or a GitError saying why not. */
export async function checkBranchName(root: string, branch: string): Promise<string> {
  try {
    return await git(root, ['check-ref-format', '--branch', branch], 5000)
  } catch {
    throw new GitError(`“${branch}” isn’t a branch name git accepts.`)
  }
}

/** Makes `branch` from what `root` has checked out, in a new worktree at `dir`. */
export async function addWorktree(root: string, dir: string, branch: string): Promise<void> {
  await git(root, ['worktree', 'add', '-b', branch, dir], 60_000)
}

/**
 * Removes the worktree at `dir`. Never forced: git refuses when it has
 * changes nobody committed, and that refusal is what the user is told.
 */
export async function removeWorktree(root: string, dir: string): Promise<void> {
  await git(root, ['worktree', 'remove', dir], 60_000)
}

/**
 * Whether a working tree whose top is `top` should be ignored for `dir`: it
 * holds the home folder (the home folder itself put under git, for dotfiles
 * or by an accidental `git init`) and `dir` is a folder inside it. Taken at
 * its word, every project in the home folder that isn't a repository of its
 * own became one project, named after the home folder, on its branch.
 */
export function homeRepoFor(top: string, dir: string, home: string): boolean {
  const t = path.resolve(top)
  const h = path.resolve(home)
  const holdsHome = t === h || h.startsWith(t.endsWith(path.sep) ? t : t + path.sep)
  return holdsHome && path.resolve(dir) !== t
}

/** The repository `dir` belongs to as a project: `repoInfo`, except that a home-folder repository doesn't count for the folders in it. */
export async function projectRepo(dir: string, home: string): Promise<RepoInfo | null> {
  const info = await repoInfo(dir)
  return info && homeRepoFor(info.top, dir, home) ? null : info
}

/** The `origin` remote's URL, or null when there is none. */
export async function remoteUrl(dir: string): Promise<string | null> {
  try {
    return (await git(dir, ['remote', 'get-url', 'origin'], 5000)) || null
  } catch {
    return null
  }
}

/** Fetches `refspec` from origin into `root` (a pull request's head, a base branch). */
export async function fetchOrigin(root: string, refspec: string): Promise<void> {
  await git(root, ['fetch', '--quiet', 'origin', refspec], 120_000)
}

/** A worktree at `dir` on `ref`, on no branch: for reading a pull request, not for working on it. */
export async function addDetachedWorktree(root: string, dir: string, ref: string): Promise<void> {
  await git(root, ['worktree', 'add', '--detach', dir, ref], 60_000)
}

/** Moves an existing worktree to `ref`, on no branch. Never forced: changes made there stop it. */
export async function checkoutDetached(dir: string, ref: string): Promise<void> {
  await git(dir, ['checkout', '--detach', ref], 60_000)
}

/** The repository's own .git folder (shared by every worktree), for its info/exclude. */
export async function commonDir(dir: string): Promise<string> {
  return path.resolve(dir, await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 5000))
}

/** A worktree at `dir` on a branch that already exists. */
export async function addWorktreeOn(root: string, dir: string, branch: string): Promise<void> {
  await git(root, ['worktree', 'add', dir, branch], 60_000)
}
