import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runProjectCheck } from '../localTools'
import { CHECK_TIMEOUT_MS, MAX_CHECKS_PER_TURN, checkFeedback, detectCheckCommand, normalizeChecks, parseRunOutput, type ProjectFacts } from '@shared/projectChecks'
import type { Settings } from '@shared/types'

/**
 * Runs the project's check after a round of file edits (shared/projectChecks.ts)
 * and says what came of it. The command is the person's own setting or the
 * project's own script, never one the model chose.
 */

/** What the folder says about how it is checked. */
export function projectFacts(cwd: string): ProjectFacts {
  let scripts: Record<string, string> = {}
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
    scripts = Object.fromEntries(Object.entries(pkg.scripts ?? {}).filter(([, v]) => typeof v === 'string')) as Record<string, string>
  } catch {
    /* no package.json, or not JSON: no scripts */
  }
  const runner = existsSync(join(cwd, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(cwd, 'yarn.lock')) ? 'yarn' : existsSync(join(cwd, 'bun.lockb')) || existsSync(join(cwd, 'bun.lock')) ? 'bun' : 'npm'
  return { scripts, tsconfig: existsSync(join(cwd, 'tsconfig.json')), typescript: existsSync(join(cwd, 'node_modules', 'typescript', 'package.json')), runner }
}

/** Where a turn keeps count. */
export interface CheckState {
  runs: number
  failing: boolean
}

/**
 * The note to add to this round's last result, or null: checks off, no check
 * to run, nothing to say, or the turn has run enough of them.
 */
export async function checkAfterEdits(cwd: string, settings: Settings, state: CheckState, signal: AbortSignal): Promise<{ text: string; failed: boolean } | null> {
  const config = normalizeChecks(settings.general.checks)
  if (!config.enabled || state.runs >= MAX_CHECKS_PER_TURN || signal.aborted) return null
  const command = config.command || detectCheckCommand(projectFacts(cwd))
  if (!command) return null
  state.runs++
  let result
  try {
    result = parseRunOutput(await runProjectCheck(command, cwd, signal, CHECK_TIMEOUT_MS))
  } catch {
    return null
  }
  if (signal.aborted) return null
  const text = checkFeedback(command, result, state.failing)
  state.failing = result.code !== 0
  return text ? { text, failed: result.code !== 0 } : null
}
