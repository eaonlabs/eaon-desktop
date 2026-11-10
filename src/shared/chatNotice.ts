import type { StreamEvent, StreamRequest } from './types'
import { programName } from './commandRisk'

/**
 * The system notifications Chat sends while Eaon isn't the window in front:
 * a task that finished, and a call waiting on the person's OK. Only the text
 * is decided here (main/index.ts shows it, when Settings → General's
 * notification switch is on and no Eaon window has focus). An approval's
 * banner says what kind of thing is asked, never a whole command or its
 * arguments: banners show on a locked screen.
 */

export interface NoticeText {
  title: string
  body: string
}

/** A task shorter than this ends before anyone has looked away. */
export const FINISHED_AFTER_MS = 20_000

/** A coding or work task that ran a while and ended: finished, or stopped with an error. */
export function finishedNotice(request: Pick<StreamRequest, 'mode' | 'chatTitle'>, error: string | undefined, elapsedMs: number): NoticeText | null {
  if (request.mode !== 'work' || elapsedMs < FINISHED_AFTER_MS) return null
  return { title: error ? 'Task stopped with an error' : 'Task finished', body: request.chatTitle || 'Eaon' }
}

type ApprovalRequestEvent = Extract<StreamEvent, { type: 'approval-request' }>

const FILE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'move_file'])
const LIMIT = 100

const clip = (text: string): string => (text.length > LIMIT ? `${text.slice(0, LIMIT - 1).trimEnd()}…` : text)
const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/** What a call waiting for approval is, in a few words. */
export function approvalWants(event: Pick<ApprovalRequestEvent, 'tool' | 'input' | 'summary'>): string {
  const input = event.input ?? {}
  if (event.tool === 'run_command') {
    const first = typeof input.command === 'string' ? (input.command.trim().split(/\s+/)[0] ?? '') : ''
    return first ? `Wants to run ${programName(first)}` : 'Wants to run a command'
  }
  if (FILE_TOOLS.has(event.tool)) {
    const path = [input.path, input.file_path, input.file, input.from].find((v): v is string => typeof v === 'string' && v.length > 0)
    return path ? `Wants to change ${baseName(path)}` : 'Wants to change a file'
  }
  const said = event.summary?.replace(/\s+/g, ' ').trim()
  // "Open the page" reads as "wants to open the page"; "GitHub…" and "[2] click" stay as they are.
  return said ? clip(`Wants to ${/^[A-Z][a-z]+\b/.test(said) ? said.charAt(0).toLowerCase() + said.slice(1) : said}`) : `Wants to use ${event.tool.replace(/_/g, ' ')}`
}

/** A call that needs the person's OK: who is waiting and for what. */
export function approvalNotice(request: Pick<StreamRequest, 'chatTitle'>, event: ApprovalRequestEvent): NoticeText {
  const who = event.agent ? `${event.agent} in ${request.chatTitle || 'Eaon'}` : request.chatTitle || 'Eaon'
  return { title: `${clip(who)} needs your OK`, body: approvalWants(event) }
}

/**
 * One banner per run in a short while: a run can ask several things at once
 * (a swarm, parallel tool calls), and the first banner says it is waiting.
 * Returns whether to show one for `runId` now.
 */
export function approvalGate(windowMs = 15_000): (runId: string, now: number) => boolean {
  const last = new Map<string, number>()
  return (runId, now) => {
    const before = last.get(runId)
    if (before !== undefined && now - before < windowMs) return false
    last.set(runId, now)
    // Old runs are forgotten, so the map doesn't grow for as long as the app is open.
    for (const [id, at] of last) if (now - at > windowMs * 4) last.delete(id)
    return true
  }
}
