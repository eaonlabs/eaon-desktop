import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { store } from '../src/main/store'
import { defaultConfig, TradingEngine, type TradingDeps } from '../src/main/features/trading/engine'
import { TradierBroker } from '../src/main/features/trading/tradier'
import { orderArgs, parseAnswer, RobinhoodError, type McpLink, type McpToolInfo } from '../src/main/features/trading/robinhood'
import type { AlpacaKeys } from '../src/main/features/trading/brokers'
import type { PriceFeed } from '../src/main/features/trading/marketData'
import { isRealMoney, LIVE_CONFIRMATION, type Quote, type TradingConfig } from '@shared/trading'

/**
 * The brokers beyond Alpaca: Tradier over its REST API (against a fake
 * server) and Robinhood's Agentic account over its MCP server (against a
 * fake MCP link), each driven through the engine, so the limits, the
 * ledger and real-money confirmation are the same as for Alpaca.
 */

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }
const engines: TradingEngine[] = []
const closers: (() => void)[] = []

afterEach(async () => {
  for (const close of closers.splice(0)) close()
  for (const engine of engines.splice(0)) {
    engine.stop()
    await engine.whenIdle()
  }
  await store.flushWrites()
})

const prices: Record<string, number> = { AAPL: 100, NVDA: 200, SPY: 500 }
const feed: PriceFeed = {
  source: 'test prices',
  quote: async (symbol: string): Promise<Quote> => {
    const s = symbol.toUpperCase()
    if (!(s in prices)) throw new Error(`Couldn’t find a stock called ${s}.`)
    return { symbol: s, name: null, price: prices[s], change: 0, changePct: 1, prevClose: prices[s], dayHigh: null, dayLow: null, volume: null, currency: 'USD', at: Date.now() }
  },
  bars: async () => []
}

function engineWith(deps: Partial<TradingDeps>, config: Partial<TradingConfig> = {}): TradingEngine {
  const files: Record<string, unknown> = { config: { ...defaultConfig(), ...config } }
  const keys: Record<string, AlpacaKeys | null> = {}
  const save = (name: string) => (value: unknown) => {
    files[name] = structuredClone(value)
  }
  const engine = new TradingEngine({
    prices: feed,
    runAgent: async () => ({ text: 'x', usage }),
    getSettings: () => store.getSettings(),
    getKeys: (kind) => keys[kind] ?? null,
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
    scheduleTickMs: 60_000,
    ...deps
  })
  engine.load()
  engines.push(engine)
  return engine
}

/* ------------------------------------------------------------------ Tradier */

/** Tradier's API as far as Eaon uses it: one account, market orders fill at once, whole shares. */
async function fakeTradier(token: string): Promise<{ url: string; forms: Record<string, string>[] }> {
  const forms: Record<string, string>[] = []
  let cash = 10_000
  const held: Record<string, { qty: number; cost: number }> = {}
  const orders: Record<string, unknown>[] = []
  const reply = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers.authorization !== `Bearer ${token}`) return reply(res, 401, { fault: 'Invalid Access Token' })
    const path = (req.url ?? '').split('?')[0]
    if (path === '/user/profile') return reply(res, 200, { profile: { id: 'u1', account: { account_number: 'VA1', status: 'active' } } })
    if (path === '/accounts/VA1/balances') {
      const value = Object.entries(held).reduce((sum, [s, p]) => sum + p.qty * prices[s], 0)
      return reply(res, 200, { balances: { total_equity: cash + value, total_cash: cash, account_type: 'cash', cash: { cash_available: cash } } })
    }
    if (path === '/accounts/VA1/positions') {
      const list = Object.entries(held).map(([symbol, p]) => ({ symbol, quantity: p.qty, cost_basis: p.cost }))
      return reply(res, 200, { positions: list.length === 0 ? 'null' : list.length === 1 ? { position: list[0] } : { position: list } })
    }
    if (path === '/accounts/VA1/orders' && req.method === 'GET') return reply(res, 200, { orders: orders.length ? { order: orders } : 'null' })
    if (path === '/accounts/VA1/orders' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      const form = Object.fromEntries(new URLSearchParams(body))
      forms.push(form)
      const qty = Number(form.quantity)
      const price = prices[form.symbol]
      const id = String(orders.length + 1)
      const filled = form.type === 'market'
      if (filled) {
        const p = (held[form.symbol] ??= { qty: 0, cost: 0 })
        if (form.side === 'buy') {
          p.qty += qty
          p.cost += qty * price
          cash -= qty * price
        } else {
          p.cost -= (p.cost / p.qty) * qty
          p.qty -= qty
          cash += qty * price
          if (p.qty === 0) delete held[form.symbol]
        }
      }
      orders.push({ id: Number(id), type: form.type, symbol: form.symbol, side: form.side, quantity: qty, status: filled ? 'filled' : 'open', price: form.price ? Number(form.price) : undefined, avg_fill_price: filled ? price : 0, exec_quantity: filled ? qty : 0, create_date: new Date().toISOString(), transaction_date: new Date().toISOString(), class: 'equity', tag: form.tag })
      return reply(res, 200, { order: { id: Number(id), status: 'ok' } })
    }
    const one = /^\/accounts\/VA1\/orders\/(\d+)$/.exec(path)
    if (one && req.method === 'GET') return reply(res, 200, { order: orders.find((o) => String(o.id) === one[1]) })
    if (one && req.method === 'DELETE') {
      const order = orders.find((o) => String(o.id) === one[1])
      if (order) order.status = 'canceled'
      return reply(res, 200, { order: { id: Number(one[1]), status: 'ok' } })
    }
    reply(res, 404, {})
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => server.close())
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, forms }
}

test('Tradier: a token links the sandbox; dollar orders become whole shares, tagged with Eaon’s id; holdings are priced from the feed', async () => {
  const { url, forms } = await fakeTradier('sandbox-token')
  const engine = engineWith({ createTradier: (kind, keys) => new TradierBroker({ kind, keys, prices: feed, baseUrl: url }) }, { simulatorAnytime: true })
  await assert.rejects(engine.setKeys('tradier-paper', '', 'wrong-token'), /refused this access token/)
  const linked = await engine.setKeys('tradier-paper', '', 'sandbox-token')
  assert.equal(linked.linked?.['tradier-paper'], true)
  assert.equal(linked.linked?.['tradier-live'], false)
  await engine.setConfig({ broker: 'tradier-paper' })
  assert.equal(engine.snapshot().account?.equity, 10_000)

  const order = await engine.placeOrder({ symbol: 'AAPL', side: 'buy', notional: 250, reason: 'Two shares' }, 'user')
  assert.equal(order.status, 'filled')
  assert.equal(order.filledQty, 2, '$250 of a $100 stock is two whole shares')
  assert.equal(forms[0].quantity, '2')
  assert.equal(forms[0].class, 'equity')
  assert.match(forms[0].tag, /^eaon-/)
  await engine.refresh()
  const snap = engine.snapshot()
  assert.equal(snap.positions[0].symbol, 'AAPL')
  assert.equal(snap.positions[0].qty, 2)
  assert.equal(snap.orders[0].reason, 'Two shares', 'the ledger keeps the reason through the tag')

  const fraction = await engine.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 0.5, reason: 'half' }, 'user')
  assert.equal(fraction.status, 'rejected')
  assert.match(fraction.error ?? '', /whole shares only/)
  const tiny = await engine.placeOrder({ symbol: 'NVDA', side: 'buy', notional: 50, reason: 'too little' }, 'user')
  assert.match(tiny.error ?? '', /doesn’t buy one share/)
})

test('real money: Tradier live and Robinhood need the typed confirmation, like Alpaca live', async () => {
  assert.equal(isRealMoney('tradier-live'), true)
  assert.equal(isRealMoney('robinhood'), true)
  assert.equal(isRealMoney('tradier-paper'), false)
  const { url } = await fakeTradier('live-token')
  const engine = engineWith({ createTradier: (kind, keys) => new TradierBroker({ kind, keys, prices: feed, baseUrl: url }) })
  await engine.setKeys('tradier-live', '', 'live-token')
  await engine.setConfig({ broker: 'tradier-live' })
  const refused = await engine.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 1, reason: 'x' }, 'user')
  assert.equal(refused.status, 'rejected')
  assert.match(refused.error ?? '', /Real-money trading isn’t confirmed yet.*Tradier live/)
  engine.confirmLive(LIVE_CONFIRMATION)
  assert.equal((await engine.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 1, reason: 'x' }, 'user')).status, 'filled')
})

/* ---------------------------------------------------------------- Robinhood */

const placeSchema = {
  type: 'object',
  properties: {
    account_number: { type: 'string' },
    symbol: { type: 'string' },
    side: { type: 'string', enum: ['buy', 'sell'] },
    quantity: { type: 'string' },
    dollar_amount: { type: 'number' },
    type: { type: 'string', enum: ['market', 'limit'] },
    limit_price: { type: 'number' },
    time_in_force: { type: 'string', enum: ['gfd', 'gtc'] },
    ref_id: { type: 'string', format: 'uuid' }
  },
  required: ['account_number', 'symbol', 'side', 'type']
}

/** Robinhood's MCP tools as far as Eaon uses them, answering JSON text the way MCP tools do. */
function fakeRobinhood(): { link: McpLink; calls: { name: string; args: Record<string, unknown> }[]; setState: (s: ReturnType<McpLink['state']>) => void } {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  let state: ReturnType<McpLink['state']> = 'missing'
  let cash = 500
  const held: Record<string, { quantity: string; average_buy_price: string }> = {}
  const orders: Record<string, unknown>[] = []
  const tool = (name: string, properties: Record<string, unknown> = {}, required: string[] = []): McpToolInfo => ({ name, description: name, inputSchema: { type: 'object', properties, required } })
  const tools: McpToolInfo[] = [
    tool('get_accounts'),
    tool('get_portfolio', { account_number: { type: 'string' } }),
    tool('get_equity_positions', { account_number: { type: 'string' } }),
    tool('get_equity_orders', { account_number: { type: 'string' } }),
    { name: 'place_equity_order', description: 'Places a real-money order', inputSchema: placeSchema },
    tool('cancel_equity_order', { order_id: { type: 'string' } }, ['order_id'])
  ]
  const link: McpLink = {
    state: () => state,
    tools: () => (state === 'ready' ? tools : []),
    call: async (name, args) => {
      calls.push({ name, args })
      const json = (value: unknown) => ({ text: JSON.stringify(value) })
      switch (name) {
        case 'get_accounts':
          return json({ accounts: [{ account_number: '5RH-MAIN', type: 'individual' }, { account_number: '5RH-AGENT', type: 'agentic', nickname: 'Agentic' }] })
        case 'get_portfolio': {
          const value = Object.entries(held).reduce((sum, [s, p]) => sum + Number(p.quantity) * prices[s], 0)
          return json({ portfolio: { equity: String(cash + value), cash: String(cash), buying_power: String(cash) } })
        }
        case 'get_equity_positions':
          return json({ results: Object.entries(held).map(([symbol, p]) => ({ symbol, ...p })) })
        case 'get_equity_orders':
          return json({ results: orders })
        case 'place_equity_order': {
          if (args.account_number !== '5RH-AGENT') return { text: 'Orders may only be placed in the Agentic account.', isError: true }
          const qty = args.quantity !== undefined ? Number(args.quantity) : Math.floor((Number(args.dollar_amount) / prices[String(args.symbol)]) * 10_000) / 10_000
          const price = prices[String(args.symbol)]
          cash -= qty * price
          held[String(args.symbol)] = { quantity: String(qty), average_buy_price: String(price) }
          const order = { id: `rh-${orders.length + 1}`, symbol: args.symbol, side: args.side, quantity: String(qty), type: args.type, state: 'filled', average_price: String(price), cumulative_quantity: String(qty), created_at: new Date().toISOString(), ref_id: args.ref_id }
          orders.unshift(order)
          return json({ order })
        }
        default:
          return { text: `Unknown tool ${name}`, isError: true }
      }
    }
  }
  return { link, calls, setState: (s) => (state = s) }
}

test('Robinhood: not linked until signed in; then the Agentic account is read and traded through Eaon’s limits', async () => {
  const rh = fakeRobinhood()
  const engine = engineWith({ robinhood: rh.link }, { simulatorAnytime: true, limits: { ...defaultConfig().limits, maxPositionPct: 50 } })
  assert.equal(engine.snapshot().linked?.robinhood, false)
  await engine.setConfig({ broker: 'robinhood' })
  assert.match(engine.snapshot().error ?? '', /sign in from the account picker/)

  rh.setState('ready')
  await engine.refresh()
  const snap = engine.snapshot()
  assert.equal(snap.linked?.robinhood, true)
  assert.equal(snap.account?.equity, 500)
  assert.ok(rh.calls.some((c) => c.name === 'get_portfolio' && c.args.account_number === '5RH-AGENT'), 'the Agentic account, not the main one')

  // Real money: nothing until the user types the confirmation.
  assert.match((await engine.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 1, reason: 'x' }, 'user')).error ?? '', /Real-money trading isn’t confirmed/)
  engine.confirmLive(LIVE_CONFIRMATION)
  // The limits stand in front: at most 50% of the $500 account in one stock.
  const big = await engine.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 3, reason: 'too much of one stock' }, 'user')
  assert.equal(big.status, 'rejected')
  assert.equal(rh.calls.filter((c) => c.name === 'place_equity_order').length, 0, 'a refused order never reaches Robinhood')

  const order = await engine.placeOrder({ symbol: 'AAPL', side: 'buy', qty: 1, reason: 'A starter position' }, 'agent')
  assert.equal(order.status, 'filled')
  const placed = rh.calls.find((c) => c.name === 'place_equity_order')!.args
  assert.deepEqual({ ...placed, ref_id: undefined }, { account_number: '5RH-AGENT', symbol: 'AAPL', side: 'buy', quantity: '1', type: 'market', time_in_force: 'gfd', ref_id: undefined })
  assert.match(String(placed.ref_id), /^[0-9a-f-]{36}$/, 'the uuid of Eaon’s id, as an idempotency key')
  await engine.refresh()
  const after = engine.snapshot()
  assert.equal(after.positions[0]?.symbol, 'AAPL')
  assert.equal(after.orders[0].reason, 'A starter position', 'the ledger matches Robinhood’s order back by its ref_id')
  assert.equal(after.orders[0].source, 'agent')
})

test('Robinhood order arguments come from the tool’s schema; anything required Eaon can’t fill stops the order', () => {
  const order = { symbol: 'NVDA', side: 'sell' as const, type: 'limit' as const, qty: 2, limitPrice: 210, clientOrderId: 'eaon-123e4567-e89b-12d3-a456-426614174000' }
  const schema = { properties: placeSchema.properties as never, required: placeSchema.required }
  assert.deepEqual(orderArgs(schema, order, '5RH-AGENT'), {
    symbol: 'NVDA',
    side: 'sell',
    quantity: '2',
    type: 'limit',
    limit_price: 210,
    time_in_force: 'gfd',
    account_number: '5RH-AGENT',
    ref_id: '123e4567-e89b-12d3-a456-426614174000'
  })
  assert.throws(() => orderArgs({ properties: { ...schema.properties, trading_password: { type: 'string' } }, required: [...schema.required, 'trading_password'] }, order, '5RH-AGENT'), (e: unknown) => e instanceof RobinhoodError && /needs trading_password/.test(e.message))
  assert.throws(() => orderArgs({ properties: { ...schema.properties, type: { type: 'string', enum: ['market'] } }, required: schema.required }, order, null), /doesn’t take limit/)
  assert.deepEqual(parseAnswer('Here is the order:\n{"id": "x", "state": "filled"}\nDone.'), { id: 'x', state: 'filled' })
})
