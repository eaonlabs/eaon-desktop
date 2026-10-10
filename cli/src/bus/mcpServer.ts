import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, GetPromptRequestSchema, ListPromptsRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { YahooMarketData } from '@main/features/trading/marketData'
import { feedStep, num, traderTools, tradePrompt as missionPrompt, type McpToolDef, type TraderHost } from '@main/features/trading/claudeTrader'
import { nextClose } from '@main/features/trading/marketHours'
import type { TradingSnapshot } from '@shared/trading'
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

export type { McpToolDef }

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

/**
 * The `trade` prompt (in Claude Code, `/mcp__eaon__trade`): hands Claude Code
 * the session waiting for it — the mission, the limits, and the loop it
 * runs until the session ends. The user invokes it; Eaon never does.
 */
export async function tradePrompt(bus: BusNode): Promise<string> {
  if (!bus.owner()) return 'Eaon isn’t running, so there is no trading session to run. Tell the user to open Eaon (`eaon`) first.'
  const snapshot = await bus.invokeOwner<TradingSnapshot>('trading:snapshot', [])
  return missionPrompt(snapshot, 'Trading tab → page 1 → mission control → AGENT: Claude Code → G')
}

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
  const liveRefusal = (snap: TradingSnapshot): string | null =>
    snap.config.broker === 'alpaca-live' && !controlMayTradeLive()
      ? 'That would trade real money (Alpaca live). The user hasn’t allowed Claude Code to trade real money: in Eaon, Trading → 1 → Mission control → CLAUDE CODE.'
      : null
  const guardLive = async (): Promise<TradingSnapshot> => {
    const snap = await snapshot()
    const refusal = liveRefusal(snap)
    if (refusal) throw new Error(refusal)
    return snap
  }
  const session = async (): Promise<NonNullable<TradingSnapshot['activeSession']>> => {
    const active = (await snapshot()).activeSession
    if (!active) throw new Error('No trading session is running. Start one with eaon_session action "start".')
    return active
  }
  const object = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({ type: 'object', properties, required })

  // One wait for a check lasts up to four hours: a check, the next open, or the end. (The Claude Code Eaon opens allows five.)
  const WAIT = 4 * 3_600_000
  const host: TraderHost = {
    snapshot,
    waitSession: (maxWaitMs) => bus.invokeOwner('trading:wait-session', [maxWaitMs], maxWaitMs + 60_000),
    waitCheck: (id, maxWaitMs) => bus.invokeOwner('trading:wait-check', [id, maxWaitMs], maxWaitMs + 60_000),
    logDecision: (id, text) => owner('trading:log-decision', id, text),
    sessionOrder: (id, request) => owner('trading:session-order', id, request),
    placeOrder: (request) => owner('trading:place-order', request),
    cancelOrder: (id) => owner('trading:cancel-order', id),
    closePosition: (symbol) => owner('trading:close-position', symbol),
    setExit: (request) => owner('trading:set-exit', request),
    research: (tool, args) => owner<string>('trading:research', tool, args),
    liveRefusal
  }

  return [
    ...traderTools(host, { waitMs: WAIT }),
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
