import fs from 'node:fs/promises'
import path from 'node:path'
import {
  actionsRunOf,
  cleanRunLog,
  hasConflictMarkers,
  parseUnifiedDiff,
  prFromGh,
  pullRequestFromCommits,
  runsFromGh,
  type ReviewAction,
  type ReviewCheck,
  type ReviewFile,
  type ReviewFileText,
  type ReviewLog,
  type ReviewResult,
  type ReviewState
} from '@shared/adeReview'
import { remoteLocation } from '@shared/adeRemote'
import { problemOf, type Runner } from './runner'

/**
 * Reviewing a session's work (shared/adeReview.ts): what changed since the
 * branch left the default branch, committed or not, and the commit → push →
 * pull request → merge steps. Plain git and the GitHub CLI, run in the
 * session's folder here or on its SSH host, as the user's own tools, so their
 * hooks, credentials and gh sign-in apply.
 */

/** Past this many new files, the rest are counted but not shown. */
const MAX_UNTRACKED = 60
const PR_FIELDS = 'number,title,url,state,isDraft,mergeable,mergeStateStatus,baseRefName,reviewDecision,statusCheckRollup'
const RUN_FIELDS = 'databaseId,name,workflowName,status,conclusion,url'
/** Past this size a conflicted file is left to the agent or an editor: it travels as a command argument over SSH. */
const MAX_RESOLVE_BYTES = 100_000

/** The default branch to measure against and open pull requests into: origin's HEAD, else main or master. */
async function defaultBranch(run: Runner, cwd: string): Promise<{ ref: string; name: string } | null> {
  const head = await run(cwd, 'git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  if (head.ok && head.stdout.trim()) {
    const ref = head.stdout.trim()
    return { ref, name: ref.replace(/^origin\//, '') }
  }
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if ((await run(cwd, 'git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).ok) return { ref, name: ref.replace(/^origin\//, '') }
  }
  return null
}

async function untrackedDiffs(run: Runner, cwd: string): Promise<ReviewFile[]> {
  const list = await run(cwd, 'git', ['ls-files', '--others', '--exclude-standard', '-z'])
  if (!list.ok) return []
  const paths = list.stdout.split('\0').filter(Boolean)
  const files: ReviewFile[] = []
  for (const file of paths.slice(0, MAX_UNTRACKED)) {
    // Exit 1 is "they differ", which is the point.
    const res = await run(cwd, 'git', ['diff', '--no-index', '--no-color', '--no-ext-diff', '--', '/dev/null', file])
    const parsed = parseUnifiedDiff(res.stdout)[0]
    files.push(parsed ? { ...parsed, path: file, status: 'added' } : { path: file, oldPath: null, status: 'added', added: 0, removed: 0, binary: true, hunks: [] })
  }
  return files
}

/** The branch's latest workflow runs, for a branch that has no pull request to show checks on. */
async function branchRuns(run: Runner, cwd: string, branch: string | null): Promise<ReviewCheck[]> {
  if (!branch) return []
  const res = await run(cwd, 'gh', ['run', 'list', '--branch', branch, '--limit', '5', '--json', RUN_FIELDS], 20_000)
  if (!res.ok) return []
  try {
    return runsFromGh(JSON.parse(res.stdout))
  } catch {
    return []
  }
}

async function github(run: Runner, cwd: string, branch: string | null): Promise<Pick<ReviewState, 'github' | 'githubProblem'>> {
  const res = await run(cwd, 'gh', ['pr', 'view', '--json', PR_FIELDS], 20_000)
  if (res.ok) {
    let pr = null
    try {
      pr = prFromGh(JSON.parse(res.stdout))
    } catch {
      /* not what gh says: as if there were none */
    }
    return { github: pr ? { pr } : { pr: null, runs: await branchRuns(run, cwd, branch) } }
  }
  const said = `${res.stderr}\n${res.stdout}`
  if (/no (open )?pull requests? found/i.test(said)) return { github: { pr: null, runs: await branchRuns(run, cwd, branch) } }
  if (res.code === null && /isn’t installed|not found|command not found/i.test(said)) {
    return { github: null, githubProblem: 'Install the GitHub CLI (gh) and sign in with gh auth login to open pull requests from here.' }
  }
  if (/command not found|No such file/i.test(said)) return { github: null, githubProblem: 'The GitHub CLI (gh) isn’t installed there.' }
  if (/gh auth login|not logged in|authentication/i.test(said)) return { github: null, githubProblem: 'Sign in to the GitHub CLI first: run gh auth login in a terminal.' }
  if (/none of the git remotes|no git remotes|not a git repository/i.test(said)) return { github: null, githubProblem: 'This repository has no GitHub remote.' }
  return { github: null, githubProblem: problemOf(res, 'GitHub couldn’t be asked about a pull request.') }
}

/** A merge, rebase or cherry-pick that stopped on conflicts, and the files still in conflict. */
async function conflictState(run: Runner, cwd: string): Promise<Pick<ReviewState, 'merging' | 'conflicted'>> {
  const has = async (ref: string): Promise<boolean> => (await run(cwd, 'git', ['rev-parse', '--quiet', '--verify', ref])).ok
  const [merge, rebase, pick, unmerged] = await Promise.all([
    has('MERGE_HEAD'),
    has('REBASE_HEAD'),
    has('CHERRY_PICK_HEAD'),
    run(cwd, 'git', ['diff', '--name-only', '--diff-filter=U', '-z'])
  ])
  const conflicted = unmerged.ok ? [...new Set(unmerged.stdout.split('\0').filter(Boolean))] : []
  return { merging: merge ? 'merge' : rebase ? 'rebase' : pick ? 'cherry-pick' : null, conflicted }
}

export async function reviewState(run: Runner, cwd: string): Promise<ReviewResult> {
  const head = await run(cwd, 'git', ['rev-parse', '--verify', '--quiet', 'HEAD'])
  if (!head.ok) {
    if (head.code === null || /not a git repository/i.test(head.stderr)) return { ok: false, error: problemOf(head, 'This folder isn’t in a git repository.') }
    return { ok: false, error: 'This repository has no commits yet. Make a first commit, then its changes can be reviewed here.' }
  }
  const sha = head.stdout.trim()
  const branchRes = await run(cwd, 'git', ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const branch = branchRes.ok ? branchRes.stdout.trim() || null : null
  const main = await defaultBranch(run, cwd)
  // On the default branch itself there is no "since it left": only what isn't committed.
  const onDefault = !main || branch === main.name
  let mergeBase = sha
  if (!onDefault && main) {
    const mb = await run(cwd, 'git', ['merge-base', main.ref, 'HEAD'])
    if (mb.ok && mb.stdout.trim()) mergeBase = mb.stdout.trim()
  }

  const [diff, untracked, ahead, status, upstream, gh, behindBase, conflicts] = await Promise.all([
    run(cwd, 'git', ['diff', mergeBase, '--no-color', '--no-ext-diff', '-M', '-U3', '--']),
    untrackedDiffs(run, cwd),
    run(cwd, 'git', ['rev-list', '--count', `${mergeBase}..HEAD`]),
    run(cwd, 'git', ['status', '--porcelain']),
    run(cwd, 'git', ['rev-list', '--left-right', '--count', '@{u}...HEAD']),
    github(run, cwd, branch),
    !onDefault && main ? run(cwd, 'git', ['rev-list', '--count', `HEAD..${main.ref}`]) : null,
    conflictState(run, cwd)
  ])
  if (!diff.ok) return { ok: false, error: problemOf(diff, 'git diff failed.') }
  const [behind, aheadUp] = upstream.ok ? upstream.stdout.trim().split(/\s+/).map(Number) : []
  return {
    ok: true,
    state: {
      branch,
      base: onDefault || !main ? 'HEAD' : main.ref,
      ahead: Number(ahead.stdout.trim()) || 0,
      uncommitted: status.stdout.split('\n').filter(Boolean).length,
      upstream: upstream.ok ? { ahead: aheadUp || 0, behind: behind || 0 } : null,
      behindBase: behindBase?.ok ? Number(behindBase.stdout.trim()) || 0 : 0,
      ...conflicts,
      files: [...parseUnifiedDiff(diff.stdout), ...untracked].sort((a, b) => a.path.localeCompare(b.path)),
      ...gh
    }
  }
}

/** Every change in the folder, new files included, as one commit. */
export async function commitAll(run: Runner, cwd: string, message: string): Promise<ReviewAction> {
  const text = message.trim()
  if (!text) return { ok: false, error: 'Write a commit message first.' }
  const add = await run(cwd, 'git', ['add', '-A'])
  if (!add.ok) return { ok: false, error: problemOf(add, 'git add failed.') }
  const commit = await run(cwd, 'git', ['commit', '-m', text], 120_000)
  if (!commit.ok) return { ok: false, error: problemOf(commit, 'git commit failed.') }
  const short = await run(cwd, 'git', ['rev-parse', '--short', 'HEAD'])
  return { ok: true, message: `Committed ${short.stdout.trim()}.` }
}

export async function push(run: Runner, cwd: string): Promise<ReviewAction> {
  const res = await run(cwd, 'git', ['push', '-u', 'origin', 'HEAD'], 180_000)
  return res.ok ? { ok: true, message: 'Pushed.' } : { ok: false, error: problemOf(res, 'git push failed.') }
}

/** Pushes the branch, then opens a pull request into `base` (the default branch unless chosen); returns its link. */
export async function createPullRequest(run: Runner, cwd: string, req: { title: string; body: string; draft: boolean; base?: string }): Promise<ReviewAction> {
  const title = req.title.trim()
  if (!title) return { ok: false, error: 'Give the pull request a title.' }
  const pushed = await push(run, cwd)
  if (!pushed.ok) return pushed
  const base = req.base?.trim() || (await defaultBranch(run, cwd))?.name
  const args = ['pr', 'create', '--title', title, '--body', req.body.trim() || ' ']
  if (base) args.push('--base', base)
  if (req.draft) args.push('--draft')
  const res = await run(cwd, 'gh', args, 120_000)
  if (!res.ok) return { ok: false, error: problemOf(res, 'gh pr create failed.') }
  const url = res.stdout.trim().split('\n').filter((l) => /^https?:\/\//.test(l.trim())).pop()?.trim()
  return { ok: true, message: 'Pull request opened.', ...(url ? { url } : {}) }
}

export async function mergePullRequest(run: Runner, cwd: string, method: 'squash' | 'merge' | 'rebase'): Promise<ReviewAction> {
  // No --delete-branch: the branch is checked out in this session's worktree.
  const res = await run(cwd, 'gh', ['pr', 'merge', `--${method}`], 120_000)
  return res.ok ? { ok: true, message: 'Merged.' } : { ok: false, error: problemOf(res, 'gh pr merge failed.') }
}

/**
 * The run behind a check: from its link when it is a GitHub Actions job or
 * run, else the branch's latest failed run of the same workflow (or name).
 */
async function runFor(run: Runner, cwd: string, check: { url: string | null; name: string; workflow: string }): Promise<{ run: string; job: string | null } | null> {
  const fromUrl = actionsRunOf(check.url)
  if (fromUrl) return fromUrl
  const branch = await run(cwd, 'git', ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (!branch.ok || !branch.stdout.trim()) return null
  const res = await run(cwd, 'gh', ['run', 'list', '--branch', branch.stdout.trim(), '--limit', '20', '--json', 'databaseId,name,workflowName,conclusion'], 20_000)
  if (!res.ok) return null
  try {
    const runs = JSON.parse(res.stdout) as { databaseId?: number; name?: string; workflowName?: string; conclusion?: string }[]
    const failed = runs.filter((r) => /failure|timed_out|startup_failure/i.test(r.conclusion ?? ''))
    const want = (check.workflow || check.name).toLowerCase()
    const match = failed.find((r) => r.workflowName?.toLowerCase() === want || r.name?.toLowerCase() === want)
    return match?.databaseId ? { run: String(match.databaseId), job: null } : null
  } catch {
    return null
  }
}

/** The end of a failed check's log: the failed steps' output, from `gh run view --log-failed`. */
export async function checkLog(run: Runner, cwd: string, check: { url: string | null; name: string; workflow: string }): Promise<ReviewLog> {
  const target = await runFor(run, cwd, check)
  if (!target) return { ok: false, error: 'This check didn’t run on GitHub Actions, so its log is only on its own page.' }
  const args = target.job ? ['run', 'view', '--job', target.job, '--log-failed'] : ['run', 'view', target.run, '--log-failed']
  const res = await run(cwd, 'gh', args, 60_000)
  if (!res.ok) return { ok: false, error: problemOf(res, 'gh couldn’t fetch the log.') }
  if (!res.stdout.trim()) return { ok: false, error: 'GitHub has no failed steps for it yet. It may still be running.' }
  return { ok: true, ...cleanRunLog(res.stdout) }
}

/** Merges the base branch in (fetched first when it is origin's), so the branch is up to date with it. */
export async function updateFromBase(run: Runner, cwd: string): Promise<ReviewAction> {
  const main = await defaultBranch(run, cwd)
  if (!main) return { ok: false, error: 'There’s no default branch to update from.' }
  if (main.ref.startsWith('origin/')) {
    const fetched = await run(cwd, 'git', ['fetch', 'origin', main.name], 180_000)
    if (!fetched.ok) return { ok: false, error: problemOf(fetched, 'git fetch failed.') }
  }
  const merged = await run(cwd, 'git', ['merge', '--no-edit', main.ref], 120_000)
  if (merged.ok) return { ok: true, message: /Already up to date/i.test(merged.stdout) ? `Already up to date with ${main.name}.` : `Merged ${main.name} in.` }
  const unmerged = await run(cwd, 'git', ['diff', '--name-only', '--diff-filter=U'])
  const count = unmerged.stdout.split('\n').filter(Boolean).length
  if (count > 0) return { ok: false, error: `Merging ${main.name} left conflicts in ${count === 1 ? 'a file' : `${count} files`}. Resolve them in the review panel.` }
  return { ok: false, error: problemOf(merged, 'git merge failed.') }
}

/** A path that is in conflict right now: the only files the resolver reads or writes. */
async function conflictedPath(run: Runner, cwd: string, file: string): Promise<string | null> {
  const { conflicted } = await conflictState(run, cwd)
  return conflicted.includes(file) ? file : null
}

/** A conflicted file's text, markers and all; over SSH for a remote session. */
export async function readConflictFile(run: Runner, cwd: string, file: string): Promise<ReviewFileText> {
  if (!(await conflictedPath(run, cwd, file))) return { ok: false, error: `${file} isn’t in conflict any more.` }
  const remote = remoteLocation(cwd)
  if (!remote) {
    try {
      return { ok: true, text: await fs.readFile(path.join(cwd, file), 'utf8') }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
  const res = await run(cwd, 'cat', ['--', file])
  return res.ok ? { ok: true, text: res.stdout } : { ok: false, error: problemOf(res, `${file} couldn’t be read.`) }
}

/** Writes the resolver's result over a conflicted file; staging it is a separate step (`markResolved`). */
export async function writeConflictFile(run: Runner, cwd: string, file: string, text: string): Promise<ReviewAction> {
  if (!(await conflictedPath(run, cwd, file))) return { ok: false, error: `${file} isn’t in conflict any more.` }
  const remote = remoteLocation(cwd)
  if (!remote) {
    try {
      await fs.writeFile(path.join(cwd, file), text, 'utf8')
      return { ok: true, message: `Saved ${file}.` }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
  if (Buffer.byteLength(text) > MAX_RESOLVE_BYTES) return { ok: false, error: `${file} is too big to save from here over SSH. Ask the agent to resolve it.` }
  // The text and path travel as arguments to a fixed script, quoted by the runner.
  const res = await run(cwd, 'sh', ['-c', 'printf "%s" "$1" > "$2"', 'sh', text, file])
  return res.ok ? { ok: true, message: `Saved ${file}.` } : { ok: false, error: problemOf(res, `${file} couldn’t be saved.`) }
}

/** Stages a conflicted file once its markers are gone (git add). */
export async function markResolved(run: Runner, cwd: string, file: string): Promise<ReviewAction> {
  const read = await readConflictFile(run, cwd, file)
  if (!read.ok) return read
  if (hasConflictMarkers(read.text)) return { ok: false, error: `${file} still has conflict markers.` }
  const res = await run(cwd, 'git', ['add', '--', file])
  return res.ok ? { ok: true, message: `Marked ${file} resolved.` } : { ok: false, error: problemOf(res, 'git add failed.') }
}

/** Ends the merge (or rebase, or cherry-pick) once nothing is in conflict, with git's own message. */
export async function finishMerge(run: Runner, cwd: string): Promise<ReviewAction> {
  const { merging, conflicted } = await conflictState(run, cwd)
  if (conflicted.length) return { ok: false, error: `Resolve ${conflicted.length === 1 ? 'the conflicted file' : `the ${conflicted.length} conflicted files`} first.` }
  const args = merging === 'rebase' ? ['rebase', '--continue'] : merging === 'cherry-pick' ? ['cherry-pick', '--continue'] : ['commit', '--no-edit']
  const res = await run(cwd, 'git', args, 120_000)
  if (!res.ok) return { ok: false, error: problemOf(res, `git ${args[0]} failed.`) }
  return { ok: true, message: merging === 'rebase' ? 'Rebase continued.' : merging === 'cherry-pick' ? 'Cherry-pick finished.' : 'Merge finished.' }
}

/** Gives up on the merge (or rebase, or cherry-pick): the branch goes back to how it was before it. */
export async function abortMerge(run: Runner, cwd: string): Promise<ReviewAction> {
  const { merging } = await conflictState(run, cwd)
  if (!merging) return { ok: false, error: 'There’s no merge in progress.' }
  const res = await run(cwd, 'git', [merging, '--abort'], 60_000)
  return res.ok ? { ok: true, message: `${merging === 'merge' ? 'Merge' : merging === 'rebase' ? 'Rebase' : 'Cherry-pick'} aborted.` } : { ok: false, error: problemOf(res, `git ${merging} --abort failed.`) }
}

/** Branches a pull request can go into: origin's (or the local ones when there's no origin), the default first. */
export async function baseBranches(run: Runner, cwd: string): Promise<{ default: string | null; branches: string[] }> {
  const main = await defaultBranch(run, cwd)
  const remote = await run(cwd, 'git', ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'])
  let names = remote.ok ? remote.stdout.split('\n').map((l) => l.trim().replace(/^origin\//, '')).filter((n) => n && n !== 'HEAD' && n !== 'origin') : []
  if (names.length === 0) {
    const local = await run(cwd, 'git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    names = local.ok ? local.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : []
  }
  const sorted = [...new Set(names)].sort((a, b) => (a === main?.name ? -1 : b === main?.name ? 1 : a.localeCompare(b)))
  return { default: main?.name ?? null, branches: sorted }
}

/** A title and description for the pull request from the commits the branch has that `base` doesn't. */
export async function pullRequestText(run: Runner, cwd: string, base: string): Promise<{ title: string; body: string } | { error: string }> {
  const remoteRef = `origin/${base}`
  const ref = (await run(cwd, 'git', ['rev-parse', '--verify', '--quiet', `${remoteRef}^{commit}`])).ok ? remoteRef : base
  const [log, branch] = await Promise.all([
    run(cwd, 'git', ['log', '--reverse', '--no-merges', '--format=%s', `${ref}..HEAD`]),
    run(cwd, 'git', ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  ])
  if (!log.ok) return { error: problemOf(log, 'git log failed.') }
  const subjects = log.stdout.split('\n').filter((l) => l.trim())
  if (subjects.length === 0) return { error: `This branch has no commits that ${base} doesn’t.` }
  return pullRequestFromCommits(subjects, branch.ok ? branch.stdout.trim() : null)
}
