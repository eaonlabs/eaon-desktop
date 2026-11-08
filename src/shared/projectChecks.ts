/**
 * Type and lint errors fed back to the agent. After a round in which the
 * agent edited files, the project's own check (its typecheck or lint script,
 * or `tsc --noEmit`) runs, and what it prints when it fails goes back to the
 * agent with that round's results, so a broken edit is fixed before the agent
 * moves on rather than found by the person. Pure, so it can be tested alone.
 */

/** The agent's tools that change files. */
export const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set(['edit_file', 'write_file', 'delete_file', 'move_file'])

/** The most of a failing check's output the agent is shown. */
export const FEEDBACK_CHARS = 6000
/** A check that takes longer than this is stopped: it isn't a quick look any more. */
export const CHECK_TIMEOUT_MS = 90_000
/** The most times a turn runs the check, so a stubborn failure can't loop for ever. */
export const MAX_CHECKS_PER_TURN = 12

export interface CheckConfig {
  enabled: boolean
  /** The command to run; empty means find the project's own. */
  command: string
}

export const DEFAULT_CHECKS: CheckConfig = { enabled: false, command: '' }

/** Settings as stored or typed. */
export function normalizeChecks(raw: unknown): CheckConfig {
  const r = (raw ?? {}) as Partial<CheckConfig>
  return { enabled: r.enabled === true, command: typeof r.command === 'string' ? r.command.replace(/[\r\n]+/g, ' ').trim().slice(0, 500) : '' }
}

/** What a project says about itself, from its package.json and files. */
export interface ProjectFacts {
  scripts: Record<string, string>
  tsconfig: boolean
  /** TypeScript is installed in the project (its own tsc, not one fetched by npx). */
  typescript: boolean
  /** The package manager's own command for running a script. */
  runner: 'npm' | 'pnpm' | 'yarn' | 'bun'
}

/** The check a project has: its typecheck, check or lint script, else tsc when TypeScript is installed. Null when it has none. */
export function detectCheckCommand(facts: ProjectFacts): string | null {
  const run = (name: string): string => (facts.runner === 'yarn' ? `yarn ${name}` : facts.runner === 'npm' ? `npm run ${name}` : `${facts.runner} run ${name}`)
  for (const name of ['typecheck', 'type-check', 'check', 'lint']) if (facts.scripts[name]) return run(name)
  if (facts.tsconfig && facts.typescript) return 'npx --no-install tsc --noEmit'
  return null
}

export interface CheckResult {
  /** The command's exit code; null when it was killed or couldn't start. */
  code: number | null
  output: string
}

/** The line a command's exit is reported as ("exit code 2\n…") read back into a result. */
export function parseRunOutput(text: string): CheckResult {
  const m = /^exit code (\d+)\n?/.exec(text)
  if (m) return { code: Number(m[1]), output: text.slice(m[0].length) }
  return { code: null, output: text.replace(/^terminated \([A-Z]+\)\n?/, '') }
}

/**
 * What the agent is told about a check, or null when there is nothing to say
 * (it passed). The start of the output is kept: compilers list the first
 * errors first, and the rest often follows from them.
 */
export function checkFeedback(command: string, result: CheckResult, previouslyFailed: boolean): string | null {
  if (result.code === 0) return previouslyFailed ? `\n\n[Checks: \`${command}\` passes now.]` : null
  const text = result.output.replace(/\u001b\[[0-9;]*m/g, '').trim()
  const cut = text.length > FEEDBACK_CHARS
  const shown = cut ? text.slice(0, FEEDBACK_CHARS) : text
  const how = result.code === null ? 'did not finish (it was stopped)' : `failed (exit code ${result.code})`
  return `\n\n[Checks: after your edits, \`${command}\` ${how}. Fix these before going on.]\n${shown || '(no output)'}${cut ? '\n[Output cut here.]' : ''}`
}
