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
export type Approver = (tool: string, input: Record<string, unknown>) => Promise<boolean>

export function requestApproval(
  messageId: string,
  tool: string,
  input: Record<string, unknown>,
  emit: (event: StreamEvent) => void
): Promise<boolean> {
  const requestId = randomUUID()
  return new Promise((resolve) => {
    pending.set(requestId, { messageId, resolve })
    emit({ type: 'approval-request', messageId, requestId, tool, input })
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
