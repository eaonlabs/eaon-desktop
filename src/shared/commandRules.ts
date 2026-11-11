/**
 * The person's own allowlist, ask list and denylist for the shell commands
 * the agent runs. A pattern is plain words with "*" for anything (`npm test`
 * also matches `npm test --watch`, `git push *` matches any push, `rm *` any
 * rm), or a regular expression between slashes (`/^git (push|reset)\b/`,
 * `/^curl .*\| *sh$/i`) matched against each command of the line.
 *
 * A denied command never runs, in any approval mode, for a worker or in the
 * CLI. An asked command always asks first, even in Full access. An allowed
 * command runs without asking, unless it is one that can't be undone. When
 * several lists match, deny beats ask beats allow. Rules come from Settings
 * (for every project) and from the project's own list, which adds to them.
 * This is a convenience list, not a sandbox: it reads the command line, so it
 * looks at every command in a chain and inside `$(…)`, backticks and
 * `sh -c '…'`, but it can't see what a script does once it is running.
 */

export interface CommandRules {
  allow: string[]
  /** Commands that always ask, whatever the approval mode. */
  ask: string[]
  deny: string[]
}

export type RuleList = keyof CommandRules

/** The stored form: `ask` and the per-project lists came later, so older settings lack them. */
export type StoredRules = { allow?: string[]; ask?: string[]; deny?: string[] }

export const MAX_RULES = 100
export const MAX_RULE_CHARS = 200

export const EMPTY_RULES: CommandRules = { allow: [], ask: [], deny: [] }

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
  return { allow: cleanList(r.allow), ask: cleanList(r.ask), deny: cleanList(r.deny) }
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

/** A pattern written as `/body/` or `/body/flags` is a regular expression. */
const REGEX_RULE = /^\/(.+)\/([a-z]*)$/s

/** The expression a regex pattern stands for, or null when it isn't one or doesn't compile. */
export function ruleRegExp(pattern: string): RegExp | null {
  const m = REGEX_RULE.exec(pattern.trim())
  if (!m) return null
  try {
    return new RegExp(m[1], m[2].replace(/[gy]/g, ''))
  } catch {
    return null
  }
}

/** Why a pattern can't be used (a regex that doesn't compile), or null. */
export function ruleProblem(pattern: string): string | null {
  const m = REGEX_RULE.exec(pattern.trim())
  if (!m) return null
  try {
    new RegExp(m[1], m[2].replace(/[gy]/g, ''))
    return null
  } catch (error) {
    return error instanceof Error ? error.message : 'Not a valid regular expression'
  }
}

const globToRegExp = (pattern: string): RegExp => {
  const body = squash(pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  // No "*" at the end means the command may carry more words after the pattern: `npm test` and `npm test --watch`.
  return new RegExp(`^${body}${pattern.trim().endsWith('*') ? '' : '(?: .*)?'}$`)
}

/** Whether one command matches one pattern. A regex that doesn't compile matches nothing. */
export function matchesRule(pattern: string, segment: string): boolean {
  if (REGEX_RULE.test(pattern.trim())) return ruleRegExp(pattern)?.test(squash(segment)) ?? false
  return globToRegExp(pattern).test(squash(segment))
}

/**
 * The first pattern any command on the line matches, or null. A regex is also
 * tried on the whole line, so `/curl .*\| *sh/` can see a pipe the chain split would hide.
 */
function firstMatch(patterns: string[], command: string): string | null {
  const commands = allCommands(command)
  for (const pattern of patterns) {
    if (commands.some((segment) => matchesRule(pattern, segment))) return pattern
    if (ruleRegExp(pattern)?.test(squash(command))) return pattern
  }
  return null
}

/** The first deny pattern any command on the line matches, or null. */
export function deniedBy(rules: CommandRules, command: string): string | null {
  if (rules.deny.length === 0) return null
  return firstMatch(rules.deny, command)
}

/** The first ask pattern any command on the line matches, or null. */
export function askedBy(rules: CommandRules, command: string): string | null {
  // Lists built by hand (tests, older callers) may lack `ask`.
  if (!rules.ask?.length) return null
  return firstMatch(rules.ask, command)
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
  if (rules.allow.length === 0 || askedBy(rules, command)) return false
  const line = command.replace(HARMLESS_REDIRECT, ' ')
  if (SMUGGLES.test(line) || />/.test(line)) return false
  const segments = commandSegments(line)
  if (segments.length === 0) return false
  return segments.every((segment) => harmless(segment) || rules.allow.some((pattern) => matchesRule(pattern, segment)))
}

/* ------------------------------------------------- per project, and "always" */

/** The lists as saved in settings: for every project, and for each project folder. */
export interface RuleSettings {
  commandRules?: StoredRules
  projectCommandRules?: Record<string, StoredRules>
}

const folderKey = (folder: string): string => folder.replace(/[\\/]+$/, '')

/** Every list of `b` added to `a`'s. */
export const mergeRules = (a: CommandRules, b: CommandRules): CommandRules => ({
  allow: [...new Set([...a.allow, ...b.allow])],
  ask: [...new Set([...a.ask, ...b.ask])],
  deny: [...new Set([...a.deny, ...b.deny])]
})

/** The rules for work in `folder`: the ones for every project plus that project's own. */
export function rulesFor(general: RuleSettings | undefined, folder: string | null | undefined): CommandRules {
  const all = normalizeRules(general?.commandRules)
  const own = folder ? general?.projectCommandRules?.[folderKey(folder)] : undefined
  return own ? mergeRules(all, normalizeRules(own)) : all
}

/** The settings patch that adds `patterns` to `list`, for every project or for `folder` only. */
export function addRulePatch(general: RuleSettings | undefined, list: RuleList, patterns: string[], folder?: string | null): { commandRules: CommandRules } | { projectCommandRules: Record<string, CommandRules> } {
  const grow = (current: StoredRules | undefined): CommandRules => {
    const rules = normalizeRules(current)
    return normalizeRules({ ...rules, [list]: [...rules[list], ...patterns] })
  }
  if (folder) return { projectCommandRules: { [folderKey(folder)]: grow(general?.projectCommandRules?.[folderKey(folder)]) } }
  return { commandRules: grow(general?.commandRules) }
}

/* ------------------------------------------------------ "Always allow" */

/** Tools that take a subcommand first: `git push`, `cargo test`. */
const SUBCOMMANDS = new Set(['git', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'cargo', 'go', 'docker', 'kubectl', 'make', 'pip', 'pip3', 'uv', 'brew', 'gh', 'dotnet', 'gradle', 'mvn', 'swift', 'xcodebuild', 'terraform', 'helm', 'deno', 'poetry', 'pytest'])
/** Package managers whose `run` takes a script name: `npm run build`. */
const RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'deno'])

/** The pattern a click on "Always allow" saves for one command: the tool and its subcommand, not the whole line. */
export function patternFor(segment: string): string {
  const words = squash(segment).split(' ')
  const program = words[0] ?? ''
  if (!SUBCOMMANDS.has(program)) return squash(segment)
  const rest = words.slice(1).filter((w) => !w.startsWith('-'))
  if (rest.length === 0) return program
  if (RUNNERS.has(program) && rest[0] === 'run' && rest[1]) return `${program} run ${rest[1]}`
  return `${program} ${rest[0]}`
}

/**
 * What "Always allow" would save for a command line: one pattern for each
 * command in the chain, or null when a pattern could not cover it safely (it
 * hides a command in `$(…)` or `sh -c`, or writes to a file).
 */
export function suggestRules(command: string): string[] | null {
  const line = command.replace(HARMLESS_REDIRECT, ' ')
  if (SMUGGLES.test(line) || />/.test(line)) return null
  const segments = commandSegments(line)
  if (segments.length === 0) return null
  return [...new Set(segments.map(patternFor))]
}
