import type { CliTool } from '@shared/cliAccounts'
import type { CliAccounts } from './service'

/**
 * The accounts as the rest of main sees them: which folder each CLI runs
 * from, and word when that changes. Kept apart from the feature (index.ts)
 * so the Codex engine can follow the active account without loading
 * Electron's side of Settings → Accounts.
 */

let service: CliAccounts | null = null
let unhook: (() => void) | null = null
const listeners = new Set<(tool: CliTool) => void>()

export function setCliAccounts(next: CliAccounts | null): void {
  unhook?.()
  unhook = null
  service = next
  if (!next) return
  unhook = next.onActive((tool) => {
    for (const listener of listeners) {
      try {
        listener(tool)
      } catch (error) {
        console.error('[cli-accounts] an account listener failed:', error)
      }
    }
  })
}

/** The folder variables every ADE pane gets, so `claude` and `codex` run as the chosen accounts. */
export function cliAccountEnv(): Record<string, string> {
  return service?.terminalEnv() ?? {}
}

/** One CLI's folder variable alone (CODEX_HOME for Eaon's Codex engine), or nothing for its default account. */
export function cliToolEnv(tool: CliTool): Record<string, string> {
  return service?.toolEnv(tool) ?? {}
}

/** Told when a CLI's active account changes. */
export function onCliAccountChange(listener: (tool: CliTool) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
