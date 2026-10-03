import { randomUUID } from 'node:crypto'
import type { StreamEvent } from '@shared/types'
import { CREDENTIAL_PATHS } from '@shared/commandRisk'

// Command risk lives in shared/ so the approval card can colour a command the same way.
export { isCatastrophicCommand, isRiskyCommand, writtenPaths } from '@shared/commandRisk'

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
/** Options that make a listed program run commands or write a file, like find's -exec. */
const WRITING_OPTIONS: Record<string, RegExp> = {
  fd: /(^|\s)(-[a-zA-Z]*[xX]\b|--exec(-batch)?\b)/,
  rg: /(^|\s)--pre\b/,
  sort: /(^|\s)(-[a-zA-Z]*o|--output\b)/,
  tree: /(^|\s)-o\b/
}

export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false
  // Redirection into a file, substitution, backgrounding and here-docs all
  // turn a harmless program into a writer.
  if (/[>`]|\$\(|<<|<\(|&\s*$|\btee\b/.test(trimmed)) return false
  if (/\bfind\b[^|;&]*\s-(delete|exec|execdir|ok|okdir|fprint\S*|fls)\b/.test(trimmed)) return false
  if (/\bgit\b[^|;&]*\s--output\b/.test(trimmed)) return false
  if (CREDENTIAL_PATHS.test(trimmed)) return false
  // Every segment of a pipeline, chain or script must itself be read-only —
  // newlines and a lone `&` separate commands just as `;` does.
  return trimmed.split(/\|\||&&|[|;&\n\r]/).every((segment) => {
    const words = segment.trim().split(/\s+/)
    let i = 0
    while (i < words.length && /^[A-Z_][A-Z0-9_]*=/.test(words[i])) i++ // leading VAR=value
    const program = words[i]?.replace(/^.*\//, '')
    if (!program) return false
    const rest = words.slice(i + 1).join(' ')
    const sub = READ_ONLY_SUBCOMMANDS[program]
    if (sub) return sub.test(rest)
    if (WRITING_OPTIONS[program]?.test(rest)) return false
    // uniq's second operand is a file it writes.
    if (program === 'uniq' && words.slice(i + 1).filter((word) => !word.startsWith('-')).length > 1) return false
    return READ_ONLY_PROGRAMS.has(program)
  })
}
