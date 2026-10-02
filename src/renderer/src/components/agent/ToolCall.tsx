import { memo, useState, type JSX } from 'react'
import {
  Ban,
  ChevronRight,
  FilePenLine,
  FilePlus2,
  FolderTree,
  Globe,
  Search,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  FileText,
  Monitor,
  AppWindow,
  CalendarClock,
  Sparkles,
  Send,
  Users,
  Eye,
  HeartPulse,
  Activity,
  UserPlus,
  Repeat,
  Target,
  CircleHelp,
  Bell,
  Hourglass,
  Mail,
  MailOpen,
  Reply,
  Wallet,
  CandlestickChart,
  Receipt,
  MessagesSquare
} from 'lucide-react'
import type { ChatToolPart } from '@shared/types'
import { ThinkingOrb } from '../ThinkingOrb'
import type { ActivityCall } from './Activity'
import { FileDiff } from './FileDiff'
import type { FileChange } from './FilesChanged'
import { SwarmCard, ToolImages } from './WorkBits'

/**
 * One tool call in the transcript.
 *
 * Collapsed by default and summarised down to the one argument that says what
 * the call actually did — the path, the command, the query. A coding turn makes
 * dozens of these, and a list that shows every argument and every result in
 * full buries the reply they were in service of. The orb spins only while the
 * call is in flight, so the row that is still working is the one that moves.
 */

const ICONS: Record<string, typeof Search> = {
  read_file: FileText,
  list_dir: FolderTree,
  grep: Search,
  codebase_search: Search,
  find_file: Search,
  find_symbol: Search,
  edit_file: FilePenLine,
  write_file: FilePlus2,
  delete_file: Trash2,
  run_command: SquareTerminal,
  web_search: Globe,
  web_fetch: Globe,
  computer: Monitor,
  browser: AppWindow,
  schedule: CalendarClock,
  load_skill: Sparkles,
  list_workers: Users,
  message_worker: Send,
  check_worker: Eye,
  set_heartbeat: HeartPulse,
  set_status: Activity,
  create_worker: UserPlus,
  add_routine: Repeat,
  remove_routine: Repeat,
  set_goal: Target,
  update_notes: FileText,
  ask_user: CircleHelp,
  notify_user: Bell,
  web_browser: AppWindow,
  wait: Hourglass,
  email_inbox: Mail,
  email_read: MailOpen,
  email_send: Send,
  email_reply: Reply,
  trading_account: Wallet,
  trading_quote: CandlestickChart,
  trading_history: CandlestickChart,
  trading_order: Receipt,
  trading_cancel: Receipt,
  trading_session: CalendarClock,
  send_chat_message: MessagesSquare
}

/** Tools whose detail is a sentence, not a path or a command — set in the UI face, not mono. */
const PROSE = new Set([
  'message_worker',
  'check_worker',
  'set_status',
  'set_heartbeat',
  'create_worker',
  'add_routine',
  'set_goal',
  'update_notes',
  'ask_user',
  'notify_user',
  'wait',
  'email_send',
  'email_reply',
  'trading_order',
  'trading_session',
  'send_chat_message'
])

/** The single argument worth putting next to the tool's name. */
function summarise(name: string, input: Record<string, unknown>): string {
  const first = (...keys: string[]): string => {
    for (const key of keys) {
      const value = input[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
    return ''
  }
  if (name === 'run_command') return first('command')
  if (name === 'spawn_agents') return Array.isArray(input.agents) ? `${input.agents.length} agents` : ''
  if (name === 'move_file') return [first('from'), first('to')].filter(Boolean).join(' → ')
  // Workers' own tools read as sentences: "Messaged Pixel", "Every 30 min".
  if (name === 'message_worker') return first('to')
  if (name === 'set_status') return first('activity')
  if (name === 'ask_user') return first('question')
  if (name === 'notify_user') return first('title', 'message')
  if (name === 'set_goal') return first('goal')
  if (name === 'update_notes') return first('add') || 'rewrote them'
  if (name === 'add_routine') return [first('name'), first('daily') ? `daily ${first('daily')}` : input.every_minutes ? `every ${input.every_minutes} min` : ''].filter(Boolean).join(' · ')
  if (name === 'web_browser') return [first('action'), first('url', 'text', 'key', 'ref')].filter(Boolean).join(' ')
  if (name === 'wait') return [input.minutes ? `${input.minutes} min` : '', first('reason')].filter(Boolean).join(' · ')
  if (name === 'email_send') return [Array.isArray(input.to) ? input.to.join(', ') : '', first('subject')].filter(Boolean).join(' — ')
  if (name === 'trading_quote') return Array.isArray(input.symbols) ? input.symbols.join(', ') : ''
  if (name === 'trading_history') return [first('symbol'), first('range')].filter(Boolean).join(' · ')
  if (name === 'trading_order') {
    const size = input.qty ? `${input.qty}` : input.notional ? `$${input.notional} of` : ''
    return [first('side'), size, first('symbol')].filter(Boolean).join(' ')
  }
  if (name === 'trading_session') return first('action')
  if (name === 'send_chat_message') return first('chat')
  if (name === 'set_heartbeat') {
    if (input.stop === true) return 'stopped'
    const every = Number(input.every_minutes)
    const once = Number(input.in_minutes)
    const when = every > 0 ? `every ${every} min` : once > 0 ? `in ${once} min` : ''
    return [when, first('note')].filter(Boolean).join(' · ')
  }
  return first('path', 'query', 'pattern', 'name', 'url', 'action', 'title')
}

const LABELS: Record<string, string> = {
  read_file: 'Read',
  list_dir: 'List',
  grep: 'Search',
  codebase_search: 'Search',
  find_file: 'Find',
  find_symbol: 'Find symbol',
  edit_file: 'Edit',
  write_file: 'Write',
  delete_file: 'Delete',
  run_command: 'Run',
  web_search: 'Web search',
  web_fetch: 'Read page',
  move_file: 'Move',
  update_plan: 'Update plan',
  present_plan: 'Present plan',
  spawn_agents: 'Swarm',
  goal_complete: 'Goal complete',
  goal_blocked: 'Goal blocked',
  plugin_tools: 'Plugin tools',
  use_plugin_tool: 'Plugin',
  computer: 'Computer',
  browser: 'Browser',
  schedule: 'Schedule',
  load_skill: 'Skill',
  list_workers: 'Looked at the team',
  message_worker: 'Messaged',
  check_worker: 'Checked on',
  set_heartbeat: 'Heartbeat',
  set_status: 'Status',
  create_worker: 'Created worker',
  add_routine: 'Routine',
  remove_routine: 'Removed routine',
  set_goal: 'Goal',
  update_notes: 'Notes',
  ask_user: 'Asked you',
  notify_user: 'Told you',
  web_browser: 'Browser',
  wait: 'Waited',
  email_inbox: 'Checked email',
  email_read: 'Read email',
  email_send: 'Emailed',
  email_reply: 'Replied',
  trading_account: 'Trading account',
  trading_quote: 'Quote',
  trading_history: 'Price history',
  trading_order: 'Order',
  trading_cancel: 'Cancelled order',
  trading_session: 'Trading session',
  send_chat_message: 'Posted'
}

/** The call as its activity line counts it. */
export function describeToolPart(part: ChatToolPart): ActivityCall {
  return { name: part.name, status: part.status, label: LABELS[part.name] ?? part.name, detail: summarise(part.name, part.input) }
}

/** The edits a turn's finished `edit_file` / `write_file` calls made, for the files-changed card. */
export function toolPartChanges(parts: ChatToolPart[]): FileChange[] {
  const changes: FileChange[] = []
  for (const part of parts) {
    if (part.status !== 'done' || typeof part.input.path !== 'string') continue
    if (part.name === 'edit_file' && typeof part.input.old_text === 'string' && typeof part.input.new_text === 'string') {
      changes.push({ file: part.input.path, before: part.input.old_text, after: part.input.new_text })
    } else if (part.name === 'write_file' && typeof part.input.content === 'string') {
      changes.push({ file: part.input.path, before: '', after: part.input.content })
    }
  }
  return changes
}

/**
 * Memoised on the part object. A Work turn can hold dozens of calls, and the
 * reply they sit in re-renders on every batch of streamed tokens; the stream
 * reducer only replaces the part that changed, so the rest — including any
 * open diff, which can run to a thousand rows — are skipped.
 */
export const ToolCall = memo(function ToolCall({ part }: { part: ChatToolPart }): JSX.Element {
  // A command still running opens itself so its live output is visible.
  const [open, setOpen] = useState(false)
  const showProgress = part.status === 'running' && Boolean(part.progress)

  const Icon = ICONS[part.name] ?? SquareTerminal
  const label = LABELS[part.name] ?? part.name
  const detail = summarise(part.name, part.input)
  const running = part.status === 'running'

  const before = typeof part.input.old_text === 'string' ? part.input.old_text : null
  const after =
    typeof part.input.new_text === 'string'
      ? part.input.new_text
      : typeof part.input.content === 'string'
        ? part.input.content
        : null
  // A diff is the honest rendering of a change; the tool's own one-line output
  // is what the model reads, not what the user needs to review.
  const diff = after !== null ? { file: String(part.input.path ?? 'file'), before: before ?? '', after } : null

  return (
    <div className="tool" data-status={part.status} data-open={open || showProgress || undefined}>
      <button className="tool__head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="tool__glyph">
          {running ? (
            <ThinkingOrb size={14} state="searching" />
          ) : part.status === 'denied' ? (
            <Ban size={14} strokeWidth={2} />
          ) : part.status === 'error' ? (
            <TriangleAlert size={14} strokeWidth={2} />
          ) : (
            <Icon size={14} strokeWidth={1.9} />
          )}
        </span>
        <span className="tool__label">{label}</span>
        {detail && (
          <span className="tool__detail" data-prose={PROSE.has(part.name) || undefined}>
            {detail}
          </span>
        )}
        <ChevronRight size={14} strokeWidth={2} className="tool__chevron" />
      </button>

      {part.agents && part.agents.length > 0 && <SwarmCard agents={part.agents} />}
      {part.images && part.images.length > 0 && <ToolImages images={part.images} />}

      {showProgress && !open && (
        <div className="tool__panel">
          <pre className="tool__output tool__output--live scroll">{part.progress}</pre>
        </div>
      )}

      {open && (
        <div className="tool__panel">
          {diff && <FileDiff file={diff.file} before={diff.before} after={diff.after} />}
          {part.output !== null && part.output.length > 0 && (
            <pre className="tool__output scroll">{part.output}</pre>
          )}
          {running && part.progress && <pre className="tool__output tool__output--live scroll">{part.progress}</pre>}
          {running && !part.progress && <div className="tool__waiting shimmer">Running…</div>}
        </div>
      )}
    </div>
  )
})
