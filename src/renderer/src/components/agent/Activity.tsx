/**
 * What a run of calls did, as a clause per kind of call ("read 3 files,
 * messaged Pixel and set a routine"): the words Chat's work log uses for the
 * tools its own table doesn't name (chat/workLog.ts), a worker's tools among
 * them.
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
