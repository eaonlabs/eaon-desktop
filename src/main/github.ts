import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { PullRequestsResult, PullRequestSummary } from '@shared/types'

/**
 * Pull requests for the "Pull requests" nav item in Eaon Work, sourced from
 * the `gh` CLI already installed/authenticated on the user's machine — no
 * token handling of our own. `gh search prs` gives us cross-repo results but
 * not diff stats or the branch name, so each hit is enriched with a second
 * `gh pr view` call.
 */

const run = promisify(execFile)

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
  const { stdout } = await run('gh', [
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
    const { stdout } = await run('gh', ['pr', 'view', row.url, '--json', DETAIL_FIELDS])
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
