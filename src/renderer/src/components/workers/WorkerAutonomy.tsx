import { useEffect, useState } from 'react'
import { AppWindow, Check, ChevronDown, CircleHelp, MonitorPlay, PanelRight, Repeat, ShieldAlert, Target, X } from 'lucide-react'
import { relativeTime, type Worker, type WorkerAsk } from '@shared/workers'
import { workerBrowserTarget } from '@shared/agentBrowser'
import { useWorkers } from './workersStore'
import { Markdown } from '../agent/Markdown'
import { ApprovalCard, CallPreview, CommandPreview } from '../agent/ApprovalCard'
import { LiveBrowserAddress, LiveBrowserControls, LiveBrowserStage, LiveBrowserSteps, useLiveBrowser } from '../agentBrowser/LiveBrowser'

/**
 * What makes a worker run on its own, made visible: the questions it is
 * waiting on (answered here without stopping it), its goal, notes and
 * routines — its own memory — and its own browser, which the user can bring
 * up to watch or to sign it in somewhere.
 */

/** Questions a worker put to the user, above its composer. */
export function WorkerAsks({ worker }: { worker: Worker }): JSX.Element | null {
  if (!worker.asks?.length) return null
  return (
    <div className="worker-asks">
      {worker.asks.map((ask) => (
        <AskCard key={ask.id} worker={worker} ask={ask} />
      ))}
    </div>
  )
}

function AskCard({ worker, ask }: { worker: Worker; ask: WorkerAsk }): JSX.Element {
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState(false)
  const answer = async (value: { text?: string; approved?: boolean }): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await window.api.workers.answer(worker.id, ask.id, value)
    } finally {
      setBusy(false)
    }
  }
  if (ask.approve) {
    const { tool, input, summary } = ask.approve
    const note = reply.trim() || undefined
    return (
      <ApprovalCard
        variant="inline"
        tool={tool}
        input={input}
        title={`${worker.name} needs your OK`}
        asker={worker.name}
        since={relativeTime(ask.at)}
        lead={<Markdown text={ask.question} />}
        approveLabel="Approve once"
        denyLabel="Decline"
        busy={busy}
        extra={
          <input
            className="input approval__note"
            value={reply}
            placeholder="Add a note (optional)"
            onChange={(e) => setReply(e.target.value)}
          />
        }
        onApprove={() => void answer({ approved: true, text: note })}
        onDeny={() => void answer({ approved: false, text: note })}
      >
        {tool === 'run_command' && typeof input.command === 'string' ? (
          <CommandPreview command={input.command} />
        ) : (
          <CallPreview summary={summary} args={input} />
        )}
      </ApprovalCard>
    )
  }
  return (
    <div className="worker-ask" data-kind="question">
      <div className="worker-ask__head">
        <CircleHelp size={15} strokeWidth={2} />
        <span className="worker-ask__who">{worker.name} asks</span>
        <span className="worker-ask__when">{relativeTime(ask.at)}</span>
      </div>
      {/* Written by the model, so it gets the same Markdown as the thread. */}
      <div className="worker-ask__question">
        <Markdown text={ask.question} />
      </div>
      <div className="worker-ask__actions">
        {ask.options.map((option) => (
          <button key={option} className="btn btn--sm" disabled={busy} onClick={() => void answer({ text: option })}>
            {option}
          </button>
        ))}
        <input
          className="input worker-ask__reply"
          value={reply}
          placeholder="Or write an answer…"
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && reply.trim()) void answer({ text: reply.trim() })
          }}
        />
      </div>
    </div>
  )
}

/** Goal, routines and notes: the worker's own memory, under its profile. */
export function WorkerMemory({ worker, now }: { worker: Worker; now: number }): JSX.Element | null {
  const [notesOpen, setNotesOpen] = useState(false)
  const routines = worker.routines ?? []
  if (!worker.goal && !worker.notes && routines.length === 0) return null
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
      {routines.map((routine) => {
        const last = routine.runs[routine.runs.length - 1]
        return (
          <div key={routine.id} className="worker-memory__row" title={routine.task}>
            <Repeat size={14} strokeWidth={2} />
            <span>
              <span className="worker-memory__label">{routine.name}</span>{' '}
              {routine.daily ? `daily at ${routine.daily}` : `every ${Math.round((routine.everyMs ?? 0) / 60_000)} min`} · next{' '}
              {relativeTime(routine.nextAt, now)}
              {last && !last.ok && <span className="worker-memory__failed"> · last run failed</span>}
            </span>
          </div>
        )
      })}
      {worker.notes && (
        <div className="worker-memory__notes" data-open={notesOpen || undefined}>
          <button className="worker-memory__toggle" onClick={() => setNotesOpen(!notesOpen)} aria-expanded={notesOpen}>
            <ChevronDown size={13} strokeWidth={2} />
            {worker.name}’s notes
          </button>
          {notesOpen && <pre className="worker-memory__text">{worker.notes}</pre>}
        </div>
      )}
    </div>
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
      <LiveBrowserStage target={target} frame={frame} latest={steps[steps.length - 1]} working={working} controlled={controlled} agentName={worker.name} />
      <LiveBrowserSteps steps={steps} />
    </aside>
  )
}
