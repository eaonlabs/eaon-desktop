import { useEffect, useId, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  AppWindow,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  GraduationCap,
  Loader,
  Loader2,
  MonitorPlay,
  PackageSearch,
  PanelRight,
  Pause,
  Pencil,
  PencilLine,
  Play,
  Repeat,
  ShieldAlert,
  ShoppingBag,
  Square,
  Target,
  Terminal,
  TriangleAlert,
  X
} from 'lucide-react'
import {
  MAX_GOAL_CHARS,
  MAX_NOTES_CHARS,
  relativeTime,
  watchText,
  type Worker,
  type WorkerAsk,
  type WorkerJob,
  type WorkerPlaybook,
  type WorkerWatch
} from '@shared/workers'
import { Modal } from '../ui'
import { workerBrowserTarget } from '@shared/agentBrowser'
import { formatMoney } from '@shared/payments'
import { usePurchaseDialog } from '../purchase/purchaseStore'
import { cadenceText } from '../purchase/plan'
import { useWorkers } from './workersStore'
import { Markdown } from '../agent/Markdown'
import { approvalRisk, CommandPreview } from '../agent/ApprovalCard'
import { LiveBrowserAddress, LiveBrowserControls, LiveBrowserStage, LiveBrowserSteps, useLiveBrowser } from '../agentBrowser/LiveBrowser'

/**
 * What makes a worker run on its own, made visible: the questions it is
 * waiting on (answered here without stopping it), its goal, notes and
 * routines — its own memory — and its own browser, which the user can bring
 * up to watch or to sign it in somewhere.
 */

/** Questions a worker put to the user, at the foot of its thread. */
export function WorkerAsks({ worker }: { worker: Worker }): JSX.Element | null {
  if (!worker.asks?.length) return null
  return (
    <div className="worker-asks">
      {worker.asks.map((ask) => (ask.approve ? <AskApproval key={ask.id} worker={worker} ask={ask} /> : <AskQuestion key={ask.id} worker={worker} ask={ask} />))}
    </div>
  )
}

/** Sends the answer once (`busy` covers the round trip so a double click can't answer twice), and says why when it couldn't. */
function useAnswer(worker: Worker, ask: WorkerAsk): [boolean, (value: { text?: string; approved?: boolean }) => Promise<void>, string | null] {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const answer = async (value: { text?: string; approved?: boolean }): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await window.api.workers.answer(worker.id, ask.id, value)
    } catch (failure) {
      // Answered somewhere else first (another window, a chat app): the card goes away on its own; say why meanwhile.
      const message = failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(failure)
      setError(/already answered/i.test(message) ? 'This was already answered somewhere else.' : message)
    } finally {
      setBusy(false)
    }
  }
  return [busy, answer, error]
}

const LETTERS = 'ABCDEFGH'

/**
 * A question as a card of lettered choices. One answer: picking it sends it.
 * Several ("choose all that apply"): pick them, then Done. Either way the
 * last row takes an answer of the user's own. With the card focused, a
 * choice's letter picks it too.
 */
function AskQuestion({ worker, ask }: { worker: Worker; ask: WorkerAsk }): JSX.Element {
  const [busy, answer, error] = useAnswer(worker, ask)
  const options = ask.options ?? []
  const multiple = Boolean(ask.multiple) && options.length > 1
  const [picked, setPicked] = useState<number[]>([])
  const [other, setOther] = useState('')
  const titleId = useId()
  const own = other.trim()

  const choose = (index: number): void => {
    if (busy) return
    if (!multiple) {
      setPicked([index])
      void answer({ text: options[index] })
      return
    }
    setPicked((current) => (current.includes(index) ? current.filter((i) => i !== index) : [...current, index].sort((a, b) => a - b)))
  }
  const ready = picked.length > 0 || own.length > 0
  const done = (): void => {
    if (!ready || busy) return
    const chosen = multiple ? picked.map((i) => options[i]) : []
    void answer({ text: [...chosen, ...(own ? [own] : [])].join('; ') })
  }

  return (
    <section
      className="ask-card"
      aria-labelledby={titleId}
      aria-busy={busy || undefined}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return
        const index = LETTERS.indexOf(e.key.toUpperCase())
        if (e.key.length === 1 && index !== -1 && index < options.length) {
          e.preventDefault()
          choose(index)
        } else if (e.key === 'Enter' && multiple) {
          e.preventDefault()
          done()
        }
      }}
    >
      <header className="ask-card__head">
        {/* Written by the model, so it gets the same Markdown as the thread. */}
        <div id={titleId} className="ask-card__title" title={`${worker.name} asked ${relativeTime(ask.at)}`}>
          <Markdown text={ask.question} />
        </div>
        <p className="ask-card__hint">
          {multiple ? 'Choose all that apply' : options.length > 0 ? 'Choose one, or write your own' : `${worker.name} is waiting for your answer`}
        </p>
      </header>
      <div className="ask-card__options" role="group" aria-labelledby={titleId}>
        {options.map((option, index) => (
          <button
            key={`${index}-${option}`}
            type="button"
            className="ask-option"
            aria-pressed={picked.includes(index)}
            disabled={busy}
            onClick={() => choose(index)}
          >
            <span className="ask-option__key" aria-hidden="true">
              {LETTERS[index]}
            </span>
            <span className="ask-option__label">{option}</span>
          </button>
        ))}
        <label className="ask-option ask-option--other" data-filled={own ? true : undefined}>
          <span className="ask-option__key" aria-hidden="true">
            {options.length > 0 ? LETTERS[options.length] : <PencilLine size={12} strokeWidth={2.2} />}
          </span>
          <input
            className="ask-option__input"
            value={other}
            disabled={busy}
            placeholder={options.length > 0 ? 'Something else…' : 'Write an answer…'}
            aria-label="Your own answer"
            onChange={(e) => setOther(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                done()
              }
            }}
          />
        </label>
      </div>
      {(multiple || own) && (
        <footer className="ask-card__foot">
          <button type="button" className="ask-btn ask-btn--primary" disabled={!ready || busy} onClick={done}>
            {busy ? <Loader2 size={14} strokeWidth={2.2} className="spinner" /> : 'Done'}
          </button>
        </footer>
      )}
      {error && <div className="msg__error">{error}</div>}
    </section>
  )
}

/** "Atlas wants to …", by the tool it is asking to use. */
const WANTS: Record<string, string> = {
  run_command: 'run a command',
  write_file: 'change a file',
  edit_file: 'change a file',
  delete_file: 'delete a file',
  move_file: 'move a file',
  computer: 'use your mouse and keyboard',
  browser: 'act in your browser',
  web_browser: 'act in its browser',
  email_send: 'send an email',
  email_reply: 'reply to an email',
  trading_order: 'place an order',
  trading_session: 'trade for you',
  payment_card: 'pay with your card',
  ios_simulator: 'use the iOS Simulator',
  use_plugin_tool: 'use a plugin',
  schedule: 'change your schedules'
}

/**
 * Asking for one specific action the worker may not take alone. Leads with
 * who wants to do what and why; the exact call is behind "Show the
 * breakdown". Allow lets exactly that call through, once.
 */
function AskApproval({ worker, ask }: { worker: Worker; ask: WorkerAsk }): JSX.Element {
  const [busy, answer, error] = useAnswer(worker, ask)
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const titleId = useId()
  const { tool, input, summary } = ask.approve!
  // A namespaced call ("default_api.email_send") is the same tool.
  const name = tool.split('.').pop() ?? tool
  const risk = approvalRisk(name, input)
  const wants = WANTS[name]
  const json = JSON.stringify(input, null, 2) ?? ''
  const text = note.trim() || undefined
  return (
    <section className="ask-card ask-card--approve" data-risk={risk} aria-labelledby={titleId}>
      <header className="ask-card__head ask-card__head--row">
        <h3 id={titleId} className="ask-card__title ask-card__title--big">
          {wants ? `${worker.name} wants to ${wants}` : `${worker.name} needs your OK`}
        </h3>
        <span className="ask-badge" title={risk === 'high' ? `Can’t be undone · asked ${relativeTime(ask.at)}` : `Asked ${relativeTime(ask.at)}`}>
          <Loader size={15} strokeWidth={2.2} className="ask-badge__icon" aria-hidden="true" />
          Approval needed
        </span>
      </header>
      <div className="ask-card__lead">
        <Markdown text={ask.question} />
      </div>
      <button type="button" className="ask-card__disclose" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={15} strokeWidth={2} />
        {open ? 'Hide the breakdown' : 'Show the breakdown'}
      </button>
      {open && (
        <div className="ask-card__breakdown">
          {summary && summary !== ask.question && <p className="ask-card__summary">{summary}</p>}
          {name === 'run_command' && typeof input.command === 'string' ? (
            <CommandPreview command={input.command} />
          ) : (
            json.length > 2 && <pre className="approval__json">{json.slice(0, 4000)}</pre>
          )}
          <p className="ask-card__tool">
            <code>{tool}</code>
          </p>
          <input aria-label={`Note for ${worker.name}`} className="input ask-card__note" value={note} placeholder={`Add a note for ${worker.name} (optional)`} onChange={(e) => setNote(e.target.value)} />
        </div>
      )}
      <footer className="ask-card__foot ask-card__foot--start">
        <button
          type="button"
          className="ask-btn ask-btn--primary ask-btn--lg"
          disabled={busy}
          title="Lets exactly this call through, once"
          onClick={() => void answer({ approved: true, text })}
        >
          Allow
        </button>
        <button type="button" className="ask-btn ask-btn--lg" disabled={busy} onClick={() => void answer({ approved: false, text })}>
          Deny
        </button>
      </footer>
      {error && <div className="msg__error">{error}</div>}
    </section>
  )
}

const GOAL_LABEL = {
  active: 'Working toward goal',
  achieved: 'Goal achieved',
  blocked: 'Blocked — needs you',
  paused: 'Goal paused'
} as const

/**
 * The goal set from the composer's Goal, above the composer like Chat's:
 * what it is, how it's going, and Pause / Resume / Clear. A blocked goal
 * also picks up again when the user answers.
 */
export function WorkerGoalBanner({ worker, now }: { worker: Worker; now: number }): JSX.Element | null {
  const goal = worker.goalRun
  if (!goal) return null
  const set = (status: 'active' | 'paused' | null): void => void window.api.workers.setGoal(worker.id, status)
  const until =
    goal.status === 'active' && typeof goal.until === 'number' ? ` · until ${new Date(goal.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''
  const progress =
    goal.status === 'active'
      ? worker.status === 'working'
        ? `${until} · on it now`
        : goal.failures && typeof goal.nextAt === 'number'
          ? `${until} · hit a problem, trying again ${relativeTime(goal.nextAt, now)}`
          : typeof goal.nextAt === 'number'
            ? `${until} · continues ${relativeTime(goal.nextAt, now)}`
            : worker.heartbeat.nextAt !== null
              ? `${until} · picks up ${relativeTime(worker.heartbeat.nextAt, now)}`
              : until
      : goal.summary
        ? ` · ${goal.summary}`
        : ''
  return (
    <div className="goal-banner" data-status={goal.status}>
      <span className="goal-banner__icon">
        {goal.status === 'blocked' ? <TriangleAlert size={14} strokeWidth={2} /> : goal.status === 'achieved' ? <Check size={14} strokeWidth={2.4} /> : <Target size={14} strokeWidth={2} />}
      </span>
      <span className="goal-banner__body">
        <span className="goal-banner__label">
          {/* Paused mid-turn: the step in hand finishes first. */}
          {goal.status === 'paused' && worker.status === 'working' ? 'Pausing after this step' : GOAL_LABEL[goal.status]}
          {progress}
        </span>
        <span className="goal-banner__text" title={goal.text}>
          {goal.text}
        </span>
      </span>
      {goal.status === 'active' && (
        <button className="icon-btn" aria-label="Pause goal" title="Pause goal" onClick={() => set('paused')}>
          <Pause size={14} strokeWidth={2} />
        </button>
      )}
      {(goal.status === 'paused' || goal.status === 'blocked') && (
        <button className="icon-btn" aria-label="Resume goal" title="Resume goal now" onClick={() => set('active')}>
          <Play size={14} strokeWidth={2} />
        </button>
      )}
      <button className="icon-btn" aria-label="Clear goal" title="Clear goal" onClick={() => set(null)}>
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  )
}

/**
 * Goal, routines, jobs, watches, playbooks and notes: what the worker keeps
 * going on its own, under its profile. Jobs can be stopped and watches and
 * playbooks removed here; the worker is told when a job it started is
 * stopped.
 */
export function WorkerMemory({ worker, now }: { worker: Worker; now: number }): JSX.Element | null {
  const [notesOpen, setNotesOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const routines = worker.routines ?? []
  const jobs = recentJobs(worker.jobs ?? [])
  const watches = worker.watches ?? []
  const playbooks = worker.playbooks ?? []
  const failed = (e: Error): void => setError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
  const stopRoutine = (id: string): void => {
    setError(null)
    window.api.workers.removeRoutineById(worker.id, id).catch(failed)
  }
  const buyNow = (id: string): void => {
    setError(null)
    window.api.workers.runRoutine(worker.id, id).catch(failed)
  }
  if (!worker.goal && !worker.notes && routines.length === 0 && jobs.length === 0 && watches.length === 0 && playbooks.length === 0) {
    return (
      <div className="worker-memory">
        <button className="worker-memory__toggle" onClick={() => setEditing(true)} title={`Write ${worker.name} a goal or notes it keeps in mind on every task`}>
          Add a goal or notes
        </button>
        {editing && <MemoryEditor worker={worker} onClose={() => setEditing(false)} />}
      </div>
    )
  }
  return (
    <div className="worker-memory">
      {worker.goal && (
        <div className="worker-memory__row">
          <Target size={14} strokeWidth={2} />
          <span>
            <span className="worker-memory__label">Goal</span> {worker.goal}
          </span>
        </div>
      )}
      {jobs.map((job) => (
        <JobRow key={job.id} worker={worker} job={job} now={now} />
      ))}
      {watches.map((watch) => (
        <WatchRow key={watch.id} worker={worker} watch={watch} now={now} />
      ))}
      {routines.map((routine) => {
        const last = routine.runs[routine.runs.length - 1]
        const plan = routine.purchase
        const Icon = plan ? ShoppingBag : routine.watch ? PackageSearch : Repeat
        const when = routine.daily ? `daily at ${routine.daily}` : plan ? cadenceText(routine.everyMs) : `every ${Math.round((routine.everyMs ?? 0) / 60_000)} min`
        return (
          <div key={routine.id} className="worker-memory__row" data-kind={plan ? 'purchase' : routine.watch ? 'watch' : undefined} title={routine.task}>
            <Icon size={14} strokeWidth={2} />
            <span>
              <span className="worker-memory__label">{routine.name}</span>{' '}
              {plan && <>{plan.maxAmount === 0 ? 'free only' : `up to ${formatMoney(plan.maxAmount, plan.currency)}`} on {plan.site} · {plan.autopilot ? 'autopilot · ' : ''}</>}
              {when} · next {relativeTime(routine.nextAt, now)}
              {last && !last.ok && <span className="worker-memory__failed"> · last run failed</span>}
            </span>
            {plan && (
              <>
                <button className="icon-btn worker-memory__stop" aria-label={`Buy ${plan.item} now`} title="Buy now" onClick={() => buyNow(routine.id)}>
                  <Play size={12} strokeWidth={2.2} />
                </button>
                <button
                  className="icon-btn worker-memory__stop"
                  aria-label={`Edit the purchase schedule “${routine.name}”`}
                  title="Edit"
                  onClick={() => usePurchaseDialog.getState().show({ workerId: worker.id, routine })}
                >
                  <Pencil size={12} strokeWidth={2.2} />
                </button>
              </>
            )}
            <button className="icon-btn worker-memory__stop" aria-label={`Stop the routine “${routine.name}”`} title="Stop this routine" onClick={() => stopRoutine(routine.id)}>
              <X size={12} strokeWidth={2.2} />
            </button>
          </div>
        )
      })}
      {playbooks.length > 0 && (
        <div className="worker-memory__group">
          <span className="worker-memory__heading">
            <BookOpen size={13} strokeWidth={2} />
            Playbooks
          </span>
          {playbooks.map((playbook) => (
            <PlaybookRow key={playbook.id} worker={worker} playbook={playbook} />
          ))}
        </div>
      )}
      {worker.notes && (
        <div className="worker-memory__notes" data-open={notesOpen || undefined}>
          <button className="worker-memory__toggle" onClick={() => setNotesOpen(!notesOpen)} aria-expanded={notesOpen}>
            <ChevronDown size={13} strokeWidth={2} />
            {worker.name}’s notes
          </button>
          {notesOpen && <pre className="worker-memory__text">{worker.notes}</pre>}
        </div>
      )}
      <button className="worker-memory__toggle" onClick={() => setEditing(true)} title={`Change what ${worker.name} keeps in mind`}>
        Edit goal and notes
      </button>
      {error && <div className="msg__error">{error}</div>}
      {editing && <MemoryEditor worker={worker} onClose={() => setEditing(false)} />}
    </div>
  )
}

/** Every job still running, and the last three that ended. */
function recentJobs(jobs: WorkerJob[]): WorkerJob[] {
  const ended = jobs.filter((j) => j.endedAt !== null).slice(-3)
  return [...jobs.filter((j) => j.endedAt === null), ...ended.reverse()]
}

const ago = (ms: number): string => {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} min`
  return minutes % 60 && minutes < 600 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${Math.round(minutes / 60)} h`
}

function JobRow({ worker, job, now }: { worker: Worker; job: WorkerJob; now: number }): JSX.Element {
  const [log, setLog] = useState<string | null>(null)
  const running = job.endedAt === null
  const toggleLog = (): void => {
    if (log !== null) return setLog(null)
    void window.api.workers.jobLog(worker.id, job.id).then(setLog, (error: unknown) => setLog(error instanceof Error ? error.message : String(error)))
  }
  return (
    <div className="worker-memory__item">
      <div className="worker-memory__row" data-running={running || undefined} title={job.command}>
        <Terminal size={14} strokeWidth={2} />
        <span className="worker-memory__body">
          <span className="worker-memory__label">{job.name}</span>{' '}
          {running ? (
            <span className="worker-memory__live">running for {ago(now - job.startedAt)}</span>
          ) : (
            <span className={job.ok ? undefined : 'worker-memory__failed'}>
              {job.result} · {relativeTime(job.endedAt!, now)}
            </span>
          )}
        </span>
        <span className="worker-memory__actions">
          <button className="worker-memory__action" onClick={toggleLog} aria-expanded={log !== null}>
            {log !== null ? 'Hide output' : 'Output'}
          </button>
          {running && (
            <button
              className="worker-memory__action"
              onClick={() => void window.api.workers.stopJob(worker.id, job.id)}
              aria-label={`Stop ${job.name}`}
              title={`Stop it; ${worker.name} is told`}
            >
              <Square size={11} strokeWidth={2.4} />
              Stop
            </button>
          )}
        </span>
      </div>
      {log !== null && <pre className="worker-memory__text">{log}</pre>}
    </div>
  )
}

function WatchRow({ worker, watch, now }: { worker: Worker; watch: WorkerWatch; now: number }): JSX.Element {
  const failing = watch.when === 'fails' && watch.last?.met
  return (
    <div className="worker-memory__row" title={watch.note ? `When it fires: ${watch.note}` : undefined}>
      <Eye size={14} strokeWidth={2} />
      <span className="worker-memory__body">
        <span className="worker-memory__label">{watch.name}</span> {watchText(watch)} · every {Math.round(watch.everyMs / 60_000)} min
        {watch.last ? (
          <span className={failing ? 'worker-memory__failed' : undefined}>
            {' '}
            · {failing ? 'failing' : 'looked'} {relativeTime(watch.last.at, now)}
          </span>
        ) : (
          ' · first look soon'
        )}
        {watch.fires > 0 && ` · woke ${worker.name} ${watch.fires === 1 ? 'once' : `${watch.fires} times`}`}
      </span>
      <span className="worker-memory__actions">
        <button
          className="worker-memory__action worker-memory__action--icon"
          onClick={() => void window.api.workers.removeWatch(worker.id, watch.id)}
          aria-label={`Stop watching ${watch.name}`}
          title="Stop watching"
        >
          <X size={12} strokeWidth={2.2} />
        </button>
      </span>
    </div>
  )
}

function PlaybookRow({ worker, playbook }: { worker: Worker; playbook: WorkerPlaybook }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="worker-memory__item">
      <div className="worker-memory__row worker-memory__row--sub">
        <button className="worker-memory__playbook" onClick={() => setOpen(!open)} aria-expanded={open}>
          <ChevronDown size={13} strokeWidth={2} />
          <span className="worker-memory__label">{playbook.name}</span>
          {playbook.summary && <span className="worker-memory__summary"> — {playbook.summary}</span>}
        </button>
        <span className="worker-memory__actions">
          {playbook.uses > 0 && <span className="worker-memory__uses">used {playbook.uses === 1 ? 'once' : `${playbook.uses}×`}</span>}
          <button
            className="worker-memory__action worker-memory__action--icon"
            onClick={() => void window.api.workers.removePlaybook(worker.id, playbook.id)}
            aria-label={`Remove the playbook ${playbook.name}`}
            title="Remove playbook"
          >
            <X size={12} strokeWidth={2.2} />
          </button>
        </span>
      </div>
      {open && <pre className="worker-memory__text">{playbook.steps}</pre>}
    </div>
  )
}

/**
 * "Teach" among the profile facts: show the worker how to do something once,
 * in its own browser, and it saves the steps as a playbook to do it alone
 * from then on.
 */
export function WorkerTeachFact({ worker }: { worker: Worker }): JSX.Element {
  const { teaching, startTeaching } = useWorkers(useShallow((s) => ({ teaching: s.teaching, startTeaching: s.startTeaching })))
  const on = teaching === worker.id
  return (
    <button
      className="worker-fact worker-fact--app"
      data-active={on || undefined}
      disabled={on}
      title={`Show ${worker.name} how to do something in its browser; it learns the steps`}
      onClick={() => void startTeaching(worker.id)}
    >
      <GraduationCap size={13} strokeWidth={2} />
      {on ? 'Teaching…' : 'Teach'}
    </button>
  )
}

/**
 * Over the worker's browser while the user teaches it: what has been
 * recorded so far, what the task was, and Finish / Cancel. The browser is
 * the user's while this shows; the worker waits.
 */
function TeachBar({ worker }: { worker: Worker }): JSX.Element {
  const finishTeaching = useWorkers((s) => s.finishTeaching)
  const [steps, setSteps] = useState<string[]>([])
  const [task, setTask] = useState('')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    const read = (): void => void window.api.workers.teachSteps(worker.id).then((list) => live && setSteps(list))
    read()
    const timer = setInterval(read, 1000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [worker.id])
  const finish = async (value: string | null): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await finishTeaching(value)
    } finally {
      setBusy(false)
    }
  }
  const ready = steps.length > 0 && task.trim().length > 0
  return (
    <div className="teach-bar">
      <div className="teach-bar__head">
        <GraduationCap size={15} strokeWidth={2} />
        <span className="teach-bar__title">
          Teaching {worker.name}
          <span className="teach-bar__hint">
            {steps.length === 0 ? 'Do the task here; every page, click and entry is written down' : `${steps.length} step${steps.length === 1 ? '' : 's'} so far`}
          </span>
        </span>
        {steps.length > 0 && (
          <button className="btn btn--ghost btn--sm" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? 'Hide steps' : 'Steps'}
          </button>
        )}
      </div>
      {open && (
        <ol className="teach-bar__steps">
          {steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      )}
      <div className="teach-bar__finish">
        <input
          className="input"
          value={task}
          placeholder="What did you show it? e.g. file an expense report"
          aria-label="What you showed it"
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && ready) void finish(task.trim())
          }}
        />
        <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void finish(null)}>
          Cancel
        </button>
        <button
          className="btn btn--primary btn--sm"
          disabled={busy || !ready}
          title={steps.length === 0 ? 'Nothing recorded yet' : !task.trim() ? 'Say what it was for' : `Send the steps to ${worker.name} to save as a playbook`}
          onClick={() => void finish(task.trim())}
        >
          Finish
        </button>
      </div>
      <p className="teach-bar__note">Passwords and card numbers are never recorded, only that one was typed.</p>
    </div>
  )
}

/** The user's way into what a worker remembers: its goal and its notes, as plain text. */
function MemoryEditor({ worker, onClose }: { worker: Worker; onClose: () => void }): JSX.Element {
  const [goal, setGoal] = useState(worker.goal)
  const [notes, setNotes] = useState(worker.notes)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      await window.api.workers.setMemory(worker.id, { goal, notes })
      onClose()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(failure))
      setSaving(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`What ${worker.name} remembers`}
      width={560}
      actions={
        <>
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" disabled={saving} onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <div className="worker-editor">
        <label className="field">
          <span className="field-label">Goal ({goal.length}/{MAX_GOAL_CHARS})</span>
          <textarea className="input" rows={2} maxLength={MAX_GOAL_CHARS} value={goal} autoFocus placeholder="What it is working towards and how it will know it is done" onChange={(e) => setGoal(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Notes ({notes.length}/{MAX_NOTES_CHARS})</span>
          <textarea className="input" rows={8} maxLength={MAX_NOTES_CHARS} value={notes} placeholder="Decisions, your preferences, where things are — one per line. It reads these on every task and adds its own." onChange={(e) => setNotes(e.target.value)} />
        </label>
        <p className="worker-editor__hint">Both are part of every message {worker.name} reads, across all its threads. Clear a box to forget it.</p>
        {error && <div className="msg__error">{error}</div>}
      </div>
    </Modal>
  )
}

/**
 * "Browser" among the profile facts, once the worker has opened its own:
 * brings that window up — to watch, or to sign the worker in to a site.
 */
export function WorkerBrowserFact({ worker }: { worker: Worker }): JSX.Element | null {
  const [has, setHas] = useState(false)
  const setBrowser = useWorkers((s) => s.setBrowser)
  useEffect(() => {
    let live = true
    void window.api.workers.hasBrowser(worker.id).then((value) => live && setHas(value))
    return () => {
      live = false
    }
  }, [worker.id, worker.status])
  if (!has) return null
  return (
    <button className="worker-fact worker-fact--app" title={`Watch ${worker.name}’s browser live, or take control to help it`} onClick={() => setBrowser(worker.id)}>
      <AppWindow size={13} strokeWidth={2} />
      Browser
    </button>
  )
}

/**
 * Beside a worker's thread: its own browser, live — the page as it changes,
 * its cursor gliding to what it clicks, and the step in hand. Opens by itself
 * when the worker starts using its browser; "Take control" lets the user sign
 * it in or get it past a captcha, and the worker waits until handed back.
 */
export function WorkerBrowserPanel({ worker }: { worker: Worker }): JSX.Element {
  const setBrowser = useWorkers((s) => s.setBrowser)
  const target = workerBrowserTarget(worker.id)
  const { frame, steps, working, controlled, exists } = useLiveBrowser(target, true)
  const teaching = useWorkers((s) => s.teaching === worker.id)
  return (
    <aside className="browser agent-browser" aria-label={`${worker.name}’s browser`}>
      <div className="browser__tabs">
        <span className="agent-browser__title">
          <MonitorPlay size={14} strokeWidth={1.9} />
          {worker.name}’s browser
          {working && !controlled && (
            <span className="agent-browser__live" aria-label="Working">
              <span className="agent-browser__live-dot" aria-hidden="true" />
              Live
            </span>
          )}
        </span>
        <div style={{ flex: 1 }} />
        <LiveBrowserControls target={target} controlled={controlled} exists={exists || Boolean(frame)} agentName={worker.name} />
        <button className="icon-btn" data-active onClick={() => setBrowser(null, worker.id)} aria-label={`Close ${worker.name}’s browser`} title="Close">
          <PanelRight size={16} strokeWidth={1.9} />
        </button>
      </div>
      <div className="browser__toolbar">
        <LiveBrowserAddress target={target} frame={frame} controlled={controlled} />
      </div>
      {teaching && <TeachBar worker={worker} />}
      <LiveBrowserStage target={target} frame={frame} latest={steps[steps.length - 1]} working={working} controlled={controlled} agentName={worker.name} />
      <LiveBrowserSteps steps={steps} />
    </aside>
  )
}
