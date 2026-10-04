import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { store } from '../src/main/store'
import type { RunOptions, RunOutcome } from '../src/main/agent/loop'
import { guidanceFor, registerToolSource, type AgentTool, type ToolContext, type ToolQuery } from '../src/main/agent/tools'
import { isOpen, marketDate, nextClose, nextOpen, sessionOn } from '../src/main/features/trading/marketHours'
import { atr, indicators, macdHistogram, normalizeSymbol, parseRss, rsi, YahooMarketData, type PriceFeed } from '../src/main/features/trading/marketData'
import { SimulatorBroker, type SimState } from '../src/main/features/trading/simulator'
import { AlpacaBroker, mapAlpacaStatus } from '../src/main/features/trading/alpaca'
import type { AlpacaKeys } from '../src/main/features/trading/brokers'
import {
  activeStop,
  buildExit,
  checkLimits,
  computeStats,
  defaultConfig,
  maxDrawdownPct,
  parseOrderRequest,
  realizeFifo,
  scheduleWindow,
  isSessionTool,
  sessionToolGate,
  sharpeRatio,
  tickersIn,
  exitTrigger,
  TradingEngine,
  type LimitCheck,
  type TradingDeps
} from '../src/main/features/trading/engine'
import { parseDays, tradingToolSource } from '../src/main/features/trading/tools'
import { setWorkerTradingLookup } from '../src/main/features/trading/access'
import type { Quote, TradingConfig, TradingOrder, TradingSession } from '@shared/trading'
import { TRADING_DISCLAIMER_VERSION } from '@shared/trading'
import type { StreamEvent, StreamRequest } from '@shared/types'

/**
 * Agentic trading: market hours, the simulator, every guardrail, FIFO P&L and
 * the stats math, the Alpaca client against a fake server, and sessions and
 * schedules driven by a fake agent. Nothing here touches the network, a real
 * broker or a model.
 */

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }
const at = (iso: string): number => Date.parse(iso)

const engines: TradingEngine[] = []

afterEach(async () => {
  for (const engine of engines.splice(0)) {
    engine.stop()
    await engine.whenIdle()
  }
  await store.flushWrites()
})

async function until(check: () => boolean, timeout = 4000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** A price feed with prices the test sets. */
function fakePrices(initial: Record<string, number>) {
  const prices: Record<string, number> = { ...initial }
  let calls = 0
  const feed: PriceFeed = {
    source: 'test prices',
    quote: async (symbol: string): Promise<Quote> => {
      calls++
      const s = symbol.toUpperCase()
      if (!(s in prices)) throw new Error(`Couldn’t find a stock called ${s}.`)
      return { symbol: s, name: null, price: prices[s], change: 0, changePct: 0.5, prevClose: prices[s], dayHigh: null, dayLow: null, volume: null, currency: 'USD', at: Date.now() }
    },
    bars: async () => []
  }
  return { feed, prices, calls: () => calls }
}

/* ============================================================ market hours */

test('market hours: the regular session in New York time, across both DST changes', () => {
  // Monday after DST began (Mar 8, 2026): 9:30 EDT is 13:30 UTC.
  assert.equal(isOpen(at('2026-03-09T13:30:00Z')), true)
  assert.equal(isOpen(at('2026-03-09T13:29:59Z')), false)
  assert.equal(isOpen(at('2026-03-09T19:59:59Z')), true)
  assert.equal(isOpen(at('2026-03-09T20:00:00Z')), false)
  // The Friday before: still EST, so 9:30 is 14:30 UTC.
  assert.equal(isOpen(at('2026-03-06T13:30:00Z')), false)
  assert.equal(isOpen(at('2026-03-06T14:30:00Z')), true)
  assert.equal(nextOpen(at('2026-03-06T22:00:00Z')), at('2026-03-09T13:30:00Z'))
  // Monday after DST ended (Nov 1, 2026): back to 14:30 UTC.
  assert.equal(nextOpen(at('2026-10-30T21:00:00Z')), at('2026-11-02T14:30:00Z'))
  assert.equal(nextClose(at('2026-11-02T15:00:00Z')), at('2026-11-02T21:00:00Z'))
  // The New York date, not the UTC one.
  assert.equal(marketDate(at('2026-10-02T02:00:00Z')), '2026-10-01')
})

test('market hours: weekends, holidays and nextOpen/nextClose', () => {
  const saturday = at('2026-10-03T15:00:00Z')
  assert.equal(isOpen(saturday), false)
  assert.equal(nextOpen(saturday), at('2026-10-05T13:30:00Z'))
  assert.equal(nextClose(saturday), at('2026-10-05T20:00:00Z'))
  // While open, the next open is tomorrow's and the next close today's.
  const thursday = at('2026-10-01T15:00:00Z')
  assert.equal(isOpen(thursday), true)
  assert.equal(nextOpen(thursday), at('2026-10-02T13:30:00Z'))
  assert.equal(nextClose(thursday), at('2026-10-01T20:00:00Z'))
  // Independence Day observed on Friday Jul 3, 2026: closed through the weekend.
  assert.equal(isOpen(at('2026-07-03T15:00:00Z')), false)
  assert.equal(nextOpen(at('2026-07-02T21:00:00Z')), at('2026-07-06T13:30:00Z'))
  // Good Friday 2026 and 2027, Thanksgiving, Christmas Eve 2027.
  for (const day of ['2026-04-03', '2027-03-26', '2026-11-26', '2027-12-24', '2027-01-18']) assert.equal(sessionOn(day), null, day)
  assert.notEqual(sessionOn('2026-10-01'), null)
})

test('market hours: half days close at 13:00', () => {
  const friday = sessionOn('2026-11-27')!
  assert.equal(friday.early, true)
  assert.equal(friday.close, at('2026-11-27T18:00:00Z'))
  assert.equal(isOpen(at('2026-11-27T17:59:00Z')), true)
  assert.equal(isOpen(at('2026-11-27T18:00:00Z')), false)
  assert.equal(nextClose(at('2026-11-27T15:00:00Z')), at('2026-11-27T18:00:00Z'))
  assert.equal(sessionOn('2026-12-24')!.close, at('2026-12-24T18:00:00Z'))
  assert.equal(sessionOn('2027-11-26')!.close, at('2027-11-26T18:00:00Z'))
})

/* ============================================================== prices */

test('symbols are normalised and checked', () => {
  assert.equal(normalizeSymbol(' $aapl '), 'AAPL')
  assert.equal(normalizeSymbol('brk.b'), 'BRK.B')
  assert.throws(() => normalizeSymbol('not a symbol'), /isn't a stock symbol/)
  assert.throws(() => normalizeSymbol('1ABC'), /isn't a stock symbol/)
})

test('indicators: SMA, RSI and the recent range', () => {
  const bars = Array.from({ length: 30 }, (_, i) => ({ t: i, o: i + 1, h: i + 1.5, l: i + 0.5, c: i + 1, v: 100 }))
  const stats = indicators(bars)!
  assert.equal(stats.last, 30)
  assert.equal(stats.sma20, 20.5) // mean of 11..30
  assert.equal(stats.sma50, null)
  assert.equal(stats.rsi14, 100) // only gains
  assert.equal(stats.changePct, 2900)
  assert.equal(stats.high20, 30.5)
  assert.equal(stats.low20, 10.5)
  // 14 changes, alternating +2 and −1: average gain 1, average loss 0.5, RS 2 → RSI 66.67.
  const seed = [100]
  for (let i = 0; i < 14; i++) seed.push(seed[seed.length - 1] + (i % 2 === 0 ? 2 : -1))
  assert.equal(Math.round(rsi(seed)! * 100) / 100, 66.67)
  // One more change of −1.5, smoothed Wilder's way: gain 13/14, loss (6.5 + 1.5)/14, RS 1.625 → 61.90.
  assert.equal(Math.round(rsi([...seed, seed[seed.length - 1] - 1.5])! * 100) / 100, 61.9)
  assert.equal(rsi(seed.slice(0, 14)), null, 'needs 15 closes')
  assert.equal(indicators([]), null)
})

test('Yahoo client: parses quotes and bars, caches, retries a 429, and explains an unknown symbol', async () => {
  let hits = 0
  let limited = 0
  const server = createServer((req, res) => {
    hits++
    const url = new URL(req.url!, 'http://x')
    res.setHeader('content-type', 'application/json')
    if (url.pathname.endsWith('/ZZZZ')) {
      res.writeHead(404)
      res.end(JSON.stringify({ chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } }))
      return
    }
    if (url.pathname.endsWith('/MSFT') && req.headers['user-agent']!.includes('Macintosh')) {
      limited++
      res.writeHead(429)
      res.end('Too Many Requests')
      return
    }
    assert.match(req.headers['user-agent']!, /Mozilla/)
    const symbol = decodeURIComponent(url.pathname.split('/').pop()!)
    res.end(
      JSON.stringify({
        chart: {
          result: [
            {
              meta: { symbol, currency: 'USD', regularMarketPrice: 105, previousClose: 100, chartPreviousClose: 90, regularMarketDayHigh: 106, regularMarketDayLow: 99, regularMarketVolume: 1234, longName: 'Test Co', regularMarketTime: 1_790_798_401 },
              timestamp: [1, 2, 3],
              indicators: { quote: [{ open: [1, 2, 3], high: [1, 2, 3], low: [1, 2, 3], close: [100.0000001, null, 105], volume: [10, 20, 30] }] }
            }
          ],
          error: null
        }
      })
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const md = new YahooMarketData({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })
    const q = await md.quote('aapl')
    assert.equal(q.symbol, 'AAPL')
    assert.equal(q.price, 105)
    assert.equal(q.prevClose, 100) // yesterday's close, not the range's
    assert.equal(q.change, 5)
    assert.equal(q.changePct, 5)
    assert.equal(q.name, 'Test Co')
    assert.equal(q.at, 1_790_798_401_000)
    await md.quote('AAPL')
    assert.equal(hits, 1, 'the second quote came from the cache')
    const bars = await md.bars('BRK.B', '1mo')
    assert.deepEqual(
      bars.map((b) => b.c),
      [100, 105],
      'the null close is skipped and float noise rounded'
    )
    await assert.rejects(md.quote('ZZZZ'), /Couldn’t find a stock called ZZZZ/)
    const msft = await md.quote('MSFT')
    assert.equal(msft.price, 105)
    assert.equal(limited, 1, 'a 429 is retried with the other User-Agent')
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

/* ============================================================ simulator */

const OPEN_TIME = at('2026-10-01T15:00:00Z') // Thursday 11:00 New York
const CLOSED_TIME = at('2026-10-03T15:00:00Z') // Saturday

function makeSim(options: { anytime?: boolean; now?: () => number; cash?: number; prices?: Record<string, number> } = {}) {
  let saved: SimState | null = null
  const { feed, prices } = fakePrices(options.prices ?? { AAPL: 100, MSFT: 400 })
  let anytime = options.anytime ?? false
  const make = (): SimulatorBroker =>
    new SimulatorBroker({
      load: () => saved,
      save: (state) => (saved = state),
      prices: feed,
      anytime: () => anytime,
      startingCash: () => options.cash ?? 10_000,
      now: options.now ?? (() => OPEN_TIME)
    })
  return { sim: make(), make, prices, saved: () => saved, setAnytime: (on: boolean) => (anytime = on) }
}

let orderSeq = 0
const cid = (): string => `eaon-test-${++orderSeq}`

test('simulator: a market buy fills at the live price plus slippage', async () => {
  const { sim } = makeSim()
  const order = await sim.submit({ symbol: 'AAPL', side: 'buy', type: 'market', qty: 10, clientOrderId: cid() })
  assert.equal(order.status, 'filled')
  assert.equal(order.filledAvgPrice, 100.02)
  const account = await sim.account()
  assert.equal(account.cash, 10_000 - 1000.2)
  assert.equal(account.equity, roundCents(10_000 - 1000.2 + 10 * 100))
  const [position] = await sim.positions()
  assert.equal(position.qty, 10)
  assert.equal(position.avgPrice, 100.02)
  assert.equal(position.unrealizedPl, -0.2)
  // A sell gets a touch less than the price.
  const sold = await sim.submit({ symbol: 'AAPL', side: 'sell', type: 'market', qty: 4, clientOrderId: cid() })
  assert.equal(sold.filledAvgPrice, 99.98)
  assert.equal((await sim.positions())[0].qty, 6)
})

const roundCents = (n: number): number => Math.round(n * 100) / 100

test('simulator: dollar orders buy fractional shares, rounded to 4 decimals', async () => {
  const { sim } = makeSim()
  const order = await sim.submit({ symbol: 'AAPL', side: 'buy', type: 'market', notional: 1000, clientOrderId: cid() })
  assert.equal(order.qty, 9.998) // 1000 / 100.02
  assert.equal(order.filledQty, 9.998)
  // Selling "all of it" in dollars lands on the holding rather than a hair over.
  const all = await sim.submit({ symbol: 'AAPL', side: 'sell', type: 'market', notional: 999.6, clientOrderId: cid() })
  assert.equal(all.filledQty, 9.998)
  assert.deepEqual(await sim.positions(), [])
})

test('simulator: no short selling, no margin', async () => {
  const { sim } = makeSim()
  await assert.rejects(sim.submit({ symbol: 'AAPL', side: 'sell', type: 'market', qty: 1, clientOrderId: cid() }), /don’t hold any AAPL.*short selling/)
  await sim.submit({ symbol: 'AAPL', side: 'buy', type: 'market', qty: 5, clientOrderId: cid() })
  await assert.rejects(sim.submit({ symbol: 'AAPL', side: 'sell', type: 'market', qty: 6, clientOrderId: cid() }), /hold 5 AAPL.*can’t sell 6/)
  await assert.rejects(sim.submit({ symbol: 'MSFT', side: 'buy', type: 'market', qty: 30, clientOrderId: cid() }), /Not enough cash/)
  // Shares promised to an open sell order can't be sold twice.
  await sim.submit({ symbol: 'AAPL', side: 'sell', type: 'limit', qty: 4, limitPrice: 150, clientOrderId: cid() })
  await assert.rejects(sim.submit({ symbol: 'AAPL', side: 'sell', type: 'market', qty: 2, clientOrderId: cid() }), /already in open sell orders/)
})

test('simulator: limit orders wait for the price, fill at the limit or better, and expire at the close', async () => {
  let now = OPEN_TIME
  const { sim, prices } = makeSim({ now: () => now })
  const buy = await sim.submit({ symbol: 'AAPL', side: 'buy', type: 'limit', qty: 10, limitPrice: 95, clientOrderId: cid() })
  assert.equal(buy.status, 'open')
  // The cash is set aside for it.
  assert.equal((await sim.account()).buyingPower, 10_000 - 950)
  await sim.settle()
  assert.equal((await sim.orders(10))[0].status, 'open')
  prices.AAPL = 94
  await sim.settle()
  const filled = (await sim.orders(10)).find((o) => o.id === buy.id)!
  assert.equal(filled.status, 'filled')
  assert.equal(filled.filledAvgPrice, 94.0188) // 94 × 1.0002, under the limit
  // A marketable limit fills straight away, never worse than its limit.
  const sell = await sim.submit({ symbol: 'AAPL', side: 'sell', type: 'limit', qty: 5, limitPrice: 93, clientOrderId: cid() })
  assert.equal(sell.status, 'filled')
  assert.equal(sell.filledAvgPrice, 93.9812)
  // A day order unfilled at the close expires.
  const lapsing = await sim.submit({ symbol: 'AAPL', side: 'buy', type: 'limit', qty: 1, limitPrice: 50, clientOrderId: cid() })
  now = at('2026-10-01T20:00:00Z')
  await sim.settle()
  assert.equal((await sim.orders(10)).find((o) => o.id === lapsing.id)!.status, 'expired')
  await sim.submit({ symbol: 'AAPL', side: 'buy', type: 'limit', qty: 1, limitPrice: 50, clientOrderId: cid() }).then((o) => sim.cancel(o.id))
  await assert.rejects(sim.cancel(lapsing.id), /isn’t open any more/)
})

test('simulator: market hours unless "trade anytime", reset, and the file survives a restart', async () => {
  const closed = makeSim({ now: () => CLOSED_TIME })
  await assert.rejects(closed.sim.submit({ symbol: 'AAPL', side: 'buy', type: 'market', qty: 1, clientOrderId: cid() }), /market is closed.*Trade anytime/s)
  // A limit order waits for the open.
  const waiting = await closed.sim.submit({ symbol: 'AAPL', side: 'buy', type: 'limit', qty: 1, limitPrice: 200, clientOrderId: cid() })
  assert.equal(waiting.status, 'open')
  closed.setAnytime(true)
  const filled = await closed.sim.submit({ symbol: 'AAPL', side: 'buy', type: 'market', qty: 2, clientOrderId: cid() })
  assert.equal(filled.status, 'filled')
  await closed.sim.settle()
  assert.equal((await closed.sim.orders(10)).find((o) => o.id === waiting.id)!.status, 'filled')

  const reopened = closed.make()
  assert.equal((await reopened.positions())[0].qty, 3)
  reopened.reset(50_000)
  assert.deepEqual(await reopened.positions(), [])
  assert.equal((await reopened.account()).cash, 50_000)
  assert.equal(reopened.startingCash, 50_000)
  assert.equal((await reopened.orders(10)).length, 0)
})

test('simulator: yesterday’s last equity becomes lastEquity on a new New York date', async () => {
  let now = OPEN_TIME
  const { sim, prices } = makeSim({ now: () => now })
  await sim.submit({ symbol: 'AAPL', side: 'buy', type: 'market', qty: 10, clientOrderId: cid() })
  prices.AAPL = 110
  const day1 = await sim.account()
  assert.equal(day1.lastEquity, 10_000)
  now = at('2026-10-02T15:00:00Z')
  prices.AAPL = 120
  const day2 = await sim.account()
  assert.equal(day2.lastEquity, day1.equity)
  assert.equal(day2.equity, roundCents(day1.equity + 100))
})

/* ============================================================ guardrails */

function limitCheck(overrides: Partial<Omit<LimitCheck, 'order' | 'config'>> & { order?: Partial<LimitCheck['order']>; config?: Partial<TradingConfig> } = {}): LimitCheck {
  const config = { ...defaultConfig(), ...overrides.config, limits: { ...defaultConfig().limits, ...overrides.config?.limits } }
  return {
    config,
    account: overrides.account ?? { equity: 100_000, lastEquity: 100_000 },
    positions: overrides.positions ?? [],
    ordersToday: overrides.ordersToday ?? 0,
    order: { symbol: 'AAPL', side: 'buy', type: 'market', qty: 10, notional: null, limitPrice: null, reason: 'test', ...overrides.order },
    price: overrides.price ?? 100,
    ...(overrides.flatten ? { flatten: true } : {})
  }
}

test('guardrails: an ordinary order inside every limit passes', () => {
  assert.equal(checkLimits(limitCheck()), null)
})

test('guardrails: the kill switch refuses everything, even the end-of-session sell-off', () => {
  assert.match(checkLimits(limitCheck({ config: { halted: true } }))!, /halted/)
  assert.match(checkLimits(limitCheck({ config: { halted: true }, flatten: true, order: { side: 'sell' }, positions: [{ symbol: 'AAPL', qty: 10, marketValue: 1000 }] }))!, /halted/)
})

test('guardrails: Alpaca live refuses until real money is confirmed', () => {
  assert.match(checkLimits(limitCheck({ config: { broker: 'alpaca-live' } }))!, /isn’t confirmed/)
  assert.equal(checkLimits(limitCheck({ config: { broker: 'alpaca-live', liveConfirmedAt: 1 } })), null)
})

test('guardrails: the allow-list', () => {
  const limits = { ...defaultConfig().limits, allowedSymbols: ['MSFT', 'SPY'] }
  assert.match(checkLimits(limitCheck({ config: { limits } }))!, /AAPL isn’t on your list of allowed symbols \(MSFT, SPY\)/)
  assert.equal(checkLimits(limitCheck({ config: { limits }, order: { symbol: 'SPY' } })), null)
})

test('guardrails: the most per order, priced from the quote or the limit', () => {
  // 10 × $100 = $1,000 passes the $2,000 default; 25 shares don't.
  assert.match(checkLimits(limitCheck({ order: { qty: 25 } }))!, /about \$2,500\.00, over your limit of \$2,000\.00/)
  // A limit order is valued at its limit.
  assert.match(checkLimits(limitCheck({ order: { qty: 10, type: 'limit', limitPrice: 250 } }))!, /over your limit/)
  assert.match(checkLimits(limitCheck({ order: { qty: null, notional: 2100 } }))!, /over your limit/)
  // Sells too.
  assert.match(checkLimits(limitCheck({ order: { side: 'sell', qty: 25 }, positions: [{ symbol: 'AAPL', qty: 30, marketValue: 3000 }] }))!, /sell in parts/)
})

test('guardrails: one stock can be at most maxPositionPct of equity', () => {
  const positions = [{ symbol: 'AAPL', qty: 190, marketValue: 19_000 }]
  // $19,000 + $1,500 = 20.5% of $100,000; the limit is 20%.
  const refusal = checkLimits(limitCheck({ positions, order: { qty: 15 } }))!
  assert.match(refusal, /\$20,500\.00 in AAPL, 20\.5% of equity; your limit is 20% per stock\. You can add up to \$1,000\.00 more/)
  assert.equal(checkLimits(limitCheck({ positions, order: { qty: 10 } })), null)
})

test('guardrails: at most maxInvestedPct invested', () => {
  const positions = [
    { symbol: 'MSFT', qty: 1, marketValue: 20_000 },
    { symbol: 'SPY', qty: 1, marketValue: 20_000 },
    { symbol: 'QQQ', qty: 1, marketValue: 20_000 },
    { symbol: 'NVDA', qty: 1, marketValue: 19_500 }
  ]
  assert.match(checkLimits(limitCheck({ positions, order: { qty: 10 } }))!, /80\.5% of equity in stocks; your limit is 80% invested\. You can invest up to \$500\.00 more/)
  assert.equal(checkLimits(limitCheck({ positions, order: { qty: 5 } })), null)
})

test('guardrails: maxOrdersPerDay counts orders already placed today', () => {
  assert.match(checkLimits(limitCheck({ ordersToday: 30 }))!, /30 orders have gone in today, your daily limit of 30/)
  assert.equal(checkLimits(limitCheck({ ordersToday: 29 })), null)
})

test('guardrails: past the daily loss limit buying stops and selling goes on', () => {
  const account = { equity: 96_900, lastEquity: 100_000 } // down 3.1%, limit 3%
  assert.match(checkLimits(limitCheck({ account }))!, /down 3\.10% today.*buying is paused.*Selling is still allowed/)
  assert.equal(checkLimits(limitCheck({ account, order: { side: 'sell', qty: 5 }, positions: [{ symbol: 'AAPL', qty: 10, marketValue: 1000 }] })), null)
  assert.equal(checkLimits(limitCheck({ account: { equity: 97_100, lastEquity: 100_000 } })), null)
})

test('guardrails: no short selling', () => {
  assert.match(checkLimits(limitCheck({ order: { side: 'sell', qty: 1 } }))!, /don’t hold any AAPL/)
  assert.match(checkLimits(limitCheck({ order: { side: 'sell', qty: 11 }, positions: [{ symbol: 'AAPL', qty: 10, marketValue: 1000 }] }))!, /hold 10 AAPL, so you can’t sell 11/)
})

test('guardrails: the end-of-session sell-off skips the size, count and allow-list limits', () => {
  const limits = { ...defaultConfig().limits, allowedSymbols: ['MSFT'] }
  const check = limitCheck({ config: { limits }, ordersToday: 99, flatten: true, order: { side: 'sell', qty: 500 }, positions: [{ symbol: 'AAPL', qty: 500, marketValue: 50_000 }] })
  assert.equal(checkLimits(check), null)
})

test('order requests are checked for shape', () => {
  assert.deepEqual(parseOrderRequest({ symbol: 'aapl', side: 'buy', qty: 1.23456, reason: ' why ' }), {
    symbol: 'AAPL',
    side: 'buy',
    type: 'market',
    qty: 1.2346,
    notional: null,
    limitPrice: null,
    reason: 'why'
  })
  assert.equal(parseOrderRequest({ symbol: 'AAPL', side: 'buy', qty: 1, limitPrice: 99, reason: '' }).type, 'limit')
  assert.throws(() => parseOrderRequest({ symbol: 'AAPL', side: 'hold', qty: 1, reason: '' }), /buy or sell/)
  assert.throws(() => parseOrderRequest({ symbol: 'AAPL', side: 'buy', reason: '' }), /how many shares/)
  assert.throws(() => parseOrderRequest({ symbol: 'AAPL', side: 'buy', qty: 1, notional: 10, reason: '' }), /not both/)
  assert.throws(() => parseOrderRequest({ symbol: 'AAPL', side: 'buy', notional: 100, type: 'limit', limitPrice: 5, reason: '' }), /has to be a market order/)
  assert.throws(() => parseOrderRequest({ symbol: 'AAPL', side: 'buy', qty: 1, type: 'limit', reason: '' }), /needs a limit price/)
})

/* ================================================================ the engine */

interface Harness {
  engine: TradingEngine
  files: Record<string, unknown>
  keys: Record<'paper' | 'live', AlpacaKeys | null>
  prices: Record<string, number>
  changes: () => number
}

const workRoot = mkdtempSync(join(tmpdir(), 'eaon-trading-'))

function harness(options: { config?: Partial<TradingConfig>; files?: Record<string, unknown>; deps?: Partial<TradingDeps>; prices?: Record<string, number> } = {}): Harness {
  const files: Record<string, unknown> = { config: { ...defaultConfig(), simulatorAnytime: true, ...options.config }, ...options.files }
  const keys: Record<'paper' | 'live', AlpacaKeys | null> = { paper: null, live: null }
  const { feed, prices } = fakePrices(options.prices ?? { AAPL: 100, MSFT: 400, SPY: 500 })
  let changes = 0
  const save = (name: string) => (value: unknown) => {
    files[name] = structuredClone(value)
  }
  const deps: TradingDeps = {
    prices: feed,
    runAgent: async () => ({ text: 'Nothing to do.', usage }),
    getSettings: () => store.getSettings(),
    getKeys: (kind) => keys[kind],
    saveKeys: (kind, value) => {
      keys[kind] = value
    },
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
    onChange: () => {
      changes++
    },
    resolveModel: () => ({ ok: true, providerId: 'ollama', modelId: 'fake-model', model: undefined }),
    workFolder: () => join(workRoot, 'Trading'),
    minuteMs: 40,
    scheduleTickMs: 60_000,
    ...options.deps
  }
  const engine = new TradingEngine(deps)
  engine.load()
  engines.push(engine)
  return { engine, files, keys, prices, changes: () => changes }
}

test('engine: a refused order is recorded as rejected with the reason, and shows on the desk', async () => {
  const { engine } = harness()
  const order = await engine.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 50, reason: 'Too big' }, 'user')
  assert.equal(order.status, 'rejected')
  assert.match(order.error!, /over your limit of \$2,000\.00 per order/)
  const snap = engine.snapshot()
  assert.equal(snap.orders[0].id, order.id)
  assert.equal(snap.orders[0].status, 'rejected')
  assert.equal(snap.orders[0].reason, 'Too big')
  // A refusal isn't an order that went in: it doesn't count toward the daily limit.
  assert.equal(snap.stats.ordersToday, 0)
  // An order the agent places must say why.
  await assert.rejects(engine.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 1, reason: '' }, 'agent'), /Give a reason/)
})

test('engine: the kill switch, live confirmation and the daily order count, end to end', async () => {
  const { engine } = harness({ config: { limits: { ...defaultConfig().limits, maxOrdersPerDay: 2 } } })
  await engine.setConfig({ halted: true })
  assert.match((await engine.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 1, reason: 'x' }, 'user')).error!, /halted/)
  await engine.setConfig({ halted: false })
  assert.equal((await engine.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 1, reason: 'x' }, 'user')).status, 'filled')
  assert.equal((await engine.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 1, reason: 'x' }, 'user')).status, 'filled')
  assert.match((await engine.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 1, reason: 'x' }, 'user')).error!, /daily limit of 2/)
  assert.equal(engine.snapshot().stats.ordersToday, 2)
  // Live: no keys, then no confirmation.
  await engine.setConfig({ broker: 'alpaca-live' })
  assert.match(engine.snapshot().error!, /Add your Alpaca live keys/)
  assert.throws(() => engine.confirmLive('i understand'), /exactly/)
  engine.confirmLive('I understand this trades real money')
  assert.notEqual(engine.snapshot().config.liveConfirmedAt, null)
})

test('engine: buys and sells on the simulator, realized P&L on the sell, reset clears the history', async () => {
  const { engine, prices } = harness({ config: { simulatorCash: 100_000 } })
  await engine.refresh()
  assert.equal(engine.snapshot().account!.equity, 100_000)
  const buy = await engine.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 10, reason: 'Dip' }, 'agent')
  assert.equal(buy.status, 'filled')
  assert.equal(buy.source, 'agent')
  prices.AAPL = 110
  const sell = await engine.placeOrder({ symbol: 'AAPL', side: 'sell', qty: 10, reason: 'Target hit' }, 'user')
  assert.equal(sell.status, 'filled')
  // (109.978 − 100.02) × 10
  assert.equal(sell.realizedPl, 99.58)
  const snap = await engine.refresh()
  assert.equal(snap.stats.trades, 1)
  assert.equal(snap.stats.wins, 1)
  assert.equal(snap.positions.length, 0)
  assert.ok(snap.equity.length >= 1)
  // Closing a position that isn't there says so.
  await assert.rejects(engine.closePosition('AAPL'), /don’t hold any AAPL/)

  const reset = await engine.resetSimulator(25_000)
  assert.equal(reset.account!.equity, 25_000)
  assert.equal(reset.orders.length, 0)
  assert.equal(reset.stats.trades, 0)
  assert.equal(reset.config.simulatorCash, 25_000)
})

/* =============================================================== P&L math */

const fill = (id: string, side: 'buy' | 'sell', qty: number, price: number, t: number): TradingOrder => ({
  id,
  symbol: 'AAPL',
  side,
  type: 'market',
  qty,
  limitPrice: null,
  status: 'filled',
  filledQty: qty,
  filledAvgPrice: price,
  submittedAt: t,
  filledAt: t,
  realizedPl: null,
  source: 'user',
  sessionId: null,
  reason: '',
  error: null
})

test('realized P&L is matched first in, first out', () => {
  // Newest first, as the ledger keeps them.
  const orders = [fill('s2', 'sell', 3, 105, 4), fill('s1', 'sell', 12, 120, 3), fill('b2', 'buy', 5, 110, 2), fill('b1', 'buy', 10, 100, 1)]
  assert.equal(realizeFifo(orders), true)
  const pl = Object.fromEntries(orders.map((o) => [o.id, o.realizedPl]))
  // s1: 10 @ 100 and 2 @ 110 → 10×20 + 2×10 = 220. s2: the 3 left @ 110 → 3×(−5) = −15.
  assert.deepEqual(pl, { s2: -15, s1: 220, b2: null, b1: null })
  assert.equal(realizeFifo(orders), false, 'nothing changes the second time')
  // A sell with no recorded buy behind it has no known P&L.
  const orphan = [fill('s', 'sell', 1, 100, 1)]
  realizeFifo(orphan)
  assert.equal(orphan[0].realizedPl, null)
  // At the same instant the buy goes first.
  const sameTime = [fill('s', 'sell', 1, 12, 5), fill('b', 'buy', 1, 10, 5)]
  realizeFifo(sameTime)
  assert.equal(sameTime[0].realizedPl, 2)
})

test('stats: trades, win rate, averages, profit factor, best and worst', () => {
  const orders = [fill('s3', 'sell', 1, 0, 6), fill('s2', 'sell', 3, 105, 4), fill('s1', 'sell', 12, 120, 3), fill('b2', 'buy', 5, 110, 2), fill('b1', 'buy', 10, 100, 1)]
  orders[0].filledQty = 0 // an unfilled sell is not a trade
  realizeFifo(orders)
  const stats = computeStats({
    orders,
    equity: [],
    account: { equity: 105_000, lastEquity: 104_000, startingEquity: 100_000 },
    positions: [{ marketValue: 21_000, unrealizedPl: 300 }],
    ordersToday: 4
  })
  assert.equal(stats.trades, 2)
  assert.equal(stats.wins, 1)
  assert.equal(stats.losses, 1)
  assert.equal(stats.winRate, 0.5)
  assert.equal(stats.avgWin, 220)
  assert.equal(stats.avgLoss, -15)
  assert.equal(stats.profitFactor, 14.67) // 220 / 15
  assert.equal(stats.bestTrade, 220)
  assert.equal(stats.worstTrade, -15)
  assert.equal(stats.realizedPl, 205)
  assert.equal(stats.unrealizedPl, 300)
  assert.equal(stats.totalReturn, 5000)
  assert.equal(stats.totalReturnPct, 5)
  assert.equal(stats.todayReturn, 1000)
  assert.equal(stats.todayReturnPct, 0.96) // 1000 / 104000
  assert.equal(stats.investedPct, 20)
  assert.equal(stats.ordersToday, 4)
  const none = computeStats({ orders: [], equity: [], account: null, positions: [], ordersToday: 0 })
  assert.equal(none.winRate, 0)
  assert.equal(none.profitFactor, null)
  assert.equal(none.bestTrade, null)
})

test('stats: max drawdown and Sharpe from the equity curve', () => {
  const curve = [100, 120, 90, 130, 117].map((equity, i) => ({ at: i, equity }))
  assert.equal(maxDrawdownPct(curve), 25) // 120 → 90
  // One close per local day: 100, 101, 99, 102, 103, 104 → Sharpe 7.1 (hand-computed, √252 annualised).
  const day = (d: number, hour: number): number => new Date(2026, 8, 21 + d, hour).getTime()
  const daily = [100, 101, 99, 102, 103, 104].flatMap((equity, d) => [
    { at: day(d, 10), equity: equity - 50 }, // earlier in the day; only the day's last point counts
    { at: day(d, 15), equity }
  ])
  assert.equal(sharpeRatio(daily), 7.1)
  assert.equal(sharpeRatio(daily.slice(0, 8)), null, 'four days is too few')
})

/* ================================================================== Alpaca */

interface FakeAlpaca {
  url: string
  requests: { method: string; path: string; headers: IncomingMessage['headers']; body: Record<string, unknown> | null }[]
  orders: Record<string, unknown>[]
  close: () => Promise<void>
}

async function fakeAlpaca(): Promise<FakeAlpaca> {
  const requests: FakeAlpaca['requests'] = []
  const orders: Record<string, unknown>[] = [
    // Placed outside Eaon, in Alpaca's own dashboard.
    { id: 'ext-1', client_order_id: 'dashboard-1', symbol: 'SPY', side: 'buy', type: 'market', qty: '1', status: 'filled', filled_qty: '1', filled_avg_price: '500', submitted_at: '2026-09-29T14:00:00Z', filled_at: '2026-09-29T14:00:01Z' }
  ]
  let next = 1
  const send = (res: ServerResponse, status: number, body?: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(body === undefined ? '' : JSON.stringify(body))
  }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const url = new URL(req.url!, 'http://x')
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null
      requests.push({ method: req.method!, path: url.pathname + url.search, headers: req.headers, body })
      if (req.headers['apca-api-key-id'] !== 'KEY' || req.headers['apca-api-secret-key'] !== 'SECRET') return send(res, 401, { code: 40110000, message: 'request is not authorized' })
      const route = `${req.method} ${url.pathname}`
      if (route === 'GET /v2/account') return send(res, 200, { equity: '10500.25', cash: '5000', buying_power: '10000', last_equity: '10400', status: 'ACTIVE', trading_blocked: false })
      if (route === 'GET /v2/positions') {
        return send(res, 200, [
          { symbol: 'AAPL', qty: '10', side: 'long', avg_entry_price: '100', current_price: '105', market_value: '1050', unrealized_pl: '50', unrealized_plpc: '0.05', change_today: '0.012' }
        ])
      }
      if (route === 'GET /v2/orders') return send(res, 200, [...orders].reverse())
      if (route === 'POST /v2/orders') {
        if (body!.symbol === 'TSLA') return send(res, 403, { code: 40310000, message: 'insufficient buying power' })
        const market = body!.type === 'market'
        const order = {
          id: `alp-${next++}`,
          client_order_id: body!.client_order_id,
          symbol: body!.symbol,
          side: body!.side,
          type: body!.type,
          qty: body!.qty ?? null,
          notional: body!.notional ?? null,
          limit_price: body!.limit_price ?? null,
          status: market ? 'filled' : 'new',
          filled_qty: market ? body!.qty : '0',
          filled_avg_price: market ? '105' : null,
          submitted_at: '2026-10-01T15:00:00Z',
          filled_at: market ? '2026-10-01T15:00:01Z' : null
        }
        orders.push(order)
        return send(res, 200, order)
      }
      const cancel = /^DELETE \/v2\/orders\/(.+)$/.exec(route)
      if (cancel) {
        const order = orders.find((o) => o.id === cancel[1])
        if (!order) return send(res, 404, { message: 'order not found' })
        order.status = 'canceled'
        return send(res, 204)
      }
      if (route === 'GET /v2/clock') return send(res, 200, { timestamp: '2026-10-01T15:00:00Z', is_open: true, next_open: '2026-10-02T13:30:00Z', next_close: '2026-10-01T20:00:00Z' })
      if (route === 'GET /v2/account/portfolio/history') return send(res, 200, { timestamp: [1_790_000_000, 1_790_086_400, 1_790_172_800], equity: [10_000, 10_200, null] })
      send(res, 404, { message: 'no route' })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    orders,
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  }
}

test('Alpaca statuses map onto the desk’s', () => {
  assert.equal(mapAlpacaStatus('new'), 'open')
  assert.equal(mapAlpacaStatus('accepted'), 'pending')
  assert.equal(mapAlpacaStatus('pending_new'), 'pending')
  assert.equal(mapAlpacaStatus('partially_filled'), 'partially_filled')
  assert.equal(mapAlpacaStatus('filled'), 'filled')
  assert.equal(mapAlpacaStatus('canceled'), 'canceled')
  assert.equal(mapAlpacaStatus('replaced'), 'canceled')
  assert.equal(mapAlpacaStatus('expired'), 'expired')
  assert.equal(mapAlpacaStatus('done_for_day'), 'expired')
  assert.equal(mapAlpacaStatus('rejected'), 'rejected')
})

test('Alpaca client: account, positions, clock and a friendly 401', async () => {
  const alpaca = await fakeAlpaca()
  try {
    const broker = new AlpacaBroker({ kind: 'alpaca-paper', keys: { keyId: 'KEY', secret: 'SECRET' }, baseUrl: alpaca.url })
    const account = await broker.account()
    assert.deepEqual(account, { equity: 10500.25, cash: 5000, buyingPower: 10000, lastEquity: 10400, status: 'ACTIVE', blocked: false })
    const [position] = await broker.positions()
    assert.equal(position.qty, 10)
    assert.equal(position.dayChangePct, 1.2)
    assert.deepEqual(await broker.clock(), { isOpen: true, nextOpen: at('2026-10-02T13:30:00Z'), nextClose: at('2026-10-01T20:00:00Z') })
    const history = await broker.history()
    assert.equal(history.length, 2, 'the null point is dropped')
    assert.equal(alpaca.requests[0].headers['apca-api-key-id'], 'KEY')

    const wrong = new AlpacaBroker({ kind: 'alpaca-paper', keys: { keyId: 'NOPE', secret: 'WRONGSECRET' }, baseUrl: alpaca.url })
    await assert.rejects(wrong.account(), (error: Error) => {
      assert.match(error.message, /Alpaca refused these keys/)
      assert.doesNotMatch(error.message, /WRONGSECRET|NOPE/, 'keys never appear in a message')
      return true
    })
  } finally {
    await alpaca.close()
  }
})

test('engine on Alpaca paper: orders carry eaon client ids, keep their reason, cancel, and refusals are explained', async () => {
  const alpaca = await fakeAlpaca()
  try {
    const { engine, keys } = harness({
      config: { broker: 'alpaca-paper', limits: { ...defaultConfig().limits, maxOrderUsd: 5000 } },
      prices: { AAPL: 105, MSFT: 400, TSLA: 200 },
      deps: { createBroker: (kind, k) => new AlpacaBroker({ kind, keys: k, baseUrl: alpaca.url }) }
    })
    // Bad keys are refused before they are saved.
    await assert.rejects(engine.setKeys('paper', 'BAD', 'BAD'), /Alpaca refused these keys/)
    assert.equal(keys.paper, null)
    const saved = await engine.setKeys('paper', ' KEY ', 'SECRET')
    assert.deepEqual(keys.paper, { keyId: 'KEY', secret: 'SECRET' })
    assert.deepEqual(saved.keys, { paper: true, live: false })
    assert.equal(saved.account!.equity, 10500.25)
    assert.equal(saved.account!.marketOpen, true)
    assert.equal(saved.positions[0].unrealizedPlPct, 5)
    // The account's history seeds the chart.
    assert.ok(saved.equity.length >= 3)
    // An order placed elsewhere shows as the user's, with no reason.
    const external = saved.orders.find((o) => o.symbol === 'SPY')!
    assert.equal(external.source, 'user')
    assert.equal(external.reason, '')

    const order = await engine.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 2, reason: 'Breaking out above the 20-day high' }, 'agent')
    assert.equal(order.status, 'filled')
    const posted = alpaca.requests.find((r) => r.method === 'POST')!
    assert.match(String(posted.body!.client_order_id), /^eaon-[0-9a-f-]{36}$/)
    assert.deepEqual({ ...posted.body, client_order_id: 'x' }, { symbol: 'AAPL', side: 'buy', type: 'market', time_in_force: 'day', client_order_id: 'x', qty: '2' })
    // After a refresh the broker's copy is tied back to the reason through the client id.
    const after = await engine.refresh()
    const mapped = after.orders.find((o) => o.id === posted.body!.client_order_id)!
    assert.equal(mapped.reason, 'Breaking out above the 20-day high')
    assert.equal(mapped.source, 'agent')
    assert.equal(mapped.filledAvgPrice, 105)
    assert.equal(after.orders.filter((o) => o.symbol === 'AAPL').length, 1, 'not duplicated by the merge')

    const limit = await engine.placeOrder({ symbol: 'MSFT', side: 'buy', qty: 1, type: 'limit', limitPrice: 390, reason: 'Wait for a pullback' }, 'user')
    assert.equal(limit.status, 'open')
    assert.equal(alpaca.requests.filter((r) => r.method === 'POST').at(-1)!.body!.limit_price, '390')
    const canceled = await engine.cancelOrder(limit.id)
    assert.ok(alpaca.requests.some((r) => r.method === 'DELETE' && r.path === '/v2/orders/alp-2'))
    assert.equal(canceled.orders.find((o) => o.id === limit.id)!.status, 'canceled')

    const refused = await engine.placeOrder({ symbol: 'TSLA', side: 'buy', qty: 1, reason: 'x' }, 'user')
    assert.equal(refused.status, 'rejected')
    assert.equal(refused.error, 'Alpaca refused the order: insufficient buying power.')
    for (const r of alpaca.requests) assert.ok(r.headers['apca-api-key-id'] && r.headers['apca-api-secret-key'], 'every request carries both key headers')

    const cleared = await engine.clearKeys('paper')
    assert.equal(cleared.keys.paper, false)
    assert.equal(cleared.account, null)
    assert.match(cleared.error!, /Add your Alpaca paper keys/)
  } finally {
    await alpaca.close()
  }
})

/* ================================================================== tools */

test('tools: offered to the main Work agent only; real money from a chat is catastrophic', async () => {
  const { engine } = harness()
  const source = tradingToolSource(engine)
  const query = (mode: 'work' | 'chat', depth: number): ToolQuery => ({ mode, depth }) as ToolQuery
  assert.deepEqual(
    source.tools(query('work', 0)).map((t) => t.name),
    ['trading_account', 'trading_quote', 'trading_history', 'trading_scan', 'trading_news', 'trading_order', 'trading_exits', 'trading_cancel', 'trading_session']
  )
  assert.equal(source.tools(query('chat', 0)).length, 0)
  assert.equal(source.tools(query('work', 1)).length, 0)
  assert.match(source.guidance!(query('work', 0))!, /practice money/)
  const order = source.tools(query('work', 0)).find((t) => t.name === 'trading_order')!
  const ctx = (chatId: string) => ({ request: { chatId } }) as ToolContext
  assert.equal(order.risky!({}, ctx('chat-1')), true)
  assert.equal(order.catastrophic!({}, ctx('chat-1')), false, 'the simulator is never catastrophic')
  assert.equal(order.describe!({ side: 'buy', symbol: 'aapl', qty: 5 }), 'Buy 5 AAPL')
  assert.equal(order.describe!({ side: 'sell', symbol: 'AAPL', notional: 500 }), 'Sell $500.00 of AAPL')
  await engine.setConfig({ broker: 'alpaca-live' })
  assert.equal(order.catastrophic!({}, ctx('chat-1')), true, 'real money from a chat always asks')
  assert.equal(order.catastrophic!({}, ctx('trading:abc')), false, 'an armed session may trade')
  // A worker set up to trade on the desk: its "place orders without asking" switch decides, even on real money;
  // a worker trading elsewhere, or not at all, is held to the chat rule.
  setWorkerTradingLookup((id) =>
    id === 'free' ? { via: 'desk', strategy: '', everyMinutes: 15, autoPlace: true } : id === 'asks' ? { via: 'desk', strategy: '', everyMinutes: 15, autoPlace: false } : id === 'rh' ? { via: 'plugin-robinhood', strategy: '', everyMinutes: 15, autoPlace: true } : null
  )
  try {
    assert.equal(order.catastrophic!({}, ctx('worker:free')), false)
    assert.equal(order.catastrophic!({}, ctx('worker:asks')), true)
    assert.equal(order.catastrophic!({}, ctx('worker:rh')), true)
    assert.equal(order.catastrophic!({}, ctx('worker:nobody')), true)
    await engine.setConfig({ broker: 'simulator' })
    assert.equal(order.catastrophic!({}, ctx('worker:asks')), true, 'asked to ask first: even practice orders wait')
    assert.equal(order.catastrophic!({}, ctx('worker:nobody')), false)
    await engine.setConfig({ broker: 'alpaca-live' })
  } finally {
    setWorkerTradingLookup(() => null)
  }
  assert.match(order.describe!({ side: 'buy', symbol: 'AAPL', qty: 1 }), /real money/)
  assert.deepEqual(parseDays(['mon', 'Wed', 5]), [1, 3, 5])
  assert.deepEqual(parseDays('weekdays'), [1, 2, 3, 4, 5])
  assert.deepEqual(parseDays(undefined), [1, 2, 3, 4, 5])
})

test('a session’s tool gate allows only trading tools, web search and fetch', () => {
  const tool = (name: string) => ({ name }) as AgentTool
  assert.match(sessionToolGate(tool('run_command'), {})!, /only use the trading tools/)
  assert.notEqual(sessionToolGate(tool('write_file'), {}), null)
  for (const name of ['trading_order', 'trading_quote', 'web_search', 'web_fetch', 'update_plan']) assert.equal(sessionToolGate(tool(name), {}), null, name)
})

/* ================================================================ sessions */

type Call = { request: StreamRequest; options: RunOptions }

/** A fake model that buys 3 AAPL through the real trading_order tool on its first check, then holds. */
function tradingAgent(getEngine: () => TradingEngine) {
  const calls: Call[] = []
  const runAgent = async (request: StreamRequest, emit: (event: StreamEvent) => void, options: RunOptions): Promise<RunOutcome> => {
    calls.push({ request: structuredClone(request), options })
    emit({ type: 'delta', messageId: request.messageId, text: '…' })
    if (calls.length === 1) {
      const order = tradingToolSource(getEngine())
        .tools({ mode: 'work', depth: 0 } as ToolQuery)
        .find((t) => t.name === 'trading_order')!
      const gate = options.toolGate!
      assert.equal(gate(order, {}), null)
      const result = await order.run({ symbol: 'AAPL', side: 'buy', qty: 3, reason: 'Testing the session' }, { request } as ToolContext)
      return { text: `Bought 3 AAPL to test. ${result}`, usage }
    }
    return { text: 'Held: nothing worth doing.', usage }
  }
  return { calls, runAgent }
}

test('sessions: checks run on their interval, trade through the tools, end on time, sell everything and sum up', async () => {
  let engine: TradingEngine | null = null
  const agent = tradingAgent(() => engine!)
  const h = harness({ deps: { runAgent: agent.runAgent } })
  engine = h.engine
  await engine.refresh()
  const started = await engine.startSession({ strategy: 'Buy AAPL on dips, sell into strength.', until: Date.now() + 700, everyMinutes: 1, flattenAtEnd: true, name: 'Test run' })
  assert.equal(started.status, 'running')
  assert.equal(engine.snapshot().activeSession!.id, started.id)
  await assert.rejects(engine.startSession({ strategy: 'Another', until: Date.now() + 5000 }), /already running/)

  await until(() => engine!.snapshot().sessions[0].status !== 'running')
  const session = engine.snapshot().sessions[0]
  assert.equal(session.status, 'done')
  assert.equal(engine.snapshot().activeSession, null)

  // Several checks, one turn at a time, each the way workers run theirs.
  assert.ok(agent.calls.length >= 3, `only ${agent.calls.length} checks ran`)
  assert.equal(session.checks, agent.calls.length)
  const first = agent.calls[0]
  assert.equal(first.request.chatId, `trading:${started.id}`)
  assert.equal(first.request.mode, 'work')
  assert.deepEqual(first.request.work, { swarm: false, plan: false })
  assert.equal(first.request.cwd, join(workRoot, 'Trading'))
  assert.match(first.request.persona!, /Buy AAPL on dips, sell into strength\./)
  assert.match(first.request.persona!, /only with trading_order/)
  assert.match(first.request.persona!, /at most \$2,000\.00 per order/)
  assert.equal(first.options.unattended, 'autonomous')
  assert.equal(await first.options.approver!('x', {}), false)
  assert.match(first.options.toolGate!({ name: 'run_command' } as AgentTool, {})!, /only use the trading tools/)
  const message = (first.request.history.at(-1)!.parts[0] as { text: string }).text
  assert.match(message, /Market: (open|closed)/)
  assert.match(message, /Account \(Simulator\): equity \$100,000\.00/)
  assert.match(message, /Positions: none/)
  // The second check sees the first one's exchange.
  assert.equal(agent.calls[1].request.history.length, 3)
  assert.match((agent.calls[1].request.history[1].parts[0] as { text: string }).text, /Bought 3 AAPL/)
  assert.match((agent.calls[1].request.history[2].parts[0] as { text: string }).text, /Positions:\n- AAPL: 3/)

  // The session's buy, and the sell-off at the end.
  const orders = engine.snapshot().orders.filter((o) => o.sessionId === started.id)
  const buy = orders.find((o) => o.side === 'buy')!
  assert.equal(buy.source, 'session')
  assert.equal(buy.reason, 'Testing the session')
  assert.equal(buy.status, 'filled')
  const sell = orders.find((o) => o.side === 'sell')!
  assert.equal(sell.reason, 'Session ended')
  assert.equal(sell.source, 'session')
  assert.equal(sell.status, 'filled')
  assert.equal(engine.snapshot().positions.length, 0)
  assert.equal(session.orders, 2)
  assert.notEqual(session.endEquity, null)
  assert.match(session.summary!, /^2 orders in .*Equity \$100,000\.00 → \$[\d,.]+ \(/)
  assert.ok(session.log.some((e) => e.kind === 'decision' && /Held/.test(e.text)))
  assert.ok(session.log.some((e) => e.kind === 'order' && /Bought 3 AAPL/.test(e.text)))
})

test('sessions: the agent’s stream events reach a listener, the desk sees checks and the next one’s time, and a check can run now', async () => {
  const events: { sessionId: string; type: string }[] = []
  let checks = 0
  const agent = async (request: StreamRequest, emit: (event: StreamEvent) => void): Promise<RunOutcome> => {
    checks++
    emit({ type: 'reasoning', messageId: request.messageId, text: 'Looking at AAPL.' })
    emit({ type: 'tool-call', messageId: request.messageId, toolId: `t${checks}`, name: 'trading_quote', input: { symbols: ['AAPL'] } })
    emit({ type: 'tool-result', messageId: request.messageId, toolId: `t${checks}`, output: 'AAPL: $100.00', status: 'done' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    return { text: 'Held.', usage }
  }
  const { engine } = harness({ deps: { runAgent: agent, minuteMs: 60_000, onAgentEvent: (sessionId, event) => void events.push({ sessionId, type: event.type }) } })
  const session = await engine.startSession({ strategy: 'Watch AAPL', until: Date.now() + 10 * 60_000, everyMinutes: 5 })
  // The first check runs at once; while it does, the desk says so.
  await until(() => engine.snapshot().agent?.checking === true)
  assert.ok(engine.snapshot().agent!.checkStartedAt! <= Date.now())
  await until(() => checks === 1 && engine.snapshot().agent?.checking === false)
  assert.deepEqual([...new Set(events.map((e) => e.sessionId))], [session.id])
  assert.deepEqual(events.map((e) => e.type).filter((t) => t !== 'delta'), ['reasoning', 'tool-call', 'tool-result'])
  // The next check is five minutes out, and "now" brings it forward.
  const next = engine.snapshot().agent!.nextCheckAt!
  assert.ok(next > Date.now() + 4 * 60_000, `next check at ${next - Date.now()} ms`)
  const snap = engine.checkNow(session.id)
  assert.equal(snap.agent!.checking, true)
  await until(() => checks === 2)
  assert.throws(() => engine.checkNow('nope'), /isn’t running/)
  await engine.stopSession(session.id)
  assert.equal(engine.snapshot().agent, null)
})

test('disclaimer: where it’s required, nothing trades until it’s accepted — except protective sells', async () => {
  const { engine } = harness({ deps: { requireDisclaimer: () => true } })
  assert.equal(engine.snapshot().needsDisclaimer, true)
  const refused = await engine.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 1, reason: 'test' }, 'user')
  assert.equal(refused.status, 'rejected')
  assert.match(refused.error!, /accept the trading disclaimer/)
  await assert.rejects(engine.startSession({ strategy: 'Anything', until: Date.now() + 60_000 }), /accept the trading disclaimer/)
  assert.throws(() => engine.acceptDisclaimer(TRADING_DISCLAIMER_VERSION + 1), /current disclaimer/)
  const accepted = engine.acceptDisclaimer(TRADING_DISCLAIMER_VERSION)
  assert.equal(accepted.needsDisclaimer, false)
  assert.equal(accepted.config.disclaimer!.version, TRADING_DISCLAIMER_VERSION)
  assert.equal((await engine.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 1, reason: 'test' }, 'user')).status, 'filled')
  // Without the requirement (the desktop), nothing changes.
  const { engine: desktop } = harness()
  assert.equal(desktop.snapshot().needsDisclaimer, false)
  assert.equal((await desktop.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 1, reason: 'test' }, 'user')).status, 'filled')
})

test('sessions: the user can write to the agent mid-session; it reads the message in a check that starts at once', async () => {
  const briefs: string[] = []
  const agent = async (request: StreamRequest): Promise<RunOutcome> => {
    briefs.push((request.history.at(-1)!.parts[0] as { text: string }).text)
    return { text: 'Done.', usage }
  }
  const { engine } = harness({ deps: { runAgent: agent, minuteMs: 60_000 } })
  const session = await engine.startSession({ strategy: 'Watch AAPL', until: Date.now() + 10 * 60_000, everyMinutes: 5 })
  await until(() => briefs.length === 1 && engine.snapshot().agent?.checking === false)
  engine.tellSession(session.id, 'Sell half of AAPL and be more careful.')
  await until(() => briefs.length === 2)
  assert.match(briefs[1], /^MESSAGE FROM THE USER \(.+\): Sell half of AAPL and be more careful\./)
  assert.ok(engine.snapshot().activeSession!.log.some((e) => e.kind === 'message' && /Sell half/.test(e.text)))
  assert.throws(() => engine.tellSession('nope', 'hi'), /isn’t running/)
  await engine.stopSession(session.id)
})

test('sessions: between checks prices are watched; a sharp move wakes the agent early with an alert, and each check says what moved', async () => {
  const briefs: string[] = []
  const agent = async (request: StreamRequest): Promise<RunOutcome> => {
    briefs.push((request.history.at(-1)!.parts[0] as { text: string }).text)
    return { text: 'Looked.', usage }
  }
  const h = harness({ deps: { runAgent: agent, minuteMs: 60_000, watchMs: 25, alertGapMs: 0 } })
  const { engine } = h
  await engine.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 5, reason: 'held' }, 'user')
  const session = await engine.startSession({ strategy: 'Hold AAPL, watch MSFT', until: Date.now() + 10 * 60_000, everyMinutes: 5 })
  await until(() => briefs.length === 1 && engine.snapshot().agent?.checking === false)
  // The watch is running between checks.
  await until(() => (engine.snapshot().agent?.watchedAt ?? 0) > 0)
  assert.ok(engine.snapshot().agent!.watching!.includes('AAPL'))
  // A small move doesn't wake it; a sharp one does.
  h.prices.AAPL = 100.5
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(briefs.length, 1)
  h.prices.AAPL = 103
  await until(() => briefs.length === 2)
  assert.match(briefs[1], /^ALERT: AAPL \+3\.00% since the last check \(\$100\.00 → \$103\.00\), which you hold\./)
  assert.match(briefs[1], /Since your last check \(Eaon watches prices every 0 s\): AAPL \$100\.00 → \$103\.00 \(\+3\.00%\)/)
  assert.ok(engine.snapshot().activeSession!.log.some((e) => e.kind === 'note' && /⚡ AAPL \+3\.00%/.test(e.text)))
  await engine.stopSession(session.id)
})

test('sessions run by Claude Code: Eaon never runs its own agent; Claude Code takes each check, and messages, check-now and the end wake it', async () => {
  let ran = 0
  const events: string[] = []
  const { engine } = harness({
    deps: {
      runAgent: async () => {
        ran++
        return { text: 'x', usage }
      },
      minuteMs: 60_000,
      onAgentEvent: (_id, event) => void events.push(event.type)
    }
  })
  const session = await engine.startSession({ strategy: 'Hold AAPL', until: Date.now() + 10 * 60_000, everyMinutes: 5, driver: 'claude-code' })
  assert.equal(session.driver, 'claude-code')
  assert.equal(engine.snapshot().agent!.driver, 'claude-code')
  assert.equal(engine.snapshot().agent!.connected, false)

  const first = await engine.waitForCheck(session.id, 1000)
  assert.equal(first.state, 'check')
  if (first.state !== 'check') return
  assert.equal(first.check, 1)
  assert.match(first.brief, /Account \(Simulator\): equity/)
  assert.match(first.brief, /eaon_log_decision/)
  assert.equal(engine.snapshot().agent!.checking, true)
  const order = await engine.sessionOrder(session.id, { symbol: 'AAPL', side: 'buy', qty: 1, reason: 'test' })
  assert.equal(order.source, 'session')
  assert.equal(order.sessionId, session.id)
  engine.recordExternalTool('trading_quote', { symbols: ['AAPL'] }, 'AAPL: $100.00, +0.50% today', true)
  engine.logDecision(session.id, 'Bought 1 AAPL.')
  assert.equal(engine.snapshot().agent!.checking, false)
  assert.ok(engine.snapshot().activeSession!.log.some((e) => e.kind === 'decision' && e.text === 'Bought 1 AAPL.'))

  // Nothing is due for five minutes: a short wait comes back empty-handed.
  assert.equal((await engine.waitForCheck(session.id, 50)).state, 'waiting')
  // The user writing wakes a waiting Claude Code at once, with the message first.
  const waiting = engine.waitForCheck(session.id, 5000)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(engine.snapshot().agent!.connected, true)
  engine.tellSession(session.id, 'Sell it.')
  const second = await waiting
  assert.equal(second.state, 'check')
  if (second.state === 'check') assert.match(second.brief, /^MESSAGE FROM THE USER \(.+\): Sell it\./)
  engine.logDecision(session.id, 'Sold.')
  // So does "check now"; and the session ending ends the wait.
  const third = engine.waitForCheck(session.id, 5000)
  engine.checkNow(session.id)
  assert.equal((await third).state, 'check')
  const fourth = engine.waitForCheck(session.id, 5000)
  await engine.stopSession(session.id)
  assert.equal((await fourth).state, 'ended')

  assert.equal(ran, 0, 'Eaon’s own agent never ran')
  assert.deepEqual(events.slice(0, 5), ['usage', 'tool-call', 'tool-result', 'delta', 'done'])
  assert.throws(() => engine.logDecision(session.id, 'x'), /isn’t running/)
  // Eaon's own sessions don't take Claude Code's calls.
  const own = await engine.startSession({ strategy: 'Own', until: Date.now() + 10 * 60_000, everyMinutes: 5 })
  await assert.rejects(engine.waitForCheck(own.id, 10), /Eaon’s own agent/)
  await engine.stopSession(own.id)
})

test('sessions: a closed market skips checks (noted once) unless the simulator trades anytime', async () => {
  const saturday = at('2026-10-03T15:00:00Z')
  const t0 = Date.now()
  let calls = 0
  const { engine } = harness({
    config: { simulatorAnytime: false },
    deps: {
      now: () => saturday + (Date.now() - t0),
      runAgent: async () => {
        calls++
        return { text: 'x', usage }
      }
    }
  })
  const session = await engine.startSession({ strategy: 'Anything', until: saturday + (Date.now() - t0) + 400, everyMinutes: 1 })
  await until(() => engine.snapshot().sessions[0].status === 'done')
  assert.equal(calls, 0)
  const notes = engine.snapshot().sessions.find((s) => s.id === session.id)!.log.filter((e) => /market is closed/.test(e.text))
  assert.equal(notes.length, 1)
  assert.match(notes[0].text, /Waiting for the open at Mon 9:30 AM ET/)
})

test('sessions: stopping aborts the running check, keeps positions, and the kill switch stops one too', async () => {
  let aborted = 0
  const held = async (_request: StreamRequest, _emit: (event: StreamEvent) => void, options: RunOptions): Promise<RunOutcome> =>
    new Promise((resolve) => {
      options.signal!.addEventListener('abort', () => {
        aborted++
        resolve({ text: '', usage, cancelled: true })
      })
    })
  const { engine } = harness({ deps: { runAgent: held } })
  await engine.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 1, reason: 'held before' }, 'user')
  const session = await engine.startSession({ strategy: 'Wait', until: Date.now() + 60_000, everyMinutes: 1, flattenAtEnd: true })
  await until(() => engine.snapshot().activeSession !== null && aborted === 0)
  await new Promise((resolve) => setTimeout(resolve, 30))
  const snap = await engine.stopSession(session.id)
  assert.equal(aborted, 1)
  const stopped = snap.sessions.find((s) => s.id === session.id)!
  assert.equal(stopped.status, 'stopped')
  assert.equal(stopped.checks, 0)
  assert.match(stopped.summary!, /0 orders/)
  assert.equal(snap.positions.length, 1, 'a hand stop keeps positions; only a natural end sells')
  await assert.rejects(engine.stopSession(session.id), /isn’t running/)

  const second = await engine.startSession({ strategy: 'Wait again', until: Date.now() + 60_000, everyMinutes: 1 })
  const halted = await engine.setConfig({ halted: true })
  assert.equal(halted.activeSession, null)
  assert.match(halted.sessions.find((s) => s.id === second.id)!.log.at(-1)!.text, /kill switch/)
  await assert.rejects(engine.startSession({ strategy: 'x', until: Date.now() + 60_000 }), /halted/)
})

test('sessions: the agent stopping its own session waits for its check to end', async () => {
  let engine: TradingEngine | null = null
  const runAgent = async (request: StreamRequest): Promise<RunOutcome> => {
    const tool = tradingToolSource(engine!)
      .tools({ mode: 'work', depth: 0 } as ToolQuery)
      .find((t) => t.name === 'trading_session')!
    const text = await tool.run({ action: 'stop' }, { request } as ToolContext)
    return { text: String(text), usage }
  }
  const h = harness({ deps: { runAgent } })
  engine = h.engine
  const session = await engine.startSession({ strategy: 'Stop at once', until: Date.now() + 60_000, everyMinutes: 1 })
  await until(() => engine!.snapshot().sessions[0].status !== 'running')
  const ended = engine.snapshot().sessions.find((s) => s.id === session.id)!
  assert.equal(ended.status, 'stopped')
  assert.equal(ended.checks, 1)
  assert.match(ended.log.find((e) => e.kind === 'decision')!.text, /stops as soon as this check ends/)
})

test('sessions: three failed checks in a row end the session as failed', async () => {
  const { engine } = harness({ deps: { runAgent: async () => ({ text: '', usage, error: 'The model is offline' }) } })
  const session = await engine.startSession({ strategy: 'x', until: Date.now() + 60_000, everyMinutes: 1 })
  await until(() => engine.snapshot().sessions[0].status !== 'running')
  const failed = engine.snapshot().sessions.find((s) => s.id === session.id)!
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error, 'The model is offline')
  assert.equal(failed.log.filter((e) => e.kind === 'error').length, 3)
})

test('sessions survive a restart: one still in its window resumes, one past its end closes as done', async () => {
  const now = Date.now()
  const base = (id: string, endsAt: number): TradingSession => ({
    id,
    scheduleId: null,
    name: id,
    strategy: 'x',
    startedAt: now - 60_000,
    endsAt,
    endedAt: null,
    status: 'running',
    everyMinutes: 1,
    flattenAtEnd: true,
    startEquity: 100_000,
    endEquity: null,
    orders: 0,
    checks: 2,
    log: [{ at: now - 30_000, kind: 'decision', text: 'Held.' }],
    summary: null,
    error: null
  })
  const calls: StreamRequest[] = []
  const { engine } = harness({
    files: { sessions: [base('live', now + 60_000), base('over', now - 1000)] },
    deps: {
      runAgent: async (request) => {
        calls.push(structuredClone(request))
        return { text: 'Still holding.', usage }
      }
    }
  })
  const snap = engine.snapshot()
  assert.equal(snap.activeSession!.id, 'live')
  assert.match(snap.activeSession!.log.at(-1)!.text, /Eaon restarted/)
  const over = snap.sessions.find((s) => s.id === 'over')!
  assert.equal(over.status, 'done')
  assert.match(over.summary!, /Eaon was closed.*not sold/)
  // Its earlier decisions stand in for the lost conversation.
  engine.start()
  await until(() => calls.length > 0)
  assert.equal(calls[0].chatId, 'trading:live')
  assert.match((calls[0].history[1].parts[0] as { text: string }).text, /Held\./)
})

/* =============================================================== schedules */

test('schedule windows are local, may cross midnight, and only open on their days', () => {
  const tuesday10 = new Date(2026, 9, 6, 10, 0).getTime() // Tue Oct 6, 2026
  const window = scheduleWindow({ days: [2], start: '09:30', end: '16:00' }, tuesday10)!
  assert.equal(window.start, new Date(2026, 9, 6, 9, 30).getTime())
  assert.equal(window.end, new Date(2026, 9, 6, 16, 0).getTime())
  assert.equal(scheduleWindow({ days: [3], start: '09:30', end: '16:00' }, tuesday10), null)
  assert.equal(scheduleWindow({ days: [2], start: '10:30', end: '16:00' }, tuesday10), null)
  // 22:00–02:00 opened on Monday is still open at 01:00 Tuesday.
  const overnight = scheduleWindow({ days: [1], start: '22:00', end: '02:00' }, new Date(2026, 9, 6, 1, 0).getTime())!
  assert.equal(overnight.end, new Date(2026, 9, 6, 2, 0).getTime())
})

test('schedules: a session starts when the window opens, once per window, and ends with it', async () => {
  const t0 = Date.now()
  let offset = new Date(2026, 9, 6, 9, 59, 30).getTime() - t0 // Tue 09:59:30 local
  const now = (): number => Date.now() + offset
  const calls: StreamRequest[] = []
  const { engine } = harness({
    deps: {
      now,
      runAgent: async (request) => {
        calls.push(request)
        return { text: 'Looked; held.', usage }
      }
    }
  })
  await assert.rejects(async () => engine.saveSchedule({ name: '', days: [], start: '10:00', end: '10:01', strategy: 'x', everyMinutes: 1, flattenAtEnd: false, enabled: true }), /at least one day/)
  const schedule = engine.saveSchedule({ name: 'Open bell', days: [2], start: '10:00', end: '10:01', strategy: 'Trade the open', everyMinutes: 1, flattenAtEnd: true, enabled: true })
  const other = engine.saveSchedule({ name: '', days: [3], start: '10:00', end: '10:01', strategy: 'Wednesdays only', everyMinutes: 1, flattenAtEnd: false, enabled: true })
  assert.equal(other.name, 'Wednesdays only')

  await engine.tickSchedules()
  assert.equal(engine.snapshot().activeSession, null, 'not before the window opens')

  offset = new Date(2026, 9, 6, 10, 0, 59, 300).getTime() - Date.now() // 700 ms before the window ends
  await engine.tickSchedules()
  const session = engine.snapshot().activeSession!
  assert.equal(session.scheduleId, schedule.id)
  assert.equal(session.name, 'Open bell')
  assert.equal(session.endsAt, new Date(2026, 9, 6, 10, 1).getTime())
  assert.equal(session.flattenAtEnd, true)

  await until(() => engine.snapshot().activeSession === null)
  assert.equal(engine.snapshot().sessions[0].status, 'done')
  assert.ok(calls.length >= 1)
  // Back inside the same window: it already ran, so nothing starts.
  offset = new Date(2026, 9, 6, 10, 0, 30).getTime() - Date.now()
  await engine.tickSchedules()
  assert.equal(engine.snapshot().activeSession, null)
  assert.equal(engine.snapshot().sessions.filter((s) => s.scheduleId === schedule.id).length, 1)

  const removed = engine.removeSchedule(schedule.id)
  assert.equal(removed.schedules.length, 1)
})

test('missions: a market-hours schedule trades from the open to just before the close, every market day, and Claude Code can wait for the next one', async () => {
  const t0 = Date.now()
  let offset = at('2026-10-05T14:00:00Z') - t0 // Monday 10:00 AM ET
  const now = (): number => Date.now() + offset
  const { engine } = harness({ deps: { now, runAgent: async () => ({ text: 'held', usage }) } })
  const mission = engine.saveSchedule({ name: 'Mission', days: [], start: '', end: '', strategy: 'Momentum in large caps', everyMinutes: 5, flattenAtEnd: true, enabled: true, marketHours: true, driver: 'claude-code' })
  assert.equal(mission.marketHours, true)
  assert.equal(mission.driver, 'claude-code')
  await engine.tickSchedules()
  const monday = engine.snapshot().activeSession!
  assert.equal(monday.scheduleId, mission.id)
  assert.equal(monday.driver, 'claude-code')
  assert.equal(monday.endsAt, at('2026-10-05T20:00:00Z') - 5 * 60_000, 'until five minutes before the 4 PM bell')
  assert.deepEqual(await engine.waitForSession(10), { state: 'session', id: monday.id })

  // Stopped by hand: it stays stopped for the rest of the day.
  await engine.stopSession(monday.id)
  await engine.tickSchedules()
  assert.equal(engine.snapshot().activeSession, null)
  const pending = engine.waitForSession(10)
  assert.equal(engine.snapshot().claudeWaiting, true, 'the desk shows Claude Code waiting for the open')
  const waiting = await pending
  assert.deepEqual(waiting, { state: 'waiting', nextAt: at('2026-10-06T13:30:00Z') })

  // The next open starts it again.
  offset = at('2026-10-06T13:31:00Z') - Date.now() // Tuesday 9:31 AM ET
  await engine.tickSchedules()
  const tuesday = engine.snapshot().activeSession!
  assert.notEqual(tuesday.id, monday.id)
  assert.equal(tuesday.scheduleId, mission.id)
  await engine.stopSession(tuesday.id)

  // Nothing on a Saturday; the next start is Monday's open.
  offset = at('2026-10-10T15:00:00Z') - Date.now()
  await engine.tickSchedules()
  assert.equal(engine.snapshot().activeSession, null)
  assert.equal(engine.nextScheduledStart('claude-code'), at('2026-10-12T13:30:00Z'))
  // Switched off, there's nothing left for Claude Code to wait for.
  engine.saveSchedule({ ...mission, enabled: false })
  assert.deepEqual(await engine.waitForSession(10), { state: 'none' })
})

test('schedules: a window that can’t start (no keys) shows a failed session and isn’t retried at once', async () => {
  const t0 = Date.now()
  const offset = new Date(2026, 9, 6, 10, 30).getTime() - t0
  const { engine } = harness({ config: { broker: 'alpaca-paper' }, deps: { now: () => Date.now() + offset } })
  engine.saveSchedule({ name: 'Paper', days: [2], start: '10:00', end: '11:00', strategy: 'x', everyMinutes: 5, flattenAtEnd: false, enabled: true })
  await engine.tickSchedules()
  await engine.tickSchedules()
  const failed = engine.snapshot().sessions
  assert.equal(failed.length, 1)
  assert.equal(failed[0].status, 'failed')
  assert.match(failed[0].error!, /Add your Alpaca paper keys/)
})

/* ======================================================== protective exits */

test('exits: a stop must be below the price, a target above it, a trail 0.5–50%', () => {
  const now = Date.now()
  assert.match(buildExit({ symbol: 'AAPL', stopPrice: 105 }, 100, undefined, 'agent', null, now) as string, /below the price now/)
  assert.match(buildExit({ symbol: 'AAPL', targetPrice: 95 }, 100, undefined, 'agent', null, now) as string, /above the price now/)
  assert.match(buildExit({ symbol: 'AAPL', trailPct: 80 }, 100, undefined, 'agent', null, now) as string, /between 0.5 and 50/)
  assert.match(buildExit({ symbol: 'AAPL', stopPrice: NaN }, 100, undefined, 'agent', null, now) as string, /isn’t a price/)
  const exit = buildExit({ symbol: 'aapl', stopPrice: 95, targetPrice: 120 }, 100, undefined, 'agent', null, now)
  assert.ok(exit && typeof exit === 'object')
  assert.equal(exit.symbol, 'AAPL')
  assert.equal(exit.activeStop, 95)
  // Undefined keeps, null clears; nothing left set is no exit at all.
  const changed = buildExit({ symbol: 'AAPL', targetPrice: null }, 100, exit, 'agent', null, now) as Exclude<ReturnType<typeof buildExit>, string>
  assert.equal(changed!.stopPrice, 95)
  assert.equal(changed!.targetPrice, null)
  assert.equal(buildExit({ symbol: 'AAPL', stopPrice: null }, 100, changed!, 'agent', null, now), null)
})

test('exits: a trailing stop rises with the price and never falls; the higher stop wins', () => {
  const exit = buildExit({ symbol: 'AAPL', stopPrice: 90, trailPct: 5 }, 100, undefined, 'agent', null, Date.now()) as Exclude<ReturnType<typeof buildExit>, string | null>
  assert.equal(exit.activeStop, 95) // 5% under 100 beats the 90 stop
  assert.equal(exitTrigger(exit, 110), null)
  assert.equal(exit.highWater, 110)
  assert.equal(exit.activeStop, 104.5)
  assert.equal(exitTrigger(exit, 106), null)
  assert.equal(exit.highWater, 110, 'a pullback leaves the high where it was')
  assert.deepEqual(exitTrigger(exit, 104), { kind: 'trail', level: 104.5 })
  assert.equal(activeStop({ stopPrice: 90, trailPct: null, highWater: null }), 90)
  const target = buildExit({ symbol: 'AAPL', targetPrice: 120 }, 100, undefined, 'agent', null, Date.now()) as Exclude<ReturnType<typeof buildExit>, string | null>
  assert.deepEqual(exitTrigger(target, 121), { kind: 'target', level: 120 })
})

test('engine: a buy with a stop is protected; the stop sells it when the price falls, then the exit is gone', async () => {
  const { engine, prices, files } = harness()
  await engine.refresh()
  // A stop above the price is refused before anything is bought.
  const bad = await engine.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 5, stopLoss: 120, reason: 'Bad stop' }, 'agent')
  assert.equal(bad.status, 'rejected')
  assert.match(bad.error!, /below the price now/)
  assert.equal((await engine.refresh()).positions.length, 0)

  const buy = await engine.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 5, stopLoss: 95, takeProfit: 130, reason: 'Breakout' }, 'agent')
  assert.equal(buy.status, 'filled')
  let snap = await engine.refresh()
  assert.equal(snap.positions[0].exit!.stopPrice, 95)
  assert.equal(snap.positions[0].exit!.targetPrice, 130)
  assert.ok((files.exits as Record<string, Record<string, unknown>>).simulator.AAPL, 'saved')

  prices.AAPL = 96 // above the stop: nothing happens
  await engine.refresh()
  await engine.whenIdle()
  assert.equal(engine.snapshot().positions.length, 1)

  prices.AAPL = 94
  await engine.refresh()
  await engine.whenIdle()
  snap = await engine.refresh()
  assert.equal(snap.positions.length, 0, 'sold at the stop')
  const sell = snap.orders.find((o) => o.side === 'sell')!
  assert.equal(sell.status, 'filled')
  assert.equal(sell.source, 'agent')
  assert.match(sell.reason, /^Stop-loss reached: AAPL at \$94\.00, stop \$95\.00/)
  assert.equal(engine.exitsNow().length, 0)
})

test('engine: exits wait for the kill switch, and the desk can set, change and clear them', async () => {
  const { engine, prices } = harness()
  await engine.refresh()
  await engine.placeOrder({ symbol: 'MSFT', side: 'buy', qty: 2, reason: 'x' }, 'user')
  await assert.rejects(engine.setExit({ symbol: 'AAPL', stopPrice: 90 }), /don’t hold any AAPL/)
  await assert.rejects(engine.setExit({ symbol: 'MSFT', stopPrice: 500 }), /below the price now/)
  const exit = await engine.setExit({ symbol: 'MSFT', stopPrice: 380, trailPct: 10 })
  assert.equal(exit!.activeStop, 380) // 10% under 400 is 360; the fixed stop is higher
  assert.equal((await engine.setExit({ symbol: 'MSFT', trailPct: null }))!.trailPct, null)

  await engine.setConfig({ halted: true })
  prices.MSFT = 370
  await engine.refresh()
  await engine.whenIdle()
  assert.equal(engine.snapshot().positions.length, 1, 'halted: nothing is sold')
  assert.equal(engine.snapshot().orders.filter((o) => o.side === 'sell').length, 0)

  await engine.setConfig({ halted: false })
  await engine.refresh()
  await engine.whenIdle()
  const sold = (await engine.refresh()).orders.find((o) => o.side === 'sell')!
  assert.equal(sold.source, 'user', 'an exit the desk set sells as the user')
  assert.equal(engine.snapshot().positions.length, 0)
  assert.equal(await engine.setExit({ symbol: 'MSFT', stopPrice: null }).catch((e: Error) => e.message), 'You don’t hold any MSFT, so there is nothing to protect.')
})

test('engine: an exit whose holding is gone is dropped once its grace period passes', async () => {
  let offset = 0
  const { engine } = harness({ deps: { now: () => Date.now() + offset } })
  await engine.refresh()
  await engine.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 1, reason: 'x' }, 'user')
  await engine.setExit({ symbol: 'AAPL', targetPrice: 200 })
  await engine.placeOrder({ symbol: 'AAPL', side: 'sell', qty: 1, reason: 'sold by hand' }, 'user')
  await engine.refresh()
  await engine.whenIdle()
  assert.equal(engine.exitsNow().length, 1, 'kept for a moment: a holding can lag its order')
  offset = 3 * 60_000
  await engine.refresh()
  await engine.whenIdle()
  assert.equal(engine.exitsNow().length, 0)
})

/* =============================================== the agent's market view */

test('indicators: ATR, MACD momentum, volume against its average and the range', () => {
  // Steady climb of 1 a bar, each bar 2 wide: true range 2, ATR 2.
  const bars = Array.from({ length: 40 }, (_, i) => ({ t: i, o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i, v: i === 39 ? 300 : 100 }))
  assert.equal(atr(bars), 2)
  assert.equal(atr(bars.slice(0, 14)), null)
  const s = indicators(bars)!
  assert.equal(s.atr14, 2)
  assert.equal(s.volumeRatio, 3)
  assert.equal(s.high, 140)
  assert.equal(s.low, 99)
  const m = macdHistogram(bars.map((b) => b.c))!
  assert.ok(m.every(Number.isFinite))
  assert.equal(macdHistogram([1, 2, 3]), null)
  // A rally that rolls over: the histogram turns negative.
  const turn = [...Array.from({ length: 40 }, (_, i) => 100 + i), ...Array.from({ length: 10 }, (_, i) => 139 - i * 3)]
  assert.ok(macdHistogram(turn)![0] < 0)
})

test('news headlines come out of RSS decoded and newest first', () => {
  const xml = `<rss><channel>
    <item><title>Older &amp; wiser</title><pubDate>Wed, 30 Sep 2026 10:00:00 +0000</pubDate><link>https://a</link></item>
    <item><title><![CDATA[Newer: chips <b>up</b>]]></title><pubDate>Thu, 01 Oct 2026 01:00:00 +0000</pubDate><source>Wire</source></item>
    <item><title></title></item>
  </channel></rss>`
  const items = parseRss(xml)
  assert.deepEqual(
    items.map((i) => i.title),
    ['Newer: chips <b>up</b>', 'Older & wiser']
  )
  assert.equal(items[0].publisher, 'Wire')
  assert.equal(items[1].url, 'https://a')
})

test('Yahoo client: the movers screener with relative volume, and news by ticker', async () => {
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x')
    if (url.pathname.startsWith('/screener')) {
      assert.equal(url.searchParams.get('scrIds'), 'day_gainers')
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          finance: {
            result: [
              {
                quotes: [
                  { symbol: 'BIG', shortName: 'Big Co', regularMarketPrice: 50, regularMarketChangePercent: 8.123, regularMarketVolume: 3_000_000, averageDailyVolume3Month: 1_000_000, marketCap: 9e10 },
                  { symbol: 'NOPRICE' }
                ]
              }
            ]
          }
        })
      )
      return
    }
    assert.equal(url.searchParams.get('s'), 'BRK-B')
    res.end('<rss><item><title>Berkshire news</title><pubDate>Thu, 01 Oct 2026 01:00:00 +0000</pubDate></item></rss>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const md = new YahooMarketData({ screenerUrl: `${base}/screener`, newsUrl: `${base}/news` })
    const rows = await md.screen('gainers', 10)
    assert.deepEqual(rows, [{ symbol: 'BIG', name: 'Big Co', price: 50, changePct: 8.12, volume: 3_000_000, relativeVolume: 3, marketCap: 9e10 }])
    const news = await md.news('brk.b')
    assert.equal(news[0].title, 'Berkshire news')
  } finally {
    server.close()
  }
})

test('tickers named in a strategy, without the words that only look like them', () => {
  assert.deepEqual(tickersIn('Buy NVDA and $AMD breakouts above the SMA, cut at 2x ATR. Hold BRK.B; avoid IPO hype in the US.'), ['NVDA', 'AMD', 'BRK.B'])
  assert.deepEqual(tickersIn('swing trade large caps'), [])
})

test('sessions: each check sees the market and its watchlist, practises after hours, and runs at the chosen effort', async () => {
  const requests: StreamRequest[] = []
  const { engine } = harness({
    deps: {
      runAgent: async (request) => {
        requests.push(request)
        return { text: 'Looked; nothing to do.', usage }
      },
      // A model that only takes High and Max: the old code jumped to Max.
      resolveModel: () => ({ ok: true, providerId: 'ollama', modelId: 'fake', model: { id: 'fake', label: 'Fake', providerId: 'ollama', efforts: ['high', 'ultra'] } })
    }
  })
  await engine.refresh()
  await engine.placeOrder({ symbol: 'MSFT', side: 'buy', qty: 1, reason: 'x' }, 'user')
  const session = await engine.startSession({ strategy: 'Trade AAPL momentum, keep MSFT.', until: Date.now() + 2000, everyMinutes: 1 })
  await until(() => requests.length >= 1)
  await engine.stopSession(session.id)
  const first = requests[0]
  assert.equal(first.effort, 'high')
  assert.match(first.persona!, /fills orders even while the market is closed/)
  assert.doesNotMatch(first.persona!, /do nothing and say so/)
  assert.match(first.persona!, /stop_loss/)
  const text = (first.history.at(-1)!.parts[0] as { text: string }).text
  assert.match(text, /Market today: SPY \$500\.00 \(\+0\.50%\); SPY since the session began 0\.00%\./)
  assert.match(text, /Watchlist: AAPL \$100\.00/)
  assert.doesNotMatch(text, /Watchlist:.*MSFT/, 'a holding is already listed')
  assert.match(text, /- MSFT: 1 @ .* · NO STOP SET/)
  // Sized right the first time: the cap that binds, and what 1% risk is.
  assert.match(text, /Buying room: the next buy can be at most \$2,000\.00 \(per order \$2,000\.00; .* 1% of equity, the usual risk per trade, is \$1,000\.00\./)
  const ended = engine.snapshot().sessions.find((s) => s.id === session.id)!
  assert.equal(ended.benchmark!.symbol, 'SPY')
  assert.match(ended.summary!, /SPY moved 0\.00% over the same time\./)
})

test('a trading check gets guidance only from the tools it is offered', () => {
  const fake: AgentTool = { name: 'fake_browser', description: 'x', inputSchema: { type: 'object', properties: {} }, mutating: false, run: async () => 'x' }
  registerToolSource({ id: 'zz-guidance-test', tools: () => [fake], guidance: () => 'FAKE BROWSER GUIDANCE' })
  try {
    const query = { mode: 'work', cwd: null, depth: 0, readOnly: false, settings: store.getSettings(), request: { chatId: 'trading:x' } } as unknown as ToolQuery
    assert.ok(guidanceFor(query).includes('FAKE BROWSER GUIDANCE'), 'a normal run gets it')
    assert.ok(!guidanceFor(query, isSessionTool).includes('FAKE BROWSER GUIDANCE'), 'a trading check does not')
  } finally {
    registerToolSource({ id: 'zz-guidance-test', tools: () => [] })
  }
})

