import { tradingEngine } from '@main/features/trading'
import { tradingToolSource } from '@main/features/trading/tools'
import { store } from '@main/store'
import { ipc } from '../runtime/ipc'

/**
 * `trading:research`: the trading agent's own read-only tools — the account,
 * quotes, history with indicators, the movers screen, headlines — run by
 * name for another agent, so Claude Code researches with exactly what
 * Eaon's agent uses and its steps read the same in the desk's feed. Served
 * by the session that runs the engines; the bus carries it to `eaon mcp`.
 */

const READS = new Set(['trading_account', 'trading_quote', 'trading_history', 'trading_scan', 'trading_news'])

export function serveTradingResearch(): void {
  ipc.handle('trading:research', async (_event, name: unknown, input: unknown) => {
    const engine = tradingEngine()
    if (!engine) throw new Error('The trading engine isn’t running in this session.')
    if (!READS.has(String(name))) throw new Error(`${String(name)} isn’t one of the research tools.`)
    const tool = tradingToolSource(engine)
      .tools({ mode: 'work', cwd: null, depth: 0, readOnly: true, settings: store.getSettings(), request: {} as never })
      .find((t) => t.name === name)
    if (!tool) throw new Error(`${String(name)} isn’t available.`)
    const result = await tool.run((input ?? {}) as Record<string, unknown>, { request: { chatId: 'claude-code' } } as never)
    return typeof result === 'string' ? result : result.text
  })
}
