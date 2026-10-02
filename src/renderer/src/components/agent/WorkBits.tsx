import { memo, useMemo, useState, type JSX } from 'react'
import {
  Check,
  ChevronDown,
  CircleDashed,
  CircleDot,
  Lightbulb,
  Loader2,
  Pause,
  Play,
  Target,
  TriangleAlert,
  X
} from 'lucide-react'
import type { Chat, ChatMessage, GoalState, PlanProposal, SubagentRun, TodoItem, TokenUsage } from '@shared/types'
import { useApp } from '../../state/store'

/**
 * The pieces of a Work turn that are not text or a single tool call: the plan
 * waiting for approval, the agent's checklist, the goal it is pursuing, the
 * sub-agents a swarm started, screenshots, and what the turn cost.
 */

/* ------------------------------------------------------------------ plan */

export function PlanCard({ message, plan }: { message: ChatMessage; plan: PlanProposal }): JSX.Element {
  const approvePlan = useApp((s) => s.approvePlan)
  const streaming = useApp((s) => s.streamingMessageId !== null)
  const setComposerDraft = useApp((s) => s.setComposerDraft)
  const pending = plan.status === 'pending'

  return (
    <div className="plan-card" data-status={plan.status}>
      <div className="plan-card__head">
        <Lightbulb size={15} strokeWidth={1.9} />
        <span className="plan-card__title">{plan.title}</span>
        {plan.status === 'approved' && (
          <span className="plan-card__badge">
            <Check size={12} strokeWidth={2.4} />
            Approved
          </span>
        )}
      </div>
      {plan.summary && <p className="plan-card__summary">{plan.summary}</p>}
      <ol className="plan-card__steps">
        {plan.steps.map((step, index) => (
          <li key={index}>{step}</li>
        ))}
      </ol>
      {pending && (
        <div className="plan-card__actions">
          <button className="btn btn--ghost btn--sm" disabled={streaming} onClick={() => setComposerDraft('Change the plan: ')}>
            Revise
          </button>
          <button className="btn btn--primary btn--sm" disabled={streaming} onClick={() => approvePlan(message.id)}>
            <Play size={13} strokeWidth={2} />
            Approve and run
          </button>
        </div>
      )}
    </div>
  )
}

/* --------------------------------------------------------------- checklist */

const TODO_ICON = {
  done: <Check size={13} strokeWidth={2.4} />,
  in_progress: <CircleDot size={13} strokeWidth={2.2} />,
  pending: <CircleDashed size={13} strokeWidth={2} />
}

/** The latest checklist in the chat, pinned above the composer while it has open items. */
export function TodoPanel({ chat }: { chat: Chat }): JSX.Element | null {
  const todos = useMemo<TodoItem[] | null>(() => {
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      const list = chat.messages[i].todos
      if (list && list.length > 0) return list
    }
    return null
  }, [chat.messages])

  const [open, setOpen] = useState(false)

  if (!todos) return null
  const done = todos.filter((t) => t.status === 'done').length
  // A finished list has done its job; it stays in the transcript, not pinned.
  if (done === todos.length) return null
  // Folded, the panel is one line — the step in progress — so it does not
  // take a third of the window above the composer.
  const current = todos.find((t) => t.status === 'in_progress') ?? todos.find((t) => t.status === 'pending')

  return (
    <div className="todo-panel" data-open={open || undefined}>
      <button className="todo-panel__head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="todo-panel__title">Plan</span>
        <span className="todo-panel__count">
          {done}/{todos.length}
        </span>
        {!open && current && <span className="todo-panel__current">{current.text}</span>}
        <ChevronDown size={14} strokeWidth={2} className="todo-panel__chevron" />
      </button>
      {open && <ul className="todo-panel__list">
        {todos.map((todo, index) => (
          <li key={index} className="todo-panel__item" data-status={todo.status}>
            <span className="todo-panel__icon">{TODO_ICON[todo.status]}</span>
            <span>{todo.text}</span>
          </li>
        ))}
      </ul>}
    </div>
  )
}

/* ------------------------------------------------------------------ goal */

const GOAL_LABEL: Record<GoalState['status'], string> = {
  active: 'Working toward goal',
  achieved: 'Goal achieved',
  blocked: 'Blocked — needs you',
  paused: 'Goal paused'
}

export function GoalBanner({ chat }: { chat: Chat }): JSX.Element | null {
  const setGoalStatus = useApp((s) => s.setGoalStatus)
  const goal = chat.goal
  if (!goal) return null
  return (
    <div className="goal-banner" data-status={goal.status}>
      <span className="goal-banner__icon">
        {goal.status === 'blocked' ? <TriangleAlert size={14} strokeWidth={2} /> : goal.status === 'achieved' ? <Check size={14} strokeWidth={2.4} /> : <Target size={14} strokeWidth={2} />}
      </span>
      <span className="goal-banner__body">
        <span className="goal-banner__label">
          {GOAL_LABEL[goal.status]}
          {goal.until && goal.status === 'active'
            ? ` · until ${new Date(goal.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
            : goal.iterations > 0 && goal.status === 'active'
              ? ` · ${goal.iterations} continuation${goal.iterations === 1 ? '' : 's'}`
              : ''}
          {goal.status === 'paused' && goal.summary ? ` · ${goal.summary}` : ''}
        </span>
        <span className="goal-banner__text" title={goal.text}>
          {goal.text}
        </span>
      </span>
      {goal.status === 'active' && (
        <button className="icon-btn" aria-label="Pause goal" title="Pause goal" onClick={() => setGoalStatus('paused')}>
          <Pause size={14} strokeWidth={2} />
        </button>
      )}
      {goal.status === 'paused' && (
        <button className="icon-btn" aria-label="Resume goal" title="Resume goal on the next message" onClick={() => setGoalStatus('active')}>
          <Play size={14} strokeWidth={2} />
        </button>
      )}
      <button className="icon-btn" aria-label="Clear goal" title="Clear goal" onClick={() => setGoalStatus(null)}>
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  )
}

/* ----------------------------------------------------------------- swarm */

export const SwarmCard = memo(function SwarmCard({ agents }: { agents: SubagentRun[] }): JSX.Element {
  return (
    <div className="swarm">
      {agents.map((agent) => (
        <div key={agent.index} className="swarm__agent" data-status={agent.status}>
          <span className="swarm__status">
            {agent.status === 'running' ? (
              <Loader2 size={13} strokeWidth={2.2} className="spinner" />
            ) : agent.status === 'done' ? (
              <Check size={13} strokeWidth={2.4} />
            ) : agent.status === 'error' ? (
              <TriangleAlert size={13} strokeWidth={2} />
            ) : (
              <CircleDashed size={13} strokeWidth={2} />
            )}
          </span>
          <span className="swarm__role">{agent.role}</span>
          <span className="swarm__task" title={agent.task}>
            {agent.status === 'running' && agent.activity ? agent.activity : agent.task}
          </span>
          {agent.toolCalls > 0 && <span className="swarm__calls">{agent.toolCalls} steps</span>}
        </div>
      ))}
    </div>
  )
})

/* ----------------------------------------------------------- screenshots */

export function ToolImages({ images }: { images: string[] }): JSX.Element {
  return (
    <div className="tool-images">
      {images.map((path) => (
        <button key={path} className="tool-images__item" onClick={() => void window.api.app.showItem(path)} title="Show in folder">
          <img src={`eaon-file://${encodeURI(path)}`} alt="Screenshot" loading="lazy" />
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ usage */

const compact = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

/**
 * What a turn cost, with the cache share next to it — prompt caching is most
 * of the saving in a long agent turn, and this is where it becomes visible.
 */
export function UsageLine({ usage }: { usage: TokenUsage }): JSX.Element | null {
  const input = usage.input + usage.cacheRead + usage.cacheWrite
  if (input === 0 && usage.output === 0) return null
  const cached = input > 0 ? Math.round((usage.cacheRead / input) * 100) : 0
  return (
    <span className="usage-line" title={`${usage.input.toLocaleString()} uncached input · ${usage.cacheRead.toLocaleString()} cache reads · ${usage.cacheWrite.toLocaleString()} cache writes · ${usage.output.toLocaleString()} output`}>
      {compact(input)} in · {compact(usage.output)} out{cached > 0 ? ` · ${cached}% cached` : ''}
    </span>
  )
}
