import { useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { formatElapsed, PixelGrid, Spinner, useElapsed } from './Loaders'

/**
 * A run of steps — thinking and tool calls, in the order they happened —
 * folded into one quiet line.
 *
 * An agent turn makes a dozen calls between two sentences — list this folder,
 * read that file, load a skill — and a bordered card per call buried the
 * sentences they were in service of. The run now reads as one line of what
 * happened ("Thought, read 3 files and used 2 skills") that opens into the
 * steps themselves. While the run is live it stays open, and its line is the
 * step in progress, so the turn shows what it is doing as it does it.
 *
 * Shared by Chat (`ChatView`) and the ADE's agent view (`code/Thread`), which
 * name their tools differently; both map onto the kinds below.
 */

export interface ActivityCall {
  /** The tool's own name (`read_file`, `bash`…). */
  name: string
  status: 'preparing' | 'running' | 'done' | 'error' | 'denied'
  /** Its label and argument as the call's own row shows them. */
  label: string
  detail: string
}

type Kind =
  | 'read'
  | 'list'
  | 'search'
  | 'find'
  | 'web'
  | 'page'
  | 'edit'
  | 'write'
  | 'delete'
  | 'move'
  | 'run'
  | 'skill'
  | 'browser'
  | 'computer'
  | 'schedule'
  | 'agents'
  | 'team'
  | 'message'
  | 'check'
  | 'create'
  | 'heartbeat'
  | 'status'
  | 'plugin'
  | 'plan'
  | 'routine'
  | 'memory'
  | 'ask'
  | 'notify'
  | 'browse'
  | 'wait'
  | 'mail'
  | 'mailsend'
  | 'market'
  | 'trade'
  | 'session'
  | 'chatpost'
  | 'other'

const KIND: Record<string, Kind> = {
  read_file: 'read',
  read: 'read',
  list_dir: 'list',
  ls: 'list',
  grep: 'search',
  codebase_search: 'search',
  find_symbol: 'search',
  find_file: 'find',
  find: 'find',
  web_search: 'web',
  web_fetch: 'page',
  edit_file: 'edit',
  edit: 'edit',
  write_file: 'write',
  write: 'write',
  delete_file: 'delete',
  move_file: 'move',
  run_command: 'run',
  bash: 'run',
  powershell: 'run',
  load_skill: 'skill',
  browser: 'browser',
  computer: 'computer',
  schedule: 'schedule',
  spawn_agents: 'agents',
  subagent: 'agents',
  agent: 'agents',
  Agent: 'agents',
  SubagentWorkflow: 'agents',
  list_workers: 'team',
  message_worker: 'message',
  check_worker: 'check',
  create_worker: 'create',
  set_heartbeat: 'heartbeat',
  set_status: 'status',
  use_plugin_tool: 'plugin',
  plugin_tools: 'plugin',
  update_plan: 'plan',
  todo: 'plan',
  add_routine: 'routine',
  remove_routine: 'routine',
  set_goal: 'memory',
  update_notes: 'memory',
  ask_user: 'ask',
  notify_user: 'notify',
  web_browser: 'browse',
  wait: 'wait',
  email_inbox: 'mail',
  email_read: 'mail',
  email_send: 'mailsend',
  email_reply: 'mailsend',
  trading_account: 'market',
  trading_quote: 'market',
  trading_history: 'market',
  trading_order: 'trade',
  trading_cancel: 'trade',
  trading_session: 'session',
  send_chat_message: 'chatpost'
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
const names = (targets: string[]): string =>
  targets.length <= 2 ? targets.join(' and ') : `${targets.slice(0, 2).join(', ')} and ${targets.length - 2} more`

/** One clause per kind; `n` counts distinct targets where the kind has them (files, folders), else calls. */
const PHRASE: Record<Kind, (n: number, targets: string[]) => string> = {
  read: (n) => `read ${plural(n, 'file')}`,
  list: (n) => `listed ${plural(n, 'folder')}`,
  search: (n) => (n === 1 ? 'searched the files' : `ran ${n} searches`),
  find: (n) => (n === 1 ? 'looked for a file' : `looked for ${n} files`),
  web: (n) => (n === 1 ? 'searched the web' : `searched the web ${n} times`),
  page: (n) => `read ${plural(n, 'web page')}`,
  edit: (n) => `edited ${plural(n, 'file')}`,
  write: (n) => `wrote ${plural(n, 'file')}`,
  delete: (n) => `deleted ${plural(n, 'file')}`,
  move: (n) => `moved ${plural(n, 'file')}`,
  run: (n) => `ran ${plural(n, 'command')}`,
  skill: (n) => `used ${plural(n, 'skill')}`,
  browser: () => 'used the browser',
  computer: () => 'used the computer',
  schedule: (_n, targets) => (targets.length > 0 && targets.every((t) => t === 'list') ? 'checked the schedules' : 'updated schedules'),
  agents: (n) => (n === 1 ? 'ran a team of agents' : `ran ${n} teams of agents`),
  team: () => 'checked the team',
  message: (n, targets) => (targets.length ? `messaged ${names(targets)}` : `sent ${plural(n, 'message')}`),
  check: (n, targets) => (targets.length ? `checked on ${names(targets)}` : 'checked on a worker'),
  create: (n) => (n === 1 ? 'created a worker' : `created ${n} workers`),
  heartbeat: () => 'set a heartbeat',
  status: () => 'updated its status',
  plugin: (n) => `used ${plural(n, 'plugin tool')}`,
  plan: () => 'updated the plan',
  routine: (n) => (n === 1 ? 'set a routine' : `set ${n} routines`),
  memory: () => 'updated its notes',
  ask: (n) => (n === 1 ? 'asked you a question' : `asked you ${n} questions`),
  notify: () => 'let you know',
  browse: (n) => (n === 1 ? 'used its browser' : `took ${n} steps in its browser`),
  wait: (n) => (n === 1 ? 'waited' : `waited ${n} times`),
  mail: (n) => (n === 1 ? 'checked its email' : `read ${n} emails`),
  mailsend: (n) => (n === 1 ? 'sent an email' : `sent ${n} emails`),
  market: () => 'looked at the market',
  trade: (n) => (n === 1 ? 'placed an order' : `placed ${n} orders`),
  session: () => 'set up trading',
  chatpost: (n) => (n === 1 ? 'posted in a chat' : `posted ${n} times in chats`),
  other: (n) => `used ${plural(n, 'tool')}`
}

/** Kinds whose targets are worth counting distinctly (reading one file twice is still one file). */
const BY_TARGET = new Set<Kind>(['read', 'list', 'find', 'page', 'edit', 'write', 'delete', 'move', 'skill', 'message', 'check'])

export function activitySummary(calls: ActivityCall[]): { text: string; failed: number; blocked: number } {
  const failed = calls.filter((call) => call.status === 'error').length
  const blocked = calls.filter((call) => call.status === 'denied').length
  // What happened is what succeeded; the failures are counted beside it, so a
  // blocked write never reads as "wrote 1 file".
  const succeeded = calls.filter((call) => call.status !== 'error' && call.status !== 'denied')
  if (succeeded.length === 0) return { text: `Tried ${plural(calls.length, 'step')}`, failed, blocked }
  const order: Kind[] = []
  const counts = new Map<Kind, { calls: number; targets: Set<string> }>()
  for (const call of succeeded) {
    const kind = KIND[call.name] ?? 'other'
    let entry = counts.get(kind)
    if (!entry) {
      entry = { calls: 0, targets: new Set() }
      counts.set(kind, entry)
      order.push(kind)
    }
    entry.calls++
    if (call.detail) entry.targets.add(call.detail)
  }
  const clauses = order.map((kind) => {
    const entry = counts.get(kind)!
    const n = BY_TARGET.has(kind) && entry.targets.size > 0 ? entry.targets.size : entry.calls
    return PHRASE[kind](n, [...entry.targets])
  })
  // Three clauses read at a glance; past that the rest is counted, not listed.
  let text: string
  if (clauses.length <= 3) {
    text = clauses.length > 1 ? `${clauses.slice(0, -1).join(', ')} and ${clauses[clauses.length - 1]}` : clauses[0] ?? ''
  } else {
    const rest = order.slice(2).reduce((sum, kind) => sum + counts.get(kind)!.calls, 0)
    text = `${clauses.slice(0, 2).join(', ')} and ${plural(rest, 'other step')}`
  }
  return { text: text.charAt(0).toUpperCase() + text.slice(1), failed, blocked }
}

/** A run's line: what its calls did, led by "Thought" when it also thought. */
export function runSummary(calls: ActivityCall[], thoughts: number): { text: string; failed: number; blocked: number } {
  if (calls.length === 0) return { text: 'Thought about this', failed: 0, blocked: 0 }
  const summary = activitySummary(calls)
  if (thoughts === 0) return summary
  return { ...summary, text: `Thought, ${summary.text.charAt(0).toLowerCase()}${summary.text.slice(1)}` }
}

/** How long a live run has been going. Its own component, so the tick re-renders only the clock. */
function RunClock({ since }: { since: number }): JSX.Element | null {
  const elapsed = formatElapsed(useElapsed(since))
  return elapsed ? <span className="activity__clock">{elapsed}</span> : null
}

/** Past this many steps a live run shows a window onto its latest ones rather than growing. */
const WINDOW_AFTER = 4

export function ActivityGroup({
  calls,
  thoughts = 0,
  active = false,
  thinking = false,
  live,
  children
}: {
  calls: ActivityCall[]
  /** How many thoughts the run holds besides its calls. */
  thoughts?: number
  /** The run is the turn's latest and the turn is still going: it opens itself until the user says otherwise. */
  active?: boolean
  /** The run's latest step is a thought being written now. */
  thinking?: boolean
  /** Shown under the line while folded and a call is running: a command's output as it arrives. */
  live?: ReactNode
  /** The steps' own rows, shown when opened. */
  children: ReactNode
}): JSX.Element {
  // Null until the user picks: open while the run is live, folded once it is done.
  const [chosen, setChosen] = useState<boolean | null>(null)
  const open = chosen ?? active
  // When the run started, as far as this window saw it: only a live run shows its clock.
  const [since] = useState(() => Date.now())
  let current: ActivityCall | undefined
  for (let i = calls.length - 1; i >= 0 && !current; i--) {
    if (calls[i].status === 'running' || calls[i].status === 'preparing') current = calls[i]
  }
  const working = active && !current
  const summary = current || working ? null : runSummary(calls, thoughts)

  // A live run past a few steps scrolls inside a window that follows the
  // newest step, unless the reader has scrolled up in it to look back.
  const windowed = active && open && calls.length + thoughts > WINDOW_AFTER
  const list = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useLayoutEffect(() => {
    if (windowed && pinned.current && list.current) list.current.scrollTop = list.current.scrollHeight
  })

  return (
    <div className="activity" data-open={open || undefined} data-active={active || undefined}>
      <button className="activity__head" onClick={() => setChosen(!open)} aria-expanded={open}>
        {current ? (
          <>
            <span className="activity__orb">
              <Spinner />
            </span>
            <span className="activity__text step-shimmer">{current.label}</span>
            {current.detail && <span className="activity__detail">{current.detail}</span>}
          </>
        ) : working ? (
          <>
            <span className="activity__orb">
              <PixelGrid cell={3} />
            </span>
            <span className="activity__text step-shimmer">{thinking ? 'Thinking' : 'Working'}</span>
          </>
        ) : (
          <>
            <span className="activity__text">{summary!.text}</span>
            {summary!.failed > 0 && <span className="activity__flag">{summary!.failed} failed</span>}
            {summary!.blocked > 0 && <span className="activity__flag">{summary!.blocked} blocked</span>}
          </>
        )}
        {active && <RunClock since={since} />}
        <ChevronRight size={13} strokeWidth={2.2} className="activity__chevron" />
      </button>
      {!open && current && live}
      {open && (
        <div
          ref={list}
          className="activity__list scroll"
          data-window={windowed || undefined}
          onScroll={(event) => {
            const el = event.currentTarget
            pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
          }}
        >
          {children}
        </div>
      )}
    </div>
  )
}
