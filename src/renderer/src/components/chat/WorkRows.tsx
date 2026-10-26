import { memo, useMemo, useState, type JSX } from 'react'
import { Bot, Brain, Check, ChevronRight, Circle, Eye, FolderSearch, Globe, Hammer, ListChecks, MonitorSmartphone, Puzzle, Search, SquarePen, Terminal, Wrench } from 'lucide-react'
import type { ChatToolPart, TodoItem } from '@shared/types'
import { Markdown } from '../agent/Markdown'
import { describeToolPart, ToolCall } from '../agent/ToolCall'
import { liveStep, stepKind, stepSummary, thoughtLine, thoughtRest, type StepCall, type StepKind } from './workLog'

/**
 * A reply's work, line by line: each run of calls as one quiet line of what
 * it did, opening into the calls themselves, and each thought as a line of
 * its own. While a run is going its line says what it is doing now.
 */

const ICON: Record<StepKind | 'mixed', typeof Eye> = {
  read: Eye,
  list: FolderSearch,
  search: Search,
  web: Globe,
  page: Globe,
  edit: SquarePen,
  command: Terminal,
  skill: Puzzle,
  browser: Globe,
  computer: MonitorSmartphone,
  agent: Bot,
  other: Wrench,
  mixed: Hammer
}

const toCall = (part: ChatToolPart): StepCall => {
  const described = describeToolPart(part)
  return { name: part.name, status: part.status, target: described.detail, label: described.label }
}

/** A run of calls: "Read 2 files and ran 1 command", opening into each call's own row. */
export const ToolRun = memo(function ToolRun({ parts }: { parts: ChatToolPart[] }): JSX.Element {
  const [open, setOpen] = useState(false)
  const calls = useMemo(() => parts.map(toCall), [parts])
  const summary = useMemo(() => stepSummary(calls), [calls])
  let running: StepCall | null = null
  for (let i = calls.length - 1; i >= 0 && !running; i--) if (calls[i].status === 'running' || calls[i].status === 'preparing') running = calls[i]
  const Icon = ICON[running ? stepKind(running.name) : summary.kind]
  const label = running ? liveStep(running) : summary.text
  return (
    <div className="wl" data-open={open || undefined}>
      <button type="button" className="wl-row" aria-expanded={open} onClick={() => setOpen(!open)} title={open ? 'Hide the steps' : 'Show the steps'}>
        <span className="wl-row__icon" aria-hidden>
          <Icon size={16} strokeWidth={1.8} />
        </span>
        <span className={`wl-row__label${running ? ' step-shimmer' : ''}`}>{label}</span>
        {!running && summary.failed > 0 && <span className="wl-row__failed">{summary.failed} failed</span>}
        {/* Stopped by you or refused by the run's rules: not a failure, and not red. */}
        {!running && summary.skipped > 0 && <span className="wl-row__failed" data-skipped>{summary.skipped} skipped</span>}
        <ChevronRight size={14} strokeWidth={2} className="wl-row__chev" aria-hidden />
      </button>
      {open && (
        <div className="wl__calls">
          {parts.map((part) => (
            <ToolCall key={part.id} part={part} />
          ))}
        </div>
      )}
    </div>
  )
})

/**
 * A thought: its line (the summary's title, or its first sentence) in full,
 * opening into the reasoning. The one being written now says Thinking.
 */
export const ThoughtRow = memo(function ThoughtRow({ text, live }: { text: string; live: boolean }): JSX.Element {
  const [open, setOpen] = useState(false)
  const line = useMemo(() => thoughtLine(text), [text])
  const more = text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().length > line.length + 2
  if (live) {
    return (
      <div className="wl wl--thought">
        <div className="wl-row" data-static>
          <span className="wl-row__icon" aria-hidden>
            <Brain size={16} strokeWidth={1.8} />
          </span>
          <span className="wl-row__label step-shimmer">Thinking</span>
        </div>
      </div>
    )
  }
  return (
    <div className="wl wl--thought" data-open={open || undefined}>
      <button
        type="button"
        className="wl-row wl-row--wrap"
        aria-expanded={more ? open : undefined}
        data-static={!more || undefined}
        onClick={() => more && setOpen(!open)}
      >
        <span className="wl-row__icon" aria-hidden>
          <Brain size={16} strokeWidth={1.8} />
        </span>
        <span className="wl-row__label">{line || 'Thought'}</span>
        {more && <ChevronRight size={14} strokeWidth={2} className="wl-row__chev" aria-hidden />}
      </button>
      {open && (
        <div className="wl__thought">
          <Markdown text={thoughtRest(text)} />
        </div>
      )}
    </div>
  )
})

/**
 * A reply's plan once it is no longer pinned above the composer (all its
 * steps done, or a later reply came): one line, opening into the steps.
 */
export const PlanRow = memo(function PlanRow({ todos }: { todos: TodoItem[] }): JSX.Element {
  const [open, setOpen] = useState(false)
  const done = todos.filter((t) => t.status === 'done').length
  const label = done === todos.length ? `Plan · ${todos.length === 1 ? 'its step' : `all ${todos.length} steps`} done` : `Plan · ${done} of ${todos.length} steps done`
  return (
    <div className="wl" data-open={open || undefined}>
      <button type="button" className="wl-row" aria-expanded={open} onClick={() => setOpen(!open)} title={open ? 'Hide the plan' : 'Show the plan'}>
        <span className="wl-row__icon" aria-hidden>
          <ListChecks size={16} strokeWidth={1.8} />
        </span>
        <span className="wl-row__label">{label}</span>
        <ChevronRight size={14} strokeWidth={2} className="wl-row__chev" aria-hidden />
      </button>
      {open && (
        <ol className="wl__plan">
          {todos.map((todo, index) => (
            <li key={index} data-status={todo.status}>
              {todo.status === 'done' ? <Check size={13} strokeWidth={2.4} aria-label="Done" /> : <Circle size={11} strokeWidth={2} aria-label="Not done" />}
              <span>{todo.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
})
