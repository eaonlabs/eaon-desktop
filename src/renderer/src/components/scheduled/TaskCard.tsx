import { memo, useState } from 'react'
import { ChevronDown, ChevronRight, Copy, Hammer, Loader2, MessagesSquare, Pencil, Play, RotateCcw, Square, Trash2 } from 'lucide-react'
import { describeSchedule, runReason, type ScheduledTask, type TaskRun } from '@shared/scheduler'
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
  onRetry: (task: ScheduledTask, run: TaskRun) => void
  onStop: (task: ScheduledTask) => void
  onOpenChat: (chatId: string) => void
}

const MACHINE = navigator.platform.startsWith('Mac') ? 'Mac' : 'computer'

const TRIGGER_LABEL: Record<TaskRun['trigger'], string> = {
  schedule: 'On schedule',
  manual: 'Run now',
  'catch-up': 'Caught up late',
  retry: 'Retry'
}

/** Runs worth running again: they didn't produce a result. */
const RETRYABLE = new Set<TaskRun['status']>(['failed', 'cancelled', 'missed', 'skipped'])

/** The line under a run: why it ran late or didn't run, else its error or its reply's first line. */
function runDetail(run: TaskRun): string | undefined {
  if (run.status === 'failed' || run.status === 'cancelled') return run.error
  return runReason(run, MACHINE) ?? run.summary ?? run.error
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

const ran = (run: TaskRun): boolean => run.status !== 'missed' && run.status !== 'skipped'

function tokenCount(run: TaskRun): string | null {
  const t = run.tokens
  if (!t) return null
  const total = t.input + t.output + t.cacheRead + t.cacheWrite
  return `${total.toLocaleString()} (${t.input.toLocaleString()} in, ${t.output.toLocaleString()} out${t.cacheRead ? `, ${t.cacheRead.toLocaleString()} cached` : ''})`
}

/**
 * One run in the history: a line that opens into its record — when it ran
 * and for how long, what started it, what it used, why it was late or didn't
 * run, the full error — with its chat and a Retry for one that didn't work.
 */
function RunRow({
  run,
  now,
  canRetry,
  onOpenChat,
  onRetry
}: {
  run: TaskRun
  now: number
  canRetry: boolean
  onOpenChat: (chatId: string) => void
  onRetry: (run: TaskRun) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const duration = run.finishedAt !== null && ran(run) ? formatDuration(run.finishedAt - run.startedAt) : null
  const detail = runDetail(run)
  const reason = runReason(run, MACHINE)
  const tokens = tokenCount(run)
  return (
    <div className="sched-run-item" data-open={open || undefined}>
      <button type="button" className="sched-run" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <StatusDot status={run.status} />
        <span className="sched-run__when">{formatStamp(run.slotAt ?? run.startedAt, now)}</span>
        <span className="sched-run__status" data-status={run.status}>
          {STATUS_LABEL[run.status]}
          {run.trigger === 'manual' ? ' · manual' : run.trigger === 'catch-up' ? ' · caught up' : run.trigger === 'retry' ? ' · retry' : ''}
        </span>
        <span className="sched-run__detail">{detail ?? ''}</span>
        {duration && <span className="sched-run__duration">{duration}</span>}
        {open ? <ChevronDown size={14} strokeWidth={2} className="sched-run__chevron" /> : <ChevronRight size={14} strokeWidth={2} className="sched-run__chevron" />}
      </button>
      {open && (
        <div className="sched-run__record">
          <dl className="sched-run__facts">
            <dt>Status</dt>
            <dd>{STATUS_LABEL[run.status]}</dd>
            <dt>{ran(run) ? 'Started' : run.status === 'skipped' ? 'Due' : 'Was due'}</dt>
            <dd>{formatWhen(run.slotAt ?? run.startedAt, now)}</dd>
            {ran(run) && run.slotAt !== undefined && run.slotAt !== run.startedAt && (
              <>
                <dt>Ran at</dt>
                <dd>{formatWhen(run.startedAt, now)}</dd>
              </>
            )}
            {ran(run) && (
              <>
                <dt>Finished</dt>
                <dd>{run.finishedAt !== null ? formatWhen(run.finishedAt, now) : 'Still running'}</dd>
              </>
            )}
            {duration && (
              <>
                <dt>Took</dt>
                <dd>{duration}</dd>
              </>
            )}
            <dt>Started by</dt>
            <dd>{TRIGGER_LABEL[run.trigger] ?? run.trigger}</dd>
            {tokens && (
              <>
                <dt>Tokens</dt>
                <dd>{tokens}</dd>
              </>
            )}
            {reason && (
              <>
                <dt>Why</dt>
                <dd>{reason}</dd>
              </>
            )}
            {run.summary && run.status === 'succeeded' && (
              <>
                <dt>Result</dt>
                <dd>{run.summary}</dd>
              </>
            )}
          </dl>
          {run.error && (run.status === 'failed' || run.status === 'cancelled') && (
            <pre className="sched-run__error">{run.error}</pre>
          )}
          <div className="sched-run__actions">
            {run.chatId && (
              <button type="button" className="btn btn--sm" onClick={() => onOpenChat(run.chatId!)}>
                <MessagesSquare size={13} strokeWidth={1.9} />
                Open chat
              </button>
            )}
            {RETRYABLE.has(run.status) && (
              <button
                type="button"
                className="btn btn--sm"
                disabled={!canRetry}
                title={canRetry ? undefined : 'Wait for the run in progress to finish'}
                onClick={() => onRetry(run)}
              >
                <RotateCcw size={13} strokeWidth={2} />
                Retry
              </button>
            )}
            {run.error && (run.status === 'failed' || run.status === 'cancelled') && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  void navigator.clipboard.writeText(run.error ?? '').then(() => setCopied(true))
                  window.setTimeout(() => setCopied(false), 1500)
                }}
              >
                <Copy size={13} strokeWidth={1.9} />
                {copied ? 'Copied' : 'Copy error'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
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
  onRetry,
  onStop,
  onOpenChat
}: Props): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  // A slot skipped while a run goes on is newer than that run; the run is
  // still the one in progress, and the last one that ran.
  const running = task.history.some((r) => r.status === 'running')
  const last = task.history.find((r) => r.status !== 'skipped') ?? task.history[0]
  const lastDetail = last ? runDetail(last) : undefined
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
                {!running && lastDetail && <span className="sched-last__detail">— {lastDetail}</span>}
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
              <p className="sched-history__policy">If a run is still going when the next one is due, that one is skipped, not stacked up.</p>
              {task.history.map((run) => (
                <RunRow key={run.id} run={run} now={now} canRetry={!running} onOpenChat={onOpenChat} onRetry={(r) => onRetry(task, r)} />
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  )
})
