import type { AdeSession } from './adeSessions'
import { ISSUE_FILE } from './linear'

/**
 * Jira and GitHub issues as ADE sessions, beside Linear's (shared/linear.ts).
 * Jira Cloud is reached with the person's own API token; GitHub issues come
 * through the `gh` they are already signed in with, so Eaon holds nothing for
 * it. An issue's Start makes a session on a branch named for it, writes the
 * issue to ISSUE_FILE for the agent, and, for Jira, moves it to In Progress and
 * links the pull request once there is one.
 */

export type TrackerId = 'jira' | 'github'

/** To do, being worked on, or finished: all each tracker's own statuses are mapped to. */
export type StatusCategory = 'todo' | 'doing' | 'done'

export interface TrackerIssue {
  tracker: TrackerId
  /** What the tracker calls it by: "ENG-12", or "acme/widget#12". */
  id: string
  /** What the list shows: "ENG-12", or "#12". */
  key: string
  title: string
  description: string
  url: string
  /** The git branch the issue gets. */
  branchName: string
  priorityLabel: string
  status: { name: string; category: StatusCategory; color: string }
  /** Jira's project, GitHub's repository. */
  group: { id: string; name: string }
  labels: string[]
  updatedAt: string
}

export interface TrackerStatus {
  connected: boolean
  user: { name: string; email: string } | null
  /** Jira: the site the token belongs to. */
  site?: string
  error: string | null
}

export type TrackerIssuesResult =
  | { ok: true; issues: TrackerIssue[]; /** issue id → its ADE session's folder */ sessions: Record<string, string> }
  | { ok: false; error: string }

export type TrackerStartResult = { ok: true; session: AdeSession; prompt: string; moved: string | null } | { ok: false; error: string }

export interface JiraCredentials {
  site: string
  email: string
  token: string
}

export const STATUS_COLORS: Record<StatusCategory, string> = { todo: '#8a8f98', doing: '#e2a32f', done: '#4cb782' }

/* ---------------------------------------------------------------- Jira site */

/**
 * The address Jira Cloud's API lives at, from what a person types: "acme",
 * "acme.atlassian.net" or a pasted link into the site. Always https, and only
 * a host: no path, no login in the address. A scratch server on this computer
 * is allowed so the connection can be tried without Atlassian.
 */
export function jiraSite(input: unknown): string | null {
  if (typeof input !== 'string') return null
  let text = input.trim().toLowerCase()
  if (!text) return null
  if (!/^[a-z]+:\/\//.test(text)) text = /^[a-z0-9-]+$/.test(text) ? `https://${text}.atlassian.net` : `https://${text}`
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.username || url.password) return null
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null
  if (!local && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(url.hostname)) return null
  return url.origin
}

/** Jira keys look like ENG-12: project letters, a dash, a number. */
export const isJiraKey = (value: unknown): value is string => typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,19}-\d{1,9}$/.test(value)

/* ----------------------------------------------------------- Jira's text */

interface AdfNode {
  type?: string
  text?: string
  attrs?: Record<string, unknown>
  content?: AdfNode[]
}

/**
 * Jira's descriptions come as Atlassian Document Format, a tree; the agent
 * and the page want text. Paragraphs, headings, lists, code, quotes and
 * links keep their shape; media and the like say what they were.
 */
export function adfToText(doc: unknown): string {
  if (typeof doc === 'string') return doc.trim()
  const out: string[] = []
  const inline = (node: AdfNode): string => {
    switch (node.type) {
      case 'text': {
        const link = (node as { marks?: { type: string; attrs?: { href?: string } }[] }).marks?.find((m) => m.type === 'link')?.attrs?.href
        return link && link !== node.text ? `${node.text ?? ''} (${link})` : (node.text ?? '')
      }
      case 'hardBreak':
        return '\n'
      case 'mention':
        return String(node.attrs?.text ?? '@someone')
      case 'emoji':
        return String(node.attrs?.text ?? node.attrs?.shortName ?? '')
      case 'inlineCard':
        return String(node.attrs?.url ?? '')
      case 'status':
        return `[${String(node.attrs?.text ?? '')}]`
      default:
        return (node.content ?? []).map(inline).join('')
    }
  }
  const block = (node: AdfNode, indent = ''): void => {
    switch (node.type) {
      case 'paragraph':
        out.push(indent + inline(node))
        break
      case 'heading':
        out.push(`${'#'.repeat(Math.min(6, Math.max(1, Number(node.attrs?.level ?? 2))))} ${inline(node)}`)
        break
      case 'codeBlock':
        out.push('```' + String(node.attrs?.language ?? ''), inline(node), '```')
        break
      case 'blockquote':
        for (const child of node.content ?? []) {
          const lines: string[] = []
          const saved = out.length
          block(child)
          lines.push(...out.splice(saved))
          out.push(...lines.join('\n').split('\n').map((l) => `> ${l}`))
        }
        break
      case 'rule':
        out.push('---')
        break
      case 'bulletList':
      case 'orderedList':
      case 'taskList':
        ;(node.content ?? []).forEach((item, i) => {
          const marker = node.type === 'orderedList' ? `${i + 1}. ` : node.type === 'taskList' ? (item.attrs?.state === 'DONE' ? '- [x] ' : '- [ ] ') : '- '
          const [first, ...rest] = item.content ?? []
          out.push(`${indent}${marker}${first ? (first.type === 'paragraph' ? inline(first) : '') : ''}`)
          if (first && first.type !== 'paragraph') block(first, indent + '  ')
          for (const child of rest) block(child, indent + '  ')
        })
        break
      case 'mediaSingle':
      case 'mediaGroup':
        out.push('[attachment]')
        break
      case 'table':
        for (const row of node.content ?? []) out.push((row.content ?? []).map((cell) => inline({ content: (cell.content ?? []).flatMap((c) => c.content ?? []) })).join(' | '))
        break
      default:
        if (node.content) for (const child of node.content) block(child, indent)
        else if (node.text) out.push(node.text)
    }
  }
  if (!doc || typeof doc !== 'object') return ''
  block(doc as AdfNode)
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export interface JiraTransition {
  id: string
  name: string
  /** Where it leads: Jira's own "new", "indeterminate" or "done". */
  to: { name: string; category: string }
}

/** The transition that starts work: into an in-progress status that isn't a review one. */
export function startTransition(list: JiraTransition[]): JiraTransition | null {
  const going = list.filter((t) => t.to.category === 'indeterminate')
  return going.find((t) => !/review/i.test(t.to.name)) ?? going[0] ?? null
}

/** The transition for an open pull request: an in-progress status named for review, if the project has one. */
export const reviewTransition = (list: JiraTransition[]): JiraTransition | null => list.find((t) => t.to.category === 'indeterminate' && /review/i.test(t.to.name)) ?? null

export function categoryOf(jiraCategory: string | undefined): StatusCategory {
  return jiraCategory === 'done' ? 'done' : jiraCategory === 'indeterminate' ? 'doing' : 'todo'
}

/* ---------------------------------------------------------------- branches */

/** "Fix the login page!" → "fix-the-login-page". */
export function slug(text: string, max = 40): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/g, '') || 'issue'
  )
}

/** Jira's habit: the key first, so its GitHub link finds it ("eng-12-add-search"). */
export const jiraBranch = (key: string, title: string): string => `${key.toLowerCase()}-${slug(title)}`

/** "issue-12-add-search". */
export const githubBranch = (number: number, title: string): string => `issue-${number}-${slug(title)}`

/** "acme/widget#12" → its parts. */
export function parseGithubId(id: unknown): { repo: string; number: number } | null {
  if (typeof id !== 'string') return null
  const m = /^([\w.-]+\/[\w.-]+)#(\d{1,9})$/.exec(id)
  return m ? { repo: m[1], number: Number(m[2]) } : null
}

/** The issue a branch is named for, by the habits above. */
export type BranchIssue = { kind: 'jira'; key: string } | { kind: 'github'; number: number }

/** Branch words that look like a key ("release-2026", "v2-3") but aren't one. */
const NOT_A_PROJECT = new Set(['release', 'rel', 'v', 'version', 'hotfix', 'fix', 'feature', 'bug', 'rc', 'pr', 'sprint', 'week', 'day', 'step', 'phase', 'test', 'tmp', 'wip', 'the', 'and', 'for', 'with', 'from', 'into', 'all', 'new', 'old', 'add', 'use', 'make', 'part', 'task', 'item', 'tier', 'top', 'two', 'one', 'my', 'to', 'of', 'in', 'on', 'is', 'it', 'no', 'not'])

/**
 * The issue a branch was made for: "eng-12-add-search" or "al/eng-12-add-search"
 * is Jira (or Linear) ENG-12; "issue-12-add-search" is GitHub issue #12.
 * Only a hint for the model's wording, so a branch that merely looks like one
 * costs a sentence, not a wrong link.
 */
export function issueFromBranch(branch: string | null | undefined): BranchIssue | null {
  if (!branch) return null
  const gh = /(?:^|\/)issue-(\d{1,9})(?:-|$)/.exec(branch)
  if (gh) return { kind: 'github', number: Number(gh[1]) }
  const m = /(?:^|\/)([a-z][a-z0-9]{1,9})-(\d{1,6})(?:-|$)/.exec(branch)
  if (!m || NOT_A_PROJECT.has(m[1]) || /^v\d+$/.test(m[1])) return null
  return { kind: 'jira', key: `${m[1].toUpperCase()}-${m[2]}` }
}

/* ----------------------------------------------------------------- the task */

const TRACKER_LABEL: Record<TrackerId, string> = { jira: 'Jira', github: 'GitHub' }
export const trackerLabel = (tracker: TrackerId): string => TRACKER_LABEL[tracker]

/** The one line the agent is started with; the issue itself is in ISSUE_FILE. */
export function trackerPrompt(issue: Pick<TrackerIssue, 'tracker' | 'id' | 'title'>): string {
  return `Work on ${trackerLabel(issue.tracker)} issue ${issue.id} (${issue.title.replace(/\s+/g, ' ').slice(0, 120)}). Read ${ISSUE_FILE} first and follow it.`
}

/** The issue, written to ISSUE_FILE in the session's worktree. */
export function trackerTask(issue: TrackerIssue): string {
  const finish =
    issue.tracker === 'jira'
      ? `- Commit as you go. When it is done, push the branch and open a pull request whose title starts with \`${issue.id}\`, so Jira links it.`
      : `- Commit as you go. When it is done, push the branch and open a pull request whose description says \`Closes ${issue.id}\`, so GitHub links it and closes the issue when it merges.`
  return [
    `# ${issue.id}: ${issue.title}`,
    '',
    `${trackerLabel(issue.tracker)}: ${issue.url}  `,
    `${issue.tracker === 'jira' ? 'Project' : 'Repository'}: ${issue.group.name} · Status: ${issue.status.name}${issue.priorityLabel ? ` · Priority: ${issue.priorityLabel}` : ''}${issue.labels.length ? ` · Labels: ${issue.labels.join(', ')}` : ''} · Branch: \`${issue.branchName}\` (checked out here)`,
    '',
    '## The issue',
    '',
    issue.description.trim() ? issue.description.trim().slice(0, 12_000) : '_(no description)_',
    '',
    '## How to work on it',
    '',
    '- Make the change this issue asks for, on this branch, with tests where the project has them.',
    finish,
    '- If something in the issue is unclear, ask before guessing.',
    ''
  ].join('\n')
}
