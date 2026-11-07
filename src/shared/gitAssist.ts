import type { ReviewFile } from './adeReview'
import { parseReview } from './prReview'

/**
 * The model's help with git: a commit message from the changes, a pull
 * request's title and description from its branch, and a review of the
 * changes before they are committed. The pure parts: what of a diff is sent
 * (and how much, said in the UI), the prompts, and reading the answers.
 * main/features/gitAssist.ts asks git and the model.
 */

/** How much diff text goes to the model, by what it is for. Past it, files are cut and the rest named. */
export const COMMIT_DIFF_CAP = 20_000
export const PR_DIFF_CAP = 28_000
export const REVIEW_DIFF_CAP = 48_000

/** A file with less room than this is named, not shown. */
const MIN_FILE_ROOM = 600
/** Longer lines are cut: a minified file's one line is the file. */
const LINE_CAP = 300
/** At most this many files are listed by name. */
const LIST_CAP = 120

/** Files whose lines are never sent, whatever the room: what looks like a secret. Their names are. */
const SECRET_FILE = /(^|\/)(\.env(\.(?!example$|sample$|template$|dist$)[^/]+)?|[^/]+\.(pem|key|p12|pfx|jks|keystore)|id_(rsa|dsa|ecdsa|ed25519)|\.netrc|\.npmrc|\.pypirc|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$/i
/** Files that are generated: counted, not read. */
const GENERATED_FILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|go\.sum|[^/]+\.min\.(js|css)|[^/]+\.map)$/i

export const looksSecret = (path: string): boolean => SECRET_FILE.test(path)

/** What was made of a change for the model, and what that comes to for the person to read. */
export interface DiffForModel {
  /** The text sent: the files by name, then each one's lines. */
  text: string
  /** Files in the change. */
  files: number
  /** Files with lines in the text, all of them or the start. */
  shown: number
  /** Files named only: binary, generated, secret-looking, or past the room there was. */
  named: number
  /** The secret-looking files, by name (their lines are never sent). */
  withheld: string[]
  /** Some lines of some file didn't fit. */
  cut: boolean
  cap: number
}

const STATUS_MARK: Record<ReviewFile['status'], string> = { added: 'A', deleted: 'D', modified: 'M', renamed: 'R' }

function fileLines(file: ReviewFile, numbered: boolean): string[] {
  const out: string[] = []
  for (const hunk of file.hunks) {
    out.push(hunk.header)
    for (const l of hunk.lines) {
      const text = l.text.length > LINE_CAP ? `${l.text.slice(0, LINE_CAP)} …` : l.text
      const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '
      // The new file's line number rides along so a finding can say which line: removed lines have none.
      out.push(numbered ? `${sign}${l.cur === null ? '     ' : String(l.cur).padStart(5)} ${text}` : `${sign}${text}`)
    }
  }
  return out
}

/**
 * A change as text for the model. Every file is listed by name; the lines of
 * the others are shared out within `cap` characters, small files whole and
 * big ones cut, so one huge file can't crowd out the rest. Binary and
 * generated files are named only, and so are files that look like secrets:
 * their lines are never sent.
 */
export function diffForModel(all: ReviewFile[], options: { cap: number; numbered?: boolean }): DiffForModel {
  const { cap } = options
  const numbered = options.numbered === true
  // Past LIST_CAP files the rest are only counted: a change that wide is read from the list, not line by line.
  const files = all.slice(0, LIST_CAP)
  const listed = files.map((f) => `${STATUS_MARK[f.status]} ${f.oldPath ? `${f.oldPath} -> ` : ''}${f.path} (+${f.added} -${f.removed})`)
  if (all.length > files.length) listed.push(`... and ${all.length - files.length} more files`)
  const listText = `Changed files:\n${listed.join('\n')}`

  const withheld: string[] = []
  const bodies: { file: ReviewFile; head: string; note: string | null; lines: string[]; size: number }[] = files.map((file) => {
    const head = `\n=== ${file.path} (${file.status}, +${file.added} -${file.removed})`
    if (looksSecret(file.path)) {
      withheld.push(file.path)
      return { file, head, note: 'lines not sent: the file looks like a secret', lines: [], size: 0 }
    }
    if (file.binary) return { file, head, note: 'binary file', lines: [], size: 0 }
    if (GENERATED_FILE.test(file.path)) return { file, head, note: 'generated file, lines not sent', lines: [], size: 0 }
    const lines = fileLines(file, numbered)
    return { file, head, note: lines.length === 0 ? 'no lines changed (mode or rename only)' : null, lines, size: lines.reduce((n, l) => n + l.length + 1, 0) }
  })

  // What every file costs before its lines: its heading and either its note or the cut notice there may be.
  const fixed = listText.length + bodies.reduce((n, b) => n + b.head.length + (b.note ? b.note.length + 2 : 70), 0)
  // Room is shared out smallest first: a file that fits in its share leaves the rest to the others.
  const open = bodies.filter((b) => b.lines.length > 0).sort((a, b) => a.size - b.size)
  const allowance = new Map<ReviewFile, number>()
  let left = Math.max(0, cap - fixed)
  open.forEach((b, i) => {
    const share = Math.floor(left / (open.length - i))
    const give = share < MIN_FILE_ROOM && b.size > share ? 0 : Math.min(b.size, share)
    allowance.set(b.file, give)
    left -= give
  })

  const parts: string[] = []
  let shown = 0
  let cut = all.length > files.length
  for (const b of bodies) {
    if (b.lines.length === 0) {
      parts.push(`${b.head}: ${b.note}`)
      continue
    }
    const give = allowance.get(b.file) ?? 0
    if (give === 0) {
      parts.push(`${b.head}: not shown, over the size limit`)
      cut = true
      continue
    }
    const kept: string[] = []
    let used = 0
    for (const line of b.lines) {
      if (used + line.length + 1 > give) break
      kept.push(line)
      used += line.length + 1
    }
    shown++
    if (kept.length < b.lines.length) {
      cut = true
      kept.push(`... ${b.lines.length - kept.length} more lines of this file not shown`)
    }
    parts.push(`${b.head}\n${kept.join('\n')}`)
  }
  return { text: `${listText}\n${parts.join('\n')}`, files: all.length, shown, named: all.length - shown, withheld, cut, cap }
}

/** One line saying what goes to the model, for the person to read before it does. */
export function describeSent(d: DiffForModel, options: { to?: string; extra?: string } = {}): string {
  if (d.files === 0) return 'There are no changes to send.'
  const parts = [`Sends the diff of ${d.files} ${d.files === 1 ? 'file' : 'files'} to ${options.to ?? 'the model'}`]
  if (d.cut) parts.push(`long files are cut to fit ${d.cap.toLocaleString('en-US')} characters`)
  if (d.named > 0) {
    const secrets = d.withheld.length > 0 ? `; ${d.withheld.length === 1 ? 'the one that looks like a secret is' : `the ${d.withheld.length} that look like secrets are`} never read` : ''
    parts.push(`${d.named} ${d.named === 1 ? 'file is' : 'files are'} named without lines (binary, generated or too big to fit${secrets})`)
  }
  if (options.extra) parts.push(options.extra)
  return `${parts.join('; ')}.`
}

/* ------------------------------------------------------------------ text from the model */

/** Model output without its thinking and its code fence: what is left to read. */
function plain(raw: string): string {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const fenced = /^```[\w-]*\n([\s\S]*?)\n?```$/.exec(text)
  if (fenced) text = fenced[1].trim()
  return text
}

/* ------------------------------------------------------------------ commit message */

export const COMMIT_SYSTEM = [
  'You write git commit messages.',
  'Reply with the commit message only: no quotes, no code fences, no commentary.',
  'Line 1 is a subject of at most 72 characters in the imperative mood ("Add", "Fix", "Show"), with no full stop.',
  'If the change needs it, leave a blank line and add a short body in plain sentences saying what changed and why. Do not list the files.',
  'Describe only what the diff shows. If recent commit subjects are given, match their style (capitals, prefixes such as "fix:").'
].join(' ')

export function commitPrompt(input: { diff: DiffForModel; branch: string | null; recent: string[] }): string {
  return [
    input.branch ? `Branch: ${input.branch}` : '',
    input.recent.length ? `Recent commit subjects:\n${input.recent.map((s) => `- ${s}`).join('\n')}` : '',
    input.diff.text,
    'Write the commit message.'
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** The message out of what the model wrote: no label, quotes or fence, and a subject without a full stop. Null when there is nothing. */
export function cleanCommitMessage(raw: string): string | null {
  let text = plain(raw)
    .replace(/^(?:commit message|message)\s*[:：]\s*/i, '')
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
    .trim()
  if (!text) return null
  const lines = text.split('\n').map((l) => l.trimEnd())
  lines[0] = lines[0].replace(/^#+\s*/, '').replace(/[.。]+$/, '')
  text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return text.slice(0, 4000) || null
}

/* ------------------------------------------------------------------ pull request text */

export const PR_SYSTEM = [
  'You write pull request titles and descriptions from a branch’s commits and diff.',
  'Reply in this form and nothing else: the first line is the title (at most 72 characters, no full stop), then a blank line, then the description in Markdown.',
  'The description says what the change does and why, in a few short paragraphs or bullets, and anything a reviewer should look at first. Describe only what the commits and diff show.',
  'If a template is given, fill it in: keep its headings, drop its instructions and comments, and leave out sections that do not apply.'
].join(' ')

export function prPrompt(input: { diff: DiffForModel; branch: string | null; base: string; commits: string[]; template: string | null }): string {
  const template = input.template?.trim()
  return [
    `Branch: ${input.branch ?? '(detached)'}, going into ${input.base}`,
    input.commits.length ? `Commits on the branch, oldest first:\n${input.commits.map((s) => `- ${s}`).join('\n')}` : '',
    template ? `The repository’s pull request template:\n${template.slice(0, 4000)}` : '',
    input.diff.text,
    'Write the pull request title and description.'
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** A title and a description out of the model's answer, in the form asked for or as JSON. Null when there is no title. */
export function parsePrText(raw: string): { title: string; body: string } | null {
  const text = plain(raw)
  if (!text) return null
  if (text.startsWith('{')) {
    try {
      const v = JSON.parse(text) as { title?: unknown; body?: unknown; description?: unknown }
      const title = typeof v.title === 'string' ? v.title.trim() : ''
      const body = typeof v.body === 'string' ? v.body : typeof v.description === 'string' ? v.description : ''
      if (title) return { title: title.replace(/[.。]+$/, '').slice(0, 200), body: body.trim().slice(0, 60_000) }
    } catch {
      /* not JSON after all: read as text */
    }
  }
  const lines = text.split('\n')
  const first = lines.findIndex((l) => l.trim())
  const title = lines[first]
    .trim()
    .replace(/^#+\s*/, '')
    .replace(/^\**\s*(?:title|pr title|pull request title)\s*\**\s*[:：]\s*\**\s*/i, '')
    .replace(/^\*\*(.*)\*\*$/, '$1')
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
    .replace(/[.。]+$/, '')
    .trim()
  if (!title) return null
  const body = lines
    .slice(first + 1)
    .join('\n')
    .replace(/^\s*(?:description|body|summary)\s*[:：]\s*\n?/i, '')
    .trim()
  return { title: title.slice(0, 200), body: body.slice(0, 60_000) }
}

/* ------------------------------------------------------------------ review of local changes */

export const REVIEW_SYSTEM = [
  'You review code changes before they are committed, the way a careful maintainer would.',
  'Look for bugs, unhandled edge cases, security problems, missing error handling and tests that the change makes necessary. Leave out style preferences and anything the diff does not show.',
  'Each diff line starts with +, - or a space, then (for lines in the new file) its line number. A finding’s "line" is a line number in the new file, on a line this change added or changed.',
  'Reply with JSON only, no code fence: {"summary": "two or three sentences on what the change does and whether it looks safe to commit", "comments": [{"path": "src/file.ts", "line": 42, "body": "What is wrong here and how to fix it."}]}.',
  'Use an empty comments list if you find nothing worth fixing. Do not invent problems.'
].join(' ')

export function reviewPromptFor(input: { diff: DiffForModel; branch: string | null }): string {
  return [input.branch ? `Branch: ${input.branch}` : '', input.diff.text, 'Review this change.'].filter(Boolean).join('\n\n')
}

/** One thing the review found, in a file of the change. */
export interface Finding {
  path: string
  line: number
  body: string
  /** The line is one the change added or changed (the rest are on code it only sits beside). */
  onChange: boolean
  /** The text of the line in the new file, when the diff shows it. */
  quote: string | null
}

export interface LocalReview {
  summary: string
  findings: Finding[]
}

/** The new file's lines the diff shows, by path and number, and whether the change added each. */
function shownLines(files: ReviewFile[]): Map<string, Map<number, { text: string; added: boolean }>> {
  const map = new Map<string, Map<number, { text: string; added: boolean }>>()
  for (const f of files) {
    const lines = new Map<number, { text: string; added: boolean }>()
    for (const h of f.hunks) for (const l of h.lines) if (l.cur !== null) lines.set(l.cur, { text: l.text, added: l.kind === 'add' })
    map.set(f.path, lines)
  }
  return map
}

/**
 * The review out of the model's answer. Findings on a file that isn't in the
 * change are dropped (the model made them up), the rest are ordered by file
 * and line. An answer that isn't JSON is kept as the summary, so nothing the
 * model said is lost. Null when it said nothing.
 */
export function parseLocalReview(raw: string, files: ReviewFile[]): LocalReview | null {
  const text = plain(raw)
  if (!text) return null
  let json: unknown = null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      json = JSON.parse(text.slice(start, end + 1))
    } catch {
      json = null
    }
  }
  const review = json ? parseReview(json) : null
  if (!review) return { summary: text.slice(0, 4000), findings: [] }
  const lines = shownLines(files)
  const seen = new Set<string>()
  const findings: Finding[] = []
  for (const c of review.comments) {
    const known = lines.get(c.path)
    if (!known) continue
    const key = `${c.path}:${c.line}:${c.body}`
    if (seen.has(key)) continue
    seen.add(key)
    const at = known.get(c.line)
    findings.push({ path: c.path, line: c.line, body: c.body, onChange: at?.added === true, quote: at ? at.text : null })
  }
  findings.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  return { summary: review.summary, findings }
}

/** Findings grouped by file, in the order of the files in the change. */
export function groupFindings(findings: Finding[], paths: string[]): { path: string; findings: Finding[] }[] {
  const order = new Map(paths.map((p, i) => [p, i]))
  const by = new Map<string, Finding[]>()
  for (const f of findings) by.set(f.path, [...(by.get(f.path) ?? []), f])
  return [...by.entries()].sort((a, b) => (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0)).map(([path, list]) => ({ path, findings: list }))
}

/** A finding as a message to the agent that made the change. */
export function findingMessage(f: Pick<Finding, 'path' | 'line' | 'body'>): string {
  return `${f.path}:${f.line}\n${f.body.trim()}`
}

/* ------------------------------------------------------------------ results */

export type GitAssistModel = { providerId: string; modelId: string }

export type CommitMessageResult = { ok: true; message: string; sent: string } | { ok: false; error: string }
export type PrTextResult = { ok: true; title: string; body: string; sent: string } | { ok: false; error: string }
/** `paths` are the files of the change, in order, for grouping what was found. */
export type LocalReviewResult = { ok: true; review: LocalReview; paths: string[]; sent: string } | { ok: false; error: string }

/** The findings as one message to the agent that made the changes. */
export function findingsMessage(findings: Pick<Finding, 'path' | 'line' | 'body'>[]): string {
  const list = [...findings].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
  const lead = list.length === 1 ? 'A review of your uncommitted changes found this. Check it and fix it if it is real:' : `A review of your uncommitted changes found ${list.length} things. Check each and fix the ones that are real:`
  return `${lead}\n\n${list.map(findingMessage).join('\n\n')}`
}
