import type { ChatMessage, ChatToolPart } from '@shared/types'
import { activitySummary, type ActivityCall } from '../agent/Activity'

/**
 * A reply as a work log, the way Chat lays it out: its sentences, each
 * thought on a line of its own, and between them each run of tool calls
 * folded to one line of what it did — "Read 2 files and ran 1 command",
 * "Changed 1 file" — that opens into the calls. Kept free of React so the
 * test harness can run it.
 */

export type LogItem =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'thought'; key: string; text: string }
  | { kind: 'tools'; key: string; parts: ChatToolPart[] }
  /** A call whose result is something to look at, not a line: a swarm's agents, a generated picture. */
  | { kind: 'own'; key: string; part: ChatToolPart }

/** Calls another part of the screen already shows: the Plan panel above the composer, the plan card. */
const SHOWN_ELSEWHERE = new Set(['update_plan', 'present_plan'])
const OWN = new Set(['spawn_agents', 'generate_image'])

/**
 * The parts in order. A run of calls stays one item until a sentence or a
 * thought comes between; whitespace doesn't split it. A run keeps its first
 * call's key as it grows, so whether it is open survives streaming.
 */
export function workLog(parts: ChatMessage['parts']): LogItem[] {
  const items: LogItem[] = []
  parts.forEach((part, index) => {
    if (part.type === 'text') {
      if (part.text.trim()) items.push({ kind: 'text', key: `t${index}`, text: part.text })
      return
    }
    if (part.type === 'reasoning') {
      if (part.text.trim()) items.push({ kind: 'thought', key: `r${index}`, text: part.text })
      return
    }
    if (part.type !== 'tool' || SHOWN_ELSEWHERE.has(part.name)) return
    if (OWN.has(part.name)) {
      items.push({ kind: 'own', key: part.id, part })
      return
    }
    const last = items[items.length - 1]
    if (last?.kind === 'tools') last.parts.push(part)
    else items.push({ kind: 'tools', key: part.id, parts: [part] })
  })
  return items
}

/** What a run's line says it did, grouped by the kind of call. */
export type StepKind = 'read' | 'list' | 'search' | 'web' | 'page' | 'edit' | 'command' | 'skill' | 'browser' | 'computer' | 'agent' | 'other'

const KIND: Record<string, StepKind> = {
  read_file: 'read',
  read: 'read',
  list_dir: 'list',
  ls: 'list',
  grep: 'search',
  codebase_search: 'search',
  find_symbol: 'search',
  find_file: 'search',
  find: 'search',
  web_search: 'web',
  web_fetch: 'page',
  edit_file: 'edit',
  write_file: 'edit',
  delete_file: 'edit',
  move_file: 'edit',
  edit: 'edit',
  write: 'edit',
  run_command: 'command',
  bash: 'command',
  powershell: 'command',
  load_skill: 'skill',
  browser: 'browser',
  web_browser: 'browser',
  computer: 'computer',
  subagent: 'agent',
  agent: 'agent'
}

export const stepKind = (name: string): StepKind => KIND[name] ?? 'other'

/** Kinds counted by what they touched (one file read twice is one file), not by calls. */
const BY_TARGET = new Set<StepKind>(['read', 'list', 'edit', 'page', 'skill'])
/** The kinds a line leads with: what changed things comes before what looked at them. */
const FIRST = new Set<StepKind>(['command', 'edit'])

const n = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`

const LABEL: Record<Exclude<StepKind, 'other'>, (count: number) => string> = {
  read: (c) => `Read ${n(c, 'file')}`,
  list: (c) => `Listed ${n(c, 'folder')}`,
  search: (c) => (c === 1 ? 'Searched the code' : `Searched the code ${c} times`),
  web: (c) => (c === 1 ? 'Searched the web' : `Searched the web ${c} times`),
  page: (c) => `Read ${n(c, 'web page')}`,
  edit: (c) => `Changed ${n(c, 'file')}`,
  command: (c) => `Ran ${n(c, 'command')}`,
  skill: (c) => `Used ${n(c, 'skill')}`,
  browser: (c) => (c === 1 ? 'Used the browser' : `Used the browser ${c} times`),
  computer: (c) => (c === 1 ? 'Used the computer' : `Used the computer ${c} times`),
  agent: (c) => `Ran ${n(c, 'agent')}`
}

/** A call as the line counts it: its tool, how it ended, and what it touched. */
export interface StepCall {
  name: string
  status: ActivityCall['status']
  /** The file, folder or page it touched, when it has one. */
  target: string
  /** Its own row's words, for the calls this table doesn't name (a worker's tools). */
  label: string
}

export interface StepSummary {
  text: string
  /** Calls that failed or were refused. */
  failed: number
  /** One kind for an icon, or 'mixed'. */
  kind: StepKind | 'mixed'
}

/**
 * A run's line: two kinds at most, those that changed things first ("Ran 2
 * commands and read 3 files"), with any other kinds counted after ("and 2
 * other steps"). Calls the table doesn't name read in their own words, the
 * way a worker's thread says "Messaged Pixel".
 */
export function stepSummary(calls: StepCall[]): StepSummary {
  const failed = calls.filter((c) => c.status === 'error' || c.status === 'denied').length
  const kinds = new Set(calls.map((c) => stepKind(c.name)))
  const kind: StepSummary['kind'] = kinds.size === 1 ? [...kinds][0] : 'mixed'
  const groups: { kind: StepKind; first: number; calls: StepCall[] }[] = []
  calls.forEach((call, index) => {
    const k = stepKind(call.name)
    const group = groups.find((g) => g.kind === k)
    if (group) group.calls.push(call)
    else groups.push({ kind: k, first: index, calls: [call] })
  })
  const named = groups.filter((g) => g.kind !== 'other')
  const other = groups.find((g) => g.kind === 'other')
  const chosen = [...named].sort((a, b) => Number(FIRST.has(b.kind)) - Number(FIRST.has(a.kind)) || a.first - b.first).slice(0, 2).sort((a, b) => a.first - b.first)
  const clauses = chosen.map((g) => {
    const targets = new Set(g.calls.map((c) => c.target).filter(Boolean))
    const count = BY_TARGET.has(g.kind) && targets.size > 0 ? targets.size : g.calls.length
    return LABEL[g.kind as Exclude<StepKind, 'other'>](count)
  })
  const leftOver = named.filter((g) => !chosen.includes(g)).reduce((sum, g) => sum + g.calls.length, 0)
  if (other) {
    // A worker's own tools say what they did; past two clauses they are counted with the rest.
    if (clauses.length < 2 && leftOver === 0) clauses.push(activitySummary(other.calls.map((c) => ({ name: c.name, status: c.status, label: c.label, detail: c.target }))).text)
    else clauses.push(n(other.calls.length + leftOver, 'other step'))
  } else if (leftOver > 0) clauses.push(n(leftOver, 'other step'))
  const text = clauses.map((c, i) => (i === 0 ? c : c.charAt(0).toLowerCase() + c.slice(1))).join(clauses.length > 2 ? ', ' : ' and ')
  return { text: clauses.length > 2 ? text.replace(/, ([^,]*)$/, ', and $1') : text, failed, kind }
}

const LIVE: Partial<Record<StepKind, string>> = {
  read: 'Reading',
  list: 'Listing',
  search: 'Searching',
  web: 'Searching the web for',
  page: 'Reading',
  edit: 'Editing',
  command: 'Running',
  skill: 'Loading',
  browser: 'Using the browser',
  computer: 'Using the computer',
  agent: 'Running'
}

/** The line while a call runs: "Running npm test", "Editing src/app.ts". */
export function liveStep(call: StepCall): string {
  const kind = stepKind(call.name)
  if (call.name === 'write_file') return `Writing ${call.target}`.trim()
  const verb = LIVE[kind]
  if (!verb) return call.target ? `${call.label} ${call.target}` : call.label
  return call.target && kind !== 'browser' && kind !== 'computer' ? `${verb} ${call.target}` : verb
}

/** A thought as it opens: without the leading `**Title**` its line already shows. */
export function thoughtRest(text: string): string {
  const heading = /^\s*\*\*([^*\r\n]+)\*\*[ \t]*\r?(?:\n|$)/.exec(text)
  return heading ? text.slice(heading[0].length).trim() : text
}

/**
 * A thought's line: its summary's first `**Title**`, or else its first
 * sentence, as plain text.
 */
export function thoughtLine(text: string): string {
  const heading = /^\s*\*\*([^*\r\n]+)\*\*[ \t]*\r?(?:\n|$)/.exec(text)?.[1]
  const plain = (heading ?? text)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+\.)[ \t]+/gm, '')
    .replace(/`+|\*\*|~~/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (heading !== undefined) return plain
  const end = /[.?!]["'”’)]?(?=\s)/.exec(plain)
  return end ? plain.slice(0, end.index + end[0].length) : plain
}
