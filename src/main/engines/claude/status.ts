import type { EngineStatus } from '@shared/engines'

/**
 * What the Claude engine's last check found about the user's Claude Code,
 * for those that need it at once without starting a check: the Claude Agent
 * provider's sign-in state (providers/oauth/claudeCode.ts).
 */

let latest: EngineStatus | null = null
const listeners = new Set<(status: EngineStatus) => void>()

export function claudeCodeStatus(): EngineStatus | null {
  return latest
}

export function noteClaudeCodeStatus(status: EngineStatus): void {
  latest = status
  for (const listener of listeners) listener(status)
}

export function onClaudeCodeStatus(listener: (status: EngineStatus) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Signed in with a Claude account: on a Claude plan, which is what Eaon uses Claude Code for. */
export const onClaudePlan = (status: EngineStatus | null): boolean => status?.auth.state === 'signed-in' && status.auth.method === 'Claude account'
