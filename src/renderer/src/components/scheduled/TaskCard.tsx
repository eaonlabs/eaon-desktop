import { memo, useState } from 'react'
import { ChevronDown, ChevronRight, Hammer, Loader2, MessagesSquare, Pencil, Play, Square, Trash2 } from 'lucide-react'
import { describeSchedule, type ScheduledTask, type TaskRun } from '@shared/scheduler'
import { Switch } from '../ui'
import { formatDuration, formatRelative, formatStamp, formatWhen, STATUS_LABEL } from './format'

/** One scheduled task: what it does, when it runs next, how the last runs went. */

interface Props {
  task: ScheduledTask
  now: number
  modelLabel: string | null
  onEdit: (task: ScheduledTask) => void
  onDelete: (task: ScheduledTask) => void
  onToggle: (task: ScheduledTask, enabled: boolean) => void
  onRunNow: (task: ScheduledTask) => void
  onStop: (task: ScheduledTask) => void
  onOpenChat: (chatId: string) => void
}

function StatusDot({ status }: { status: TaskRun['status'] }): JSX.Element {
  if (status === 'running') return <Loader2 size={12} strokeWidth={2.4} className="spinner sched-status__spinner" aria-hidden />
  return <span className="sched-status__dot" data-status={status} aria-hidden />
}

function modeLabel(task: ScheduledTask): string {
  if (task.mode === 'chat') return 'Chat'
  return task.allowChanges ? 'Work · can make changes' : 'Work · read-only'
}

function nextRunText(task: ScheduledTask, now: number): string {
  if (task.nextRunAt !== null && task.enabled) return `${formatWhen(task.nextRunAt, now)} · ${formatRelative(task.nextRunAt, now)}`
  if (task.schedule.kind === 'once' && task.lastRunAt !== null) return 'Done — edit to pick a new time'
  if (task.schedule.kind === 'once' && task.schedule.at <= now) return 'Time has passed — edit to pick a new time'
  return 'Paused'
}

function RunRow({ run, now, onOpenChat }: { run: TaskRun; now: number; onOpenChat: (chatId: string) => void }): JSX.Element {
  const duration = run.finishedAt !== null && run.status !== 'missed' ? formatDuration(run.finishedAt - run.startedAt) : null
  const detail = run.status === 'failed' || run.status === 'missed' ? run.error : run.summary
  return (
    <button
      type="button"
      className="sched-run"
      disabled={!run.chatId}
      onClick={() => run.chatId && onOpenChat(run.chatId)}
      title={run.chatId ? 'Open this run’s chat' : undefined}
    >
      <StatusDot status={run.status} />
      <span className="sched-run__when">{formatStamp(run.startedAt, now)}</span>
      <span className="sched-run__status" data-status={run.status}>
        {STATUS_LABEL[run.status]}
        {run.trigger === 'manual' ? ' · manual' : run.trigger === 'catch-up' ? ' · caught up' : ''}
      </span>
      <span className="sched-run__detail">{detail ?? ''}</span>
      {duration && <span className="sched-run__duration">{duration}</span>}
      {run.chatId && <ChevronRight size={14} strokeWidth={2} className="sched-run__chevron" />}
    </button>
  )
}

export const TaskCard = memo(function TaskCard({
  task,
  now,
  modelLabel,
  onEdit,
  onDelete,
  onToggle,
  onRunNow,
  onStop,
  onOpenChat
}: Props): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const last = task.history[0]
  const running = last?.status === 'running'
  const Icon = task.mode === 'work' ? Hammer : MessagesSquare

  return (
    <article className="card sched-task" data-paused={!task.enabled || undefined} aria-label={task.name}>
      <div className="sched-task__head">
        <span className="sched-task__icon" data-mode={task.mode}>
          <Icon size={16} strokeWidth={1.9} />
        </span>
        <div className="sched-task__body">
          <h3 className="sched-task__name">{task.name}</h3>
          <div className="sched-task__meta">
            <span>{describeSchedule(task.schedule)}</span>
            <span aria-hidden>·</span>
            <span>{modeLabel(task)}</span>
            {modelLabel && (
              <>
                <span aria-hidden>·</span>
                <span>{modelLabel}</span>
              </>
            )}
          </div>
          <p className="sched-task__prompt">{task.prompt}</p>
        </div>
        <div className="sched-task__actions">
          {running ? (
            <button className="btn btn--sm" onClick={() => onStop(task)}>
              <Square size={11} strokeWidth={2.4} />
              Stop
            </button>
          ) : (
            <button className="btn btn--sm" onClick={() => onRunNow(task)}>
              <Play size={12} strokeWidth={2.2} />
              Run now
            </button>
          )}
          <button className="icon-btn" aria-label={`Edit ${task.name}`} title="Edit" onClick={() => onEdit(task)}>
            <Pencil size={14} strokeWidth={1.9} />
          </button>
          <button className="icon-btn" aria-label={`Delete ${task.name}`} title="Delete" onClick={() => onDelete(task)}>
            <Trash2 size={14} strokeWidth={1.9} />
          </button>
          <Switch label={`${task.enabled ? 'Pause' : 'Resume'} ${task.name}`} checked={task.enabled} onChange={(on) => onToggle(task, on)} />
        </div>
      </div>

      <dl className="sched-task__facts">
        <div className="sched-fact">
          <dt>Next run</dt>
          <dd>{nextRunText(task, now)}</dd>
        </div>
        <div className="sched-fact">
          <dt>Last run</dt>
          <dd>
            {last ? (
              <button
                type="button"
                className="sched-last"
                disabled={!last.chatId}
                onClick={() => last.chatId && onOpenChat(last.chatId)}
              >
                <StatusDot status={last.status} />
                <span className="sched-last__status" data-status={last.status}>
                  {STATUS_LABEL[last.status]}
                </span>
                <span className="sched-last__when">{running ? `started ${formatRelative(last.startedAt, now)}` : formatRelative(last.finishedAt ?? last.startedAt, now)}</span>
                {!running && (last.status === 'failed' || last.status === 'missed' ? last.error : last.summary) && (
                  <span className="sched-last__detail">
                    — {last.status === 'failed' || last.status === 'missed' ? last.error : last.summary}
                  </span>
                )}
              </button>
            ) : (
              <span className="sched-muted">Hasn’t run yet</span>
            )}
          </dd>
        </div>
      </dl>

      {task.history.length > 0 && (
        <div className="sched-history">
          <button type="button" className="sched-history__toggle" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
            {expanded ? <ChevronDown size={14} strokeWidth={2} /> : <ChevronRight size={14} strokeWidth={2} />}
            Run history
            <span className="sched-history__count">{task.history.length}</span>
          </button>
          {expanded && (
            <div className="sched-history__list">
              {task.history.map((run) => (
                <RunRow key={run.id} run={run} now={now} onOpenChat={onOpenChat} />
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  )
})
