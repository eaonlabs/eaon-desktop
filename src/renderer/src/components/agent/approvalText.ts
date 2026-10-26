import { countChanges } from '../chatCode/diff/model'
import { commandSummary } from './commandText'

/**
 * What an approval says, in words: the dialog's title ("Write index.html?")
 * and the transcript row's two lines ("Run npm, git" over the command itself).
 * Kept free of React so the test harness can run it.
 */

/** What is being asked, as far as its words go. */
export interface ApprovalAsk {
  tool: string
  input: Record<string, unknown>
  summary?: string
  before?: string | null
}

const APPROVAL_TITLES: Record<string, string> = {
  run_command: 'Run this command?',
  write_file: 'Write this file?',
  edit_file: 'Make this edit?',
  delete_file: 'Move this to the Trash?',
  move_file: 'Move this file?',
  computer: 'Let Eaon use your computer?',
  browser: 'Let Eaon do this in your browser?',
  web_browser: 'Let Eaon do this in its browser?',
  email_send: 'Send this email?',
  email_reply: 'Send this reply?',
  trading_order: 'Place this order?',
  trading_session: 'Let Eaon trade?',
  use_plugin_tool: 'Use this plugin?',
  schedule: 'Change your schedules?'
}

const pick = (input: Record<string, unknown>, key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '')

/** "Write index.html?": the title names the file when the call is about one; "Replace" when the file is there. */
export function approvalTitle(tool: string, input: Record<string, unknown>, before?: string | null): string {
  const name = pick(input, 'path').split(/[\\/]/).pop() ?? ''
  if (name && tool === 'write_file') return typeof before === 'string' ? `Replace ${name}?` : `Write ${name}?`
  if (name && tool === 'edit_file') return `Edit ${name}?`
  if (name && tool === 'delete_file') return `Move ${name} to the Trash?`
  if (APPROVAL_TITLES[tool]) return APPROVAL_TITLES[tool]
  // Browser Use and desktop control name each action as its own tool.
  if (tool.startsWith('desktop_')) return APPROVAL_TITLES.computer
  if (tool.startsWith('browser_')) return APPROVAL_TITLES.browser
  return `Allow ${tool.replace(/_/g, ' ')}?`
}

/** Where a file call acts: its folder, beside what it does. */
export function approvalDetail(tool: string, input: Record<string, unknown>): string | undefined {
  if (!['write_file', 'edit_file', 'delete_file', 'move_file'].includes(tool)) return undefined
  const folder = (pick(input, 'path') || pick(input, 'from')).split(/[\\/]/).slice(0, -1).join('/')
  return folder || undefined
}

/** The one line that says what is about to happen, for tools without a bespoke preview. */
export function approvalSummary(tool: string, input: Record<string, unknown>): string {
  if (tool === 'move_file') return `${pick(input, 'from')} → ${pick(input, 'to')}`
  if (tool === 'use_plugin_tool') return pick(input, 'name')
  if (tool === 'computer' || tool === 'browser') {
    const detail = pick(input, 'text') || pick(input, 'keys') || pick(input, 'key') || pick(input, 'url') || pick(input, 'ref') || pick(input, 'app')
    const point = typeof input.x === 'number' ? ` at ${input.x}, ${input.y}` : ''
    return `${pick(input, 'action')}${point}${detail ? ` — ${detail}` : ''}`
  }
  return pick(input, 'path') || pick(input, 'name') || pick(input, 'action') || ''
}

const lineCount = (text: string): number => (text === '' ? 0 : text.replace(/\n$/, '').split('\n').length)

/**
 * The transcript row's words: a title saying what it wants to do ("Run npm,
 * git", "Edit app.ts") and under it, as the link that opens the rest, the
 * thing itself — the command as typed, a file change's size and folder.
 */
export function approvalRow(ask: ApprovalAsk): { title: string; link: string } {
  const { tool, input } = ask
  const title = approvalTitle(tool, input, ask.before).replace(/\?$/, '')
  if (tool === 'run_command') {
    const command = pick(input, 'command').replace(/\s+/g, ' ').trim()
    const programs = commandSummary(command)
    return { title: programs ? `Run ${programs}` : 'Run a command', link: command || 'Show the command' }
  }
  if (tool === 'write_file' || tool === 'edit_file') {
    const counts =
      tool === 'edit_file'
        ? countChanges(pick(input, 'old_text'), pick(input, 'new_text'))
        : typeof ask.before === 'string'
          ? countChanges(ask.before, pick(input, 'content'))
          : null
    const size = counts ? `+${counts.added} −${counts.removed}` : `${lineCount(pick(input, 'content'))} ${lineCount(pick(input, 'content')) === 1 ? 'line' : 'lines'}`
    const folder = approvalDetail(tool, input)
    return { title, link: folder ? `${size} in ${folder}` : size }
  }
  return { title, link: ask.summary || approvalSummary(tool, input) || 'Show details' }
}

/** A sub-agent's role as the row names it: "tester" → "Tester". */
export const askerName = (agent?: string): string => (agent ? agent.charAt(0).toUpperCase() + agent.slice(1) : 'Eaon')
