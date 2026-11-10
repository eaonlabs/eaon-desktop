/**
 * The person's own allowlist and denylist for the shell commands the agent
 * runs. Patterns are plain words with "*" for anything: `npm test` also
 * matches `npm test --watch`, `git push *` matches any push, `rm *` any rm.
 *
 * A denied command never runs, in any approval mode, for a worker or in the
 * CLI. An allowed command runs without asking, unless it is one that can't be
 * undone. This is a convenience list, not a sandbox: it reads the command
 * line, so it looks at every command in a chain and inside `$(…)`, backticks
 * and `sh -c '…'`, but it can't see what a script does once it is running.
 */

export interface CommandRules {
  allow: string[]
  deny: string[]
}

export const MAX_RULES = 100
export const MAX_RULE_CHARS = 200

export const EMPTY_RULES: CommandRules = { allow: [], deny: [] }

const cleanList = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const pattern = item.replace(/\s+/g, ' ').trim().slice(0, MAX_RULE_CHARS)
    if (pattern && !out.includes(pattern)) out.push(pattern)
    if (out.length >= MAX_RULES) break
  }
  return out
}

/** Rules as stored or typed: trimmed, deduplicated, bounded; anything else is empty. */
export function normalizeRules(raw: unknown): CommandRules {
  const r = (raw ?? {}) as Partial<CommandRules>
  return { allow: cleanList(r.allow), deny: cleanList(r.deny) }
}

/** A list as typed into a box, one pattern a line, "#" starting a comment. */
export const parseRuleText = (text: string): string[] =>
  cleanList(
    text
      .split('\n')
      .map((line) => line.replace(/(^|\s)#.*$/, '').trim())
      .filter(Boolean)
  )

/* ------------------------------------------------------------ the command */

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** The commands of a chain: split at && || ; | & and new lines, quotes left alone. */
export function commandSegments(command: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote) {
      current += c
      if (c === quote && command[i - 1] !== '\\') quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      current += c
      continue
    }
    if (c === ';' || c === '|' || c === '&' || c === '\n' || c === '\r') {
      // `2>&1` and `&>` are redirections, not chain operators.
      if (c === '&' && (command[i - 1] === '>' || command[i + 1] === '>')) {
        current += c
        continue
      }
      if (squash(current)) out.push(squash(current))
      current = ''
      continue
    }
    current += c
  }
  if (squash(current)) out.push(squash(current))
  return out
}

/** Commands hidden inside another: `$(…)`, backticks, and the text after `sh -c`, `bash -c` or `eval`. */
function nested(segment: string): string[] {
  const found: string[] = []
  for (const m of segment.matchAll(/\$\(([^()]*)\)/g)) found.push(m[1])
  for (const m of segment.matchAll(/`([^`]*)`/g)) found.push(m[1])
  for (const m of segment.matchAll(/\b(?:ba|z|da|k)?sh\s+(?:-[a-z]*c[a-z]*\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/g)) found.push(m[1] ?? m[2] ?? m[3] ?? '')
  for (const m of segment.matchAll(/\beval\s+(?:"([^"]*)"|'([^']*)'|(.+))/g)) found.push(m[1] ?? m[2] ?? m[3] ?? '')
  return found.filter(Boolean)
}

/** Every command the line would run, those inside others included (to a few levels). */
export function allCommands(command: string, depth = 0): string[] {
  const out: string[] = []
  for (const segment of commandSegments(command)) {
    out.push(segment)
    if (depth < 3) for (const inner of nested(segment)) out.push(...allCommands(inner, depth + 1))
  }
  return out
}

const globToRegExp = (pattern: string): RegExp => {
  const body = squash(pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  // No "*" at the end means the command may carry more words after the pattern: `npm test` and `npm test --watch`.
  return new RegExp(`^${body}${pattern.trim().endsWith('*') ? '' : '(?: .*)?'}$`)
}

/** Whether one command matches one pattern. */
export const matchesRule = (pattern: string, segment: string): boolean => globToRegExp(pattern).test(squash(segment))

/** The first deny pattern any command on the line matches, or null. */
export function deniedBy(rules: CommandRules, command: string): string | null {
  if (rules.deny.length === 0) return null
  for (const segment of allCommands(command)) for (const pattern of rules.deny) if (matchesRule(pattern, segment)) return pattern
  return null
}

/** What makes a line unsafe to wave through on a pattern: one command smuggling another, or writing to a file. */
const SMUGGLES = /\$\(|`|<\(|>\(|<<|\beval\b|\b(?:ba|z|da|k)?sh\s+-[a-z]*c\b/

/** A line's output redirections that only merge streams or discard: `2>&1`, `>/dev/null`. */
const HARMLESS_REDIRECT = /\d*>&\d+|&>\s*\/dev\/null|\d*>\s*\/dev\/null/g

/**
 * Whether the person has allowed everything the line does. Every command in
 * the chain must match an allow pattern (or be one `harmless` calls read-only),
 * and nothing may be smuggled in or written to a file.
 */
export function allowedBy(rules: CommandRules, command: string, harmless: (segment: string) => boolean = () => false): boolean {
  if (rules.allow.length === 0) return false
  const line = command.replace(HARMLESS_REDIRECT, ' ')
  if (SMUGGLES.test(line) || />/.test(line)) return false
  const segments = commandSegments(line)
  if (segments.length === 0) return false
  return segments.every((segment) => harmless(segment) || rules.allow.some((pattern) => matchesRule(pattern, segment)))
}
