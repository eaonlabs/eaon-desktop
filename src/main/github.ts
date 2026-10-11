import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import type { PullRequestAction, PullRequestDetail, PullRequestsResult, PullRequestSummary } from '@shared/types'

/**
 * Pull requests for the "Pull requests" nav item in Eaon Work, sourced from
 * the `gh` CLI already installed/authenticated on the user's machine — no
 * token handling of our own. `gh search prs` gives us cross-repo results but
 * not diff stats or the branch name, so each hit is enriched with a second
 * `gh pr view` call.
 */

const execFileAsync = promisify(execFile)
/**
 * `gh` waits on the network with no limit of its own; a stalled call would
 * leave the page's spinner up forever. On timeout the child is killed and the
 * call rejects like any other gh error.
 */
const GH_TIMEOUT_MS = 30_000
/** The GitHub CLI: the user's own. EAON_GH_BIN swaps in a stand-in for the end-to-end tests. */
const gh = (): string => process.env.EAON_GH_BIN || 'gh'
const run = (file: string, args: string[]): Promise<{ stdout: string }> =>
  // windowsHide: every call would otherwise flash a console window on Windows.
  execFileAsync(file, args, { timeout: GH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true })

interface SearchRow {
  repository: { nameWithOwner: string }
  number: number
  title: string
  updatedAt: string
  state: string
  isDraft: boolean
  url: string
}

const SEARCH_FIELDS = 'repository,number,title,updatedAt,state,isDraft,url'
const DETAIL_FIELDS = 'additions,deletions,headRefName'
const ENRICH_CONCURRENCY = 6

async function searchPrs(filter: string): Promise<SearchRow[]> {
  const { stdout } = await run(gh(), [
    'search',
    'prs',
    filter,
    '--json',
    SEARCH_FIELDS,
    '--sort',
    'updated',
    '--limit',
    '30'
  ])
  return JSON.parse(stdout) as SearchRow[]
}

async function enrichOne(row: SearchRow): Promise<PullRequestSummary | null> {
  try {
    const { stdout } = await run(gh(), ['pr', 'view', row.url, '--json', DETAIL_FIELDS])
    const detail = JSON.parse(stdout) as { additions: number; deletions: number; headRefName: string }
    return {
      id: row.url,
      title: row.title,
      repo: row.repository.nameWithOwner,
      branch: detail.headRefName,
      url: row.url,
      updatedAt: row.updatedAt,
      additions: detail.additions,
      deletions: detail.deletions,
      state: row.isDraft ? 'draft' : (row.state as PullRequestSummary['state'])
    }
  } catch {
    // A PR the search API can see but `gh pr view` can't (rare — e.g. a repo
    // access edge case) shouldn't blank the whole list; just drop that one.
    return null
  }
}

async function enrichAll(rows: SearchRow[]): Promise<PullRequestSummary[]> {
  const results: PullRequestSummary[] = []
  for (let i = 0; i < rows.length; i += ENRICH_CONCURRENCY) {
    const batch = rows.slice(i, i + ENRICH_CONCURRENCY)
    for (const item of await Promise.all(batch.map(enrichOne))) {
      if (item) results.push(item)
    }
  }
  return results
}

function describeGhError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/ENOENT/i.test(message)) return 'GitHub CLI (gh) is not installed.'
  if (/gh auth login|not logged into|authentication/i.test(message)) {
    return 'Not signed in to GitHub CLI. Run "gh auth login" in a terminal.'
  }
  if ((error as { killed?: boolean }).killed) return 'GitHub didn’t answer in time. Check your connection and try again.'
  return message.split('\n')[0]
}

export async function listPullRequests(): Promise<PullRequestsResult> {
  try {
    const [authoredRows, reviewingRows] = await Promise.all([
      searchPrs('--author=@me'),
      searchPrs('--review-requested=@me')
    ])
    const [authored, reviewing] = await Promise.all([enrichAll(authoredRows), enrichAll(reviewingRows)])
    return { authored, reviewing, error: null }
  } catch (error) {
    return { authored: [], reviewing: [], error: describeGhError(error) }
  }
}

/* ------------------------------------------------ one pull request (detail tabs) */

const PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/

/** Only ever a pull request's own address: nothing from the page reaches `gh` as anything else. */
function prUrl(value: unknown): string {
  const url = String(value ?? '')
  if (!PR_URL.test(url)) throw new Error('That isn’t a GitHub pull request address.')
  return url
}

/**
 * `gh` run outside any repository (the home folder), so acting on a pull
 * request by its address never switches or deletes a branch checked out here.
 */
const runGh = (args: string[], timeout = GH_TIMEOUT_MS): Promise<{ stdout: string }> =>
  execFileAsync(gh(), args, { timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true, cwd: homedir(), env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' } })

const DETAIL_VIEW_FIELDS =
  'number,title,body,author,state,isDraft,baseRefName,headRefName,additions,deletions,changedFiles,createdAt,updatedAt,mergeable,mergeStateStatus,reviewDecision,latestReviews,statusCheckRollup,url'

function checkStatus(c: Record<string, unknown>): PullRequestDetail['checks'][number]['status'] {
  const word = String(c.conclusion || c.state || '').toUpperCase()
  if (word === 'SUCCESS' || word === 'NEUTRAL') return 'passed'
  if (word === 'SKIPPED') return 'skipped'
  if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(word)) return 'failed'
  return 'pending'
}

export async function pullRequestDetail(url: unknown): Promise<PullRequestDetail> {
  const address = prUrl(url)
  const repo = address.split('/').slice(3, 5).join('/')
  const [view, settings] = await Promise.all([
    runGh(['pr', 'view', address, '--json', DETAIL_VIEW_FIELDS]),
    runGh(['repo', 'view', repo, '--json', 'squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed,deleteBranchOnMerge']).catch(() => null)
  ])
  const v = JSON.parse(view.stdout) as Record<string, any>
  const s = settings ? (JSON.parse(settings.stdout) as Record<string, boolean>) : null
  const state = String(v.state).toLowerCase()
  return {
    url: address,
    number: v.number,
    title: v.title,
    body: v.body ?? '',
    repo,
    author: v.author?.login ?? '',
    state: v.isDraft && state === 'open' ? 'draft' : (state as PullRequestDetail['state']),
    base: v.baseRefName,
    head: v.headRefName,
    additions: v.additions ?? 0,
    deletions: v.deletions ?? 0,
    changedFiles: v.changedFiles ?? 0,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    mergeable: v.mergeable ?? 'UNKNOWN',
    mergeState: v.mergeStateStatus ?? 'UNKNOWN',
    reviewDecision: v.reviewDecision ?? '',
    reviews: (v.latestReviews ?? []).map((r: any) => ({ author: r.author?.login ?? '', state: r.state ?? '' })),
    checks: (v.statusCheckRollup ?? []).map((c: any) => ({
      name: c.name || c.context || 'Check',
      status: checkStatus(c),
      url: c.detailsUrl || c.targetUrl || null
    })),
    // When GitHub won't say (no admin rights on the repo's settings), offer all three; GitHub refuses a disallowed one with its own message.
    methods: s ? { squash: s.squashMergeAllowed !== false, merge: s.mergeCommitAllowed !== false, rebase: s.rebaseMergeAllowed !== false } : { squash: true, merge: true, rebase: true },
    deletesBranch: s?.deleteBranchOnMerge === true
  }
}

/** The pull request's changes as git's unified diff (parsed on the page with shared/adeReview's parser). */
export async function pullRequestDiff(url: unknown): Promise<string> {
  return (await runGh(['pr', 'diff', prUrl(url), '--color', 'never'], 60_000)).stdout
}

function actionError(error: unknown, fallback: string): PullRequestAction {
  const e = error as { stderr?: string; killed?: boolean }
  if (e.killed) return { ok: false, error: 'GitHub didn’t answer in time.' }
  const said = String(e.stderr ?? (error instanceof Error ? error.message : '')).trim().split('\n').filter(Boolean)
  return { ok: false, error: (said.find((l) => /^(X |error|failed|GraphQL)/i.test(l)) ?? said.pop() ?? fallback).replace(/^X\s+/, '') }
}

export interface MergeOptions {
  method: 'squash' | 'merge' | 'rebase'
  deleteBranch: boolean
  /** Merge on its own once the required checks and reviews pass. */
  auto: boolean
  subject?: string
  body?: string
}

export async function mergePullRequest(url: unknown, options: MergeOptions): Promise<PullRequestAction> {
  const address = prUrl(url)
  const method = options.method === 'merge' || options.method === 'rebase' ? options.method : 'squash'
  const args = ['pr', 'merge', address, `--${method}`]
  if (options.deleteBranch) args.push('--delete-branch')
  if (options.auto) args.push('--auto')
  if (method !== 'rebase' && options.subject?.trim()) args.push('--subject', options.subject.trim().slice(0, 500))
  if (method !== 'rebase' && typeof options.body === 'string') args.push('--body', options.body.slice(0, 60_000))
  try {
    await runGh(args, 120_000)
    return { ok: true, message: options.auto ? 'It will merge once its checks and reviews pass.' : 'Merged.' }
  } catch (error) {
    return actionError(error, 'GitHub didn’t merge it.')
  }
}

export async function pullRequestAction(url: unknown, action: unknown): Promise<PullRequestAction> {
  const address = prUrl(url)
  const steps: Record<string, { args: string[]; done: string }> = {
    approve: { args: ['pr', 'review', address, '--approve'], done: 'Approved.' },
    ready: { args: ['pr', 'ready', address], done: 'Marked ready for review.' },
    draft: { args: ['pr', 'ready', address, '--undo'], done: 'Turned back into a draft.' },
    close: { args: ['pr', 'close', address], done: 'Closed.' },
    reopen: { args: ['pr', 'reopen', address], done: 'Reopened.' },
    'update-branch': { args: ['pr', 'update-branch', address], done: 'Brought up to date with its base.' },
    'disable-auto': { args: ['pr', 'merge', address, '--disable-auto'], done: 'Won’t merge on its own any more.' }
  }
  const step = steps[String(action)]
  if (!step) return { ok: false, error: 'Unknown action.' }
  try {
    await runGh(step.args, 60_000)
    return { ok: true, message: step.done }
  } catch (error) {
    return actionError(error, 'GitHub refused.')
  }
}
