import type { AgentMode, StreamEvent } from '@shared/types'
import type { AgentRunSource, UsageSource } from '@shared/usage'
import { store } from '../../store'
import { localDay } from './ledger'

/**
 * Eaon's agent runs, counted on this computer for Settings → Usage and the
 * Tokn profiles (Agents, Longest agent). One run is one task an agent works
 * on from the prompt to its final answer: a Work task, a worker's turn, a
 * scheduled task, or a Chat turn on an agent engine. A run that never called
 * a tool was a reply, not an agent at work, and isn't counted.
 *
 * Kept as totals per local day and source rather than a line per run: a
 * worker that wakes every few minutes makes hundreds of runs a day, and a
 * year of those is more than a settings file should hold. A run is counted
 * when it ends, under the day it started; one cut off by a crash or a quit
 * is never counted. Its time is the time it was working, which leaves out
 * any time the computer slept.
 */

const FILE = 'agent-runs.json'
/** Like the usage ledger: a little over a year. */
const KEEP_DAYS = 400
const SAVE_DELAY_MS = 1500
/** One run is never counted as longer than this: a goal left running for days is still one day's work. */
export const MAX_RUN_MS = 24 * 3_600_000

export interface AgentRunTotals {
  runs: number
  totalMs: number
  longestMs: number
}

/** day → source → totals. */
export type AgentRunDays = Record<string, Partial<Record<AgentRunSource, AgentRunTotals>>>

const SOURCES = new Set<AgentRunSource>(['chat', 'work', 'worker', 'scheduled'])

let days: AgentRunDays | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const whole = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0)

/** The days as saved, with anything that isn't a day of totals left out and every number whole. */
export function cleanAgentRuns(raw: unknown): AgentRunDays {
  const clean: AgentRunDays = {}
  if (!isObject(raw)) return clean
  for (const [day, bySource] of Object.entries(raw)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !isObject(bySource)) continue
    for (const [source, totals] of Object.entries(bySource)) {
      if (!SOURCES.has(source as AgentRunSource) || !isObject(totals)) continue
      const runs = whole(totals.runs)
      if (runs === 0) continue
      const longestMs = Math.min(whole(totals.longestMs), MAX_RUN_MS)
      ;(clean[day] ??= {})[source as AgentRunSource] = { runs, totalMs: Math.max(whole(totals.totalMs), longestMs), longestMs }
    }
  }
  return clean
}

function load(): AgentRunDays {
  days ??= cleanAgentRuns(store.getJson<{ days?: unknown }>(FILE, {}).days)
  return days
}

/** Counts one finished run. `workingMs` is capped at MAX_RUN_MS. */
export function recordAgentRun(source: AgentRunSource, startedAt: Date, workingMs: number, now: Date = new Date()): void {
  if (!SOURCES.has(source)) return
  const ms = Math.min(whole(workingMs), MAX_RUN_MS)
  const totals = ((load()[localDay(startedAt)] ??= {})[source] ??= { runs: 0, totalMs: 0, longestMs: 0 })
  totals.runs += 1
  totals.totalMs += ms
  totals.longestMs = Math.max(totals.longestMs, ms)
  scheduleSave(now)
  for (const listener of listeners) listener()
}

/**
 * What a run counts as, or null when it isn't an agent: a plain Chat turn on
 * Eaon's own loop (web search at most), a trading session, or a request
 * another app made through Eaon.
 */
export function agentRunSource(mode: AgentMode, onEngine: boolean, usage: UsageSource): AgentRunSource | null {
  if (mode !== 'work' && !onEngine) return null
  if (usage === 'worker') return 'worker'
  if (usage === 'schedule') return 'scheduled'
  if (usage === 'chat') return mode === 'work' ? 'work' : 'chat'
  return null
}

/**
 * Watches one run's events: `emit` passes them on, noting whether a tool was
 * called, and `finish` counts the run once it has ended, if it did call one.
 * A null source watches nothing.
 */
export function trackAgentRun(
  source: AgentRunSource | null,
  emit: (event: StreamEvent) => void
): { emit: (event: StreamEvent) => void; finish: () => void } {
  if (!source) return { emit, finish: () => undefined }
  const startedAt = new Date()
  // Monotonic, like the scheduler's watchdog: time asleep does not count.
  const started = performance.now()
  let usedTools = false
  let finished = false
  return {
    emit: (event) => {
      if (event.type === 'tool-call') usedTools = true
      emit(event)
    },
    finish: () => {
      if (finished) return
      finished = true
      if (usedTools) recordAgentRun(source, startedAt, performance.now() - started)
    }
  }
}

export function agentRunDays(): AgentRunDays {
  return load()
}

/** Called after every counted run. */
export function onAgentRun(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function scheduleSave(now: Date): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    prune(now)
    store.setJsonAsync(FILE, { version: 1, days: load() })
  }, SAVE_DELAY_MS)
}

function prune(now: Date): void {
  const oldest = localDay(new Date(now.getTime() - KEEP_DAYS * 86_400_000))
  const all = load()
  for (const day of Object.keys(all)) if (day < oldest) delete all[day]
}

/** Writes anything still waiting, at quit. */
export function flushAgentRuns(now: Date = new Date()): void {
  if (!saveTimer) return
  clearTimeout(saveTimer)
  saveTimer = null
  prune(now)
  store.setJson(FILE, { version: 1, days: load() })
}

/** Tests: forget the in-memory copy so the next read comes from disk. */
export function resetAgentRunsForTests(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  days = null
}
