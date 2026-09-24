import { randomUUID } from 'node:crypto'
import type { StreamEvent } from '@shared/types'

/**
 * The approval round-trip: the loop emits an `approval-request` over the
 * stream and blocks on a promise the renderer resolves over `chat:approve`.
 * Kept in one place so cancelling a turn also releases every approval it is
 * parked on — otherwise a stopped turn would wait for an answer forever.
 */

interface PendingApproval {
  messageId: string
  resolve: (approved: boolean) => void
}

const pending = new Map<string, PendingApproval>()

/** Headless runs (scheduled tasks) have nobody to ask; they decide with this instead. */
export type Approver = (tool: string, input: Record<string, unknown>, summary?: string) => Promise<boolean>

export function requestApproval(
  messageId: string,
  tool: string,
  input: Record<string, unknown>,
  emit: (event: StreamEvent) => void,
  summary?: string
): Promise<boolean> {
  const requestId = randomUUID()
  return new Promise((resolve) => {
    pending.set(requestId, { messageId, resolve })
    emit({ type: 'approval-request', messageId, requestId, tool, input, ...(summary ? { summary } : {}) })
  })
}

export function resolveApproval(requestId: string, approved: boolean): void {
  pending.get(requestId)?.resolve(approved)
  pending.delete(requestId)
}

export function cancelApprovals(messageId: string): void {
  for (const [requestId, entry] of pending) {
    if (entry.messageId !== messageId) continue
    entry.resolve(false)
    pending.delete(requestId)
  }
}

/**
 * Shell commands that can destroy work or reach beyond the project, which
 * "Approve for me" still stops to ask about. A deny-list is not a sandbox and
 * does not pretend to be one — it catches the commands a model most plausibly
 * runs by mistake, so auto mode is safe to leave on for ordinary work.
 */
const RISKY_COMMANDS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/, // rm -rf, rm -r, rm -f
  /\bsudo\b/,
  /\bmkfs\b|\bdd\s+if=|\bdiskutil\s+(erase|partition)/,
  /\bchmod\s+(-R\s+)?[0-7]*7{2}\b|\bchown\s+-R\b/,
  /\bgit\s+push\b[^\n]*(--force|-f\b)/,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|branch\s+-D|stash\s+(drop|clear)|filter-branch)/,
  /\bgit\s+push\b/,
  /(curl|wget)[^|\n]*\|\s*(sh|bash|zsh|python)/,
  /\b(shutdown|reboot|halt)\b|\blaunchctl\b|\bsystemctl\b|\bdefaults\s+write\b|\bcrontab\b/,
  /\bkill(all)?\s+-9\b|\bpkill\b/,
  /\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/,
  /\bdocker\s+(system\s+prune|rm\s+-f|volume\s+rm)/,
  /\bDROP\s+(TABLE|DATABASE)\b|\bTRUNCATE\b/i,
  />\s*\/dev\/(sd|disk)/,
  /\bsecurity\s+(delete|dump)|\bkeychain\b/
]

export function isRiskyCommand(command: string): boolean {
  return RISKY_COMMANDS.some((pattern) => pattern.test(command))
}

/**
 * Commands that only look: listing, reading, searching, inspecting git. They
 * run without asking even in "Ask for approval", and they are the only shell
 * commands plan mode allows — research needs `ls` and `git log`, and an agent
 * that has to ask before looking at anything is unusable.
 *
 * Deny by default: anything with redirection, command substitution, a pipe
 * into something that is not itself read-only, or a program not on the list
 * counts as a change.
 */
// Deliberately absent, though they usually only read: awk and sed (both can
// run commands), env (prefixes any other command), node/python -e (arbitrary
// code), xxd (-r writes files), and pagers like less/top (they never exit).
const READ_ONLY_PROGRAMS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'rg', 'ag', 'find', 'fd', 'tree', 'pwd', 'echo',
  'which', 'whereis', 'type', 'file', 'stat', 'du', 'df', 'date', 'uname', 'whoami', 'printenv',
  'sort', 'uniq', 'cut', 'tr', 'jq', 'diff', 'cmp', 'basename', 'dirname', 'realpath', 'readlink', 'sw_vers',
  'ps', 'uptime', 'lsof', 'column', 'nl', 'od', 'hexdump', 'strings', 'md5', 'shasum', 'sha256sum', 'md5sum',
  'mdfind', 'mdls', 'system_profiler'
])
const READ_ONLY_SUBCOMMANDS: Record<string, RegExp> = {
  // Inspection subcommands take any arguments; branch, tag, remote and config
  // are listing-only in the exact forms below, since their other forms write.
  git: /^((status|log|diff|show|rev-parse|ls-files|ls-tree|blame|describe|shortlog|stash\s+list)(\s.*)?|reflog(\s+show(\s.*)?)?|branch(\s+(-a|-r|-v|-vv|--list|--all|--remotes|--show-current|--merged|--no-merged|--contains\s+\S+))*|tag(\s+(-l|--list)(\s+\S+)?)?|remote(\s+-v)?|config\s+--get(-all)?\s+\S+)\s*$/,
  npm: /^(ls|list|view|outdated|-v|--version|root|prefix|why)\b/,
  node: /^(-v|--version)\s*$/,
  python3: /^(-V|--version)\s*$/,
  python: /^(-V|--version)\s*$/,
  gh: /^(pr\s+(list|view|diff|status|checks)|issue\s+(list|view)|repo\s+view|run\s+(list|view))\b/,
  cargo: /^(--version|tree|metadata)\b/,
  go: /^(version|env|list)\b/,
  brew: /^(list|info|search|--version|config)\b/,
  docker: /^(ps|images|inspect|logs|version|info)\b/,
  defaults: /^read\b/
}

export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false
  // Redirection into a file, substitution, backgrounding and here-docs all
  // turn a harmless program into a writer.
  if (/[>`]|\$\(|<<|&\s*$|\btee\b/.test(trimmed)) return false
  if (/\bfind\b[^|;&]*\s-(delete|exec|execdir|ok|okdir|fprint\S*|fls)\b/.test(trimmed)) return false
  if (/\bgit\b[^|;&]*\s--output\b/.test(trimmed)) return false
  // Every segment of a pipeline or `&&`/`;` chain must itself be read-only.
  return trimmed.split(/\|\||&&|[|;]/).every((segment) => {
    const words = segment.trim().split(/\s+/)
    let i = 0
    while (i < words.length && /^[A-Z_][A-Z0-9_]*=/.test(words[i])) i++ // leading VAR=value
    const program = words[i]?.replace(/^.*\//, '')
    if (!program) return false
    const rest = words.slice(i + 1).join(' ')
    const sub = READ_ONLY_SUBCOMMANDS[program]
    if (sub) return sub.test(rest)
    return READ_ONLY_PROGRAMS.has(program)
  })
}
