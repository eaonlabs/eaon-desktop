/**
 * What reviewers said on a pull request, for an agent to act on: the inline
 * threads still open and the notes that came with a review asking for
 * changes. Read through `gh api graphql` (main/features/ade/review.ts),
 * shaped here, and sent to an agent as one message the way a failing check's
 * log is. Pure, so it can be tested alone.
 */

export interface ThreadComment {
  author: string
  body: string
}

export interface ReviewThread {
  path: string
  /** The line in the file now; null when the code it was about has moved or gone. */
  line: number | null
  outdated: boolean
  resolved: boolean
  comments: ThreadComment[]
}

/** A review's own words, written with "Request changes" or a comment. */
export interface ReviewNote {
  author: string
  state: string
  body: string
}

export interface PrFeedback {
  threads: ReviewThread[]
  notes: ReviewNote[]
}

export type PrFeedbackResult = ({ ok: true } & PrFeedback) | { ok: false; error: string }

/** `https://github.com/acme/widget/pull/7` → its parts. */
export function parsePrUrl(url: unknown): { owner: string; name: string; number: number } | null {
  if (typeof url !== 'string') return null
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d{1,9})\/?$/.exec(url)
  return m ? { owner: m[1], name: m[2], number: Number(m[3]) } : null
}

export const FEEDBACK_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 60) { nodes { isResolved isOutdated path line originalLine comments(first: 20) { nodes { body author { login } } } } }
      reviews(last: 30) { nodes { state body author { login } } }
    }
  }
}`

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** gh's GraphQL answer as feedback; null when it isn't the shape of one. */
export function parseFeedback(json: unknown): PrFeedback | null {
  const pr = (json as { data?: { repository?: { pullRequest?: unknown } } } | null)?.data?.repository?.pullRequest as
    | { reviewThreads?: { nodes?: unknown[] }; reviews?: { nodes?: unknown[] } }
    | null
    | undefined
  if (!pr) return null
  const threads: ReviewThread[] = []
  for (const raw of pr.reviewThreads?.nodes ?? []) {
    const t = raw as { isResolved?: boolean; isOutdated?: boolean; path?: unknown; line?: unknown; originalLine?: unknown; comments?: { nodes?: { body?: unknown; author?: { login?: unknown } | null }[] } }
    const comments = (t.comments?.nodes ?? []).map((c) => ({ author: str(c.author?.login) || 'someone', body: str(c.body).trim() })).filter((c) => c.body)
    if (!str(t.path) || comments.length === 0) continue
    const line = typeof t.line === 'number' ? t.line : typeof t.originalLine === 'number' ? t.originalLine : null
    threads.push({ path: str(t.path), line, outdated: t.isOutdated === true, resolved: t.isResolved === true, comments })
  }
  const notes: ReviewNote[] = []
  for (const raw of pr.reviews?.nodes ?? []) {
    const r = raw as { state?: unknown; body?: unknown; author?: { login?: unknown } | null }
    const body = str(r.body).trim()
    const state = str(r.state)
    if (body && (state === 'CHANGES_REQUESTED' || state === 'COMMENTED')) notes.push({ author: str(r.author?.login) || 'someone', state, body })
  }
  return { threads, notes }
}

/** The threads that still need an answer. */
export const openThreads = (threads: ReviewThread[]): ReviewThread[] => threads.filter((t) => !t.resolved)

/** Most of one comment's text kept in the message; a longer one is cut with a note. */
const COMMENT_CAP = 1500

const clip = (text: string): string => (text.length > COMMENT_CAP ? `${text.slice(0, COMMENT_CAP)}\n[cut: ${text.length - COMMENT_CAP} more characters]` : text)

/** The message an agent is sent: each open thread by file and line, then the reviews' own words. */
export function feedbackMessage(feedback: PrFeedback, pr: { number: number; title: string; url: string }): string {
  const open = openThreads(feedback.threads)
  const notes = feedback.notes.filter((n) => n.state === 'CHANGES_REQUESTED').concat(feedback.notes.filter((n) => n.state !== 'CHANGES_REQUESTED'))
  const parts: string[] = [
    `Reviewers left feedback on pull request #${pr.number} (${pr.title}, ${pr.url}). Go through it: make the change each comment asks for if it is right, and if you disagree with one, say why instead of changing it. Don't commit or push; tell me what you did for each.`
  ]
  open.forEach((t, i) => {
    const where = `${t.path}${t.line ? `:${t.line}` : ''}${t.outdated ? ' (the code it was about has changed since)' : ''}`
    parts.push(`${i + 1}. ${where}\n${t.comments.map((c) => `   ${c.author}: ${clip(c.body).replace(/\n/g, '\n   ')}`).join('\n')}`)
  })
  for (const n of notes) parts.push(`${n.author} (${n.state === 'CHANGES_REQUESTED' ? 'asked for changes' : 'commented'}) wrote:\n${clip(n.body)}`)
  return parts.join('\n\n')
}
