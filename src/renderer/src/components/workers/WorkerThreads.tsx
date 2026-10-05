import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  Archive,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  Clock,
  History,
  Loader2,
  MessageCircleQuestion,
  MessagesSquare,
  PanelRight,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X
} from 'lucide-react'
import {
  DELEGATION_LABEL,
  MAIN_THREAD,
  describeWorker,
  relativeTime,
  type ExecutionState,
  type Worker,
  type WorkerDelegation,
  type WorkerExecution,
  type WorkerThreadInfo
} from '@shared/workers'
import { useApp } from '../../state/store'
import { MenuItem, MenuSearch, Popover, useDisclosure } from '../ui'
import { WorkerFace } from './WorkerFace'
import { useWorkers } from './workersStore'

/**
 * A worker's threads, its run history and the Workers search.
 *
 * A worker talks with the user in its main thread; routines, side tasks and
 * jobs colleagues delegate run in threads of their own. The tabs above the
 * transcript switch between them and show which are running, queued or
 * failed; the Activity panel lists every run with how it went, and Retry.
 */

/* ------------------------------------------------------------------ tabs */

/** What a thread is doing, for its tab: running, waiting for a slot, failed, finished. */
function threadState(worker: Worker, thread: WorkerThreadInfo | null): 'running' | 'queued' | 'failed' | 'closed' | 'idle' {
  if (thread ? thread.runningMessageId : worker.runningMessageId) return 'running'
  if (thread ? thread.inbox.length > 0 && worker.queued : worker.inbox.length > 0 && worker.queued) return 'queued'
  if (thread ? thread.lastOutcome?.ok === false : worker.lastOutcome?.ok === false && worker.status === 'failed') return 'failed'
  if (thread?.closedAt) return 'closed'
  return 'idle'
}

function ThreadIcon({ state }: { state: ReturnType<typeof threadState> }): JSX.Element | null {
  if (state === 'running') return <Loader2 size={12} strokeWidth={2.2} className="spinner" aria-label="Working" />
  if (state === 'queued') return <Clock size={12} strokeWidth={2.2} aria-label="Queued" />
  if (state === 'failed') return <CircleAlert size={12} strokeWidth={2.2} aria-label="Failed" />
  return null
}

const KIND_LABEL: Record<WorkerThreadInfo['kind'], string> = { task: 'Task', routine: 'Routine', delegation: 'Delegated job' }

/**
 * The thread switcher above a worker's transcript. Hidden while the worker
 * has nothing but its main thread, so a simple worker looks as it always did.
 */
export function ThreadTabs({ worker, active }: { worker: Worker; active: string }): JSX.Element | null {
  const { selectThread, closeThread, removeThread } = useWorkers(
    useShallow((s) => ({ selectThread: s.selectThread, closeThread: s.closeThread, removeThread: s.removeThread }))
  )
  const finishedAnchor = useRef<HTMLButtonElement>(null)
  const finished = useDisclosure()
  const open = worker.threads.filter((t) => !t.closedAt || t.id === active)
  const closed = worker.threads.filter((t) => t.closedAt && t.id !== active).sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
  if (worker.threads.length === 0 && active !== 'new') return null
  const mainUnread = worker.unread - worker.threads.reduce((n, t) => n + t.unread, 0)

  return (
    <div className="worker-threads" role="tablist" aria-label={`${worker.name}’s threads`}>
      <ThreadTab
        label="Main"
        title="Your conversation with this worker"
        selected={active === MAIN_THREAD}
        state={threadState(worker, null)}
        unread={mainUnread}
        onSelect={() => selectThread(worker.id, MAIN_THREAD)}
      />
      {open.map((thread) => (
        <ThreadTab
          key={thread.id}
          label={thread.title}
          title={`${KIND_LABEL[thread.kind]}: ${thread.title}${thread.activity ? ` — ${thread.activity}` : ''}`}
          selected={active === thread.id}
          state={threadState(worker, thread)}
          unread={thread.unread}
          onSelect={() => selectThread(worker.id, thread.id)}
          onClose={thread.kind === 'routine' ? undefined : () => void closeThread(worker.id, thread.id)}
          closeLabel={thread.runningMessageId ? `Stop and finish “${thread.title}”` : `Finish “${thread.title}”`}
        />
      ))}
      {active === 'new' && <ThreadTab label="New task" title="A task that runs beside everything else" selected state="idle" unread={0} onSelect={() => {}} />}
      <button className="worker-threads__new" onClick={() => selectThread(worker.id, 'new')} title={`Start a task ${worker.name} works on beside everything else`}>
        <Plus size={13} strokeWidth={2} />
        <span>New task</span>
      </button>
      {closed.length > 0 && (
        <>
          <button ref={finishedAnchor} className="worker-threads__new" onClick={finished.toggle} aria-expanded={finished.open} title="Finished threads">
            <Archive size={13} strokeWidth={2} />
            <span>Finished ({closed.length})</span>
          </button>
          <Popover anchor={finishedAnchor} open={finished.open} onClose={finished.close} placement="bottom-end" width={300}>
            {closed.map((thread) => (
              <div key={thread.id} className="worker-threads__finished">
                <MenuItem
                  title={thread.title}
                  description={`${KIND_LABEL[thread.kind]} · finished ${relativeTime(thread.closedAt ?? thread.updatedAt)}`}
                  onClick={() => {
                    selectThread(worker.id, thread.id)
                    finished.close()
                  }}
                />
                <button
                  className="icon-btn"
                  aria-label={`Delete “${thread.title}”`}
                  title="Delete this thread and its messages"
                  onClick={() => void removeThread(worker.id, thread.id)}
                >
                  <Trash2 size={13} strokeWidth={1.9} />
                </button>
              </div>
            ))}
          </Popover>
        </>
      )}
    </div>
  )
}

function ThreadTab({
  label,
  title,
  selected,
  state,
  unread,
  onSelect,
  onClose,
  closeLabel
}: {
  label: string
  title: string
  selected: boolean
  state: ReturnType<typeof threadState>
  unread: number
  onSelect: () => void
  onClose?: () => void
  closeLabel?: string
}): JSX.Element {
  return (
    <span className="worker-thread-tab" data-selected={selected || undefined} data-state={state}>
      <button role="tab" aria-selected={selected} className="worker-thread-tab__main" onClick={onSelect} title={title}>
        <ThreadIcon state={state} />
        <span className="worker-thread-tab__label">{label}</span>
        {unread > 0 && !selected && <span className="unread-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {onClose && (
        <button className="worker-thread-tab__close" aria-label={closeLabel} title={closeLabel} onClick={onClose}>
          <X size={11} strokeWidth={2.2} />
        </button>
      )}
    </span>
  )
}

/* -------------------------------------------------------------- activity */

const STATE_LABEL: Record<ExecutionState, string> = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Stopped',
  interrupted: 'Interrupted',
  missed: 'Skipped'
}

function StateIcon({ state }: { state: ExecutionState }): JSX.Element {
  const props = { size: 14, strokeWidth: 2 } as const
  switch (state) {
    case 'running':
      return <Loader2 {...props} className="spinner" />
    case 'queued':
      return <Clock {...props} />
    case 'completed':
      return <CircleCheck {...props} />
    case 'failed':
    case 'interrupted':
      return <CircleAlert {...props} />
    case 'missed':
      return <CircleDashed {...props} />
    default:
      return <CircleSlash {...props} />
  }
}

function duration(ms: number): string {
  if (ms < 1000) return 'under a second'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function tokens(execution: WorkerExecution): string | null {
  const usage = execution.usage
  if (!usage) return null
  const total = usage.input + usage.output
  if (total === 0) return null
  const count = total >= 1000 ? `${Math.round(total / 100) / 10}k tokens` : `${total} tokens`
  // A subscription's tokens count against its limits; they aren't a bill.
  return execution.billing === 'plan' ? `${count} · on your plan` : count
}

/**
 * The run history beside a worker's page: every run with what woke it, the
 * thread it ran in, how it ended, how long it took and what it cost, and the
 * delegations the worker is part of. A failed or interrupted run can be
 * retried from here.
 */
export function WorkerActivityPanel({ worker }: { worker: Worker }): JSX.Element {
  const { executions, delegations, loadExecutions, retry, selectThread, setActivityOpen, now } = useWorkers(
    useShallow((s) => ({
      executions: s.executions[worker.id],
      delegations: s.delegations,
      loadExecutions: s.loadExecutions,
      retry: s.retry,
      selectThread: s.selectThread,
      setActivityOpen: s.setActivityOpen,
      now: s.now
    }))
  )
  const [error, setError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState<string | null>(null)
  const load = (): void => {
    setError(null)
    loadExecutions(worker.id).catch((e: Error) => setError(e.message))
  }
  useEffect(load, [worker.id])

  const mine = delegations.filter((d) => d.parent.workerId === worker.id || d.recipient.workerId === worker.id)
  const runs = executions ? [...executions].reverse() : null
  const threadTitle = (id: string): string | null => (id === MAIN_THREAD ? null : (worker.threads.find((t) => t.id === id)?.title ?? 'A deleted thread'))

  return (
    <aside className="browser worker-activity" aria-label={`${worker.name}’s activity`}>
      <div className="browser__tabs">
        <span className="agent-browser__title">
          <History size={14} strokeWidth={1.9} />
          Activity
        </span>
        <div style={{ flex: 1 }} />
        <button className="icon-btn" data-active onClick={() => setActivityOpen(false)} aria-label="Close activity" title="Close">
          <PanelRight size={16} strokeWidth={1.9} />
        </button>
      </div>
      <div className="worker-activity__body scroll">
        {mine.length > 0 && (
          <section className="worker-activity__section">
            <h2 className="worker-activity__heading">Delegated work</h2>
            {mine.slice(-12).reverse().map((d) => (
              <DelegationRow key={d.id} delegation={d} worker={worker} now={now} onOpen={(threadId) => selectThread(worker.id, threadId)} />
            ))}
          </section>
        )}
        <section className="worker-activity__section">
          <h2 className="worker-activity__heading">Runs</h2>
          {error ? (
            <div className="worker-activity__empty">
              Couldn’t load {worker.name}’s runs: {error}{' '}
              <button className="btn btn--sm" onClick={load}>
                Try again
              </button>
            </div>
          ) : !runs ? (
            <div className="worker-activity__empty">
              <Loader2 size={13} strokeWidth={2} className="spinner" /> Loading…
            </div>
          ) : runs.length === 0 ? (
            <div className="worker-activity__empty">No runs yet. Each time {worker.name} works, the run shows up here.</div>
          ) : (
            runs.map((run) => {
              const title = threadTitle(run.threadId)
              const took = run.startedAt !== null && run.endedAt !== null ? duration(run.endedAt - run.startedAt) : null
              const meta = [relativeTime(run.endedAt ?? run.startedAt ?? run.queuedAt, now), took, tokens(run), title ? `in “${title}”` : null].filter(Boolean)
              const canRetry = (run.state === 'failed' || run.state === 'interrupted' || run.state === 'cancelled') && !worker.paused
              return (
                <div key={run.id} className="worker-run" data-state={run.state}>
                  <span className="worker-run__icon">
                    <StateIcon state={run.state} />
                  </span>
                  <div className="worker-run__main">
                    <div className="worker-run__line">
                      <span className="worker-run__label">{run.trigger.label}</span>
                      <span className="worker-run__state">{STATE_LABEL[run.state]}</span>
                    </div>
                    <div className="worker-run__meta">{meta.join(' · ')}</div>
                    {(run.error || run.reason || run.result) && (
                      <div className="worker-run__detail" data-error={run.error ? true : undefined} title={run.error ?? run.reason ?? run.result ?? undefined}>
                        {run.error ?? run.reason ?? run.result}
                      </div>
                    )}
                    <div className="worker-run__actions">
                      {run.messageId && (
                        <button className="btn btn--ghost btn--sm" onClick={() => selectThread(worker.id, run.threadId)}>
                          Open
                        </button>
                      )}
                      {canRetry && (
                        <button
                          className="btn btn--sm"
                          disabled={retrying === run.id}
                          onClick={() => {
                            setRetrying(run.id)
                            retry(worker.id, run.id)
                              .then(() => selectThread(worker.id, run.threadId))
                              .catch((e: Error) => setError(e.message))
                              .finally(() => setRetrying(null))
                          }}
                          title={run.sideEffects ? 'It may already have changed things; the retry is told to check first' : undefined}
                        >
                          <RotateCcw size={12} strokeWidth={2} />
                          Retry
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </section>
      </div>
    </aside>
  )
}

function DelegationRow({ delegation, worker, now, onOpen }: { delegation: WorkerDelegation; worker: Worker; now: number; onOpen: (threadId: string) => void }): JSX.Element {
  const outgoing = delegation.parent.workerId === worker.id
  const sentence = outgoing
    ? `Delegated “${delegation.objective}” to ${delegation.recipient.name}`
    : `${delegation.parent.name} delegated “${delegation.objective}”`
  const threadId = outgoing ? delegation.parent.threadId : delegation.recipient.threadId
  const after =
    delegation.state === 'completed'
      ? outgoing
        ? delegation.deliveredAt
          ? `${worker.name} took in the result`
          : 'Result waiting for its next turn'
        : 'Reported back'
      : delegation.failureReason
  return (
    <div className="worker-run" data-state={delegation.state === 'completed' ? 'completed' : delegation.state === 'failed' ? 'failed' : delegation.state === 'cancelled' ? 'cancelled' : 'running'}>
      <span className="worker-run__icon">
        <MessagesSquare size={14} strokeWidth={2} />
      </span>
      <div className="worker-run__main">
        <div className="worker-run__line">
          <span className="worker-run__label">{sentence}</span>
          <span className="worker-run__state">{DELEGATION_LABEL[delegation.state]}</span>
        </div>
        <div className="worker-run__meta">
          {relativeTime(delegation.updatedAt, now)}
          {delegation.deadlineAt && delegation.state !== 'completed' ? ` · due ${relativeTime(delegation.deadlineAt, now)}` : ''}
        </div>
        {after && <div className="worker-run__detail">{after}</div>}
        {threadId && (
          <div className="worker-run__actions">
            <button className="btn btn--ghost btn--sm" onClick={() => onOpen(threadId)}>
              Open
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- search */

interface Hit {
  key: string
  title: string
  description: string
  icon: JSX.Element
  open: () => void
}

/**
 * Search for the Workers tab: workers by name, job and what they're doing;
 * their tasks and routines by title; questions waiting on the user; group
 * chats; and anything that failed. The chat search would find none of that.
 */
export function WorkersSearch({ anchor, open, onClose }: { anchor: React.RefObject<HTMLElement>; open: boolean; onClose: () => void }): JSX.Element {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  const hits = useMemo((): Hit[] => {
    if (!open) return []
    const { workers, rooms, threads, now } = useWorkers.getState()
    const go = (workerId: string, threadId: string = MAIN_THREAD): void => {
      const store = useWorkers.getState()
      store.select(workerId)
      store.selectThread(workerId, threadId)
      if (useApp.getState().view !== 'chat') useApp.getState().setView('chat')
    }
    const q = query.trim().toLowerCase()
    const has = (...texts: (string | null | undefined)[]): boolean => !q || texts.some((t) => t?.toLowerCase().includes(q))
    const out: Hit[] = []
    for (const w of workers) {
      const face = <WorkerFace color={w.color} size={16} />
      if (has(w.name, w.purpose, w.activity, describeWorker(w, now), w.status === 'failed' ? 'failed error problem' : null, w.queued ? 'queued waiting' : null)) {
        out.push({ key: w.id, title: w.name, description: describeWorker(w, now), icon: face, open: () => go(w.id) })
      }
      for (const ask of w.asks) {
        if (has(ask.question, 'question waiting answer')) {
          out.push({ key: `${w.id}:${ask.id}`, title: ask.question, description: `${w.name} is waiting for your answer`, icon: <MessageCircleQuestion size={15} strokeWidth={1.9} />, open: () => go(w.id) })
        }
      }
      for (const t of w.threads) {
        if (!q) continue
        if (has(t.title, t.activity, t.lastError, t.lastError ? 'failed error' : null)) {
          out.push({
            key: `${w.id}#${t.id}`,
            title: t.title,
            description: `${w.name} · ${KIND_LABEL[t.kind].toLowerCase()}${t.runningMessageId ? ' · running' : t.lastError ? ` · failed: ${t.lastError}` : t.closedAt ? ' · finished' : ''}`,
            icon: face,
            open: () => go(w.id, t.id)
          })
        }
      }
      // Recent words in the threads already opened this session.
      if (q.length >= 3) {
        for (const [key, thread] of Object.entries(threads)) {
          if (key !== w.id && !key.startsWith(`${w.id}#`)) continue
          const match = thread.messages.slice(-60).find((m) => m.parts.some((p) => p.type === 'text' && p.text.toLowerCase().includes(q)))
          if (!match) continue
          const part = match.parts.find((p) => p.type === 'text' && p.text.toLowerCase().includes(q)) as { text: string }
          const at = part.text.toLowerCase().indexOf(q)
          out.push({
            key: `${key}:${match.id}`,
            title: `…${part.text.slice(Math.max(0, at - 30), at + 60).replace(/\s+/g, ' ')}…`,
            description: `In ${w.name}’s ${thread.threadId ? `“${w.threads.find((t) => t.id === thread.threadId)?.title ?? 'thread'}”` : 'conversation'}`,
            icon: <Search size={15} strokeWidth={1.9} />,
            open: () => go(w.id, thread.threadId ?? MAIN_THREAD)
          })
        }
      }
    }
    for (const room of rooms) {
      if (!has(room.name)) continue
      out.push({
        key: `room:${room.id}`,
        title: room.name,
        description: `Group chat · ${room.members.length} worker${room.members.length === 1 ? '' : 's'}`,
        icon: <MessagesSquare size={15} strokeWidth={1.9} />,
        open: () => {
          useWorkers.getState().selectRoom(room.id)
          if (useApp.getState().view !== 'chat') useApp.getState().setView('chat')
        }
      })
    }
    return out.slice(0, 30)
  }, [query, open])

  useEffect(() => setActive(0), [query])

  const onKeyDown = (e: ReactKeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, hits.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && hits[active]) {
      e.preventDefault()
      hits[active].open()
      onClose()
    }
  }

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} placement="bottom-end" width={340}>
      <div onKeyDown={onKeyDown}>
        <MenuSearch value={query} onChange={setQuery} placeholder="Search workers, tasks and questions" />
        {hits.length === 0 ? (
          <div className="menu__empty">{query.trim() ? 'Nothing matches' : 'No workers yet'}</div>
        ) : (
          <div className="worker-search__results" role="listbox" aria-label="Results">
            {hits.map((hit, index) => (
              <div key={hit.key} role="option" aria-selected={index === active} data-active={index === active || undefined} onMouseEnter={() => setActive(index)}>
                <MenuItem
                  icon={hit.icon}
                  title={hit.title}
                  description={hit.description}
                  onClick={() => {
                    hit.open()
                    onClose()
                  }}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </Popover>
  )
}

/** The Workers tab's search button, where the chat search sits in the other tabs. */
export function WorkersSearchButton(): JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null)
  const menu = useDisclosure()
  return (
    <>
      <button ref={anchor} className="icon-btn" onClick={menu.toggle} aria-label="Search workers" title="Search workers, tasks and questions">
        <Search size={16} strokeWidth={1.9} />
      </button>
      <WorkersSearch anchor={anchor} open={menu.open} onClose={menu.close} />
    </>
  )
}
