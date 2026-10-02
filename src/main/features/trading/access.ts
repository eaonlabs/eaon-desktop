import { mcpCatalogEntry } from '@shared/mcpCatalog'
import type { McpTool } from '@shared/types'
import type { WorkerTrading } from '@shared/workers'
import { store } from '../../store'

/**
 * Who may trade where, for the tools that place orders outside a trading
 * session: the trading desk's own tools and broker plugins (Robinhood,
 * Tradier…). The workers feature says which worker is set up to trade and
 * how freely; the trading feature says whether the kill switch is on. Both
 * register here so the agent's tools can ask without importing either.
 */

/** Where a trading worker trades, described for its prompt. */
export interface TradingVenue {
  kind: 'desk' | 'plugin'
  /** "Simulator", "Alpaca live", "Robinhood". */
  label: string
  realMoney: boolean
  /** What a broker plugin really does (drafts only, confirm in its app…), from the catalog. */
  note: string | null
  /** Plugin tools are named `<prefix>__<tool>`; null for the desk. */
  toolPrefix: string | null
  /** False when the broker plugin is missing, off or signed out. */
  connected: boolean
}

let workerTrading: (workerId: string) => WorkerTrading | null = () => null
let halted: () => boolean = () => false

export function setWorkerTradingLookup(lookup: (workerId: string) => WorkerTrading | null): void {
  workerTrading = lookup
}

export function setTradingHalted(check: () => boolean): void {
  halted = check
}

/** The kill switch on the trading desk ("Stop all trading"). It stops broker plugins' orders too. */
export function tradingHalted(): boolean {
  try {
    return halted()
  } catch {
    return false
  }
}

/** The trading set-up of the worker behind a chat id (`worker:<id>`), or null for anything else. */
export function tradingFor(chatId: string): WorkerTrading | null {
  const match = /^worker:(.+)$/.exec(chatId)
  if (!match) return null
  try {
    return workerTrading(match[1])
  } catch {
    return null
  }
}

/**
 * A plugin server that is a broker: a catalog broker, or any server the user
 * picked as a worker's trading account. `realMoney` is false only for a
 * catalog practice account (Tradier paper); a hand-added broker is assumed
 * real.
 */
export function brokerOf(serverId: string, chatId?: string): { realMoney: boolean } | null {
  const server = store.getMcpServers().find((s) => s.id === serverId)
  const entry = server?.pluginId ? mcpCatalogEntry(server.pluginId) : undefined
  if (entry?.category === 'trading') return { realMoney: entry.realMoney !== false }
  if (chatId && tradingFor(chatId)?.via === serverId) return { realMoney: true }
  return null
}

/**
 * Whether a plugin tool changes something at the broker. The server's own
 * read-only hint decides when it gives one; many broker servers (Tradier,
 * for one) annotate nothing, so a tool named like a lookup counts as a read
 * and everything else — orders, cancels, transfers — as a write.
 */
export function writesToBroker(tool: Pick<McpTool, 'name' | 'readOnly'>): boolean {
  if (tool.readOnly) return false
  return !/^(get|list|search|find|fetch|read|describe|lookup|look_up|quote|preview|check|validate|estimate|calculate|show|view)(_|$)|_(get|list|quote|quotes|history|status|info|details|search|lookup|preview|chain|positions|balances|profile)$/i.test(
    tool.name
  )
}

/**
 * Whether a broker plugin's write must wait for the user: always where the
 * worker was set up to ask first, never where it was set up to place orders
 * on its own, and otherwise whenever real money moves — in a chat that means
 * the approval prompt even under "Approve for me"; for a worker, Approve once.
 */
export function brokerWriteNeedsUser(tool: Pick<McpTool, 'name' | 'readOnly' | 'serverId'>, chatId: string): boolean {
  if (!writesToBroker(tool)) return false
  const broker = brokerOf(tool.serverId, chatId)
  if (!broker) return false
  const plan = tradingFor(chatId)
  if (plan && plan.via === tool.serverId) return !plan.autoPlace
  return broker.realMoney
}
