import { capText } from './chatContext'

/**
 * A project's rules files, as Chat reads them: AGENTS.md, CLAUDE.md and the
 * files other coding tools keep their rules in (.cursorrules, Cursor's rules
 * folder, Copilot's instructions…). Main finds them in the project's folder
 * (main/features/chatContext/rules.ts) and this file turns them into the text
 * added to the agent's instructions and the list the workspace card shows, so
 * the user can see which files the agent was given.
 */

/** The most characters of rules sent with a turn, all files together (25 KB, about 6,000 tokens): room for two files at their cap. */
export const RULES_BUDGET = 25_000
/** One file is cut at this many characters (12 KB): a rules file that long is mostly not rules. */
export const RULE_FILE_CAP = 12_000

/** A rules file as found on disk. */
export interface RuleSource {
  /** Where it is, absolute. */
  path: string
  /** How the project's folder names it: "AGENTS.md", ".cursor/rules/style.mdc", "../AGENTS.md". */
  name: string
  body: string
}

/** A rules file the agent was given. */
export interface RuleFile {
  path: string
  name: string
  /** How many characters of it went in. */
  chars: number
  /** Cut because it was long, or because the budget ran out. */
  cut: boolean
}

export interface ProjectRules {
  files: RuleFile[]
  /** Found but not used, and why. */
  skipped: { name: string; path: string; reason: string }[]
  /** The block added to the instructions; empty when there are no rules. */
  text: string
}

/** The front matter of a Markdown file (`---` lines of `key: value`), and the text after it. */
export function parseFrontMatter(text: string): { data: Record<string, string>; body: string; has: boolean } {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
  if (!m) return { data: {}, body: text, has: false }
  const data: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (kv) data[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  return { data, body: text.slice(m[0].length), has: true }
}

/**
 * Whether a Cursor rule goes to every request. One with no front matter does;
 * one with it does only when it says `alwaysApply: true`. The rest are for
 * files that match a pattern or for when the model asks, which a chat can't
 * tell, so they are left out and listed as such.
 */
export function cursorRule(text: string): { applies: true; body: string } | { applies: false; reason: string } {
  const front = parseFrontMatter(text)
  if (!front.has || front.data.alwaysApply === 'true') return { applies: true, body: front.body }
  if (front.data.globs) return { applies: false, reason: 'applies only to files that match its pattern' }
  if (front.data.description) return { applies: false, reason: 'is used only when the model asks for it' }
  return { applies: false, reason: 'is not set to always apply' }
}

/**
 * The rules to send, in the order found: each file cut at `RULE_FILE_CAP`,
 * a copy of a file already in left out, and no more than `RULES_BUDGET`
 * characters in all (the rest are listed as skipped, not silently dropped).
 */
export function composeRules(sources: RuleSource[], skipped: ProjectRules['skipped'] = []): ProjectRules {
  const files: RuleFile[] = []
  const left: ProjectRules['skipped'] = [...skipped]
  const blocks: string[] = []
  const seen = new Set<string>()
  let used = 0
  for (const source of sources) {
    const body = source.body.trim()
    if (!body) continue
    if (seen.has(body)) {
      left.push({ name: source.name, path: source.path, reason: 'has the same text as a file already used' })
      continue
    }
    seen.add(body)
    const capped = capText(body, RULE_FILE_CAP, 'file')
    const block = `From ${source.name}:\n${capped.text.trimEnd()}`
    if (used + block.length > RULES_BUDGET) {
      left.push({ name: source.name, path: source.path, reason: `would pass the limit of ${RULES_BUDGET.toLocaleString('en-US')} characters of rules` })
      continue
    }
    used += block.length
    blocks.push(block)
    files.push({ path: source.path, name: source.name, chars: Math.min(body.length, RULE_FILE_CAP), cut: capped.truncated })
  }
  const text = blocks.length > 0 ? `The project's own rules files, found in its folder. Follow them:\n\n${blocks.join('\n\n')}` : ''
  return { files, skipped: left, text }
}

/** The instructions typed into the project, then the rules files' text, as one block. */
export function withRules(instructions: string, rules: ProjectRules): string {
  return [instructions, rules.text].filter((part) => part && part.trim()).join('\n\n')
}
