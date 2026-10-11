import { parseUnifiedDiff, prFromGh, type ReviewAction, type ReviewFile, type ReviewResult } from '@shared/adeReview'
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
const PR_FIELDS = 'number,title,url,state,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup'

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

async function github(run: Runner, cwd: string): Promise<Pick<Extract<ReviewResult, { ok: true }>['state'], 'github' | 'githubProblem'>> {
  const res = await run(cwd, 'gh', ['pr', 'view', '--json', PR_FIELDS], 20_000)
  if (res.ok) {
    try {
      return { github: { pr: prFromGh(JSON.parse(res.stdout)) } }
    } catch {
      return { github: { pr: null } }
    }
  }
  const said = `${res.stderr}\n${res.stdout}`
  if (/no (open )?pull requests? found/i.test(said)) return { github: { pr: null } }
  if (res.code === null && /isn’t installed|not found|command not found/i.test(said)) {
    return { github: null, githubProblem: 'Install the GitHub CLI (gh) and sign in with gh auth login to open pull requests from here.' }
  }
  if (/command not found|No such file/i.test(said)) return { github: null, githubProblem: 'The GitHub CLI (gh) isn’t installed there.' }
  if (/gh auth login|not logged in|authentication/i.test(said)) return { github: null, githubProblem: 'Sign in to the GitHub CLI first: run gh auth login in a terminal.' }
  if (/none of the git remotes|no git remotes|not a git repository/i.test(said)) return { github: null, githubProblem: 'This repository has no GitHub remote.' }
  return { github: null, githubProblem: problemOf(res, 'GitHub couldn’t be asked about a pull request.') }
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

  const [diff, untracked, ahead, status, upstream, gh] = await Promise.all([
    run(cwd, 'git', ['diff', mergeBase, '--no-color', '--no-ext-diff', '-M', '-U3', '--']),
    untrackedDiffs(run, cwd),
    run(cwd, 'git', ['rev-list', '--count', `${mergeBase}..HEAD`]),
    run(cwd, 'git', ['status', '--porcelain']),
    run(cwd, 'git', ['rev-list', '--left-right', '--count', '@{u}...HEAD']),
    github(run, cwd)
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

/** Pushes the branch, then opens a pull request into the default branch; returns its link. */
export async function createPullRequest(run: Runner, cwd: string, req: { title: string; body: string; draft: boolean }): Promise<ReviewAction> {
  const title = req.title.trim()
  if (!title) return { ok: false, error: 'Give the pull request a title.' }
  const pushed = await push(run, cwd)
  if (!pushed.ok) return pushed
  const main = await defaultBranch(run, cwd)
  const args = ['pr', 'create', '--title', title, '--body', req.body.trim() || ' ']
  if (main) args.push('--base', main.name)
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
