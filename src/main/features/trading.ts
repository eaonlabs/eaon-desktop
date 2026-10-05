import type { BarRange, ExitRequest, OrderRequest, StartSessionRequest, TradingScheduleDraft } from '@shared/trading'
import type { StreamEvent } from '@shared/types'
import { runAgent } from '../agent/loop'
import { withUsageSource } from './usage/attribution'
import { registerToolSource } from '../agent/tools'
import { secrets } from '../secrets'
import { store } from '../store'
import { TradingEngine, type KeyKind, type TradingConfigPatch } from './trading/engine'
import { YahooMarketData } from './trading/marketData'
import { setTradingHalted } from './trading/access'
import { tradingToolSource } from './trading/tools'
import type { Feature } from './types'

/**
 * Agentic trading: the agent trades US stocks for the user, inside limits the
 * user sets, on the simulator, Alpaca paper or Alpaca live. The engine
 * (`trading/engine.ts`) owns all of it; this wires it to the app — the store
 * files, the secrets vault, the agent loop, IPC and the tool registry.
 *
 * Alpaca keys live in the vault as `trading:alpaca-<paper|live>:<key|secret>`
 * and never reach the renderer, which only learns whether they are saved.
 */

const FILES = {
  config: 'trading-config.json',
  orders: 'trading-orders.json',
  equity: 'trading-equity.json',
  schedules: 'trading-schedules.json',
  sessions: 'trading-sessions.json',
  sim: 'trading-sim.json',
  exits: 'trading-exits.json'
}
/** Lets the window load first; nothing here is needed to paint it. */
const START_DELAY_MS = 5000
/** At most two pushes a second: a busy session changes something many times a second. */
const PUSH_EVERY_MS = 500

const vaultName = (kind: KeyKind, part: 'key' | 'secret'): string => `trading:alpaca-${kind}:${part}`

let engine: TradingEngine | null = null
let startTimer: ReturnType<typeof setTimeout> | null = null
let stopPushes: (() => void) | null = null

/** The running engine, for other features (and tests); null before registration. */
export function tradingEngine(): TradingEngine | null {
  return engine
}

/** Calls `fn` at most once per `ms`, always delivering the latest change (trailing edge). */
function throttle(fn: () => void, ms: number): { call: () => void; cancel: () => void } {
  let last = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    call() {
      if (timer) return
      timer = setTimeout(
        () => {
          timer = null
          last = Date.now()
          fn()
        },
        Math.max(0, last + ms - Date.now())
      )
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
}

/** Orders and sessions wait for the trading disclaimer. The CLI turns this on before the engine starts; the desktop doesn't. */
let disclaimerRequired = false
export function requireTradingDisclaimer(): void {
  disclaimerRequired = true
}

/** Listeners for the session agent's stream events (the CLI's desk shows each step). The desktop has none. */
const agentListeners = new Set<(sessionId: string, event: StreamEvent) => void>()
export function onTradingAgentEvent(fn: (sessionId: string, event: StreamEvent) => void): () => void {
  agentListeners.add(fn)
  return () => agentListeners.delete(fn)
}

export const tradingFeature: Feature = {
  id: 'trading',
  register: (ctx) => {
    const push = throttle(() => {
      if (engine) ctx.send('trading:changed', engine.snapshot())
    }, PUSH_EVERY_MS)
    stopPushes = push.cancel

    const trading = new TradingEngine({
      prices: new YahooMarketData(),
      // Counted under Trading in Settings → Usage.
      runAgent: (request, emit, options) => withUsageSource('trading', () => runAgent(request, emit, options)),
      getSettings: () => store.getSettings(),
      getKeys: (kind) => {
        const keyId = secrets.get(vaultName(kind, 'key'))
        const secret = secrets.get(vaultName(kind, 'secret'))
        return keyId && secret ? { keyId, secret } : null
      },
      saveKeys: (kind, keys) => {
        // An empty value deletes the entry.
        secrets.set(vaultName(kind, 'key'), keys?.keyId ?? '')
        secrets.set(vaultName(kind, 'secret'), keys?.secret ?? '')
      },
      loadConfig: () => store.getJson<unknown>(FILES.config, null),
      saveConfig: (config) => store.setJson(FILES.config, config),
      loadOrders: () => store.getJson<unknown>(FILES.orders, []),
      // The ledger, the curve and the session logs grow; write them off the main thread.
      saveOrders: (orders) => store.setJsonAsync(FILES.orders, orders),
      loadEquity: () => store.getJson<unknown>(FILES.equity, {}),
      saveEquity: (equity) => store.setJsonAsync(FILES.equity, equity),
      loadSchedules: () => store.getJson<unknown>(FILES.schedules, []),
      saveSchedules: (schedules) => store.setJson(FILES.schedules, schedules),
      loadSessions: () => store.getJson<unknown>(FILES.sessions, []),
      saveSessions: (sessions) => store.setJsonAsync(FILES.sessions, sessions),
      loadSim: () => store.getJson<unknown>(FILES.sim, null),
      saveSim: (state) => store.setJsonAsync(FILES.sim, state),
      loadExits: () => store.getJson<unknown>(FILES.exits, {}),
      saveExits: (exits) => store.setJson(FILES.exits, exits),
      onChange: push.call,
      onAgentEvent: (sessionId, event) => {
        for (const fn of agentListeners) fn(sessionId, event)
      },
      requireDisclaimer: () => disclaimerRequired
    })
    engine = trading
    trading.load()
    registerToolSource(tradingToolSource(trading))
    setTradingHalted(() => trading.getConfig().halted)

    const { ipcMain } = ctx
    ipcMain.handle('trading:snapshot', () => {
      trading.touch()
      return trading.snapshot()
    })
    ipcMain.handle('trading:refresh', () => {
      trading.touch()
      return trading.refresh()
    })
    ipcMain.handle('trading:set-config', (_e, patch: TradingConfigPatch) => trading.setConfig(patch ?? {}))
    ipcMain.handle('trading:set-keys', (_e, kind: KeyKind, keyId: string, secret: string) => trading.setKeys(kind, String(keyId ?? ''), String(secret ?? '')))
    ipcMain.handle('trading:clear-keys', (_e, kind: KeyKind) => trading.clearKeys(kind))
    ipcMain.handle('trading:confirm-live', (_e, phrase: string) => trading.confirmLive(String(phrase ?? '')))
    ipcMain.handle('trading:place-order', (_e, request: OrderRequest) => trading.placeOrder(request ?? ({} as OrderRequest), 'user'))
    ipcMain.handle('trading:cancel-order', (_e, id: string) => trading.cancelOrder(String(id ?? '')))
    ipcMain.handle('trading:close-position', (_e, symbol: string) => trading.closePosition(String(symbol ?? '')))
    ipcMain.handle('trading:set-exit', async (_e, request: ExitRequest) => {
      await trading.setExit(request, 'user')
      return trading.snapshot()
    })
    ipcMain.handle('trading:reset-simulator', (_e, cash?: number) => trading.resetSimulator(cash ?? undefined))
    ipcMain.handle('trading:quote', (_e, symbol: string) => trading.quote(String(symbol ?? '')))
    ipcMain.handle('trading:bars', (_e, symbol: string, range: BarRange) => trading.bars(String(symbol ?? ''), range))
    ipcMain.handle('trading:save-schedule', (_e, draft: TradingScheduleDraft) => trading.saveSchedule(draft ?? ({} as TradingScheduleDraft)))
    ipcMain.handle('trading:remove-schedule', (_e, id: string) => trading.removeSchedule(String(id ?? '')))
    ipcMain.handle('trading:start-session', (_e, request: StartSessionRequest) => trading.startSession(request ?? ({} as StartSessionRequest)))
    ipcMain.handle('trading:stop-session', (_e, id: string) => trading.stopSession(String(id ?? '')))
    ipcMain.handle('trading:check-now', (_e, id: string) => trading.checkNow(String(id ?? '')))
    ipcMain.handle('trading:tell-session', (_e, id: string, text: string) => trading.tellSession(String(id ?? ''), String(text ?? '')))
    // A session Claude Code runs, through Eaon's MCP server: its checks, decisions, orders and the steps the feed shows.
    ipcMain.handle('trading:wait-check', (_e, id: string, maxWaitMs?: number) => trading.waitForCheck(String(id ?? ''), Number(maxWaitMs) || undefined))
    ipcMain.handle('trading:wait-session', (_e, maxWaitMs?: number) => trading.waitForSession(Number(maxWaitMs) || undefined))
    ipcMain.handle('trading:log-decision', (_e, id: string, text: string) => trading.logDecision(String(id ?? ''), String(text ?? '')))
    ipcMain.handle('trading:session-order', (_e, id: string, request: OrderRequest) => trading.sessionOrder(String(id ?? ''), request ?? ({} as OrderRequest)))
    ipcMain.handle('trading:external-tool', (_e, name: string, input: Record<string, unknown>, output: string, ok: boolean) =>
      trading.recordExternalTool(String(name ?? ''), input ?? {}, String(output ?? ''), ok !== false)
    )
    ipcMain.handle('trading:accept-disclaimer', (_e, version: number) => trading.acceptDisclaimer(Number(version)))
    // Not in the original list: lets the desk say it is on screen, for 30-second refreshes.
    ipcMain.handle('trading:desk-open', (_e, open: boolean) => trading.setDeskOpen(open === true))

    startTimer = setTimeout(() => {
      startTimer = null
      trading.start()
    }, START_DELAY_MS)
    startTimer.unref?.()
  },
  shutdown: async () => {
    if (startTimer) clearTimeout(startTimer)
    startTimer = null
    stopPushes?.()
    // Synchronous: a running check is aborted and recorded as interrupted before the store flushes.
    engine?.stop()
  }
}
