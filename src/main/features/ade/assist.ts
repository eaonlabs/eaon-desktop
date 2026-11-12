import { parseUnifiedDiff, type ReviewFile } from '@shared/adeReview'
import {
  COMMIT_DIFF_CAP,
  COMMIT_SYSTEM,
  PR_DIFF_CAP,
  PR_SYSTEM,
  REVIEW_DIFF_CAP,
  REVIEW_SYSTEM,
  cleanCommitMessage,
  commitPrompt,
  describeSent,
  diffForModel,
  parseLocalReview,
  parsePrText,
  prPrompt,
  reviewPromptFor,
  type CommitMessageResult,
  type GitAssistModel,
  type LocalReviewResult,
  type PrTextResult
} from '@shared/gitAssist'
import type { AskModel } from '../../agent/askModel'
import { problemOf, type Runner } from './runner'
import { untrackedDiffs } from './review'

/**
 * The model's help with git, end to end (shared/gitAssist.ts has the prompts
 * and the reading of answers): git asked for the change, a bounded diff of it
 * sent through `ask`, and what comes back made safe to show. `run` and `ask`
 * are arguments so tests use a real repository and a stand-in model; nothing
 * here writes to the repository or to GitHub.
 */

/** git's own name for the tree with nothing in it: what a repository with no commits is compared to. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

const TEMPLATES = ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', 'docs/pull_request_template.md', 'pull_request_template.md', 'PULL_REQUEST_TEMPLATE.md']

type Changes = { ok: true; files: ReviewFile[] } | { ok: false; error: string }

/** What isn't committed, against HEAD, new files included: what Commit takes. */
export async function workingChanges(run: Runner, cwd: string): Promise<Changes> {
  const head = await run(cwd, 'git', ['rev-parse', '--verify', '--quiet', 'HEAD'], 5000)
  if (!head.ok && (head.code === null || /not a git repository/i.test(head.stderr))) return { ok: false, error: problemOf(head, 'This folder isn’t in a git repository.') }
  const [diff, untracked] = await Promise.all([
    run(cwd, 'git', ['diff', head.ok ? 'HEAD' : EMPTY_TREE, '--no-color', '--no-ext-diff', '-M', '-U3', '--'], 30_000),
    untrackedDiffs(run, cwd)
  ])
  if (!diff.ok) return { ok: false, error: problemOf(diff, 'git diff failed.') }
  return { ok: true, files: [...parseUnifiedDiff(diff.stdout), ...untracked].sort((a, b) => a.path.localeCompare(b.path)) }
}

const branchOf = async (run: Runner, cwd: string): Promise<string | null> => {
  const res = await run(cwd, 'git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], 5000)
  return res.ok ? res.stdout.trim() || null : null
}

const noAnswer = (model: GitAssistModel): { ok: false; error: string } => ({
  ok: false,
  error: `The model didn’t answer. Check that ${model.modelId} is connected (Settings → Model providers), then try again.`
})

/** A commit message for what Commit would take: every change in the folder, new files included. */
export async function writeCommitMessage(run: Runner, cwd: string, model: GitAssistModel, ask: AskModel): Promise<CommitMessageResult> {
  const changes = await workingChanges(run, cwd)
  if (!changes.ok) return changes
  if (changes.files.length === 0) return { ok: false, error: 'There are no changes to describe.' }
  const diff = diffForModel(changes.files, { cap: COMMIT_DIFF_CAP })
  const [branch, log] = await Promise.all([branchOf(run, cwd), run(cwd, 'git', ['log', '-n5', '--no-merges', '--no-color', '--format=%s'], 10_000)])
  const recent = log.ok ? log.stdout.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 5) : []
  const raw = await ask({ ...model, system: COMMIT_SYSTEM, prompt: commitPrompt({ diff, branch, recent }), outputCap: 700, cacheKey: 'eaon-commit-message' })
  if (raw === null) return noAnswer(model)
  const message = cleanCommitMessage(raw)
  if (!message) return { ok: false, error: 'The model’s answer had no message in it. Try again.' }
  return { ok: true, message, sent: describeSent(diff, { extra: recent.length ? `the last ${recent.length} commit ${recent.length === 1 ? 'subject' : 'subjects'} go too, for style` : undefined }) }
}

/** The pull request's title and description from the commits and diff the branch has that `base` doesn't. */
export async function writePullRequestText(run: Runner, cwd: string, base: string, model: GitAssistModel, ask: AskModel): Promise<PrTextResult> {
  const remoteRef = `origin/${base}`
  const ref = (await run(cwd, 'git', ['rev-parse', '--verify', '--quiet', `${remoteRef}^{commit}`], 5000)).ok ? remoteRef : base
  const [log, diffRes, branch] = await Promise.all([
    run(cwd, 'git', ['log', '--reverse', '--no-merges', '--no-color', '--format=%s', `${ref}..HEAD`], 15_000),
    run(cwd, 'git', ['diff', '--no-color', '--no-ext-diff', '-M', '-U3', `${ref}...HEAD`, '--'], 30_000),
    branchOf(run, cwd)
  ])
  if (!log.ok) return { ok: false, error: problemOf(log, 'git log failed.') }
  const commits = log.stdout.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 60)
  if (commits.length === 0) return { ok: false, error: `This branch has no commits that ${base} doesn’t.` }
  if (!diffRes.ok) return { ok: false, error: problemOf(diffRes, 'git diff failed.') }
  const diff = diffForModel(parseUnifiedDiff(diffRes.stdout), { cap: PR_DIFF_CAP })

  let template: string | null = null
  for (const file of TEMPLATES) {
    const shown = await run(cwd, 'git', ['show', `HEAD:${file}`], 5000)
    if (shown.ok && shown.stdout.trim()) {
      template = shown.stdout
      break
    }
  }
  const raw = await ask({ ...model, system: PR_SYSTEM, prompt: prPrompt({ diff, branch, base, commits, template }), outputCap: 1500, cacheKey: 'eaon-pr-text' })
  if (raw === null) return noAnswer(model)
  const text = parsePrText(raw)
  if (!text) return { ok: false, error: 'The model’s answer had no title in it. Try again.' }
  const extra = `the ${commits.length} commit ${commits.length === 1 ? 'subject' : 'subjects'}${template ? ' and the repository’s pull request template' : ''} go too`
  return { ok: true, ...text, sent: describeSent(diff, { extra }) }
}

/** A review of what isn't committed: what the model found, by file and line, for the person to act on. */
export async function reviewLocalChanges(run: Runner, cwd: string, model: GitAssistModel, ask: AskModel): Promise<LocalReviewResult> {
  const changes = await workingChanges(run, cwd)
  if (!changes.ok) return changes
  if (changes.files.length === 0) return { ok: false, error: 'There is nothing to review: no changes are uncommitted.' }
  const diff = diffForModel(changes.files, { cap: REVIEW_DIFF_CAP, numbered: true })
  const raw = await ask({
    ...model,
    system: REVIEW_SYSTEM,
    prompt: reviewPromptFor({ diff, branch: await branchOf(run, cwd) }),
    outputCap: 3500,
    effort: 'light',
    cacheKey: 'eaon-local-review',
    timeoutMs: 180_000
  })
  if (raw === null) return noAnswer(model)
  const review = parseLocalReview(raw, changes.files)
  if (!review) return { ok: false, error: 'The model’s answer was empty. Try again.' }
  return { ok: true, review, paths: changes.files.map((f) => f.path), sent: describeSent(diff) }
}
