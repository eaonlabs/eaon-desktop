import { BROKERS, cadenceText, type ExitRequest, type OrderRequest, type TradingOrder, type TradingSchedule, type TradingSession, type TradingSnapshot } from '@shared/trading'
import { brokerLabel, describeExit, describeLimits, duration, orderOutcome, type TradingEngine } from './engine'
import { tradingToolSource } from './tools'
import { isMutating } from '../../agent/tools'

/**
 * Claude Code as Eaon's trading agent: the MCP tools it trades through and
 * the `trade` prompt that hands it a session. Two hosts serve them — the
 * desktop app's own loopback server (`claudeServer.ts`, for the Claude Code
 * pane on the Trading tab) and Eaon CLI's `eaon mcp --control`, which reaches
 * the engine over the session bus — so both describe the same tools in the
 * same words, and the desk's feed reads Claude Code's steps the same way.
 *
 * Policy (see the brain note on the removed Claude Code provider): Eaon never
 * starts Claude Code's work. The user hands the session over by typing the
 * prompt's slash command themselves; from there Claude Code calls these
 * tools, and every order still passes the engine's limits and kill switch.
 */

export interface McpToolDef {
  name: string
  description: () => string
  inputSchema: Record<string, unknown>
  run: (args: Record<string, unknown>) => Promise<string>
}

export type WaitSessionResult = { state: 'session'; id: string } | { state: 'waiting'; nextAt: number | null } | { state: 'none' }
export type WaitCheckResult =
  | { state: 'check'; check: number; brief: string; endsAt: number }
  | { state: 'waiting'; nextCheckAt: number | null }
  | { state: 'ended'; status: string; summary: string | null }

/** What the tools need from wherever the trading engine runs. */
export interface TraderHost {
  snapshot(): Promise<TradingSnapshot>
  waitSession(maxWaitMs: number): Promise<WaitSessionResult>
  waitCheck(sessionId: string, maxWaitMs: number): Promise<WaitCheckResult>
  logDecision(sessionId: string, text: string): Promise<unknown>
  sessionOrder(sessionId: string, request: OrderRequest): Promise<TradingOrder>
  placeOrder(request: OrderRequest): Promise<TradingOrder>
  cancelOrder(orderId: string): Promise<TradingSnapshot>
  closePosition(symbol: string): Promise<TradingOrder>
  setExit(request: ExitRequest): Promise<TradingSnapshot>
  /** One of the trading agent's read-only tools, by name (`trading_history`…), as text. */
  research(tool: string, args: Record<string, unknown>): Promise<string>
  /** Why Claude Code may not trade this account's money, or null when it may. */
  liveRefusal(snapshot: TradingSnapshot): string | null
}

export const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
export const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.trim() && Number.isFinite(Number(value)) ? Number(value) : undefined

/** The session Claude Code runs, if one is: a running session whose driver is Claude Code. */
export function claudeSession(snapshot: TradingSnapshot): TradingSession | null {
  const s = snapshot.activeSession
  return s && s.driver === 'claude-code' ? s : null
}

/** The mission Claude Code runs, if one is: an enabled schedule it drives (the every-market-day one first). */
export function claudeMission(snapshot: TradingSnapshot): TradingSchedule | null {
  const mine = (snapshot.schedules ?? []).filter((s) => s.enabled && s.driver === 'claude-code')
  return mine.find((s) => s.marketHours) ?? mine[0] ?? null
}

const when = (at: number | null): string =>
  at === null ? 'when it next opens' : new Date(at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
const timeOf = (at: number): string => new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

/** A check every few seconds: Claude Code works in a tight loop, so each check has to stay short. */
const FAST_CHECK_SECONDS = 30

/**
 * The `trade` prompt: hands Claude Code the session (or mission) waiting for
 * it — the goal, the limits, and the loop it runs until it ends.
 * `howToStart` says where in Eaon the user starts one, for when none waits.
 */
export function tradePrompt(snapshot: TradingSnapshot, howToStart: string): string {
  const session = claudeSession(snapshot)
  const mission = claudeMission(snapshot)
  if (!session && !mission) return `There is no Eaon trading session waiting for Claude Code. Tell the user to start one in Eaon: ${howToStart}. Then run this command again.`
  const broker = BROKERS.find((b) => b.id === snapshot.config.broker)
  const name = session?.name ?? mission!.name
  const strategy = session?.strategy ?? mission!.strategy
  const cadence = session ?? mission!
  const fast = Boolean(cadence.everySeconds && cadence.everySeconds <= FAST_CHECK_SECONDS)
  const daily = Boolean(mission?.marketHours && (!session || session.scheduleId === mission.id))
  const pending = !session && mission?.once ? mission.once : null
  const span = daily
    ? `every market day, from the open until just before the close; when the market reopens a new day’s session starts, until the user stops the mission${session ? '' : '. No day’s session is running right now: eaon_wait_for_check waits for the next one, at the open'}`
    : pending
      ? `from ${when(pending.start)} until ${timeOf(pending.end)}. It hasn’t started yet: eaon_wait_for_check waits until it does`
      : `until ${timeOf(session!.endsAt)} (${duration(Math.max(0, session!.endsAt - Date.now()))} from now)`
  return [
    `You are now the trading agent for Eaon’s ${daily ? 'mission' : 'trading session'} “${name}”, on ${brokerLabel(snapshot.config.broker)}${broker?.real ? ' — REAL MONEY: every loss is the user’s own money' : ' (practice money)'}. You trade US stocks and ETFs for the user, following their goal, within their limits, ${span}. Nobody approves each step: decide on your own, act, and keep going.`,
    '',
    'The goal, in the user’s words:',
    strategy,
    '',
    `Run it in a loop until ${daily ? 'Eaon says the mission is over' : 'the session ends'}:`,
    `1. Call eaon_wait_for_check. It waits until the next check is due — ${cadenceText(cadence)} while the market is open, sooner when a price alert fires or the user writes to you${daily ? ', and through the night until the next open' : ''} — and returns the brief: the time, the market, the account, positions and open orders, what moved since your last check, any ALERT and any MESSAGE FROM THE USER. If it says no check is due yet${daily || pending ? ' or that trading hasn’t started' : ''}, call it again. ${daily ? 'When a day’s session ends, call it again to wait for the next open. Stop only when it says the mission is over, and say how it went.' : 'If it says the session has ended, stop and say how it went.'}`,
    '2. Look before you act: eaon_history (trend, RSI, ATR, MACD, volume), eaon_scan (today’s movers), eaon_news, eaon_quote, eaon_account. Web search is fine for context.',
    '3. Act only through Eaon: eaon_order (always with a reason), eaon_set_exit to raise or set stops, eaon_close_position, eaon_cancel. Orders past the user’s limits are refused, and the refusal says why. Don’t use the shell or files to trade.',
    '4. End every check with eaon_log_decision: one line, what you did and why (the user sees it in Eaon). Then go back to step 1.',
    ...(fast
      ? [
          '',
          `Checks come ${cadenceText(cadence)}, so this is a fast loop: keep each check short. The brief already has the prices and what moved; research only when something changed, act when the goal calls for it, log one line, and go straight back to eaon_wait_for_check. Holding is a fine decision.`
        ]
      : []),
    '',
    'Risk, unless the goal says otherwise: give every new position a stop_loss (under a recent swing low, or about 2×ATR below the entry) or a trailing_stop_pct; size from the stop to risk about 1% of equity, then fit the limits; cut losers at the stop and never average down; raise stops on winners rather than selling early; be slower to buy when SPY and QQQ are falling. Doing nothing is often right; never trade for the sake of it.',
    `Limits (orders past them are refused): ${describeLimits(snapshot.config.limits)}.`,
    'The user can write to you while you trade; their message arrives in the next brief. Answer it in your decision and follow it where it fits the limits. Don’t stop the loop to ask them questions.',
    'Start now: call eaon_wait_for_check.'
  ].join('\n')
}

/** How a tool appears in the desk's feed: as the trading agent's tool of the same job. */
export function feedStep(name: string, args: Record<string, unknown>): { name: string; input: Record<string, unknown> } | null {
  switch (name) {
    case 'eaon_quote':
      return { name: 'trading_quote', input: { symbols: args.symbols } }
    case 'eaon_history':
    case 'eaon_scan':
    case 'eaon_news':
    case 'eaon_account':
      return { name: `trading_${name.slice(5)}`, input: args }
    case 'eaon_order':
      return { name: 'trading_order', input: args }
    case 'eaon_close_position':
      return { name: 'trading_order', input: { symbol: args.symbol, side: 'sell', reason: 'Closing the whole position.' } }
    case 'eaon_set_exit':
      return { name: 'trading_exits', input: args }
    case 'eaon_cancel':
      return { name: 'trading_cancel', input: args }
    default:
      return null
  }
}

const object = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({ type: 'object', properties, required })

/**
 * The tools Claude Code trades a session with: wait for each check, look,
 * trade, protect, and log the decision. `waitMs` is the longest one
 * `eaon_wait_for_check` call waits before saying "call again".
 */
export function traderTools(host: TraderHost, options: { waitMs: number }): McpToolDef[] {
  const WAIT = options.waitMs
  const guardLive = async (): Promise<TradingSnapshot> => {
    const snap = await host.snapshot()
    const refusal = host.liveRefusal(snap)
    if (refusal) throw new Error(refusal)
    return snap
  }
  const research = (tool: string) => (args: Record<string, unknown>) => host.research(tool, args)

  return [
    {
      name: 'eaon_wait_for_check',
      description: () =>
        'When you run an Eaon trading session or mission: waits for the next check (the interval, a price alert, a message from the user, or "check now"; before trading starts, its start) and returns its brief — market, account, positions, what moved, alerts, messages. Says when to call again, when a day’s session ended (call again for the next), and when it is all over.',
      inputSchema: object({}),
      run: async () => {
        const before = await host.snapshot()
        let session = claudeSession(before)
        if (!session) {
          const had = claudeMission(before)
          const between = await host.waitSession(WAIT)
          if (between.state === 'none')
            return had
              ? `The mission “${had.name}” is over: the user stopped it in Eaon. Stop here and tell the user how it went.`
              : 'No Eaon trading session or mission is waiting for Claude Code, so there is nothing to run. If one just ended, you’re done; otherwise the user starts one in Eaon.'
          if (between.state === 'waiting')
            return had?.marketHours
              ? `The market is closed; the mission’s next session starts ${when(between.nextAt)}. Call eaon_wait_for_check again to keep waiting for it.`
              : `Trading hasn’t started yet; it starts ${when(between.nextAt)}. Call eaon_wait_for_check again to keep waiting for it.`
          session = claudeSession(await host.snapshot())
          if (!session) return 'The next session is starting. Call eaon_wait_for_check again.'
        }
        const result = await host.waitCheck(session.id, WAIT)
        if (result.state === 'check') return `CHECK ${result.check} of “${session.name}”\n\n${result.brief}`
        if (result.state === 'waiting')
          return `No check is due yet${result.nextCheckAt ? ` (next at ${new Date(result.nextCheckAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })})` : ''}. Call eaon_wait_for_check again.`
        const mission = claudeMission(await host.snapshot())
        if (mission?.marketHours && session.scheduleId === mission.id)
          return `Today’s session has ended (${result.status}).${result.summary ? ` ${result.summary}` : ''} The mission goes on: the next session starts at the next market open. Call eaon_wait_for_check to wait for it.`
        return `The session has ended (${result.status}).${result.summary ? ` ${result.summary}` : ''} Stop here and tell the user how it went.`
      }
    },
    {
      name: 'eaon_log_decision',
      description: () => 'When you run an Eaon trading session: the one line that ends a check — what you did and why. The user sees it in Eaon’s activity feed.',
      inputSchema: object({ decision: { type: 'string' } }, ['decision']),
      run: async (args) => {
        const session = claudeSession(await host.snapshot())
        if (!session) throw new Error('No Eaon trading session is running for Claude Code right now (the market may be closed). Call eaon_wait_for_check.')
        await host.logDecision(session.id, str(args.decision))
        return 'Logged. Call eaon_wait_for_check for the next check.'
      }
    },
    {
      name: 'eaon_history',
      description: () => 'Trend and indicators for up to 5 US stocks or ETFs over a range: moving averages, RSI, ATR, MACD momentum, volume against its average, the range high and low.',
      inputSchema: object(
        {
          symbols: { type: 'array', items: { type: 'string' } },
          range: { type: 'string', enum: ['1d', '5d', '1mo', '6mo', '1y'], description: 'Default 6mo (daily bars); 1d and 5d are intraday' }
        },
        ['symbols']
      ),
      run: research('trading_history')
    },
    {
      name: 'eaon_scan',
      description: () => 'Today’s biggest US stock movers — gainers, losers or most active — with relative volume. Skips penny stocks and tiny companies.',
      inputSchema: object({ list: { type: 'string', enum: ['gainers', 'losers', 'active'] }, count: { type: 'number' } }),
      run: research('trading_scan')
    },
    {
      name: 'eaon_news',
      description: () => 'The latest headlines about up to 3 stocks, newest first.',
      inputSchema: object({ symbols: { type: 'array', items: { type: 'string' } } }, ['symbols']),
      run: research('trading_news')
    },
    {
      name: 'eaon_account',
      description: () => 'The trading account in full: equity, cash, positions with their exits, open orders, P&L statistics, the running session and the limits.',
      inputSchema: object({}),
      run: research('trading_account')
    },
    {
      name: 'eaon_order',
      description: () =>
        'Buy or sell a US stock or ETF on Eaon’s trading desk (the simulator or the Alpaca account it is set to). Checked against the user’s limits first; refusals say why. Give shares (qty) or dollars (notional), and a reason.',
      inputSchema: object(
        {
          symbol: { type: 'string' },
          side: { type: 'string', enum: ['buy', 'sell'] },
          qty: { type: 'number', description: 'Shares; fractions allowed' },
          notional: { type: 'number', description: 'Dollars, instead of qty (market orders)' },
          type: { type: 'string', enum: ['market', 'limit'] },
          limit_price: { type: 'number' },
          stop_loss: { type: 'number', description: 'Buys: sell if the price falls to this' },
          take_profit: { type: 'number', description: 'Buys: sell if the price rises to this' },
          trailing_stop_pct: { type: 'number', description: 'Buys: sell if the price falls this % below its high' },
          reason: { type: 'string', description: 'Why, in a sentence; shown to the user' }
        },
        ['symbol', 'side', 'reason']
      ),
      run: async (args) => {
        const snap = await guardLive()
        const request: OrderRequest = {
          symbol: str(args.symbol),
          side: args.side === 'sell' ? 'sell' : 'buy',
          reason: `Claude Code: ${str(args.reason) || 'no reason given'}`,
          ...(num(args.qty) !== undefined ? { qty: num(args.qty) } : {}),
          ...(num(args.notional) !== undefined ? { notional: num(args.notional) } : {}),
          ...(args.type === 'limit' || args.type === 'market' ? { type: args.type } : {}),
          ...(num(args.limit_price) !== undefined ? { limitPrice: num(args.limit_price) } : {}),
          ...(num(args.stop_loss) !== undefined ? { stopLoss: num(args.stop_loss) } : {}),
          ...(num(args.take_profit) !== undefined ? { takeProfit: num(args.take_profit) } : {}),
          ...(num(args.trailing_stop_pct) !== undefined ? { trailPct: num(args.trailing_stop_pct) } : {})
        }
        const session = claudeSession(snap)
        const order = session ? await host.sessionOrder(session.id, request) : await host.placeOrder(request)
        if (order.status === 'rejected') return orderOutcome(order)
        const exit = (await host.snapshot()).positions.find((p) => p.symbol === order.symbol)?.exit
        return `${orderOutcome(order)} Order id: ${order.id}.${exit ? ` Protected: ${describeExit(exit)}.` : order.side === 'buy' ? ' No stop is set on it.' : ''}`
      }
    },
    {
      name: 'eaon_cancel',
      description: () => 'Cancel an open order on Eaon’s desk by its id (eaon_account lists open orders).',
      inputSchema: object({ order_id: { type: 'string' } }, ['order_id']),
      run: async (args) => {
        const snap = await host.cancelOrder(str(args.order_id))
        const order = snap.orders.find((o) => o.id === str(args.order_id))
        return order ? `Order ${order.id}: ${order.status}.` : 'Canceled.'
      }
    },
    {
      name: 'eaon_close_position',
      description: () => 'Sell an entire holding at market on Eaon’s desk.',
      inputSchema: object({ symbol: { type: 'string' } }, ['symbol']),
      run: async (args) => {
        await guardLive()
        return orderOutcome(await host.closePosition(str(args.symbol)))
      }
    },
    {
      name: 'eaon_set_exit',
      description: () =>
        'Set, change or clear the protective exit on a holding: stop_loss, take_profit and trailing_stop_pct. Eaon watches it and sells at market when it is reached. 0 clears a value; clear removes them all.',
      inputSchema: object({ symbol: { type: 'string' }, stop_loss: { type: 'number' }, take_profit: { type: 'number' }, trailing_stop_pct: { type: 'number' }, clear: { type: 'boolean' } }, ['symbol']),
      run: async (args) => {
        const value = (raw: unknown): number | null | undefined => (raw === undefined ? undefined : num(raw) === 0 || raw === null ? null : num(raw))
        const request: ExitRequest =
          args.clear === true
            ? { symbol: str(args.symbol), stopPrice: null, targetPrice: null, trailPct: null }
            : { symbol: str(args.symbol), stopPrice: value(args.stop_loss), targetPrice: value(args.take_profit), trailPct: value(args.trailing_stop_pct) }
        const snap = await host.setExit(request)
        const exit = snap.positions.find((p) => p.symbol === request.symbol.toUpperCase())?.exit
        return exit ? `${exit.symbol} protected: ${describeExit(exit)}.` : `No exit on ${request.symbol.toUpperCase()} now.`
      }
    }
  ]
}

/** The trading agent's read-only tools, which Claude Code researches with too. */
const RESEARCH_TOOLS = new Set(['trading_account', 'trading_quote', 'trading_history', 'trading_scan', 'trading_news'])

/**
 * Runs one of the trading agent's read-only tools by name, so Claude Code
 * researches with exactly what Eaon's agent uses and its steps read the same.
 */
export async function runResearchTool(engine: TradingEngine, settings: Parameters<ReturnType<typeof tradingToolSource>['tools']>[0]['settings'], name: string, input: Record<string, unknown>): Promise<string> {
  if (!RESEARCH_TOOLS.has(name)) throw new Error(`${name} isn’t one of the research tools.`)
  const tool = tradingToolSource(engine)
    .tools({ mode: 'work', cwd: null, depth: 0, readOnly: true, settings, request: {} as never })
    .find((t) => t.name === name)
  if (!tool) throw new Error(`${name} isn’t available.`)
  const args = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const ctx = { request: { chatId: 'claude-code' }, settings, readOnly: true } as never
  // This runs a tool without the loop's approval, so it may only ever look:
  // a tool on the list that some input makes mutating is refused, not run.
  if (isMutating(tool, args, ctx)) throw new Error(`${name} with those arguments would change something; research tools only look.`)
  const result = await tool.run(args, ctx)
  return typeof result === 'string' ? result : result.text
}
