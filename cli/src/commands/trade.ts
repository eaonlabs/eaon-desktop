import type { OrderRequest, TradingOrder, TradingSnapshot } from '@shared/trading'
import { BusNode, claimEngines, releaseEngines } from '../bus/bus'
import { boot, shutdown, startEngines } from '../runtime/boot'
import { invoke } from '../runtime/ipc'

/**
 * `eaon order …` and `eaon session …`: trading from a plain shell.
 *
 * The order goes to whichever process runs the engines: an open eaon
 * (over the bus), or, when none is open, an engine started just for this
 * command — so the same limits, ledger and simulator apply either way.
 */

type Call = <T>(channel: string, ...args: unknown[]) => Promise<T>

async function withTrading<T>(work: (call: Call) => Promise<T>): Promise<T> {
  const bus = await new BusNode({ kind: 'eaon', name: 'eaon-shell', mode: 'cmd' }).open()
  try {
    if (bus.owner()) return await work(<R>(channel: string, ...args: unknown[]) => bus.invokeOwner<R>(channel, args))
    if (!claimEngines(bus.self.id)) throw new Error('Another session is starting the engines; try again in a moment.')
    try {
      await boot({ engines: false, mcp: false })
      await startEngines()
      return await work(<R>(channel: string, ...args: unknown[]) => invoke<R>(channel, ...args))
    } finally {
      await shutdown()
      releaseEngines()
    }
  } finally {
    await bus.close()
  }
}

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}

const USAGE = `Usage: eaon order <buy|sell> <shares | $dollars> <SYMBOL> [--limit <price>]
                 [--stop <price>] [--target <price>] [--trail <pct>] [--reason "<why>"]
       eaon order cancel <order id>
       eaon order close <SYMBOL>`

export async function runOrderCommand(args: string[]): Promise<number> {
  const [action, size, rawSymbol] = args
  if (action === 'cancel' && size) {
    return withTrading(async (call) => {
      await call<TradingSnapshot>('trading:cancel-order', size)
      console.log(`Cancelled ${size}.`)
      return 0
    })
  }
  if (action === 'close' && size) {
    return withTrading(async (call) => {
      const order = await call<TradingOrder>('trading:close-position', size.toUpperCase())
      console.log(order.status === 'rejected' ? `Refused: ${order.error}` : `Selling all ${order.symbol}: ${order.status}`)
      return order.status === 'rejected' ? 1 : 0
    })
  }
  if ((action !== 'buy' && action !== 'sell') || !size || !rawSymbol) {
    console.error(USAGE)
    return 2
  }
  const dollars = size.startsWith('$')
  const amount = Number(size.replace(/[$,]/g, ''))
  if (!Number.isFinite(amount) || amount <= 0) {
    console.error(`“${size}” isn’t a number of shares or dollars.`)
    return 2
  }
  const number = (name: string): number | undefined => {
    const value = option(args, name)
    return value === undefined ? undefined : Number(value)
  }
  const limit = number('limit')
  const request: OrderRequest = {
    symbol: rawSymbol.toUpperCase(),
    side: action,
    ...(dollars ? { notional: amount } : { qty: amount }),
    type: limit !== undefined ? 'limit' : 'market',
    ...(limit !== undefined ? { limitPrice: limit } : {}),
    ...(number('stop') !== undefined ? { stopLoss: number('stop') } : {}),
    ...(number('target') !== undefined ? { takeProfit: number('target') } : {}),
    ...(number('trail') !== undefined ? { trailPct: number('trail') } : {}),
    reason: option(args, 'reason') ?? 'Placed from the command line'
  }
  return withTrading(async (call) => {
    const order = await call<TradingOrder>('trading:place-order', request)
    if (order.status === 'rejected') {
      console.log(`Refused: ${order.error}`)
      return 1
    }
    const fill = order.filledAvgPrice ? ` at ${order.filledAvgPrice.toFixed(2)}` : ''
    console.log(`${order.side === 'buy' ? 'Buy' : 'Sell'} ${order.filledQty || order.qty} ${order.symbol}: ${order.status}${fill} (${order.id})`)
    return 0
  })
}
