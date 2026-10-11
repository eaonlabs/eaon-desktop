import { tradingEngine } from '@main/features/trading'
import { runResearchTool } from '@main/features/trading/claudeTrader'
import { store } from '@main/store'
import { ipc } from '../runtime/ipc'

/**
 * `trading:research`: the trading agent's own read-only tools — the account,
 * quotes, history with indicators, the movers screen, headlines — run by
 * name for another agent, so Claude Code researches with exactly what
 * Eaon's agent uses and its steps read the same in the desk's feed. Served
 * by the session that runs the engines; the bus carries it to `eaon mcp`.
 */

export function serveTradingResearch(): void {
  ipc.handle('trading:research', async (_event, name: unknown, input: unknown) => {
    const engine = tradingEngine()
    if (!engine) throw new Error('The trading engine isn’t running in this session.')
    return runResearchTool(engine, store.getSettings(), String(name), (input ?? {}) as Record<string, unknown>)
  })
}
