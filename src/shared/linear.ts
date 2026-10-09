import type { AdeSession } from './adeSessions'

/**
 * Linear issues as ADE sessions. Connected with a Linear personal API key
 * (kept in Eaon's keychain-backed vault). An issue's Start makes a session on
 * the branch Linear names for it, gives the agent the issue as its task, and
 * moves the issue to In Progress; once that branch has a pull request, the
 * PR is linked on the issue and the issue moves to In Review.
 */

/** Inside the session's worktree; `.eaon/` is excluded from git there. */
export const ISSUE_FILE = '.eaon/issue.md'

export type LinearStateType = 'triage' | 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled'

export interface LinearState {
  id: string
  name: string
  type: LinearStateType | string
  color?: string
  position?: number
}

export interface LinearIssue {
  id: string
  /** "ENG-123" */
  identifier: string
  title: string
  description: string
  url: string
  /** The git branch Linear suggests for it ("al/eng-123-fix-login"), which its GitHub integration recognises. */
  branchName: string
  /** 0 none, 1 urgent … 4 low. */
  priority: number
  priorityLabel: string
  state: { name: string; type: string; color: string }
  team: { id: string; key: string; name: string }
  updatedAt: string
}

export interface LinearStatus {
  connected: boolean
  /** Who the key belongs to. */
  user: { name: string; email: string } | null
  error: string | null
}

export type LinearIssuesResult =
  | { ok: true; issues: LinearIssue[]; /** issue id → its ADE session's folder */ sessions: Record<string, string> }
  | { ok: false; error: string }

export type StartIssueResult = { ok: true; session: AdeSession; prompt: string; moved: string | null } | { ok: false; error: string }

/** The state an issue moves to when work starts: the team's first "started" state that isn't a review one. */
export function startedState(states: LinearState[]): LinearState | null {
  const started = states.filter((s) => s.type === 'started').sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  return started.find((s) => !/review/i.test(s.name)) ?? started[0] ?? null
}

/** The state an issue moves to once its pull request is open: a "started" state named for review, if the team has one. */
export function reviewState(states: LinearState[]): LinearState | null {
  return states.filter((s) => s.type === 'started' && /review/i.test(s.name)).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0] ?? null
}

/** The one line the agent is started with; the issue itself is in ISSUE_FILE. */
export function issuePrompt(issue: Pick<LinearIssue, 'identifier' | 'title'>): string {
  return `Work on Linear issue ${issue.identifier} (${issue.title.replace(/\s+/g, ' ').slice(0, 120)}). Read ${ISSUE_FILE} first and follow it.`
}

/** The issue, written to ISSUE_FILE in the session's worktree. */
export function issueTask(issue: LinearIssue): string {
  return [
    `# ${issue.identifier}: ${issue.title}`,
    '',
    `Linear: ${issue.url}  `,
    `Team: ${issue.team.name} · Priority: ${issue.priorityLabel || 'none'} · Branch: \`${issue.branchName}\` (checked out here)`,
    '',
    '## The issue',
    '',
    issue.description.trim() ? issue.description.trim().slice(0, 12_000) : '_(no description)_',
    '',
    '## How to work on it',
    '',
    '- Make the change this issue asks for, on this branch, with tests where the project has them.',
    '- Commit as you go. When it is done, push the branch and open a pull request whose title starts with ' + `\`${issue.identifier}\`` + ', so Linear links it.',
    '- If something in the issue is unclear, ask before guessing.',
    ''
  ].join('\n')
}
