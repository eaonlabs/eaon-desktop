import { EventEmitter } from 'node:events'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { StreamEvent } from '@shared/types'
import { onTradingAgentEvent, tradingEngine } from '@main/features/trading'
import { events, hasHandler, invoke, ipc } from '../runtime/ipc'
import { cliHome } from '../runtime/paths'

/**
 * Everything the trading agent does in its sessions, step by step, for the
 * desk's activity feed: each check, what it thought, every tool it called
 * (scans, quotes, history, news, orders, stops) with what came back, and
 * what it concluded.
 *
 * The engine keeps only a session's decisions, orders and notes; the steps
 * come from the agent's stream events (`onTradingAgentEvent`). The session
 * that runs the engines records them, keeps them in the CLI profile so they
 * outlive a restart, and publishes changes on `trading:activity`, which the
 * bus carries to every other terminal. Those ask the owner for a session's
 * steps the first time they show it (`trading:activity` as a call).
 */

export interface AgentStep {
  id: string
  at: number
  /** Which check of the session this belongs to, counted as the engine does. */
  check: number
  kind: 'check' | 'thought' | 'tool' | 'answer'
  tool?: string
  input?: Record<string, unknown>
  output?: string
  status?: 'running' | 'done' | 'error' | 'denied'
  /** A thought's or the answer's text. */
  text?: string
  endedAt?: number
}

export interface ActivityUpdate {
  sessionId: string
  steps: AgentStep[]
}

const MAX_STEPS = 800
const MAX_SESSIONS = 12
const TEXT_CAP = 3000
const OUTPUT_CAP = 1500
const file = (): string => join(cliHome(), 'trading-activity.json')

/** A long thought keeps its start and its newest part, which is what the feed shows. */
function capText(text: string): string {
  return text.length <= TEXT_CAP ? text : `${text.slice(0, TEXT_CAP / 2)} … ${text.slice(-TEXT_CAP / 2)}`
}

function capInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input ?? {})) out[k] = typeof v === 'string' && v.length > 400 ? `${v.slice(0, 400)}…` : v
  return out
}

class ActivityBook extends EventEmitter {
  private bySession = new Map<string, AgentStep[]>()
  /** Sessions whose steps this process has (all of them, in the session that records). */
  private known = new Set<string>()
  private asking = new Set<string>()
  recording = false

  /** A session's steps, oldest first. Another terminal asks the owner once, then follows its updates. */
  of(sessionId: string): AgentStep[] {
    if (!this.recording && !this.known.has(sessionId) && !this.asking.has(sessionId) && hasHandler('trading:activity')) {
      this.asking.add(sessionId)
      void invoke<AgentStep[]>('trading:activity', sessionId)
        .then((steps) => {
          this.known.add(sessionId)
          this.merge({ sessionId, steps: steps ?? [] })
        })
        .catch(() => {})
        .finally(() => this.asking.delete(sessionId))
    }
    return this.bySession.get(sessionId) ?? []
  }

  /** Adds or replaces steps by id. */
  merge(update: ActivityUpdate): void {
    const list = this.bySession.get(update.sessionId) ?? []
    const index = new Map(list.map((s, i) => [s.id, i]))
    for (const step of update.steps) {
      const at = index.get(step.id)
      if (at === undefined) {
        index.set(step.id, list.length)
        list.push(step)
      } else if (list[at] !== step) list[at] = step
    }
    list.sort((a, b) => a.at - b.at)
    if (list.length > MAX_STEPS) list.splice(0, list.length - MAX_STEPS)
    this.bySession.set(update.sessionId, list)
    this.emit('change', update.sessionId)
  }

  /** For saving: the newest sessions' steps. */
  dump(): Record<string, AgentStep[]> {
    const newest = [...this.bySession.entries()].sort((a, b) => (b[1].at(-1)?.at ?? 0) - (a[1].at(-1)?.at ?? 0)).slice(0, MAX_SESSIONS)
    return Object.fromEntries(newest)
  }

  load(saved: Record<string, AgentStep[]>): void {
    for (const [sessionId, steps] of Object.entries(saved)) {
      if (!Array.isArray(steps)) continue
      this.known.add(sessionId)
      // A step left running by a quit never finished.
      this.merge({ sessionId, steps: steps.map((s) => (s.status === 'running' ? { ...s, status: 'error' as const, output: s.output ?? 'Interrupted.' } : s)) })
    }
  }

  markKnown(sessionId: string): void {
    this.known.add(sessionId)
  }
}

export const activity = new ActivityBook()
activity.setMaxListeners(50)

// Every terminal follows the owner's updates (the owner hears its own too; merging them again changes nothing).
events.on('trading:activity', (update: ActivityUpdate) => {
  if (!activity.recording && update?.sessionId && Array.isArray(update.steps)) activity.merge(update)
})

/** One check in progress: the steps it is still adding to. */
interface Live {
  messageId: string
  check: AgentStep
  thought: AgentStep | null
  answer: AgentStep | null
  tools: Map<string, AgentStep>
  rounds: number
}

/**
 * Starts recording the trading agent's steps. Called by the session that
 * runs the engines, once they are registered; returns a stop function.
 */
export function recordTradingActivity(subscribe: typeof onTradingAgentEvent = onTradingAgentEvent): () => void {
  activity.recording = true
  try {
    activity.load(JSON.parse(readFileSync(file(), 'utf8')) as Record<string, AgentStep[]>)
  } catch {
    /* nothing saved yet */
  }
  ipc.handle('trading:activity', (_event, sessionId: unknown) => activity.of(String(sessionId ?? '')))

  const live = new Map<string, Live>()
  const dirty = new Map<string, Map<string, AgentStep>>()
  let flush: ReturnType<typeof setTimeout> | null = null
  let save: ReturnType<typeof setTimeout> | null = null

  const touched = (sessionId: string, step: AgentStep): void => {
    const set = dirty.get(sessionId) ?? new Map<string, AgentStep>()
    set.set(step.id, step)
    dirty.set(sessionId, set)
    if (!flush)
      flush = setTimeout(() => {
        flush = null
        for (const [id, steps] of dirty) {
          const update = { sessionId: id, steps: [...steps.values()] }
          activity.merge(update)
          // Copies, so other terminals get the step as it is now.
          events.emit('trading:activity', { sessionId: id, steps: update.steps.map((s) => ({ ...s })) })
        }
        dirty.clear()
        if (!save)
          save = setTimeout(() => {
            save = null
            try {
              mkdirSync(dirname(file()), { recursive: true })
              const tmp = `${file()}.tmp`
              writeFileSync(tmp, JSON.stringify(activity.dump()))
              renameSync(tmp, file())
            } catch (error) {
              console.error('[trading activity] could not save:', error)
            }
          }, 1500)
      }, 120)
  }

  const close = (step: AgentStep | null, now: number): void => {
    if (step && step.endedAt === undefined) step.endedAt = now
  }

  const stop = subscribe((sessionId, event: StreamEvent) => {
    const now = Date.now()
    activity.markKnown(sessionId)
    let current = live.get(sessionId)
    if (!current || current.messageId !== event.messageId) {
      if (current) close(current.check, now)
      // Eaon's agent: the engine counts a check once it ends, so this is the next one. Claude Code's checks
      // are counted when it takes them, and their ids carry the number (`claude-code:<session>:<n>`).
      const external = /^claude-code:.+:(\d+)$/.exec(event.messageId)
      const number = external ? Number(external[1]) : (tradingEngine()?.activeSession()?.checks ?? 0) + 1
      const check: AgentStep = { id: `${event.messageId}:check`, at: now, check: number, kind: 'check' }
      current = { messageId: event.messageId, check, thought: null, answer: null, tools: new Map(), rounds: 0 }
      live.set(sessionId, current)
      touched(sessionId, check)
    }
    const c = current
    const fresh = (kind: 'thought' | 'answer'): AgentStep => {
      c.rounds++
      return { id: `${c.messageId}:${kind}:${c.rounds}`, at: now, check: c.check.check, kind, text: '' }
    }
    switch (event.type) {
      case 'reasoning': {
        if (!c.thought) c.thought = fresh('thought')
        c.thought.text = capText((c.thought.text ?? '') + event.text)
        touched(sessionId, c.thought)
        break
      }
      case 'delta': {
        close(c.thought, now)
        c.thought = null
        if (!c.answer) c.answer = fresh('answer')
        c.answer.text = capText((c.answer.text ?? '') + event.text)
        touched(sessionId, c.answer)
        break
      }
      case 'tool-call': {
        // A tool call ends the round's thinking and talking; the next round starts new ones.
        for (const step of [c.thought, c.answer]) {
          close(step, now)
          if (step) touched(sessionId, step)
        }
        c.thought = null
        c.answer = null
        const step: AgentStep = { id: `${c.messageId}:tool:${event.toolId}`, at: now, check: c.check.check, kind: 'tool', tool: event.name, input: capInput(event.input), status: 'running' }
        c.tools.set(event.toolId, step)
        touched(sessionId, step)
        break
      }
      case 'tool-result': {
        const step = c.tools.get(event.toolId)
        if (!step) break
        step.status = event.status
        step.output = event.output.length > OUTPUT_CAP ? `${event.output.slice(0, OUTPUT_CAP)}…` : event.output
        step.endedAt = now
        touched(sessionId, step)
        break
      }
      case 'done':
      case 'error': {
        for (const step of [c.thought, c.answer, c.check]) {
          close(step, now)
          if (step) touched(sessionId, step)
        }
        for (const step of c.tools.values()) {
          if (step.status !== 'running') continue
          step.status = 'error'
          step.endedAt = now
          touched(sessionId, step)
        }
        live.delete(sessionId)
        break
      }
    }
  })

  return () => {
    stop()
    activity.recording = false
    if (flush) clearTimeout(flush)
    if (save) clearTimeout(save)
  }
}
