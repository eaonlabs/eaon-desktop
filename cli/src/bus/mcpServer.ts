import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { YahooMarketData } from '@main/features/trading/marketData'
import { brokerLabel, describeExit, describeLimits, duration, orderOutcome } from '@main/features/trading/engine'
import { nextClose } from '@main/features/trading/marketHours'
import { BROKERS, type ExitRequest, type OrderRequest, type TradingOrder, type TradingSchedule, type TradingSession, type TradingSnapshot } from '@shared/trading'
import { cliHome } from '../runtime/paths'
import type { Worker } from '@shared/workers'
import { BusNode, type PeerKind, type PeerMessage } from './bus'
import { classifyCommand } from './external'
import { describeMessage, describeSend, describeSessions, seconds } from './format'
import { formatQuote, formatTradingSummary, formatWorkers, localTradingSnapshot } from './summaries'

/**
 * `eaon mcp`: the bridge that lets Claude Code, Codex (or any MCP host)
 * join Eaon's session bus.
 *
 * The user adds it to their own Claude Code or Codex (`eaon connect
 * claude`), and their session — the real, unmodified CLI, signed in its own
 * way — gets tools to see the other sessions, message them, answer them,
 * and read Eaon's desk. That is the only way Eaon talks to those tools.
 * Eaon never runs them headless or reads their answers back as a model
 * would: the user's Claude plan is for Claude Code, not for powering another
 * product (see the brain note on the removed Claude Code provider).
 *
 * By default nothing here can place an order or change a worker; the desk
 * is read-only from outside Eaon. With `--control` (the Claude Code session
 * the Eaon TUI opens on its own tab, or `eaon connect claude --control`),
 * the server adds tools that run Eaon: orders, the agent's sessions, the
 * trading settings, the kill switch, messages to workers. All of them go
 * through the trading engine, so the user's limits, the kill switch and the
 * disclaimer still stand in front of every order; real money also needs the
 * user's say-so in the TUI (`cli-claude-control.json`). Only the MCP
 * transport may write to stdout, so every log goes to stderr.
 */

declare const __EAON_CLI_VERSION__: string
const VERSION = typeof __EAON_CLI_VERSION__ === 'string' ? __EAON_CLI_VERSION__ : '0.0.0-dev'
const INBOX_LIMIT = 200

const INSTRUCTIONS =
  "This server connects this session to Eaon's local session bus. Other Eaon CLI, Claude Code and Codex sessions on this computer can message this one, and it can message them. " +
  'Check eaon_inbox when the user mentions Eaon or another session, or says a message is waiting, and answer with eaon_reply. ' +
  'eaon_sessions lists who is running; eaon_trading and eaon_quote show Eaon’s trading desk and prices (read-only).'

const CONTROL_INSTRUCTIONS =
  "This server is Eaon, the app this session runs in, and it gives you full control of it. Read the desk with eaon_trading and prices with eaon_quote. " +
  'When the user hands you an Eaon trading session (the /mcp__eaon__trade command), you are its trading agent: loop on eaon_wait_for_check, research with eaon_history, eaon_scan and eaon_news, trade with eaon_order, and end each check with eaon_log_decision, until the session ends. ' +
  'Trade with eaon_order, eaon_cancel, eaon_close_position and eaon_set_exit (stops and targets). Run the trading agent with eaon_session: start it on a strategy for some hours, stop it, run a check now, or tell it something while it trades. ' +
  'Change the trading limits with eaon_limits, the account with eaon_broker, and stop everything with eaon_kill_switch. Message Eaon’s workers with eaon_worker_message, and other sessions with eaon_send. ' +
  'Every order passes the user’s limits and the kill switch inside Eaon, and nothing trades until the user has accepted Eaon’s trading disclaimer in the app. Say what you are about to do before you trade.'

/** Whether the user let Claude Code (and other `--control` hosts) trade real money, set in the TUI's mission control. */
export function controlMayTradeLive(): boolean {
  try {
    return (JSON.parse(readFileSync(join(cliHome(), 'store', 'cli-claude-control.json'), 'utf8')) as { liveMoney?: boolean }).liveMoney === true
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ inbox */

interface InboxEntry {
  message: PeerMessage
  read: boolean
}

/** Messages this session was sent, oldest first, with read state; and a way to wait for the next one. */
export class Inbox {
  private entries: InboxEntry[] = []
  private waiters = new Set<(message: PeerMessage) => void>()
  private listeners = new Set<() => void>()

  constructor(bus?: BusNode) {
    bus?.onMessage((message) => this.add(message))
  }

  add(message: PeerMessage): void {
    this.entries.push({ message, read: false })
    if (this.entries.length > INBOX_LIMIT) this.entries.splice(0, this.entries.length - INBOX_LIMIT)
    for (const waiter of this.waiters) waiter(message)
    for (const fn of this.listeners) fn()
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  unread(): PeerMessage[] {
    return this.entries.filter((e) => !e.read).map((e) => e.message)
  }

  find(id: string): PeerMessage | null {
    return this.entries.find((e) => e.message.id === id || e.message.id.startsWith(id))?.message ?? null
  }

  markRead(id: string): void {
    const entry = this.entries.find((e) => e.message.id === id)
    if (entry) entry.read = true
  }

  /** Unread messages (or all with `includeRead`), newest last; marks them read. */
  take(includeRead = false): PeerMessage[] {
    const picked = this.entries.filter((e) => includeRead || !e.read)
    for (const entry of picked) entry.read = true
    return picked.map((e) => e.message)
  }

  /** The next message to arrive, or null after `timeoutMs`. */
  next(timeoutMs: number): Promise<PeerMessage | null> {
    return new Promise((resolve) => {
      const done = (message: PeerMessage | null): void => {
        clearTimeout(timer)
        this.waiters.delete(waiter)
        resolve(message)
      }
      const waiter = (message: PeerMessage): void => done(message)
      const timer = setTimeout(() => done(null), timeoutMs)
      this.waiters.add(waiter)
    })
  }
}

/* ------------------------------------------------------------------ tools */

export interface McpToolDef {
  name: string
  description: () => string
  inputSchema: Record<string, unknown>
  run: (args: Record<string, unknown>) => Promise<string>
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/**
 * The bridge's tools, kept apart from the stdio transport so they can be
 * driven directly (tests, or another host).
 */
export function createEaonMcpTools(
  bus: BusNode,
  inbox = new Inbox(bus),
  options: { control?: boolean } = {}
): { tools: McpToolDef[]; inbox: Inbox; call: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }> } {
  const tools: McpToolDef[] = [
    {
      name: 'eaon_sessions',
      description: () => 'List the Eaon CLI, Claude Code and Codex sessions running on this computer that this session can message, and this session’s own name.',
      inputSchema: { type: 'object', properties: {} },
      run: async () => describeSessions(bus)
    },
    {
      name: 'eaon_send',
      description: () =>
        'Send a message to another session (by name, e.g. "eaon@api", or id). Set wait_seconds to wait for its reply; a session that is busy may answer later, and the answer then shows up in eaon_inbox.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Session name or id, from eaon_sessions' },
          message: { type: 'string' },
          wait_seconds: { type: 'number', description: 'How long to wait for a reply, 0–300. Default 0.' }
        },
        required: ['to', 'message']
      },
      run: async (args) => {
        const to = str(args.to)
        const text = str(args.message)
        if (!to || !text) throw new Error('Give both `to` and `message`.')
        const wait = seconds(args.wait_seconds, 0, 300)
        const result = await bus.send(to, text, wait ? { waitMs: wait * 1000 } : {})
        // The reply also landed in the inbox; it has been read here.
        if (result.reply) inbox.markRead(result.reply.id)
        return describeSend(result, wait)
      }
    },
    {
      name: 'eaon_reply',
      description: () => 'Reply to a message from eaon_inbox. The sender sees it as the answer to that message.',
      inputSchema: {
        type: 'object',
        properties: { message_id: { type: 'string' }, text: { type: 'string' } },
        required: ['message_id', 'text']
      },
      run: async (args) => {
        const original = inbox.find(str(args.message_id))
        if (!original) throw new Error(`No message ${str(args.message_id)} in the inbox. eaon_inbox lists them.`)
        const text = str(args.text)
        if (!text) throw new Error('The reply is empty.')
        inbox.markRead(original.id)
        const result = await bus.send(original.from.id, text, { replyTo: original.id })
        return result.delivered ? `Replied to ${original.from.name}.` : `Not delivered: ${result.error ?? 'the session has closed.'}`
      }
    },
    {
      name: 'eaon_inbox',
      description: () => {
        const unread = inbox.unread()
        const latest = unread[unread.length - 1]
        return `Read the messages other sessions sent here, and mark them read.${unread.length ? ` ${unread.length} unread now, the latest from ${latest.from.name}.` : ''}`
      },
      inputSchema: { type: 'object', properties: { include_read: { type: 'boolean', description: 'Also show messages already read' } } },
      run: async (args) => {
        const messages = inbox.take(args.include_read === true)
        if (messages.length === 0) return args.include_read === true ? 'The inbox is empty.' : 'No unread messages.'
        return messages.map((m) => describeMessage(m)).join('\n\n')
      }
    },
    {
      name: 'eaon_wait',
      description: () => 'Wait for the next message from another session (unread ones are returned at once). Use it to sit and listen while another session works.',
      inputSchema: { type: 'object', properties: { timeout_seconds: { type: 'number', description: 'Default 120, at most 600' } } },
      run: async (args) => {
        const waiting = inbox.take()
        if (waiting.length > 0) return waiting.map((m) => describeMessage(m)).join('\n\n')
        const timeout = seconds(args.timeout_seconds, 120, 600)
        const message = await inbox.next(timeout * 1000)
        if (!message) return `No message in ${timeout}s.`
        inbox.markRead(message.id)
        return describeMessage(message)
      }
    },
    {
      name: 'eaon_trading',
      description: () => 'A read-only summary of Eaon’s trading desk: broker, equity, returns, positions, open orders, the running trading session and the latest orders.',
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        if (bus.owner()) {
          try {
            return formatTradingSummary(await bus.invokeOwner<TradingSnapshot>('trading:snapshot', []), true)
          } catch {
            /* the owner is closing: fall back to what's on disk */
          }
        }
        const snapshot = localTradingSnapshot()
        return snapshot ? formatTradingSummary(snapshot, false) : 'Eaon hasn’t traded on this computer yet.'
      }
    },
    {
      name: 'eaon_quote',
      description: () => 'Latest prices for up to 10 US stocks or ETFs, from the same feed Eaon trades on.',
      inputSchema: {
        type: 'object',
        properties: { symbols: { type: 'array', items: { type: 'string' }, description: 'Tickers, e.g. ["AAPL", "SPY"]' } },
        required: ['symbols']
      },
      run: async (args) => {
        const symbols = (Array.isArray(args.symbols) ? args.symbols : [args.symbols]).map(str).filter(Boolean).slice(0, 10)
        if (symbols.length === 0) throw new Error('Give at least one ticker.')
        const feed = new YahooMarketData()
        const results = await Promise.allSettled(symbols.map((s) => feed.quote(s)))
        return results.map((r, i) => (r.status === 'fulfilled' ? formatQuote(r.value) : `${symbols[i].toUpperCase()}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`)).join('\n')
      }
    },
    {
      name: 'eaon_workers',
      description: () => 'Eaon’s workers (its always-on agents): what each is doing and when it next wakes.',
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        if (!bus.owner()) return 'Eaon isn’t running, so its workers can’t be reached right now.'
        return formatWorkers(await bus.invokeOwner<Worker[]>('workers:list', []))
      }
    }
  ]

  if (options.control) {
    tools.push(...controlTools(bus))
    // Quotes from the engine's own tool when Eaon runs, so they read the same as its agent's.
    const quote = tools.find((t) => t.name === 'eaon_quote')!
    const direct = quote.run
    quote.run = async (args) => (bus.owner() ? bus.invokeOwner<string>('trading:research', ['trading_quote', { symbols: args.symbols }]) : direct(args))
  }

  const call = async (name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> => {
    const tool = tools.find((t) => t.name === name)
    if (!tool) return { text: `Unknown tool ${name}.`, isError: true }
    let result: { text: string; isError: boolean }
    try {
      result = { text: await tool.run(args ?? {}), isError: false }
    } catch (error) {
      result = { text: error instanceof Error ? error.message : String(error), isError: true }
    }
    // While Claude Code runs a session, its trading steps show in the desk's feed as the agent's would.
    const step = options.control ? feedStep(name, args ?? {}) : null
    if (step && bus.owner()) void bus.invokeOwner('trading:external-tool', [step.name, step.input, result.text, !result.isError]).catch(() => {})
    return result
  }
  return { tools, inbox, call }
}

/* ---------------------------------------------------------- full control */

/** How a control tool appears in the desk's feed: as the trading agent's tool of the same job. */
function feedStep(name: string, args: Record<string, unknown>): { name: string; input: Record<string, unknown> } | null {
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

/** The session Claude Code runs, if one is: a running session whose driver is Claude Code. */
function claudeSession(snapshot: TradingSnapshot): TradingSession | null {
  const s = snapshot.activeSession
  return s && s.driver === 'claude-code' ? s : null
}

/** The mission Claude Code runs, if one is: an enabled schedule it drives (the every-market-day one first). */
function claudeMission(snapshot: TradingSnapshot): TradingSchedule | null {
  const mine = (snapshot.schedules ?? []).filter((s) => s.enabled && s.driver === 'claude-code')
  return mine.find((s) => s.marketHours) ?? mine[0] ?? null
}

const when = (at: number | null): string =>
  at === null ? 'when it next opens' : new Date(at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })

/**
 * The `trade` prompt (in Claude Code, `/mcp__eaon__trade`): hands Claude Code
 * the session waiting for it — the mission, the limits, and the loop it
 * runs until the session ends. The user invokes it; Eaon never does.
 */
export async function tradePrompt(bus: BusNode): Promise<string> {
  if (!bus.owner()) return 'Eaon isn’t running, so there is no trading session to run. Tell the user to open Eaon (`eaon`) first.'
  const snapshot = await bus.invokeOwner<TradingSnapshot>('trading:snapshot', [])
  const session = claudeSession(snapshot)
  const mission = claudeMission(snapshot)
  if (!session && !mission)
    return 'There is no Eaon trading session waiting for Claude Code. Tell the user to start one in Eaon: Trading tab → page 1 → mission control → AGENT: Claude Code → G. Then run this command again.'
  const broker = BROKERS.find((b) => b.id === snapshot.config.broker)
  const name = session?.name ?? mission!.name
  const strategy = session?.strategy ?? mission!.strategy
  const every = session?.everyMinutes ?? mission!.everyMinutes
  const daily = Boolean(mission?.marketHours && (!session || session.scheduleId === mission.id))
  const span = daily
    ? `every market day, from the open until just before the close; when the market reopens a new day’s session starts, until the user stops the mission${session ? '' : '. No day’s session is running right now: eaon_wait_for_check waits for the next one, at the open'}`
    : `until ${new Date(session!.endsAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} (${duration(Math.max(0, session!.endsAt - Date.now()))} from now)`
  return [
    `You are now the trading agent for Eaon’s ${daily ? 'mission' : 'trading session'} “${name}”, on ${brokerLabel(snapshot.config.broker)}${broker?.real ? ' — REAL MONEY: every loss is the user’s own money' : ' (practice money)'}. You trade US stocks and ETFs for the user, following their goal, within their limits, ${span}. Nobody approves each step: decide on your own, act, and keep going.`,
    '',
    'The goal, in the user’s words:',
    strategy,
    '',
    `Run it in a loop until ${daily ? 'Eaon says the mission is over' : 'the session ends'}:`,
    `1. Call eaon_wait_for_check. It waits until the next check is due — every ${every} minutes while the market is open, sooner when a price alert fires or the user writes to you${daily ? ', and through the night until the next open' : ''} — and returns the brief: the time, the market, the account, positions and open orders, what moved since your last check, any ALERT and any MESSAGE FROM THE USER. If it says no check is due yet${daily ? ' or that the market is closed' : ''}, call it again. ${daily ? 'When a day’s session ends, call it again to wait for the next open. Stop only when it says the mission is over, and say how it went.' : 'If it says the session has ended, stop and say how it went.'}`,
    '2. Look before you act: eaon_history (trend, RSI, ATR, MACD, volume), eaon_scan (today’s movers), eaon_news, eaon_quote, eaon_account. Web search is fine for context.',
    '3. Act only through Eaon: eaon_order (always with a reason), eaon_set_exit to raise or set stops, eaon_close_position, eaon_cancel. Orders past the user’s limits are refused, and the refusal says why. Don’t use the shell or files to trade.',
    '4. End every check with eaon_log_decision: one line, what you did and why (the user sees it in Eaon). Then go back to step 1.',
    '',
    'Risk, unless the goal says otherwise: give every new position a stop_loss (under a recent swing low, or about 2×ATR below the entry) or a trailing_stop_pct; size from the stop to risk about 1% of equity, then fit the limits; cut losers at the stop and never average down; raise stops on winners rather than selling early; be slower to buy when SPY and QQQ are falling. Doing nothing is often right; never trade for the sake of it.',
    `Limits (orders past them are refused): ${describeLimits(snapshot.config.limits)}.`,
    'The user can write to you while you trade; their message arrives in the next brief. Answer it in your decision and follow it where it fits the limits. Don’t stop the loop to ask them questions.',
    'Start now: call eaon_wait_for_check.'
  ].join('\n')
}

const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.trim() && Number.isFinite(Number(value)) ? Number(value) : undefined)

/** "3" or 3 hours, "90m", "15:30", or "close", as a time. */
function untilFrom(args: Record<string, unknown>, now = Date.now()): number | null {
  const hours = num(args.hours)
  if (hours !== undefined) return hours > 0 ? now + hours * 3_600_000 : null
  const text = str(args.until).toLowerCase()
  if (!text || text === 'close') return nextClose(now) - 5 * 60_000
  const rel = /^(\d+(?:\.\d+)?)\s*(m|min|minutes?|h|hr|hours?)$/.exec(text)
  if (rel) return now + Number(rel[1]) * (rel[2].startsWith('h') ? 3_600_000 : 60_000)
  const clock = /^(\d{1,2}):(\d{2})$/.exec(text)
  if (!clock) return null
  const at = new Date(now)
  at.setHours(Number(clock[1]), Number(clock[2]), 0, 0)
  if (at.getTime() <= now) at.setDate(at.getDate() + 1)
  return at.getTime()
}

/** The tools that run Eaon, for `--control`. Each reaches the session that runs the engines. */
function controlTools(bus: BusNode): McpToolDef[] {
  const owner = <T>(channel: string, ...args: unknown[]): Promise<T> => {
    if (!bus.owner()) throw new Error('Eaon isn’t running, so its trading engine can’t be reached. Open Eaon (`eaon`) and try again.')
    return bus.invokeOwner<T>(channel, args)
  }
  const snapshot = (): Promise<TradingSnapshot> => owner<TradingSnapshot>('trading:snapshot')
  /** Real money from here needs the user's say-so in the TUI, on top of everything the engine checks. */
  const guardLive = async (): Promise<TradingSnapshot> => {
    const snap = await snapshot()
    if (snap.config.broker === 'alpaca-live' && !controlMayTradeLive())
      throw new Error('That would trade real money (Alpaca live). The user hasn’t allowed Claude Code to trade real money: in Eaon, Trading → 1 → Mission control → CLAUDE CODE.')
    return snap
  }
  const session = async (): Promise<NonNullable<TradingSnapshot['activeSession']>> => {
    const active = (await snapshot()).activeSession
    if (!active) throw new Error('No trading session is running. Start one with eaon_session action "start".')
    return active
  }
  const object = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({ type: 'object', properties, required })

  const research = (tool: string) => (args: Record<string, unknown>) => owner<string>('trading:research', tool, args)

  return [
    {
      name: 'eaon_wait_for_check',
      description: () =>
        'When you run an Eaon trading session or mission: waits for the next check (the interval, a price alert, a message from the user, or "check now"; overnight, the next open) and returns its brief — market, account, positions, what moved, alerts, messages. Says when to call again, when a day’s session ended (call again for the next), and when it is all over.',
      inputSchema: object({}),
      run: async () => {
        // One call waits up to four hours: a check, the next open, or the end. (The Claude Code Eaon opens allows five.)
        const WAIT = 4 * 3_600_000
        const before = await snapshot()
        let session = claudeSession(before)
        if (!session) {
          const had = claudeMission(before)
          const between = await bus.invokeOwner<{ state: 'session'; id: string } | { state: 'waiting'; nextAt: number | null } | { state: 'none' }>('trading:wait-session', [WAIT], WAIT + 60_000)
          if (between.state === 'none')
            return had
              ? `The mission “${had.name}” is over: the user stopped it in Eaon. Stop here and tell the user how it went.`
              : 'No Eaon trading session or mission is waiting for Claude Code, so there is nothing to run. If one just ended, you’re done; otherwise the user starts one in Eaon (AGENT: Claude Code, then G).'
          if (between.state === 'waiting') return `The market is closed; the mission’s next session starts ${when(between.nextAt)}. Call eaon_wait_for_check again to keep waiting for it.`
          session = claudeSession(await snapshot())
          if (!session) return 'The next session is starting. Call eaon_wait_for_check again.'
        }
        const result = await bus.invokeOwner<
          { state: 'check'; check: number; brief: string; endsAt: number } | { state: 'waiting'; nextCheckAt: number | null } | { state: 'ended'; status: string; summary: string | null }
        >('trading:wait-check', [session.id, WAIT], WAIT + 60_000)
        if (result.state === 'check') return `CHECK ${result.check} of “${session.name}”\n\n${result.brief}`
        if (result.state === 'waiting')
          return `No check is due yet${result.nextCheckAt ? ` (next at ${new Date(result.nextCheckAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })})` : ''}. Call eaon_wait_for_check again.`
        const mission = claudeMission(await snapshot())
        if (mission && session.scheduleId === mission.id)
          return `Today’s session has ended (${result.status}).${result.summary ? ` ${result.summary}` : ''} The mission goes on: the next session starts at the next market open. Call eaon_wait_for_check to wait for it.`
        return `The session has ended (${result.status}).${result.summary ? ` ${result.summary}` : ''} Stop here and tell the user how it went.`
      }
    },
    {
      name: 'eaon_log_decision',
      description: () => 'When you run an Eaon trading session: the one line that ends a check — what you did and why. The user sees it in Eaon’s activity feed.',
      inputSchema: object({ decision: { type: 'string' } }, ['decision']),
      run: async (args) => {
        const session = claudeSession(await snapshot())
        if (!session) throw new Error('No Eaon trading session is running for Claude Code right now (the market may be closed). Call eaon_wait_for_check.')
        await owner('trading:log-decision', session.id, str(args.decision))
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
      description: () => 'Buy or sell a US stock or ETF on Eaon’s trading desk (the simulator or the Alpaca account it is set to). Checked against the user’s limits first; refusals say why. Give shares (qty) or dollars (notional), and a reason.',
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
        await guardLive()
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
        const session = claudeSession(await snapshot())
        const order = session ? await owner<TradingOrder>('trading:session-order', session.id, request) : await owner<TradingOrder>('trading:place-order', request)
        if (order.status === 'rejected') return orderOutcome(order)
        const exit = (await snapshot()).positions.find((p) => p.symbol === order.symbol)?.exit
        return `${orderOutcome(order)} Order id: ${order.id}.${exit ? ` Protected: ${describeExit(exit)}.` : order.side === 'buy' ? ' No stop is set on it.' : ''}`
      }
    },
    {
      name: 'eaon_cancel',
      description: () => 'Cancel an open order on Eaon’s desk by its id (eaon_trading lists open orders).',
      inputSchema: object({ order_id: { type: 'string' } }, ['order_id']),
      run: async (args) => {
        const snap = await owner<TradingSnapshot>('trading:cancel-order', str(args.order_id))
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
        return orderOutcome(await owner<TradingOrder>('trading:close-position', str(args.symbol)))
      }
    },
    {
      name: 'eaon_set_exit',
      description: () => 'Set, change or clear the protective exit on a holding: stop_loss, take_profit and trailing_stop_pct. Eaon watches it and sells at market when it is reached. 0 clears a value; clear removes them all.',
      inputSchema: object(
        { symbol: { type: 'string' }, stop_loss: { type: 'number' }, take_profit: { type: 'number' }, trailing_stop_pct: { type: 'number' }, clear: { type: 'boolean' } },
        ['symbol']
      ),
      run: async (args) => {
        const value = (raw: unknown): number | null | undefined => (raw === undefined ? undefined : num(raw) === 0 || raw === null ? null : num(raw))
        const request: ExitRequest =
          args.clear === true
            ? { symbol: str(args.symbol), stopPrice: null, targetPrice: null, trailPct: null }
            : { symbol: str(args.symbol), stopPrice: value(args.stop_loss), targetPrice: value(args.take_profit), trailPct: value(args.trailing_stop_pct) }
        const snap = await owner<TradingSnapshot>('trading:set-exit', request)
        const exit = snap.positions.find((p) => p.symbol === request.symbol.toUpperCase())?.exit
        return exit ? `${exit.symbol} protected: ${describeExit(exit)}.` : `No exit on ${request.symbol.toUpperCase()} now.`
      }
    },
    {
      name: 'eaon_session',
      description: () =>
        'Eaon’s trading agent. action "start" sets it trading on a strategy for some hours (hours, or until "15:30" / "close"), checking every few minutes; "stop" stops it; "check_now" runs its next check now; "tell" sends it a message it reads at once (it answers in the session log); "status" says what it is doing.',
      inputSchema: object(
        {
          action: { type: 'string', enum: ['start', 'stop', 'check_now', 'tell', 'status'] },
          strategy: { type: 'string', description: 'start: what to trade and how' },
          hours: { type: 'number', description: 'start: how many hours to trade' },
          until: { type: 'string', description: 'start: instead of hours, "15:30", "90m" or "close"' },
          every_minutes: { type: 'number', description: 'start: how often it checks; default 5' },
          flatten_at_end: { type: 'boolean', description: 'start: sell everything when it ends' },
          message: { type: 'string', description: 'tell: what to tell the agent' }
        },
        ['action']
      ),
      run: async (args) => {
        switch (args.action) {
          case 'start': {
            await guardLive()
            const strategy = str(args.strategy)
            if (!strategy) throw new Error('Give the strategy to trade.')
            const until = untilFrom(args)
            if (!until) throw new Error('Say how long: hours (e.g. 2), or until "15:30", "90m" or "close".')
            const started = await owner<{ name: string; endsAt: number; everyMinutes: number }>('trading:start-session', {
              strategy,
              until,
              everyMinutes: num(args.every_minutes) ?? 5,
              flattenAtEnd: args.flatten_at_end === true
            })
            return `The agent is trading “${started.name}” until ${new Date(started.endsAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}, checking every ${started.everyMinutes} min. Its steps show on Eaon’s trading desk.`
          }
          case 'stop': {
            const active = await session()
            await owner('trading:stop-session', active.id)
            return `Stopped “${active.name}”. Its open orders are canceled; holdings are kept.`
          }
          case 'check_now': {
            const active = await session()
            await owner('trading:check-now', active.id)
            return 'The agent is checking now.'
          }
          case 'tell': {
            const active = await session()
            const message = str(args.message)
            if (!message) throw new Error('Say what to tell the agent.')
            await owner('trading:tell-session', active.id, message)
            return 'Sent. The agent reads it in a check that starts now; its answer appears in the session log (eaon_trading).'
          }
          default: {
            const snap = await snapshot()
            const active = snap.activeSession
            if (!active) return 'No trading session is running.'
            const recent = active.log.slice(-6).map((e) => `- ${new Date(e.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} ${e.kind}: ${e.text.slice(0, 300)}`)
            const n = (k: number, w: string): string => `${k} ${w}${k === 1 ? '' : 's'}`
            return [`“${active.name}”: ${n(active.checks, 'check')}, ${n(active.orders, 'order')}, ends ${new Date(active.endsAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.${snap.agent?.checking ? ' Checking right now.' : ''}`, ...recent].join('\n')
          }
        }
      }
    },
    {
      name: 'eaon_limits',
      description: () => 'Change the trading limits every order must pass: max_order_usd, max_position_pct, max_invested_pct, max_daily_loss_pct, max_orders_per_day, allowed_symbols (empty for any); and simulator_anytime.',
      inputSchema: object({
        max_order_usd: { type: 'number' },
        max_position_pct: { type: 'number' },
        max_invested_pct: { type: 'number' },
        max_daily_loss_pct: { type: 'number' },
        max_orders_per_day: { type: 'number' },
        allowed_symbols: { type: 'array', items: { type: 'string' } },
        simulator_anytime: { type: 'boolean' }
      }),
      run: async (args) => {
        const limits: Record<string, unknown> = {}
        const pairs: [string, string][] = [
          ['max_order_usd', 'maxOrderUsd'],
          ['max_position_pct', 'maxPositionPct'],
          ['max_invested_pct', 'maxInvestedPct'],
          ['max_daily_loss_pct', 'maxDailyLossPct'],
          ['max_orders_per_day', 'maxOrdersPerDay']
        ]
        for (const [from, to] of pairs) if (num(args[from]) !== undefined) limits[to] = num(args[from])
        if (Array.isArray(args.allowed_symbols)) limits.allowedSymbols = args.allowed_symbols.map((s) => String(s).toUpperCase())
        const snap = await owner<TradingSnapshot>('trading:set-config', {
          ...(Object.keys(limits).length ? { limits } : {}),
          ...(typeof args.simulator_anytime === 'boolean' ? { simulatorAnytime: args.simulator_anytime } : {})
        })
        const l = snap.config.limits
        return `Limits now: $${l.maxOrderUsd} per order · ${l.maxPositionPct}% per stock · ${l.maxInvestedPct}% invested at most · stop buying at a ${l.maxDailyLossPct}% day loss · ${l.maxOrdersPerDay} orders a day · ${l.allowedSymbols.length ? `only ${l.allowedSymbols.join(' ')}` : 'any symbol'}.`
      }
    },
    {
      name: 'eaon_broker',
      description: () => 'Switch the account Eaon’s desk trades: "simulator", "alpaca-paper" or "alpaca-live" (real money; needs the user’s keys, their typed confirmation in Eaon, and their permission for Claude Code). Switching stops a running session.',
      inputSchema: object({ broker: { type: 'string', enum: ['simulator', 'alpaca-paper', 'alpaca-live'] } }, ['broker']),
      run: async (args) => {
        const broker = str(args.broker)
        if (broker === 'alpaca-live' && !controlMayTradeLive()) throw new Error('The user hasn’t allowed Claude Code to use real money (in Eaon: Trading → 1 → Mission control → CLAUDE CODE).')
        const snap = await owner<TradingSnapshot>('trading:set-config', { broker })
        return `Eaon’s desk now trades on ${snap.config.broker}.${snap.error ? ` ${snap.error}` : ''}`
      }
    },
    {
      name: 'eaon_kill_switch',
      description: () => 'The kill switch: on stops the running session and refuses every order (the user’s, the agent’s, every worker’s) until it is switched off.',
      inputSchema: object({ on: { type: 'boolean' } }, ['on']),
      run: async (args) => {
        const snap = await owner<TradingSnapshot>('trading:set-config', { halted: args.on === true })
        return snap.config.halted ? 'Kill switch ON: nothing trades until it is switched off.' : 'Kill switch off: orders and sessions are allowed again, inside the limits.'
      }
    },
    {
      name: 'eaon_worker_message',
      description: () => 'Send a message to one of Eaon’s workers (by name or id); it answers in its own thread (eaon_workers shows them).',
      inputSchema: object({ worker: { type: 'string' }, text: { type: 'string' } }, ['worker', 'text']),
      run: async (args) => {
        const workers = await owner<Worker[]>('workers:list')
        const key = str(args.worker).toLowerCase()
        const worker = workers.find((w) => w.id === key || w.name.toLowerCase() === key) ?? workers.find((w) => w.name.toLowerCase().startsWith(key))
        if (!worker) throw new Error(`No worker called “${str(args.worker)}”. ${workers.length ? `There are: ${workers.map((w) => w.name).join(', ')}.` : 'There are no workers yet.'}`)
        await owner('workers:send', worker.id, str(args.text), [], {})
        return `Sent to ${worker.name}. It answers in its thread.`
      }
    }
  ]
}

/* ------------------------------------------------------------ the host */

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 3000, windowsHide: true }, (error, stdout) => resolve(error ? '' : String(stdout)))
  })
}

/**
 * Works out who started this server by walking up the process tree a few
 * levels (a host may start it through npx or a shell). Claude Code also
 * marks the processes it starts with `CLAUDECODE=1`.
 */
export async function detectHost(): Promise<PeerKind> {
  if (process.env.CLAUDECODE === '1') return 'claude-code'
  let pid = process.ppid
  for (let level = 0; level < 4 && pid > 1; level++) {
    let command = ''
    let parent = 0
    if (process.platform === 'win32') {
      const out = await run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { "$($p.ParentProcessId)\`t$($p.CommandLine)" }`
      ])
      const [ppid, ...rest] = out.trim().split('\t')
      parent = Number(ppid)
      command = rest.join('\t')
    } else {
      const out = (await run('ps', ['-o', 'ppid=,args=', '-p', String(pid)])).trim()
      const match = /^(\d+)\s+(.*)$/.exec(out)
      if (!match) break
      parent = Number(match[1])
      command = match[2]
    }
    const kind = classifyCommand(command)
    if (kind) return kind
    if (!Number.isFinite(parent) || parent === pid) break
    pid = parent
  }
  return 'other'
}

/* ------------------------------------------------------------ the server */

export async function runMcpServer(options: { control?: boolean } = {}): Promise<void> {
  // Only the transport may write to stdout; anything else would corrupt the stream.
  const toStderr = (...args: unknown[]): void => console.error(...args)
  console.log = toStderr
  console.info = toStderr
  console.debug = toStderr
  console.warn = toStderr

  const kind = await detectHost()
  const bus = await new BusNode({ kind, cwd: process.cwd(), mode: 'mcp' }).open()
  process.on('exit', () => bus.closeSync())
  const { tools, inbox, call } = createEaonMcpTools(bus, undefined, options)

  const server = new Server(
    { name: 'eaon', version: VERSION },
    { capabilities: { tools: { listChanged: true }, ...(options.control ? { prompts: {} } : {}) }, instructions: options.control ? `${INSTRUCTIONS} ${CONTROL_INSTRUCTIONS}` : INSTRUCTIONS }
  )
  if (options.control) {
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: [{ name: 'trade', description: 'Take over the Eaon trading session waiting for Claude Code, and run it as its trading agent until it ends.' }]
    }))
    server.setRequestHandler(GetPromptRequestSchema, async (req) => {
      if (req.params.name !== 'trade') throw new Error(`Unknown prompt ${req.params.name}`)
      return { description: 'Run the Eaon trading session', messages: [{ role: 'user' as const, content: { type: 'text' as const, text: await tradePrompt(bus) } }] }
    })
  }
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description(), inputSchema: t.inputSchema as { type: 'object' } }))
  }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await call(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>)
    return { content: [{ type: 'text' as const, text: result.text }], ...(result.isError ? { isError: true } : {}) }
  })
  // A new message changes eaon_inbox's description ("2 unread, the latest from…"); hosts that
  // follow list changes then show the model that something is waiting.
  inbox.onChange(() => void server.sendToolListChanged().catch(() => {}))

  let closing = false
  const close = (): void => {
    if (closing) return
    closing = true
    void bus.close().finally(() => process.exit(0))
  }
  process.on('SIGINT', close)
  process.on('SIGTERM', close)
  process.stdin.on('end', close)
  process.stdin.on('close', close)

  const transport = new StdioServerTransport()
  transport.onclose = close
  await server.connect(transport)
  console.error(`[eaon] joined the session bus as ${bus.self.name}`)
}
