import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { store } from '../src/main/store'
import { defaultConfig, scheduleWindow, TradingEngine, type TradingDeps } from '../src/main/features/trading/engine'
import { ClaudeTradingServer, TRADE_COMMAND } from '../src/main/features/trading/claudeServer'
import { tradePrompt } from '../src/main/features/trading/claudeTrader'
import type { PriceFeed } from '../src/main/features/trading/marketData'
import { cadenceText, checkIntervalMs, type Quote, type TradingConfig } from '@shared/trading'

/**
 * The Trading tab's Claude Code: checks as often as every second, a one-off
 * window with a start and a stop time, the live curve, and the MCP server
 * Claude Code trades through — driven here by a real MCP client over HTTP,
 * in Claude Code's place. No network beyond loopback, no model.
 */

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }
const engines: TradingEngine[] = []
const servers: ClaudeTradingServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop()
  for (const engine of engines.splice(0)) {
    engine.stop()
    await engine.whenIdle()
  }
  await store.flushWrites()
})

const workRoot = mkdtempSync(join(tmpdir(), 'eaon-trading-claude-'))

function harness(options: { config?: Partial<TradingConfig>; deps?: Partial<TradingDeps> } = {}): { engine: TradingEngine; files: Record<string, unknown>; prices: Record<string, number> } {
  const files: Record<string, unknown> = { config: { ...defaultConfig(), simulatorAnytime: true, ...options.config } }
  const prices: Record<string, number> = { AAPL: 100, NVDA: 200, SPY: 500, QQQ: 400 }
  const feed: PriceFeed = {
    source: 'test prices',
    quote: async (symbol: string): Promise<Quote> => {
      const s = symbol.toUpperCase()
      if (!(s in prices)) throw new Error(`Couldn’t find a stock called ${s}.`)
      return { symbol: s, name: null, price: prices[s], change: 0, changePct: 0.5, prevClose: prices[s], dayHigh: null, dayLow: null, volume: null, currency: 'USD', at: Date.now() }
    },
    bars: async () => []
  }
  const save = (name: string) => (value: unknown) => {
    files[name] = structuredClone(value)
  }
  const deps: TradingDeps = {
    prices: feed,
    runAgent: async () => ({ text: 'Nothing to do.', usage }),
    getSettings: () => store.getSettings(),
    getKeys: () => null,
    saveKeys: () => {},
    loadConfig: () => files.config,
    saveConfig: save('config'),
    loadOrders: () => files.orders,
    saveOrders: save('orders'),
    loadEquity: () => files.equity,
    saveEquity: save('equity'),
    loadSchedules: () => files.schedules,
    saveSchedules: save('schedules'),
    loadSessions: () => files.sessions,
    saveSessions: save('sessions'),
    loadSim: () => files.sim,
    saveSim: save('sim'),
    loadExits: () => files.exits,
    saveExits: save('exits'),
    resolveModel: () => ({ ok: true, providerId: 'ollama', modelId: 'fake-model', model: undefined }),
    workFolder: () => join(workRoot, 'Trading'),
    minuteMs: 60_000,
    scheduleTickMs: 60_000,
    ...options.deps
  }
  const engine = new TradingEngine(deps)
  engine.load()
  engines.push(engine)
  return { engine, files, prices }
}

test('cadence: seconds win over minutes, and read as words', () => {
  assert.equal(checkIntervalMs({ everyMinutes: 5 }), 300_000)
  assert.equal(checkIntervalMs({ everyMinutes: 1, everySeconds: 1 }), 1000)
  assert.equal(checkIntervalMs({ everyMinutes: 1, everySeconds: 30 }, 6000), 3000, 'a test minute shrinks seconds with it')
  assert.equal(cadenceText({ everyMinutes: 1, everySeconds: 1 }), 'every second')
  assert.equal(cadenceText({ everyMinutes: 1, everySeconds: 15 }), 'every 15 s')
  assert.equal(cadenceText({ everyMinutes: 5 }), 'every 5 min')
})

test('Claude Code deciding every second: each check is due a second after the last, and a closed market backs off to a minute', async () => {
  const { engine } = harness()
  const session = await engine.startSession({ strategy: 'Scalp AAPL', until: Date.now() + 10 * 60_000, everySeconds: 1, driver: 'claude-code' })
  assert.equal(session.everySeconds, 1)
  assert.match(engine.snapshot().activeSession!.log[0].text, /a check every second until/)

  const first = await engine.waitForCheck(session.id, 1000)
  assert.equal(first.state, 'check')
  engine.logDecision(session.id, 'Held.')
  const started = Date.now()
  const second = await engine.waitForCheck(session.id, 3000)
  assert.equal(second.state, 'check')
  const waited = Date.now() - started
  assert.ok(waited >= 700 && waited < 2500, `the next check came ${waited} ms later`)
  if (second.state === 'check') assert.equal(second.check, 2)
  engine.logDecision(session.id, 'Held again.')

  // Closed, with the simulator keeping market hours: no check, and no asking the broker every second.
  const saturday = Date.parse('2026-10-03T15:00:00Z')
  const offset = saturday - Date.now()
  const closed = harness({ config: { simulatorAnytime: false }, deps: { now: () => Date.now() + offset } }).engine
  const quiet = await closed.startSession({ strategy: 'Scalp', until: saturday + 10 * 60_000, everySeconds: 1, driver: 'claude-code' })
  const result = await closed.waitForCheck(quiet.id, 200)
  assert.equal(result.state, 'waiting')
  if (result.state === 'waiting') assert.ok(result.nextCheckAt! - saturday >= 60_000, 'the next look is a minute away, not a second')
})

test('a one-off window: armed for a start time, it starts then with Claude Code, ends at the stop, and switches itself off', async () => {
  const t0 = Date.now()
  let offset = new Date(2026, 9, 6, 9, 0).getTime() - t0
  const now = (): number => Date.now() + offset
  const { engine } = harness({ deps: { now } })
  const start = new Date(2026, 9, 6, 9, 45).getTime()
  const end = new Date(2026, 9, 6, 11, 30).getTime()
  assert.throws(() => engine.saveSchedule({ name: '', days: [], start: '', end: '', strategy: 'x', everyMinutes: 1, flattenAtEnd: false, enabled: true, once: { start: end, end: start } }), /stop has to come after the start/)
  const plan = engine.saveSchedule({ name: '', days: [], start: '', end: '', strategy: 'Momentum on NVDA', everyMinutes: 1, everySeconds: 5, flattenAtEnd: true, enabled: true, driver: 'claude-code', once: { start, end } })
  assert.deepEqual(plan.once, { start, end })
  assert.equal(plan.start, '09:45')
  assert.equal(plan.end, '11:30')
  assert.deepEqual(plan.days, [2])
  assert.equal(scheduleWindow(plan, start - 1), null)
  assert.deepEqual(scheduleWindow(plan, start), { start, end })

  // Before the start: nothing runs; Claude Code, holding the session, is told when it starts.
  await engine.tickSchedules()
  assert.equal(engine.snapshot().activeSession, null)
  assert.equal(engine.nextScheduledStart('claude-code'), start)
  assert.deepEqual(await engine.waitForSession(10), { state: 'waiting', nextAt: start })
  assert.match(tradePrompt(engine.snapshot(), 'x'), /It hasn’t started yet: eaon_wait_for_check waits until it does/)

  offset = start + 1000 - Date.now()
  await engine.tickSchedules()
  const session = engine.snapshot().activeSession!
  assert.equal(session.scheduleId, plan.id)
  assert.equal(session.driver, 'claude-code')
  assert.equal(session.everySeconds, 5)
  assert.equal(session.endsAt, end)
  assert.equal(session.flattenAtEnd, true)
  assert.match(tradePrompt(engine.snapshot(), 'x'), /every 5 s while the market is open/)
  assert.match(tradePrompt(engine.snapshot(), 'x'), /this is a fast loop: keep each check short/)

  // After the stop: the window has run, so there is nothing more to wait for, and the plan switches off.
  await engine.stopSession(session.id)
  offset = end + 60_000 - Date.now()
  await engine.tickSchedules()
  assert.equal(engine.snapshot().schedules.find((s) => s.id === plan.id)!.enabled, false)
  assert.deepEqual(await engine.waitForSession(10), { state: 'none' })
})

test('the live curve: a point at every refresh while a session runs, in the whole snapshot only', async () => {
  const { engine, prices } = harness()
  await engine.refresh()
  assert.equal(engine.snapshot().live, undefined, 'nothing before a session')
  const session = await engine.startSession({ strategy: 'Hold AAPL', until: Date.now() + 10 * 60_000, everySeconds: 1, driver: 'claude-code' })
  await engine.sessionOrder(session.id, { symbol: 'AAPL', side: 'buy', qty: 10, reason: 'test' })
  await engine.refresh()
  prices.AAPL = 110
  await new Promise((r) => setTimeout(r, 5))
  await engine.refresh()
  const live = engine.snapshot().live!
  assert.ok(live.length >= 2)
  assert.ok(live[live.length - 1].equity > live[0].equity, 'the curve follows the price')
  assert.equal(engine.summary().live, undefined, 'a summary push leaves it out')
})

test('the MCP server: only the key gets in; Claude Code takes the session with the trade prompt, trades it, and its steps reach the feed', async () => {
  const steps: string[] = []
  const { engine } = harness({ deps: { onAgentEvent: (_id, event) => event.type === 'tool-call' && void steps.push(event.name) } })
  const server = new ClaudeTradingServer({ engine, settings: () => store.getSettings(), mayTradeLive: () => false })
  servers.push(server)
  const { url, token } = await server.start()
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  assert.equal(TRADE_COMMAND, '/mcp__eaon-trading__trade')

  // No key, a wrong key, or a web page: refused.
  const post = (headers: Record<string, string>) =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
  assert.equal((await post({})).status, 401)
  assert.equal((await post({ Authorization: 'Bearer nope' })).status, 401)
  assert.equal((await post({ Authorization: `Bearer ${token}`, Origin: 'https://evil.example' })).status, 403)

  const client = new Client({ name: 'stand-in for Claude Code', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  const names = (await client.listTools()).tools.map((t) => t.name)
  for (const name of ['eaon_wait_for_check', 'eaon_log_decision', 'eaon_order', 'eaon_set_exit', 'eaon_quote', 'eaon_history']) assert.ok(names.includes(name), name)
  assert.ok(!names.includes('eaon_limits') && !names.includes('eaon_kill_switch') && !names.includes('eaon_broker'), 'the limits, the account and the kill switch stay the user’s')

  const text = (result: Awaited<ReturnType<Client['callTool']>>): string => (result.content as { type: string; text: string }[])[0].text
  const prompts = await client.listPrompts()
  assert.deepEqual(
    prompts.prompts.map((p) => p.name),
    ['trade']
  )
  const none = await client.getPrompt({ name: 'trade' })
  assert.match((none.messages[0].content as { text: string }).text, /no Eaon trading session waiting for Claude Code/)

  const session = await engine.startSession({ strategy: 'Buy NVDA on strength', until: Date.now() + 30 * 60_000, everySeconds: 1, driver: 'claude-code' })
  const prompt = (await client.getPrompt({ name: 'trade' })).messages[0].content as { text: string }
  assert.match(prompt.text, /trading agent for Eaon’s trading session/)
  assert.match(prompt.text, /every second while the market is open/)

  const check = text(await client.callTool({ name: 'eaon_wait_for_check', arguments: {} }))
  assert.match(check, /^CHECK 1 of “Buy NVDA on strength”/)
  assert.equal(engine.snapshot().agent!.connected, true)
  assert.match(text(await client.callTool({ name: 'eaon_quote', arguments: { symbols: ['NVDA'] } })), /NVDA/)
  const bought = text(await client.callTool({ name: 'eaon_order', arguments: { symbol: 'NVDA', side: 'buy', qty: 2, stop_loss: 190, reason: 'Strength' } }))
  assert.match(bought, /^Bought 2 NVDA/)
  assert.match(bought, /Protected: stop/)
  const order = engine.snapshot().orders[0]
  assert.equal(order.source, 'session')
  assert.equal(order.sessionId, session.id)
  assert.equal(order.reason, 'Claude Code: Strength')
  const refused = await client.callTool({ name: 'eaon_order', arguments: { symbol: 'NVDA', side: 'buy', qty: 500, reason: 'Too big' } })
  assert.match(text(refused), /Refused/i)
  await client.callTool({ name: 'eaon_log_decision', arguments: { decision: 'Bought 2 NVDA with a stop at 190.' } })
  assert.ok(engine.snapshot().activeSession!.log.some((e) => e.kind === 'decision' && e.text === 'Bought 2 NVDA with a stop at 190.'))
  assert.deepEqual(steps.slice(0, 2), ['trading_quote', 'trading_order'])

  // The session over, there is nothing left to run.
  await engine.stopSession(session.id)
  assert.match(text(await client.callTool({ name: 'eaon_wait_for_check', arguments: {} })), /nothing to run/)
  await client.close()
})
