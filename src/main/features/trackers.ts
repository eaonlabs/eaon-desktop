import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Feature } from './types'
import { store } from '../store'
import { secrets } from '../secrets'
import { adoptLoginShellPath } from '../shellEnv'
import { adeSessions, worktreesRoot } from './ade'
import * as git from './ade/git'
import { ghPrForBranch } from './linear'
import { folderName, worktreeFolderFor } from '@shared/adeSessions'
import { ISSUE_FILE } from '@shared/linear'
import {
  STATUS_COLORS,
  adfToText,
  categoryOf,
  githubBranch,
  isJiraKey,
  jiraBranch,
  jiraSite,
  parseGithubId,
  reviewTransition,
  startTransition,
  trackerPrompt,
  trackerTask,
  type JiraCredentials,
  type JiraTransition,
  type TrackerId,
  type TrackerIssue,
  type TrackerIssuesResult,
  type TrackerStartResult,
  type TrackerStatus
} from '@shared/trackers'

/**
 * Jira and GitHub issues as ADE sessions (shared/trackers.ts). Jira Cloud's
 * REST API with the person's own API token (kept in the encrypted vault, sent
 * only to the site they named); GitHub through the `gh` they are signed in
 * with, which Eaon never reads a token from. Nothing is sent but what each
 * action says: reading their issues, moving a Jira issue when work starts or
 * its pull request opens, and linking that pull request.
 */

const JIRA_VAULT_KEY = 'jira'
const LINKS_FILE = 'tracker-sessions.json'
const ISSUE_LIMIT = 75

class TrackerError extends Error {}

/* ------------------------------------------------------------------ links */

/** An issue's session, and whether its pull request has been linked. */
interface Link {
  tracker: TrackerId
  id: string
  cwd: string
  root: string
  branch: string
  pr: string | null
}
type Links = Record<string, Link>
const linkKey = (tracker: TrackerId, id: string): string => `${tracker}:${id}`
const loadLinks = (): Links => store.getJson<Links>(LINKS_FILE, {}) ?? {}
const saveLinks = (links: Links): void => store.setJson(LINKS_FILE, links)

function sessionsFor(tracker: TrackerId): Record<string, string> {
  const sessions: Record<string, string> = {}
  for (const link of Object.values(loadLinks())) if (link.tracker === tracker && fs.existsSync(link.cwd)) sessions[link.id] = link.cwd
  return sessions
}

/* ------------------------------------------------------------------- Jira */

const jiraBase = (site: string): string => process.env.EAON_JIRA_API || site

function jiraCredentials(): JiraCredentials | null {
  const raw = secrets.get(JIRA_VAULT_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<JiraCredentials>
    const site = jiraSite(parsed.site)
    return site && parsed.email && parsed.token ? { site, email: parsed.email, token: parsed.token } : null
  } catch {
    return null
  }
}

async function jira<T>(c: JiraCredentials, method: string, route: string, body?: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${jiraBase(c.site)}/rest/api/3${route}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${c.email}:${c.token}`).toString('base64')}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
      // The token goes to the site named and nowhere else, not through a redirect.
      redirect: 'error'
    })
  } catch {
    throw new TrackerError('Jira didn’t answer. Check the site address and your connection, and try again.')
  }
  if (response.status === 401) throw new TrackerError('Jira didn’t accept that email and API token. Make a new token and connect again.')
  if (response.status === 403) throw new TrackerError('Jira says this account can’t do that.')
  if (!response.ok) {
    const json = (await response.json().catch(() => null)) as { errorMessages?: string[]; errors?: Record<string, string> } | null
    throw new TrackerError(json?.errorMessages?.[0] ?? Object.values(json?.errors ?? {})[0] ?? `Jira answered ${response.status}.`)
  }
  if (response.status === 204) return undefined as T
  return (await response.json().catch(() => undefined)) as T
}

interface RawJiraIssue {
  key: string
  fields: {
    summary?: string
    description?: unknown
    updated?: string
    labels?: string[]
    status?: { name?: string; statusCategory?: { key?: string } }
    priority?: { name?: string } | null
    project?: { key?: string; name?: string }
  }
}

function jiraIssue(site: string, raw: RawJiraIssue): TrackerIssue {
  const f = raw.fields
  const category = categoryOf(f.status?.statusCategory?.key)
  const title = f.summary ?? ''
  return {
    tracker: 'jira',
    id: raw.key,
    key: raw.key,
    title,
    description: adfToText(f.description),
    url: `${site}/browse/${raw.key}`,
    branchName: jiraBranch(raw.key, title),
    priorityLabel: f.priority?.name ?? '',
    status: { name: f.status?.name ?? '', category, color: STATUS_COLORS[category] },
    group: { id: f.project?.key ?? raw.key.split('-')[0], name: f.project?.name ?? f.project?.key ?? raw.key.split('-')[0] },
    labels: f.labels ?? [],
    updatedAt: f.updated ?? ''
  }
}

const JIRA_FIELDS = 'summary,description,status,priority,project,labels,updated'

async function jiraStatus(): Promise<TrackerStatus> {
  const c = jiraCredentials()
  if (!c) return { connected: false, user: null, error: null }
  try {
    const me = await jira<{ displayName: string; emailAddress?: string }>(c, 'GET', '/myself')
    return { connected: true, user: { name: me.displayName, email: me.emailAddress ?? c.email }, site: c.site, error: null }
  } catch (error) {
    return { connected: true, user: null, site: c.site, error: (error as Error).message }
  }
}

async function jiraConnect(raw: unknown): Promise<TrackerStatus> {
  const input = (raw ?? {}) as Partial<Record<keyof JiraCredentials, unknown>>
  const site = jiraSite(input.site)
  const email = typeof input.email === 'string' ? input.email.trim() : ''
  const token = typeof input.token === 'string' ? input.token.trim() : ''
  if (!site) return { connected: false, user: null, error: 'That doesn’t look like a Jira Cloud address. It’s the one you sign in at, like acme.atlassian.net.' }
  if (!/^\S+@\S+\.\S+$/.test(email)) return { connected: false, user: null, error: 'Enter the email address of your Atlassian account.' }
  if (token.length < 8) return { connected: false, user: null, error: 'Paste the API token you made in your Atlassian account.' }
  const c = { site, email, token }
  try {
    const me = await jira<{ displayName: string; emailAddress?: string }>(c, 'GET', '/myself')
    secrets.set(JIRA_VAULT_KEY, JSON.stringify(c))
    return { connected: true, user: { name: me.displayName, email: me.emailAddress ?? email }, site, error: null }
  } catch (error) {
    return { connected: false, user: null, error: (error as Error).message }
  }
}

function jiraDisconnect(): TrackerStatus {
  secrets.clear(JIRA_VAULT_KEY)
  return { connected: false, user: null, error: null }
}

async function jiraIssues(): Promise<TrackerIssuesResult> {
  const c = jiraCredentials()
  if (!c) return { ok: false, error: 'Connect Jira first.' }
  try {
    const jql = encodeURIComponent('assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC')
    const data = await jira<{ issues?: RawJiraIssue[] }>(c, 'GET', `/search/jql?jql=${jql}&fields=${JIRA_FIELDS}&maxResults=${ISSUE_LIMIT}`)
    return { ok: true, issues: (data.issues ?? []).map((i) => jiraIssue(c.site, i)), sessions: sessionsFor('jira') }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

async function jiraTransitions(c: JiraCredentials, key: string): Promise<JiraTransition[]> {
  const data = await jira<{ transitions?: { id: string; name: string; to?: { name?: string; statusCategory?: { key?: string } } }[] }>(c, 'GET', `/issue/${key}/transitions`)
  return (data.transitions ?? []).map((t) => ({ id: t.id, name: t.name, to: { name: t.to?.name ?? t.name, category: t.to?.statusCategory?.key ?? '' } }))
}

async function jiraMove(c: JiraCredentials, key: string, pick: (list: JiraTransition[]) => JiraTransition | null): Promise<string | null> {
  const transition = pick(await jiraTransitions(c, key))
  if (!transition) return null
  await jira(c, 'POST', `/issue/${key}/transitions`, { transition: { id: transition.id } })
  return transition.to.name
}

/* ----------------------------------------------------------------- GitHub */

function gh(args: string[], cwd?: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn('gh', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GH_PROMPT_DISABLED: '1' } })
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += String(d)))
    child.stderr.on('data', (d) => (err += String(d)))
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, out, err: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'ENOENT' : String(error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, out, err })
    })
  })
}

const GH_MISSING = 'The GitHub CLI isn’t installed. Install it from cli.github.com, then run “gh auth login” in a terminal.'
const GH_SIGNED_OUT = 'The GitHub CLI isn’t signed in. Run “gh auth login” in a terminal, then try again.'

async function githubStatus(): Promise<TrackerStatus> {
  await adoptLoginShellPath()
  const me = await gh(['api', 'user', '--jq', '.login'])
  if (me.err === 'ENOENT') return { connected: false, user: null, error: GH_MISSING }
  if (me.code !== 0) return { connected: false, user: null, error: GH_SIGNED_OUT }
  return { connected: true, user: { name: me.out.trim(), email: '' }, error: null }
}

interface RawGhIssue {
  number: number
  title: string
  body?: string | null
  url: string
  updatedAt?: string
  repository?: { nameWithOwner?: string; name?: string }
  labels?: { name: string }[]
}

function githubIssue(raw: RawGhIssue): TrackerIssue {
  const repo = raw.repository?.nameWithOwner ?? raw.url.replace(/^https:\/\/github\.com\//, '').replace(/\/issues\/\d+.*$/, '')
  return {
    tracker: 'github',
    id: `${repo}#${raw.number}`,
    key: `#${raw.number}`,
    title: raw.title,
    description: raw.body ?? '',
    url: raw.url,
    branchName: githubBranch(raw.number, raw.title),
    priorityLabel: '',
    status: { name: 'Open', category: 'todo', color: STATUS_COLORS.doing },
    group: { id: repo, name: repo },
    labels: (raw.labels ?? []).map((l) => l.name),
    updatedAt: raw.updatedAt ?? ''
  }
}

async function githubIssues(): Promise<TrackerIssuesResult> {
  await adoptLoginShellPath()
  const result = await gh(['search', 'issues', '--assignee', '@me', '--state', 'open', '--limit', String(ISSUE_LIMIT), '--json', 'number,title,body,url,repository,labels,updatedAt'])
  if (result.err === 'ENOENT') return { ok: false, error: GH_MISSING }
  if (result.code !== 0) return { ok: false, error: /auth|login|token/i.test(result.err) ? GH_SIGNED_OUT : `GitHub answered: ${result.err.trim().slice(0, 200) || 'an error'}` }
  try {
    const raw = JSON.parse(result.out) as RawGhIssue[]
    const issues = raw.map(githubIssue).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return { ok: true, issues, sessions: sessionsFor('github') }
  } catch {
    return { ok: false, error: 'GitHub’s answer couldn’t be read.' }
  }
}

/** The issue as the start needs it: its text now, not as the list showed it earlier. */
async function githubOne(id: string): Promise<TrackerIssue> {
  const parsed = parseGithubId(id)
  if (!parsed) throw new TrackerError('That isn’t a GitHub issue.')
  const result = await gh(['issue', 'view', String(parsed.number), '--repo', parsed.repo, '--json', 'number,title,body,url,labels,updatedAt'])
  if (result.code !== 0) throw new TrackerError(`GitHub didn’t give the issue: ${result.err.trim().slice(0, 200) || 'an error'}`)
  const raw = JSON.parse(result.out) as RawGhIssue
  return githubIssue({ ...raw, repository: { nameWithOwner: parsed.repo } })
}

/* ---------------------------------------------------------------- one flow */

async function jiraOne(c: JiraCredentials, key: string): Promise<TrackerIssue> {
  const raw = await jira<RawJiraIssue>(c, 'GET', `/issue/${key}?fields=${JIRA_FIELDS}`)
  return jiraIssue(c.site, raw)
}

async function start(tracker: TrackerId, idRaw: unknown, projectRaw: unknown): Promise<TrackerStartResult> {
  if (typeof idRaw !== 'string' || typeof projectRaw !== 'string') return { ok: false, error: 'Pick an issue and a project.' }
  try {
    await adoptLoginShellPath()
    let creds: JiraCredentials | null = null
    let issue: TrackerIssue
    if (tracker === 'jira') {
      creds = jiraCredentials()
      if (!creds) return { ok: false, error: 'Connect Jira first.' }
      if (!isJiraKey(idRaw)) return { ok: false, error: 'That isn’t a Jira issue.' }
      issue = await jiraOne(creds, idRaw)
    } else {
      issue = await githubOne(idRaw)
    }
    const repo = await git.repoInfo(path.resolve(projectRaw))
    if (!repo) return { ok: false, error: `${folderName(projectRaw)} isn’t a git repository, so the issue can’t have a branch of its own there.` }
    const links = loadLinks()
    const lk = linkKey(tracker, issue.id)
    const known = links[lk]
    const branch = issue.branchName
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
    fs.writeFileSync(path.join(dir, ISSUE_FILE), trackerTask(issue))
    const session = await adeSessions().track(dir, `${issue.key} ${issue.title}`, true)
    links[lk] = { tracker, id: issue.id, cwd: dir, root: repo.root, branch, pr: known?.pr ?? null }
    saveLinks(links)
    // Moved on only from before work started; an issue already in progress or in review stays where it is.
    const moved = creds && issue.status.category === 'todo' ? await jiraMove(creds, issue.id, startTransition).catch(() => null) : null
    return { ok: true, session, prompt: trackerPrompt(issue), moved }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}

let syncing = false

/** Each started Jira issue whose branch now has a pull request: the PR linked on the issue, and the issue moved to review. GitHub links its own by "Closes #n". */
async function sync(): Promise<void> {
  const c = jiraCredentials()
  if (!c || syncing) return
  syncing = true
  try {
    await adoptLoginShellPath()
    const links = loadLinks()
    for (const [lk, link] of Object.entries(links)) {
      if (link.tracker !== 'jira' || link.pr || !fs.existsSync(link.root)) continue
      const pr = await ghPrForBranch(link.root, link.branch)
      if (!pr) continue
      try {
        await jira(c, 'POST', `/issue/${link.id}/remotelink`, { globalId: pr.url, object: { url: pr.url, title: pr.title || pr.url } })
        const now = await jira<RawJiraIssue>(c, 'GET', `/issue/${link.id}?fields=status`)
        if (now.fields.status?.statusCategory?.key === 'indeterminate' && !/review/i.test(now.fields.status.name ?? '')) await jiraMove(c, link.id, reviewTransition).catch(() => null)
        links[lk] = { ...link, pr: pr.url }
        saveLinks(links)
      } catch (error) {
        console.error(`[trackers] could not link ${pr.url} to ${link.id}:`, error)
      }
    }
  } finally {
    syncing = false
  }
}

const isTracker = (value: unknown): value is TrackerId => value === 'jira' || value === 'github'
const unknownTracker = (): { ok: false; error: string } => ({ ok: false, error: 'Unknown issue tracker.' })

export const trackersFeature: Feature = {
  id: 'trackers',
  register: ({ ipcMain }) => {
    ipcMain.handle('trackers:status', (_e, tracker: unknown) => (tracker === 'jira' ? jiraStatus() : tracker === 'github' ? githubStatus() : { connected: false, user: null, error: 'Unknown issue tracker.' }))
    ipcMain.handle('trackers:connect', (_e, tracker: unknown, input: unknown) =>
      tracker === 'jira' ? jiraConnect(input) : tracker === 'github' ? githubStatus() : { connected: false, user: null, error: 'Unknown issue tracker.' }
    )
    ipcMain.handle('trackers:disconnect', (_e, tracker: unknown) => (tracker === 'jira' ? jiraDisconnect() : { connected: tracker === 'github', user: null, error: null }))
    ipcMain.handle('trackers:issues', (_e, tracker: unknown): Promise<TrackerIssuesResult> | { ok: false; error: string } =>
      tracker === 'jira' ? jiraIssues() : tracker === 'github' ? githubIssues() : unknownTracker()
    )
    ipcMain.handle('trackers:start', (_e, tracker: unknown, id: unknown, project: unknown): Promise<TrackerStartResult> | { ok: false; error: string } =>
      isTracker(tracker) ? start(tracker, id, project) : unknownTracker()
    )
    ipcMain.handle('trackers:sync', () => sync())
    // A pull request opened from a terminal is noticed without the Issues page being open.
    setInterval(() => void sync().catch(() => undefined), 10 * 60_000).unref?.()
  }
}
