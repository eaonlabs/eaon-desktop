import { useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { Check, CircleAlert, Copy, Link2, Play, RotateCcw, Send, ShieldAlert, Square, Zap } from 'lucide-react'
import {
  BROKERS,
  cadenceText,
  type ClaudeTradingLaunch,
  type SessionDriver,
  type TradingSchedule,
  type TradingSession,
  type TradingSnapshot,
  type TradingStep
} from '@shared/trading'
import { Segmented, Select, Switch } from '../ui'
import { terminals } from '../code/terminal/registry'
import { clock, dayAndTime, direction, signedPct, signedUsd, span, usd, useNow, useTrading } from './tradingStore'

/**
 * The agent desk: the user's own Claude Code, running in a pane on the
 * Trading tab and connected to Eaon's trading MCP server, beside the controls
 * that set it trading — the goal, when to start and stop, how often it
 * decides — and a live feed of what it does.
 *
 * Eaon never types into Claude Code (see the brain note on the removed Claude
 * Code provider): it starts the binary with Eaon's MCP config, and the user
 * hands it the session by typing the `trade` command themselves. Every order
 * it places goes through the engine's limits and kill switch.
 */

type When = 'now' | 'at' | 'market'

const CADENCES: { value: string; label: string }[] = [
  { value: '1', label: 'Every second' },
  { value: '5', label: 'Every 5 seconds' },
  { value: '15', label: 'Every 15 seconds' },
  { value: '30', label: 'Every 30 seconds' },
  { value: '60', label: 'Every minute' },
  { value: '300', label: 'Every 5 minutes' },
  { value: '900', label: 'Every 15 minutes' }
]

const GOAL_HINT =
  'e.g. Day-trade liquid large caps. Buy strength above the opening range with a 1% stop, take profit at +2%, at most 3 positions. Flat by the end.'

/** Local "HH:MM" as its next timestamp: today, or tomorrow once today's has passed. */
function nextAt(time: string, after = Date.now()): number {
  const [h, m] = time.split(':').map(Number)
  const at = new Date(after)
  at.setHours(h, m, 0, 0)
  if (at.getTime() <= after) at.setDate(at.getDate() + 1)
  return at.getTime()
}

const hhmm = (at: number): string => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** A cadence in seconds as the request's fields. */
function cadenceFields(seconds: number): { everySeconds?: number; everyMinutes: number } {
  return seconds < 60 ? { everySeconds: seconds, everyMinutes: 1 } : { everyMinutes: Math.round(seconds / 60) }
}

/** The armed schedule the desk started for an agent and hasn't run out yet: a one-off window or every market day. */
function armedPlan(snapshot: TradingSnapshot): TradingSchedule | null {
  const now = Date.now()
  return snapshot.schedules.find((s) => s.enabled && (s.marketHours || (s.once && s.once.end > now))) ?? null
}

export function AgentDesk({ snapshot }: { snapshot: TradingSnapshot }): JSX.Element {
  const session = snapshot.activeSession
  const plan = armedPlan(snapshot)
  const [driver, setDriver] = useState<SessionDriver>(() => session?.driver ?? plan?.driver ?? 'claude-code')
  const usesClaude = (session?.driver ?? plan?.driver ?? driver) === 'claude-code'
  return (
    <div className="tr-agent-desk" data-claude={usesClaude || undefined}>
      {usesClaude && <ClaudePane snapshot={snapshot} />}
      <div className="tr-agent-desk__side">
        <MissionControl snapshot={snapshot} driver={driver} setDriver={setDriver} plan={plan} />
        <LiveFeed snapshot={snapshot} />
      </div>
    </div>
  )
}

/* -------------------------------------------------------------- Claude Code */

function usePaneStatus(paneId: string): string {
  useSyncExternalStore(terminals.subscribe, terminals.getVersion)
  return terminals.statusOf(paneId).status
}

/** What the pane's header says Claude Code is doing, from the engine's side of it. */
function claudeState(snapshot: TradingSnapshot): { tone: 'idle' | 'wait' | 'live' | 'warn'; text: string } {
  const session = snapshot.activeSession
  const claudeSession = session?.driver === 'claude-code' ? session : null
  if (claudeSession) {
    if (!snapshot.agent?.connected) return { tone: 'warn', text: 'Waiting for you to hand it the session' }
    if (snapshot.agent.checking) return { tone: 'live', text: `Deciding · check ${claudeSession.checks}` }
    return { tone: 'live', text: 'Trading · waiting for the next check' }
  }
  if (snapshot.claudeWaiting) return { tone: 'wait', text: 'Holding the session until trading starts' }
  const plan = armedPlan(snapshot)
  if (plan?.driver === 'claude-code') return { tone: 'warn', text: 'Armed · hand it the session now so it’s ready' }
  return { tone: 'idle', text: 'Connected to Eaon’s trading desk' }
}

function ClaudePane({ snapshot }: { snapshot: TradingSnapshot }): JSX.Element {
  const screen = useRef<HTMLDivElement>(null)
  const [launch, setLaunch] = useState<ClaudeTradingLaunch | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const status = usePaneStatus(launch?.paneId ?? 'trading-claude')
  const state = claudeState(snapshot)
  const needsHandover = state.tone === 'warn'

  const load = (): void => {
    setError(null)
    window.api.trading.claudeLaunch().then(setLaunch, (e) => setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)))
  }
  useEffect(load, [])

  useEffect(() => {
    const host = screen.current
    if (!host || !launch?.installed) return
    terminals.attach(launch.paneId, host, { cwd: launch.cwd, command: launch.command, agent: 'claude' })
    return () => terminals.detach(launch.paneId, host)
  }, [launch])

  const copy = (): void => {
    if (!launch) return
    void navigator.clipboard.writeText(launch.tradeCommand).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    })
  }

  return (
    <section className="term-pane tr-claude" data-status={status} aria-label="Claude Code" onMouseDown={() => launch && terminals.focus(launch.paneId)}>
      <header className="term-pane__head">
        <span className="term-pane__dot" />
        <span className="term-pane__name">Claude Code</span>
        <span className="tr-claude__state" data-tone={state.tone}>
          {state.text}
        </span>
        <span className="term-pane__spacer" />
        {launch?.installed && (
          <button className="term-pane__btn" aria-label="Restart Claude Code" title="Restart Claude Code" onClick={() => terminals.restart(launch.paneId, { cwd: launch.cwd, command: launch.command, agent: 'claude' })}>
            <RotateCcw size={13} strokeWidth={2} />
          </button>
        )}
      </header>
      {launch && needsHandover && (
        <div className="tr-claude__handover" role="status">
          <Zap size={14} strokeWidth={2} />
          <span>
            Hand Claude Code the session: click in the terminal, type <code>{launch.tradeCommand}</code> and press Return.
          </span>
          <button className="btn btn--sm" onClick={copy}>
            {copied ? <Check size={13} strokeWidth={2.2} /> : <Copy size={13} strokeWidth={2} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
      {error && <p className="tr-claude__note tr-error">{error}</p>}
      {launch && !launch.installed ? (
        <div className="tr-claude__missing">
          <CircleAlert size={18} strokeWidth={1.8} />
          <p>Claude Code isn’t installed on this computer. Install it, sign in once with its own /login, then check again.</p>
          <code>{launch.installHint}</code>
          <button className="btn btn--sm" onClick={load}>
            Check again
          </button>
        </div>
      ) : (
        <div ref={screen} className="term-pane__screen tr-claude__screen" />
      )}
      {launch?.installed && status === 'exited' && (
        <button className="term-pane__restart" onClick={() => terminals.restart(launch.paneId, { cwd: launch.cwd, command: launch.command, agent: 'claude' })}>
          <RotateCcw size={13} strokeWidth={2} />
          Restart Claude Code
        </button>
      )}
    </section>
  )
}

/* ---------------------------------------------------------- mission control */

function MissionControl({
  snapshot,
  driver,
  setDriver,
  plan
}: {
  snapshot: TradingSnapshot
  driver: SessionDriver
  setDriver: (driver: SessionDriver) => void
  plan: TradingSchedule | null
}): JSX.Element {
  const session = snapshot.activeSession
  return (
    <section className="tr-panel tr-mission" aria-label="Mission control">
      <div className="tr-panel__head">
        <h2 className="tr-h2">Agentic trading</h2>
        <AccountChip snapshot={snapshot} />
      </div>
      {session ? <RunningSession snapshot={snapshot} session={session} plan={plan} /> : plan ? <ArmedPlan snapshot={snapshot} plan={plan} /> : <SetUp snapshot={snapshot} driver={driver} setDriver={setDriver} />}
    </section>
  )
}

/** Which account the agent trades, and whether it is linked; links to the setup below. */
function AccountChip({ snapshot }: { snapshot: TradingSnapshot }): JSX.Element {
  const broker = BROKERS.find((b) => b.id === snapshot.config.broker)!
  const linked = Boolean(snapshot.account)
  return (
    <button
      className="tr-account-chip"
      data-real={broker.real || undefined}
      data-linked={linked || undefined}
      title={linked ? `Trading ${broker.label}. Change the account or its limits below.` : 'Link an account below'}
      onClick={() => document.getElementById('tr-setup')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
    >
      {broker.real ? <ShieldAlert size={13} strokeWidth={2} /> : <Link2 size={13} strokeWidth={2} />}
      {broker.label}
      <span className="tr-muted">{linked ? usd(snapshot.account!.equity, true) : 'not linked'}</span>
    </button>
  )
}

function SetUp({ snapshot, driver, setDriver }: { snapshot: TradingSnapshot; driver: SessionDriver; setDriver: (d: SessionDriver) => void }): JSX.Element {
  const run = useTrading((s) => s.run)
  const [goal, setGoal] = useState('')
  const [when, setWhen] = useState<When>('now')
  const [start, setStart] = useState(() => hhmm(Date.now() + 15 * 60_000))
  const [end, setEnd] = useState(() => (new Date().getHours() < 15 ? '15:55' : hhmm(Date.now() + 2 * 3600_000)))
  const [cadence, setCadence] = useState('1')
  const [flatten, setFlatten] = useState(false)
  const [liveMoney, setLiveMoney] = useState<boolean | null>(null)
  const real = BROKERS.find((b) => b.id === snapshot.config.broker)?.real === true
  const claude = driver === 'claude-code'

  useEffect(() => {
    if (claude && real && liveMoney === null) void window.api.trading.claudeLaunch().then((l) => setLiveMoney(l.liveMoney), () => setLiveMoney(false))
  }, [claude, real, liveMoney])

  const startAt = when === 'at' ? nextAt(start) : Date.now()
  const endAt = nextAt(end, startAt)
  const blocked = !goal.trim() || snapshot.config.halted || !snapshot.account || (when !== 'market' && !/^\d{2}:\d{2}$/.test(end))
  const fields = { ...cadenceFields(Number(cadence)), flattenAtEnd: flatten, ...(claude ? { driver: 'claude-code' as const } : {}) }

  const begin = async (): Promise<void> => {
    const strategy = goal.trim()
    let done: unknown = null
    if (when === 'now') done = await run(() => window.api.trading.startSession({ strategy, until: endAt, ...fields }))
    else
      done = await run(() =>
        window.api.trading.saveSchedule({
          name: '',
          days: [],
          start: '',
          end: '',
          strategy,
          enabled: true,
          ...fields,
          ...(when === 'market' ? { marketHours: true } : { once: { start: startAt, end: endAt } })
        })
      )
    if (!done) return
    setGoal('')
    void run(() => window.api.trading.snapshot())
  }

  return (
    <div className="tr-setup-form">
      <div className="tr-setup-form__row">
        <span className="tr-label">Agent</span>
        <Segmented
          value={driver}
          options={[
            { value: 'claude-code', label: 'Claude Code' },
            { value: 'eaon', label: 'Eaon’s agent' }
          ]}
          onChange={setDriver}
        />
      </div>
      <label className="tr-field">
        <span>Goal</span>
        <textarea className="input" rows={3} value={goal} placeholder={GOAL_HINT} onChange={(e) => setGoal(e.target.value)} />
      </label>
      <div className="tr-setup-form__row">
        <span className="tr-label">Start</span>
        <Segmented
          value={when}
          options={[
            { value: 'now', label: 'Now' },
            { value: 'at', label: 'At a time' },
            { value: 'market', label: 'Every market day' }
          ]}
          onChange={setWhen}
        />
      </div>
      {when !== 'market' ? (
        <div className="tr-setup-form__times">
          {when === 'at' && (
            <label className="tr-field tr-field--inline">
              <span>Start at</span>
              <input className="input tr-time" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
            </label>
          )}
          <label className="tr-field tr-field--inline">
            <span>Stop at</span>
            <input className="input tr-time" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
          </label>
          <span className="tr-muted tr-setup-form__span">
            {when === 'at' ? `${dayAndTime(startAt)} → ${dayAndTime(endAt)}` : `for ${span(endAt - Date.now())}`}
          </span>
        </div>
      ) : (
        <p className="tr-muted tr-hint">From the opening bell to five minutes before the close, every day the US market is open, until you stop it.</p>
      )}
      <div className="tr-setup-form__row">
        <span className="tr-label">Decide</span>
        <Select value={cadence} options={CADENCES} onChange={setCadence} width={180} />
        <label className="tr-switch-field">
          <Switch label="Sell everything at the end" checked={flatten} onChange={setFlatten} />
          <span>Sell all at the end</span>
        </label>
      </div>
      {Number(cadence) < 60 && (
        <p className="tr-muted tr-hint">
          {claude ? 'Claude Code' : 'The agent'} gets a fresh brief {cadenceText(cadenceFields(Number(cadence)))} and decides on it; while it is still thinking, the next check waits, so in practice it decides as fast as it can work.
        </p>
      )}
      {claude && real && (
        <label className="tr-switch-field tr-real">
          <Switch
            label="Let Claude Code trade real money"
            checked={liveMoney === true}
            onChange={(on) => void window.api.trading.setClaudeLiveMoney(on).then(setLiveMoney)}
          />
          <span>Let Claude Code trade real money on this account</span>
        </label>
      )}
      <div className="tr-setup-form__actions">
        {!snapshot.account && <span className="tr-muted">Link an account below first.</span>}
        <button className="btn btn--primary" disabled={blocked} onClick={() => void begin()}>
          <Play size={13} strokeWidth={2} />
          {when === 'now' ? 'Start trading' : 'Arm'}
        </button>
      </div>
    </div>
  )
}

/** A one-off window or a market-days mission, armed and waiting for its start. */
function ArmedPlan({ snapshot, plan }: { snapshot: TradingSnapshot; plan: TradingSchedule }): JSX.Element {
  const run = useTrading((s) => s.run)
  const now = useNow()
  const nextOpen = snapshot.account?.nextOpen ?? null
  const startsAt = plan.once ? plan.once.start : nextOpen
  return (
    <div className="tr-armed">
      <div className="tr-armed__title">
        <span className="tr-badge">{plan.driver === 'claude-code' ? 'Claude Code' : 'Eaon’s agent'}</span>
        {plan.marketHours ? 'Every market day, open to close' : `${dayAndTime(plan.once!.start)} → ${clock(plan.once!.end)}`}
      </div>
      <div className="tr-armed__count">
        {startsAt && startsAt > now ? (
          <>
            Starts in <strong>{span(startsAt - now)}</strong>
          </>
        ) : (
          'Starting…'
        )}
        <span className="tr-muted"> · decides {cadenceText(plan)}</span>
      </div>
      <p className="tr-armed__goal">{plan.strategy}</p>
      <div className="tr-setup-form__actions">
        <button className="btn" onClick={() => void run(() => window.api.trading.removeSchedule(plan.id))}>
          <Square size={11} strokeWidth={0} fill="currentColor" />
          Disarm
        </button>
      </div>
    </div>
  )
}

function RunningSession({ snapshot, session, plan }: { snapshot: TradingSnapshot; session: TradingSession; plan: TradingSchedule | null }): JSX.Element {
  const run = useTrading((s) => s.run)
  const now = useNow()
  const agent = snapshot.agent
  const change = (snapshot.account?.equity ?? session.startEquity) - session.startEquity
  const used = Math.min(1, Math.max(0, (now - session.startedAt) / Math.max(1, session.endsAt - session.startedAt)))
  const minutes = Math.max(1 / 60, (now - session.startedAt) / 60_000)
  const mission = plan && session.scheduleId === plan.id ? plan : null
  const claude = session.driver === 'claude-code'
  const next = agent?.checking
    ? `${claude ? 'Claude Code' : 'The agent'} is deciding · ${span(now - (agent.checkStartedAt ?? now))}`
    : claude && !agent?.connected
      ? 'Waiting for Claude Code to take the session'
      : agent?.nextCheckAt
        ? agent.nextCheckAt <= now
          ? 'Next check due now'
          : `Next check in ${span(agent.nextCheckAt - now)}`
        : 'Between checks'
  const stop = async (): Promise<void> => {
    await run(() => window.api.trading.stopSession(session.id))
    // A stopped mission or one-off window mustn't start the session again.
    if (mission) await run(() => window.api.trading.removeSchedule(mission.id))
  }
  return (
    <div className="tr-running">
      <div className="tr-running__head">
        <span className="tr-session__pulse" aria-hidden="true" />
        <div className="tr-running__title">
          <span className="tr-badge">{claude ? 'Claude Code' : 'Eaon’s agent'}</span>
          {session.name}
        </div>
      </div>
      <div className="tr-running__time">
        <div className="tr-progress" role="progressbar" aria-label="Time used" aria-valuenow={Math.round(used * 100)} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${used * 100}%` }} />
        </div>
        <div className="tr-running__clock">
          <span>Started {clock(session.startedAt)}</span>
          <strong>{span(session.endsAt - now)} left</strong>
          <span>Stops {clock(session.endsAt)}</span>
        </div>
      </div>
      <dl className="tr-running__stats">
        <div>
          <dt>This session</dt>
          <dd>
            <span className="tr-delta" data-dir={direction(change)}>
              {signedUsd(change)} <span className="tr-muted">{signedPct(session.startEquity ? (change / session.startEquity) * 100 : 0)}</span>
            </span>
          </dd>
        </div>
        <div>
          <dt>Checks</dt>
          <dd>
            {session.checks} <span className="tr-muted">{(session.checks / minutes).toFixed(session.checks / minutes < 10 ? 1 : 0)}/min</span>
          </dd>
        </div>
        <div>
          <dt>Orders</dt>
          <dd>{session.orders}</dd>
        </div>
        <div>
          <dt>Decides</dt>
          <dd>{cadenceText(session)}</dd>
        </div>
      </dl>
      <div className="tr-running__next" aria-live="polite">
        {next}
      </div>
      <div className="tr-setup-form__actions">
        <button className="btn" disabled={agent?.checking} onClick={() => void run(() => window.api.trading.checkNow(session.id))}>
          <Zap size={13} strokeWidth={2} />
          Check now
        </button>
        <button className="btn" onClick={() => void stop()}>
          <Square size={11} strokeWidth={0} fill="currentColor" />
          {mission ? 'Stop and disarm' : 'Stop'}
        </button>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- live feed */

const list = (value: unknown): string => (Array.isArray(value) ? value.map(String).join(', ') : typeof value === 'string' ? value : '')

/** A tool step in plain words. */
function stepText(step: TradingStep): string {
  const i = step.input
  switch (step.tool) {
    case 'trading_quote':
      return `Priced ${list(i.symbols)}`
    case 'trading_history':
      return `Read the trend of ${list(i.symbols)}${i.range ? ` (${String(i.range)})` : ''}`
    case 'trading_scan':
      return `Scanned today’s ${typeof i.list === 'string' ? (i.list === 'active' ? 'most active' : i.list) : 'movers'}`
    case 'trading_news':
      return `Read the news on ${list(i.symbols)}`
    case 'trading_account':
      return 'Checked the account'
    case 'trading_order':
      return `Order: ${String(i.side ?? '')} ${i.qty ?? (i.notional ? `$${String(i.notional)} of` : '')} ${String(i.symbol ?? '')}`.replace(/\s+/g, ' ')
    case 'trading_exits':
      return `Set the exit on ${String(i.symbol ?? '')}`
    case 'trading_cancel':
      return 'Canceled an order'
    case 'web_search':
      return `Searched the web: ${String(i.query ?? '')}`
    case 'web_fetch':
      return 'Read a web page'
    default:
      return step.tool.replace(/_/g, ' ')
  }
}

type FeedItem = { key: string; at: number; kind: string; text: string; detail?: string | null }

function LiveFeed({ snapshot }: { snapshot: TradingSnapshot }): JSX.Element | null {
  const steps = useTrading((s) => s.steps)
  const run = useTrading((s) => s.run)
  const [message, setMessage] = useState('')
  const session = snapshot.activeSession ?? snapshot.sessions[0] ?? null
  if (!session) return null
  const items: FeedItem[] = [
    ...session.log.map((e, n) => ({ key: `l${n}-${e.at}`, at: e.at, kind: e.kind, text: e.text })),
    ...steps.filter((s) => s.sessionId === session.id).map((s) => ({ key: s.id, at: s.at, kind: `tool-${s.status}`, text: stepText(s), detail: s.status === 'error' ? s.output : null }))
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, 60)
  const live = snapshot.activeSession?.id === session.id
  const send = (): void => {
    const text = message.trim()
    if (!text) return
    void run(() => window.api.trading.tellSession(session.id, text)).then((done) => done && setMessage(''))
  }
  return (
    <section className="tr-panel tr-feed" aria-label="What the agent is doing">
      <div className="tr-panel__head">
        <h2 className="tr-h2">{live ? 'Live' : 'Last session'}</h2>
        <span className="tr-muted">{live ? 'Every step, as it happens' : session.name}</span>
      </div>
      {live && (
        <form
          className="tr-feed__say"
          onSubmit={(e) => {
            e.preventDefault()
            send()
          }}
        >
          <input className="input" value={message} placeholder={`Tell ${session.driver === 'claude-code' ? 'Claude Code' : 'the agent'} something…`} onChange={(e) => setMessage(e.target.value)} />
          <button className="btn btn--sm" type="submit" disabled={!message.trim()} aria-label="Send">
            <Send size={13} strokeWidth={2} />
          </button>
        </form>
      )}
      {session.summary && <p className="tr-log__summary">{session.summary}</p>}
      {items.length === 0 ? (
        <p className="tr-empty">Nothing yet — steps show up here as the agent works.</p>
      ) : (
        <ol className="tr-feed__list">
          {items.map((item) => (
            <li key={item.key} data-kind={item.kind}>
              <span className="tr-feed__time">{new Date(item.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</span>
              <span className="tr-feed__text">
                {item.text}
                {item.detail && <span className="tr-feed__detail">{item.detail}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
