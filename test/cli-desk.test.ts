import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StreamEvent } from '../src/shared/types'
import type { TradingSession } from '../src/shared/trading'

/**
 * The trading desk's agent page: the activity recorder (stream events into
 * steps) and the feed it draws (checks, tool results, trades, decisions).
 */

process.env.EAON_CLI_HOME = mkdtempSync(join(tmpdir(), 'eaon-cli-desk-'))

const { activity, recordTradingActivity } = await import('../cli/src/core/tradingActivity')
const { CommandDesk } = await import('../cli/src/tui/views/trading/command')

const until = async (check: () => boolean, ms = 3000): Promise<void> => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n')

test('activity: a check’s stream events become steps — the check, thoughts, tools with results, the answer', async () => {
  let emit: ((sessionId: string, event: StreamEvent) => void) | null = null
  const stop = recordTradingActivity((fn) => {
    emit = fn
    return () => {}
  })
  const m = 'msg-1'
  const send = (event: StreamEvent): void => emit!('s1', event)
  send({ type: 'reasoning', messageId: m, text: 'Scanning ' })
  send({ type: 'reasoning', messageId: m, text: 'the leaders.' })
  send({ type: 'tool-call', messageId: m, toolId: 't1', name: 'trading_scan', input: { list: 'gainers' } })
  send({ type: 'tool-result', messageId: m, toolId: 't1', output: 'Today’s gainers:\n- NVDA (NVIDIA): $234.00, +4.20%', status: 'done' })
  send({ type: 'tool-call', messageId: m, toolId: 't2', name: 'trading_order', input: { symbol: 'NVDA', side: 'buy', qty: 8, reason: 'Breakout' } })
  send({ type: 'tool-result', messageId: m, toolId: 't2', output: 'Bought 8 NVDA at $234.00 ($1,872.00). Order id: x.', status: 'done' })
  send({ type: 'delta', messageId: m, text: 'Bought NVDA.' })
  send({ type: 'done', messageId: m })
  await until(() => activity.of('s1').some((s) => s.kind === 'answer' && s.endedAt !== undefined))
  const steps = activity.of('s1')
  assert.deepEqual(
    steps.map((s) => s.kind),
    ['check', 'thought', 'tool', 'tool', 'answer']
  )
  assert.equal(steps[0].check, 1)
  assert.equal(steps[1].text, 'Scanning the leaders.')
  assert.equal(steps[2].status, 'done')
  assert.match(steps[3].output!, /^Bought 8 NVDA/)
  assert.ok(steps.every((s) => s.endedAt !== undefined), 'everything closes when the check is done')
  // Claude Code's checks carry their number in the id; the feed shows that one.
  send({ type: 'usage', messageId: 'claude-code:s1:4', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as StreamEvent)
  await until(() => activity.of('s1').some((s) => s.id === 'claude-code:s1:4:check'))
  assert.equal(activity.of('s1').find((s) => s.id === 'claude-code:s1:4:check')!.check, 4)
  stop()
})

test('desk feed: the session in order, trades once with their protection, decisions, and no echo of the engine’s start note', () => {
  const t0 = Date.parse('2026-10-05T14:00:00Z')
  const session: TradingSession = {
    id: 'feed-1',
    scheduleId: null,
    name: 'Momentum',
    strategy: 'Buy breakouts with a trailing stop.',
    startedAt: t0,
    endsAt: t0 + 3_600_000,
    endedAt: null,
    status: 'running',
    everyMinutes: 5,
    flattenAtEnd: false,
    startEquity: 100_000,
    endEquity: null,
    orders: 1,
    checks: 1,
    log: [
      { at: t0, kind: 'note', text: 'Started on Simulator: a check every 5 min until 3:00 PM.' },
      { at: t0 + 21_000, kind: 'order', text: 'Bought 8 NVDA at $234.00 ($1,872.00). Protected: trailing 4% (stop now $224.64). Why: Breakout' },
      { at: t0 + 30_000, kind: 'decision', text: 'Bought NVDA on the breakout.' },
      { at: t0 + 600_000, kind: 'order', text: 'Stop hit at $224.64: Sold 8 NVDA at $224.50 ($1,796.00), realized -$76.00.' }
    ],
    summary: null,
    error: null
  }
  activity.merge({
    sessionId: 'feed-1',
    steps: [
      { id: 'c1', at: t0 + 10_000, check: 1, kind: 'check', endedAt: t0 + 31_000 },
      { id: 'th', at: t0 + 11_000, check: 1, kind: 'thought', text: 'Looking for momentum.', endedAt: t0 + 12_000 },
      {
        id: 'q',
        at: t0 + 13_000,
        check: 1,
        kind: 'tool',
        tool: 'trading_quote',
        input: { symbols: ['NVDA'] },
        output: 'NVDA (NVIDIA): $234.00, +1.20% today (+$2.77)',
        status: 'done',
        endedAt: t0 + 14_000
      },
      {
        id: 'o',
        at: t0 + 20_000,
        check: 1,
        kind: 'tool',
        tool: 'trading_order',
        input: { symbol: 'NVDA', side: 'buy', qty: 8, trailing_stop_pct: 4, reason: 'Breakout on volume' },
        output: 'Bought 8 NVDA at $234.00 ($1,872.00). Order id: eaon-1. Protected: trailing 4% (stop now $224.64).',
        status: 'done',
        endedAt: t0 + 21_000
      },
      { id: 'a', at: t0 + 25_000, check: 1, kind: 'answer', text: 'Bought NVDA on the breakout.', endedAt: t0 + 30_000 }
    ]
  })
  const view = { snapshot: null, app: { toast() {} }, positions: () => [], market: { quote: () => undefined } } as never
  const desk = new CommandDesk(view)
  const feed = text(desk.feedLines(session, activity.of('feed-1'), 90))
  assert.match(feed, /Session started/)
  assert.doesNotMatch(feed, /Started on Simulator/)
  assert.match(feed, /CHECK 1/)
  assert.match(feed, /∴ Looking for momentum\./)
  assert.match(feed, /Quote NVDA {2}→ NVDA \$234\.00 \+1\.20%/)
  // The agent's buy shows once (its tool call), with what protects it and why.
  assert.equal((feed.match(/8 NVDA/g) ?? []).length, 2, feed)
  assert.match(feed, /▲ BUY 8 NVDA {2}filled @ 234\.00/)
  assert.match(feed, /trailing 4% \(stop now \$224\.64\)/)
  assert.match(feed, /“Breakout on volume”/)
  // The decision once, and the stop that fired later from the engine's log.
  assert.equal((feed.match(/Bought NVDA on the breakout\./g) ?? []).length, 1)
  assert.match(feed, /▼ SOLD 8 NVDA {2}@ \$224\.50 · \$1,796\.00 · -\$76\.00/)
  assert.match(feed, /Stop hit at \$224\.64/)
  // In time order.
  const order = ['Session started', 'CHECK 1', 'Quote NVDA', 'BUY 8 NVDA', 'Bought NVDA on', 'SOLD 8 NVDA'].map((s) => feed.indexOf(s))
  assert.deepEqual([...order].sort((a, b) => a - b), order)
})

test('disclaimer dialog: ⏎ does nothing until the box is ticked; then it accepts the current version', async () => {
  const { ipc } = await import('../cli/src/runtime/ipc')
  const { DisclaimerModal } = await import('../cli/src/tui/views/trading/disclaimer')
  const { TRADING_DISCLAIMER_VERSION } = await import('../src/shared/trading')
  const accepted: number[] = []
  ipc.handle('trading:accept-disclaimer', (_e, version) => {
    accepted.push(Number(version))
    return { needsDisclaimer: false }
  })
  const toasts: string[] = []
  const view = { snapshot: { needsDisclaimer: true }, app: { toast: (t: string) => void toasts.push(t), invalidate() {} } } as never
  let ran = 0
  let closed = 0
  const modal = new DisclaimerModal(view, () => void ran++)
  modal.close = () => void closed++
  const key = (name: string, ch?: string) => modal.onEvent({ type: 'key', name, ch, ctrl: false, meta: false, shift: false } as never)
  key('enter')
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(accepted, [])
  assert.equal(closed, 0)
  key('space', ' ')
  key('enter')
  await until(() => closed === 1)
  assert.deepEqual(accepted, [TRADING_DISCLAIMER_VERSION])
  assert.equal(ran, 1, 'what was waiting for the disclaimer runs once it is accepted')
})

test('control tools (eaon mcp --control): real money needs the user’s say-so, hours become an end time, messages reach the agent', async () => {
  const { createEaonMcpTools, Inbox } = await import('../cli/src/bus/mcpServer')
  const calls: { channel: string; args: unknown[] }[] = []
  let broker = 'simulator'
  const snapshot = () => ({ config: { broker, limits: { maxOrderUsd: 2000, maxPositionPct: 20, maxInvestedPct: 80, maxDailyLossPct: 3, maxOrdersPerDay: 30, allowedSymbols: [] } }, activeSession: { id: 's1', name: 'Test', checks: 1, orders: 0, endsAt: Date.now() + 3600_000, log: [] }, orders: [], positions: [] })
  const bus = {
    owner: () => ({ id: 'owner' }),
    onMessage: () => () => {},
    invokeOwner: async (channel: string, args: unknown[]) => {
      calls.push({ channel, args })
      if (channel === 'trading:place-order') return { id: 'o1', symbol: 'AAPL', side: 'buy', type: 'market', qty: 1, limitPrice: null, status: 'filled', filledQty: 1, filledAvgPrice: 100, submittedAt: Date.now(), filledAt: Date.now(), realizedPl: null, source: 'user', sessionId: null, reason: '', error: null }
      if (channel === 'trading:start-session') return { name: 'X', endsAt: (args[0] as { until: number }).until, everyMinutes: 5 }
      return snapshot()
    }
  }
  const { call, tools } = createEaonMcpTools(bus as never, new Inbox(), { control: true })
  assert.ok(tools.some((t) => t.name === 'eaon_order'))
  assert.equal(createEaonMcpTools(bus as never, new Inbox()).tools.some((t) => t.name === 'eaon_order'), false, 'read-only without --control')

  const placed = await call('eaon_order', { symbol: 'AAPL', side: 'buy', qty: 1, reason: 'test' })
  assert.equal(placed.isError, false)
  assert.match(placed.text, /^Bought 1 AAPL/)
  assert.match((calls.find((c) => c.channel === 'trading:place-order')!.args[0] as { reason: string }).reason, /^Claude Code: test/)

  broker = 'alpaca-live'
  const live = await call('eaon_order', { symbol: 'AAPL', side: 'buy', qty: 1, reason: 'test' })
  assert.equal(live.isError, true)
  assert.match(live.text, /real money/)
  broker = 'simulator'

  const before = Date.now()
  await call('eaon_session', { action: 'start', strategy: 'Hold', hours: 2 })
  const until = (calls.find((c) => c.channel === 'trading:start-session')!.args[0] as { until: number }).until
  assert.ok(until >= before + 2 * 3600_000 - 1000 && until <= Date.now() + 2 * 3600_000 + 1000)

  await call('eaon_session', { action: 'tell', message: 'Sell half' })
  assert.deepEqual(calls.find((c) => c.channel === 'trading:tell-session')!.args, ['s1', 'Sell half'])
})

test('Claude Code as the agent: the trade prompt hands over the session, checks come through the wait, orders are the session’s, and steps reach the feed', async () => {
  const { createEaonMcpTools, Inbox, tradePrompt } = await import('../cli/src/bus/mcpServer')
  const calls: { channel: string; args: unknown[]; timeout?: number }[] = []
  let session: Record<string, unknown> | null = { id: 's9', name: 'Momentum', strategy: 'Buy breakouts with a trailing stop.', driver: 'claude-code', everyMinutes: 5, checks: 0, orders: 0, endsAt: Date.now() + 2 * 3600_000, log: [] }
  const snapshot = () => ({ config: { broker: 'simulator', limits: { maxOrderUsd: 2000, maxPositionPct: 20, maxInvestedPct: 80, maxDailyLossPct: 3, maxOrdersPerDay: 30, allowedSymbols: [] } }, activeSession: session, orders: [], positions: [] })
  const bus = {
    owner: () => ({ id: 'owner' }),
    onMessage: () => () => {},
    invokeOwner: async (channel: string, args: unknown[], timeout?: number) => {
      calls.push({ channel, args, timeout })
      if (channel === 'trading:wait-check') return { state: 'check', check: 1, brief: 'Market: open. Account …', endsAt: Date.now() + 3600_000 }
      if (channel === 'trading:session-order') return { id: 'o9', symbol: 'NVDA', side: 'buy', type: 'market', qty: 2, limitPrice: null, status: 'filled', filledQty: 2, filledAvgPrice: 200, submittedAt: Date.now(), filledAt: Date.now(), realizedPl: null, source: 'session', sessionId: 's9', reason: '', error: null }
      if (channel === 'trading:research') return `research ${String(args[0])}`
      return snapshot()
    }
  }
  const prompt = await tradePrompt(bus as never)
  assert.match(prompt, /trading agent for Eaon’s trading session “Momentum”/)
  assert.match(prompt, /Buy breakouts with a trailing stop\./)
  assert.match(prompt, /eaon_wait_for_check/)
  assert.match(prompt, /eaon_log_decision/)

  const { call } = createEaonMcpTools(bus as never, new Inbox(), { control: true })
  const check = await call('eaon_wait_for_check', {})
  assert.match(check.text, /^CHECK 1 of “Momentum”\n\nMarket: open/)
  const wait = calls.find((c) => c.channel === 'trading:wait-check')!
  // It returns as soon as a check is due; the long cap only matters overnight.
  assert.deepEqual(wait.args, ['s9', 4 * 3_600_000])
  assert.ok((wait.timeout ?? 0) >= 4 * 3_600_000, 'the bus call outlasts the wait')

  assert.equal((await call('eaon_history', { symbols: ['NVDA'] })).text, 'research trading_history')
  const order = await call('eaon_order', { symbol: 'NVDA', side: 'buy', qty: 2, reason: 'Breakout' })
  assert.match(order.text, /^Bought 2 NVDA/)
  assert.deepEqual(calls.find((c) => c.channel === 'trading:session-order')!.args.slice(0, 1), ['s9'])
  await call('eaon_log_decision', { decision: 'Bought 2 NVDA on the breakout.' })
  assert.deepEqual(calls.find((c) => c.channel === 'trading:log-decision')!.args, ['s9', 'Bought 2 NVDA on the breakout.'])

  // Steps go to the feed under the agent's own tool names.
  await new Promise((r) => setTimeout(r, 10))
  const steps = calls.filter((c) => c.channel === 'trading:external-tool').map((c) => c.args[0])
  assert.deepEqual(steps, ['trading_history', 'trading_order'])

  // No session waiting: the prompt says how to start one.
  session = null
  assert.match(await tradePrompt(bus as never), /no Eaon trading session waiting for Claude Code/)

  // An armed every-day mission between sessions: Claude Code takes the mission and waits for the open.
  const closed = bus.invokeOwner
  bus.invokeOwner = async (channel: string, args: unknown[], timeout?: number) =>
    channel === 'trading:snapshot'
      ? { ...snapshot(), schedules: [{ id: 'm1', name: 'Semis', strategy: 'Swing the semis.', enabled: true, marketHours: true, driver: 'claude-code', everyMinutes: 5, days: [1, 2, 3, 4, 5], start: '09:30', end: '16:00' }] }
      : closed(channel, args, timeout)
  const mission = await tradePrompt(bus as never)
  assert.match(mission, /every market day, from the open until just before the close/)
  assert.match(mission, /No day’s session is running right now: eaon_wait_for_check waits for the next one, at the open/)
  assert.match(mission, /Stop only when it says the mission is over/)

  // Waiting between days, then the user stops the mission: Claude Code is told it is over.
  const armed = bus.invokeOwner
  bus.invokeOwner = async (channel: string, args: unknown[], timeout?: number) => (channel === 'trading:wait-session' ? { state: 'none' } : armed(channel, args, timeout))
  assert.match((await call('eaon_wait_for_check', {})).text, /The mission “Semis” is over: the user stopped it in Eaon/)
})

test('mission: G with “every market day” arms a market-hours schedule for the chosen agent, and X stops the session and the mission', async () => {
  const { ipc } = await import('../cli/src/runtime/ipc')
  const saved: Record<string, unknown>[] = []
  const stopped: string[] = []
  let schedules: Record<string, unknown>[] = []
  let active: Record<string, unknown> | null = null
  const snap = () => ({
    config: { broker: 'simulator', halted: false, limits: {} },
    keys: { paper: false, live: false },
    schedules,
    sessions: [],
    activeSession: active,
    agent: null,
    needsDisclaimer: false
  })
  ipc.handle('trading:save-schedule', (_e, draft: Record<string, unknown>) => {
    saved.push(draft)
    const schedule = { ...draft, id: (draft.id as string) ?? 'mission-1' }
    schedules = [schedule]
    return schedule
  })
  ipc.handle('trading:snapshot', () => snap())
  ipc.handle('trading:stop-session', (_e, id: string) => {
    stopped.push(id)
    active = null
    return snap()
  })
  const toasts: string[] = []
  const modes: string[] = []
  const pushed: { onEvent(e: unknown): void }[] = []
  const view = {
    snapshot: snap(),
    loadError: null,
    app: { toast: (t: string) => void toasts.push(t), invalidate() {}, switchMode: (m: string) => void modes.push(m), push: (m: never) => void pushed.push(m) },
    positions: () => [],
    market: { quote: () => undefined }
  } as never as { snapshot: ReturnType<typeof snap> }
  const desk = new CommandDesk(view as never)
  assert.equal(desk.mission.until, 'market', 'every market day is the default')
  desk.mission.strategy = 'Swing the semis; never more than 20% in one.'
  desk.mission.driver = 'claude-code'
  await desk.start()
  assert.equal(saved.length, 1)
  assert.equal(saved[0].marketHours, true)
  assert.equal(saved[0].driver, 'claude-code')
  assert.equal(saved[0].enabled, true)
  assert.equal(saved[0].strategy, 'Swing the semis; never more than 20% in one.')
  assert.equal(desk.mission.missionId, 'mission-1')
  assert.deepEqual(modes, ['claude'], 'Claude Code’s screen opens for the hand-over')
  assert.match(toasts.at(-1)!, /Mission armed — type \/mcp__eaon__trade/)

  // Arming again updates the same schedule rather than adding one.
  await desk.start()
  assert.equal(saved[1].id, 'mission-1')

  // Today's session of the mission is running; X stops it and the mission.
  active = { id: 'today', scheduleId: 'mission-1', status: 'running', driver: 'claude-code' }
  view.snapshot = snap()
  desk.stopAgent()
  await until(() => pushed.length > 0)
  pushed.at(-1)!.onEvent({ type: 'key', name: 'y', ch: 'y', ctrl: false, meta: false, shift: false })
  await until(() => stopped.length === 1)
  assert.deepEqual(stopped, ['today'])
  assert.equal(saved.at(-1)!.enabled, false, 'the mission won’t start again at the next open')
})
