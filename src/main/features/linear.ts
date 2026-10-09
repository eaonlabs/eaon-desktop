import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Feature } from './types'
import { store } from '../store'
import { secrets } from '../secrets'
import { adoptLoginShellPath } from '../shellEnv'
import { adeSessions, worktreesRoot } from './ade'
import * as git from './ade/git'
import { folderName, worktreeFolderFor } from '@shared/adeSessions'
import {
  ISSUE_FILE,
  issuePrompt,
  issueTask,
  reviewState,
  startedState,
  type LinearIssue,
  type LinearIssuesResult,
  type LinearState,
  type LinearStatus,
  type StartIssueResult
} from '@shared/linear'

/**
 * Linear issues as ADE sessions (shared/linear.ts), over Linear's GraphQL
 * API with the person's own API key. Nothing is sent to Linear but what each
 * action says: reading their issues, moving one when work starts or its pull
 * request opens, and linking that pull request.
 */

const VAULT_KEY = 'linear'
const LINKS_FILE = 'linear-sessions.json'
const endpoint = (): string => process.env.EAON_LINEAR_API || 'https://api.linear.app/graphql'

class LinearError extends Error {}

async function gql<T>(key: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(endpoint(), {
      method: 'POST',
      // A personal API key goes as it is, without "Bearer".
      headers: { Authorization: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20_000)
    })
  } catch {
    throw new LinearError('Linear didn’t answer. Check your connection and try again.')
  }
  if (response.status === 401 || response.status === 403) throw new LinearError('Linear didn’t accept the API key. Make a new one in Linear → Settings → Security & access, and connect again.')
  const json = (await response.json().catch(() => null)) as { data?: T; errors?: { message?: string }[] } | null
  if (!json) throw new LinearError(`Linear answered ${response.status}.`)
  if (json.errors?.length) throw new LinearError(json.errors[0]?.message ?? 'Linear returned an error.')
  return json.data as T
}

const ISSUE_FIELDS = `id identifier title description url branchName priority priorityLabel updatedAt
  state { name type color } team { id key name }`

const normalize = (raw: Partial<LinearIssue>): LinearIssue => ({
  id: String(raw.id),
  identifier: String(raw.identifier),
  title: raw.title ?? '',
  description: raw.description ?? '',
  url: raw.url ?? '',
  branchName: raw.branchName ?? '',
  priority: typeof raw.priority === 'number' ? raw.priority : 0,
  priorityLabel: raw.priorityLabel ?? '',
  state: { name: raw.state?.name ?? '', type: raw.state?.type ?? '', color: raw.state?.color ?? '#888888' },
  team: { id: raw.team?.id ?? '', key: raw.team?.key ?? '', name: raw.team?.name ?? '' },
  updatedAt: raw.updatedAt ?? ''
})

/* ------------------------------------------------------------------ links */

/** An issue's session, and whether its pull request has been linked. */
interface Link {
  identifier: string
  cwd: string
  root: string
  branch: string
  pr: string | null
}
type Links = Record<string, Link>
const loadLinks = (): Links => store.getJson<Links>(LINKS_FILE, {}) ?? {}
const saveLinks = (links: Links): void => store.setJson(LINKS_FILE, links)

/* ------------------------------------------------------------------ actions */

let who: LinearStatus['user'] = null

async function status(): Promise<LinearStatus> {
  const key = secrets.get(VAULT_KEY)
  if (!key) return { connected: false, user: null, error: null }
  if (who) return { connected: true, user: who, error: null }
  try {
    const data = await gql<{ viewer: { name: string; email: string } }>(key, 'query { viewer { name email } }')
    who = { name: data.viewer.name, email: data.viewer.email }
    return { connected: true, user: who, error: null }
  } catch (error) {
    return { connected: true, user: null, error: (error as Error).message }
  }
}

async function connect(raw: unknown): Promise<LinearStatus> {
  const key = typeof raw === 'string' ? raw.trim() : ''
  if (!/^lin_api_[A-Za-z0-9]{20,}$/.test(key)) return { connected: false, user: null, error: 'That doesn’t look like a Linear API key (they start with lin_api_).' }
  try {
    const data = await gql<{ viewer: { name: string; email: string } }>(key, 'query { viewer { name email } }')
    secrets.set(VAULT_KEY, key)
    who = { name: data.viewer.name, email: data.viewer.email }
    return { connected: true, user: who, error: null }
  } catch (error) {
    return { connected: false, user: null, error: (error as Error).message }
  }
}

function disconnect(): LinearStatus {
  secrets.clear(VAULT_KEY)
  who = null
  return { connected: false, user: null, error: null }
}

async function issues(): Promise<LinearIssuesResult> {
  const key = secrets.get(VAULT_KEY)
  if (!key) return { ok: false, error: 'Connect Linear first.' }
  try {
    const data = await gql<{ viewer: { assignedIssues: { nodes: Partial<LinearIssue>[] } } }>(
      key,
      `query { viewer { assignedIssues(first: 75, orderBy: updatedAt, filter: { state: { type: { nin: ["completed", "canceled"] } } }) { nodes { ${ISSUE_FIELDS} } } } }`
    )
    const links = loadLinks()
    const sessions: Record<string, string> = {}
    for (const [id, link] of Object.entries(links)) if (fs.existsSync(link.cwd)) sessions[id] = link.cwd
    return { ok: true, issues: data.viewer.assignedIssues.nodes.map(normalize), sessions }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

async function moveTo(key: string, issueId: string, state: LinearState | null): Promise<string | null> {
  if (!state) return null
  await gql(key, 'mutation($id: String!, $state: String!) { issueUpdate(id: $id, input: { stateId: $state }) { success } }', { id: issueId, state: state.id })
  return state.name
}

async function start(issueId: unknown, projectRaw: unknown): Promise<StartIssueResult> {
  const key = secrets.get(VAULT_KEY)
  if (!key) return { ok: false, error: 'Connect Linear first.' }
  if (typeof issueId !== 'string' || typeof projectRaw !== 'string') return { ok: false, error: 'Pick an issue and a project.' }
  try {
    await adoptLoginShellPath()
    const data = await gql<{ issue: Partial<LinearIssue> & { team: { id: string; key: string; name: string; states: { nodes: LinearState[] } } } }>(
      key,
      `query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} team { id key name states { nodes { id name type position } } } } }`,
      { id: issueId }
    )
    const issue = normalize(data.issue)
    const repo = await git.repoInfo(path.resolve(projectRaw))
    if (!repo) return { ok: false, error: `${folderName(projectRaw)} isn’t a git repository, so the issue can’t have a branch of its own there.` }
    const branch = issue.branchName || `${issue.identifier.toLowerCase()}`
    const links = loadLinks()
    const known = links[issue.id]
    let dir = known && fs.existsSync(known.cwd) ? known.cwd : path.join(worktreesRoot(), worktreeFolderFor(folderName(repo.root)), worktreeFolderFor(branch))
    if (!known || !fs.existsSync(known.cwd)) {
      if (fs.existsSync(dir)) dir = `${dir}-${Date.now().toString(36)}`
      fs.mkdirSync(path.dirname(dir), { recursive: true })
      if (await git.branchExists(repo.root, branch)) await git.addWorktreeOn(repo.root, dir, branch)
      else await git.addWorktree(repo.root, dir, branch)
    }
    const exclude = path.join(await git.commonDir(dir), 'info', 'exclude')
    const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : ''
    if (!current.split('\n').some((line) => line.trim() === '.eaon/')) fs.appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}# Eaon's notes\n.eaon/\n`)
    fs.mkdirSync(path.join(dir, '.eaon'), { recursive: true })
    fs.writeFileSync(path.join(dir, ISSUE_FILE), issueTask(issue))
    const session = await adeSessions().track(dir, `${issue.identifier} ${issue.title}`, true)
    links[issue.id] = { identifier: issue.identifier, cwd: dir, root: repo.root, branch, pr: known?.pr ?? null }
    saveLinks(links)
    // Moved on only from before work started; an issue already in progress or in review stays where it is.
    const moved = ['triage', 'backlog', 'unstarted'].includes(issue.state.type) ? await moveTo(key, issue.id, startedState(data.issue.team.states.nodes)).catch(() => null) : null
    return { ok: true, session, prompt: issuePrompt(issue), moved }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

/* ------------------------------------------------------------------ pull requests */

function ghPrForBranch(root: string, branch: string): Promise<{ url: string; title: string } | null> {
  return new Promise((resolve) => {
    const child = spawn('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'url,title', '--limit', '1'], {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GH_PROMPT_DISABLED: '1' }
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.on('close', () => clearTimeout(timer))
    let out = ''
    child.stdout.on('data', (d) => (out += String(d)))
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      try {
        resolve(code === 0 ? ((JSON.parse(out) as { url: string; title: string }[])[0] ?? null) : null)
      } catch {
        resolve(null)
      }
    })
  })
}

let syncing = false

/** Each started issue whose branch now has a pull request: the PR linked on the issue, and the issue moved to review. */
async function sync(): Promise<void> {
  const key = secrets.get(VAULT_KEY)
  if (!key || syncing) return
  syncing = true
  try {
    await adoptLoginShellPath()
    const links = loadLinks()
    for (const [issueId, link] of Object.entries(links)) {
      if (link.pr || !fs.existsSync(link.root)) continue
      const pr = await ghPrForBranch(link.root, link.branch)
      if (!pr) continue
      try {
        await gql(key, 'mutation($id: String!, $url: String!, $title: String) { attachmentLinkURL(issueId: $id, url: $url, title: $title) { success } }', {
          id: issueId,
          url: pr.url,
          title: pr.title
        })
        const data = await gql<{ issue: { state: { type: string; name: string }; team: { states: { nodes: LinearState[] } } } }>(
          key,
          'query($id: String!) { issue(id: $id) { state { type name } team { states { nodes { id name type position } } } } }',
          { id: issueId }
        )
        if (data.issue.state.type === 'started' && !/review/i.test(data.issue.state.name)) await moveTo(key, issueId, reviewState(data.issue.team.states.nodes))
        links[issueId] = { ...link, pr: pr.url }
        saveLinks(links)
      } catch (error) {
        console.error(`[linear] could not link ${pr.url} to ${link.identifier}:`, error)
      }
    }
  } finally {
    syncing = false
  }
}

export const linearFeature: Feature = {
  id: 'linear',
  register: ({ ipcMain }) => {
    ipcMain.handle('linear:status', () => status())
    ipcMain.handle('linear:connect', (_e, key: unknown) => connect(key))
    ipcMain.handle('linear:disconnect', () => disconnect())
    ipcMain.handle('linear:issues', () => issues())
    ipcMain.handle('linear:start', (_e, issueId: unknown, project: unknown) => start(issueId, project))
    ipcMain.handle('linear:sync', () => sync())
    // A pull request opened from a terminal is noticed without the Linear page being open.
    setInterval(() => void sync().catch(() => undefined), 10 * 60_000).unref?.()
  }
}
