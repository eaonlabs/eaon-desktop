import { ipcRenderer } from 'electron'
import type {
  Bar,
  BarRange,
  ClaudeTradingLaunch,
  ExitRequest,
  OrderRequest,
  Quote,
  StartSessionRequest,
  TradingConfig,
  TradingOrder,
  TradingSchedule,
  TradingScheduleDraft,
  TradingSession,
  TradingSnapshot,
  TradingStep
} from '@shared/trading'

/**
 * Renderer bridge for agentic trading. Exposed as `window.api.trading`. Main
 * owns the accounts, orders and sessions; the desk shows snapshots and sends
 * commands. Alpaca keys go in and never come back out — a snapshot only says
 * whether they are saved. Calls that fail reject with a sentence for the
 * user. Keep every channel this feature uses in this file.
 */

function subscribe<T>(channel: string, handler: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

type ConfigPatch = Partial<Pick<TradingConfig, 'broker' | 'simulatorCash' | 'simulatorAnytime' | 'model' | 'halted'>> & {
  limits?: Partial<TradingConfig['limits']>
}

export const tradingApi = {
  snapshot: (): Promise<TradingSnapshot> => ipcRenderer.invoke('trading:snapshot'),
  /** Pulls the account, positions and orders from the broker now. */
  refresh: (): Promise<TradingSnapshot> => ipcRenderer.invoke('trading:refresh'),
  /** Broker, limits, simulator cash and hours, the session model, the kill switch. Switching broker or halting stops a running session. */
  setConfig: (patch: ConfigPatch): Promise<TradingSnapshot> => ipcRenderer.invoke('trading:set-config', patch),
  /** Checks the keys with Alpaca, then saves them. */
  setKeys: (kind: 'paper' | 'live', keyId: string, secret: string): Promise<TradingSnapshot> => ipcRenderer.invoke('trading:set-keys', kind, keyId, secret),
  clearKeys: (kind: 'paper' | 'live'): Promise<TradingSnapshot> => ipcRenderer.invoke('trading:clear-keys', kind),
  /** `phrase` must be LIVE_CONFIRMATION exactly. */
  confirmLive: (phrase: string): Promise<TradingSnapshot> => ipcRenderer.invoke('trading:confirm-live', phrase),
  /** Resolves with the order as recorded; one a guardrail or the broker refused comes back `rejected`, with `error` saying why. */
  placeOrder: (request: OrderRequest): Promise<TradingOrder> => ipcRenderer.invoke('trading:place-order', request),
  cancelOrder: (id: string): Promise<TradingSnapshot> => ipcRenderer.invoke('trading:cancel-order', id),
  /** Sells the whole holding at market. */
  closePosition: (symbol: string): Promise<TradingOrder> => ipcRenderer.invoke('trading:close-position', symbol),
  /** Sets, changes or clears (null) a holding's stop-loss, take-profit or trailing stop, which Eaon watches. */
  setExit: (request: ExitRequest): Promise<TradingSnapshot> => ipcRenderer.invoke('trading:set-exit', request),
  /** Back to a fresh simulator account (with `cash`, or the configured amount); its orders and equity history go too. */
  resetSimulator: (cash?: number): Promise<TradingSnapshot> => ipcRenderer.invoke('trading:reset-simulator', cash),
  quote: (symbol: string): Promise<Quote> => ipcRenderer.invoke('trading:quote', symbol),
  bars: (symbol: string, range: BarRange): Promise<Bar[]> => ipcRenderer.invoke('trading:bars', symbol, range),
  saveSchedule: (draft: TradingScheduleDraft): Promise<TradingSchedule> => ipcRenderer.invoke('trading:save-schedule', draft),
  removeSchedule: (id: string): Promise<TradingSnapshot> => ipcRenderer.invoke('trading:remove-schedule', id),
  startSession: (request: StartSessionRequest): Promise<TradingSession> => ipcRenderer.invoke('trading:start-session', request),
  stopSession: (id: string): Promise<TradingSnapshot> => ipcRenderer.invoke('trading:stop-session', id),
  /** Runs the session's next check now. */
  checkNow: (id: string): Promise<TradingSnapshot> => ipcRenderer.invoke('trading:check-now', id),
  /** A message to the session's agent; it reads it in a check that starts at once. */
  tellSession: (id: string, text: string): Promise<TradingSnapshot> => ipcRenderer.invoke('trading:tell-session', id, text),
  /** Starts Eaon's trading MCP server and says how the Trading tab's pane starts Claude Code with it. */
  claudeLaunch: (): Promise<ClaudeTradingLaunch> => ipcRenderer.invoke('trading:claude-launch'),
  /** Lets Claude Code trade real money (Alpaca live), or stops it; resolves with the setting. */
  setClaudeLiveMoney: (on: boolean): Promise<boolean> => ipcRenderer.invoke('trading:claude-live-money', on),
  /** The latest steps of the session's agent — the tools it used — newest last. */
  steps: (): Promise<TradingStep[]> => ipcRenderer.invoke('trading:steps'),
  onSteps: (handler: (steps: TradingStep[]) => void): (() => void) => subscribe('trading:steps', handler),
  /** Tell main the desk is on screen (true) or gone (false): it refreshes every 30 s while open, every 5 min otherwise. */
  setDeskOpen: (open: boolean): Promise<void> => ipcRenderer.invoke('trading:desk-open', open),
  /** Every change, at most about twice a second. */
  onChanged: (handler: (snapshot: TradingSnapshot) => void): (() => void) => subscribe('trading:changed', handler)
}
