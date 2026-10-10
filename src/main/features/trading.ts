import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { BarRange, ClaudeTradingLaunch, ExitRequest, OrderRequest, StartSessionRequest, TradingScheduleDraft, TradingStep } from '@shared/trading'
import type { StreamEvent } from '@shared/types'
import { runAgent } from '../agent/loop'
import { withUsageSource } from './usage/attribution'
import { registerToolSource } from '../agent/tools'
import { secrets } from '../secrets'
import { onPath } from '../shellEnv'
import { store } from '../store'
import { CLAUDE_SERVER_NAME, ClaudeTradingServer, TRADE_COMMAND } from './trading/claudeServer'
import { prepareOutsidePane } from './terminals/outsidePanes'
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
  exits: 'trading-exits.json',
  claude: 'trading-claude.json'
}
/** Lets the window load first; nothing here is needed to paint it. */
const START_DELAY_MS = 5000
/**
 * At most two pushes a second: a busy session changes something many times a
 * second. Each is the whole snapshot only while a desk is open; otherwise a
 * summary (`TradingEngine.summary`), which is all a banner or a status line reads.
 */
const PUSH_EVERY_MS = 500

const vaultName = (kind: KeyKind, part: 'key' | 'secret'): string => `trading:alpaca-${kind}:${part}`

let engine: TradingEngine | null = null
let startTimer: ReturnType<typeof setTimeout> | null = null
let stopPushes: (() => void) | null = null
let claudeServer: ClaudeTradingServer | null = null

/** The pane on the Trading tab that runs the user's Claude Code. */
const CLAUDE_PANE = 'trading-claude'
/** The newest steps kept for the desk's live feed. */
const MAX_STEPS = 80

/**
 * What Claude Code is told about where it runs, on top of its own system
 * prompt. It is passed on the command line, so it keeps clear of quotes and
 * dollar signs (shells read those).
 */
const CLAUDE_CONTEXT = [
  'You are running inside the Trading tab of Eaon, a desktop app.',
  `The ${CLAUDE_SERVER_NAME} MCP server is the user's Eaon trading desk: its tools read the market and the account and place orders through Eaon, where the user's limits and kill switch apply.`,
  `When the user runs ${TRADE_COMMAND} you become the trading agent for the session they set up in Eaon, and you keep its loop going until it ends.`,
  'Trade only through those tools, never through the shell or files.'
].join(' ')

/** Whether the user let Claude Code trade real money, from the switch on the Trading tab. */
function claudeLiveMoney(): boolean {
  return store.getJson<{ liveMoney?: boolean }>(FILES.claude, {}).liveMoney === true
}

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

/** The latest steps of the running session's agent (Eaon's or Claude Code), newest last. */
const steps: TradingStep[] = []
let sendSteps: ((steps: TradingStep[]) => void) | null = null

function recordStep(sessionId: string, event: StreamEvent): void {
  if (event.type === 'tool-call') {
    const check = /:(\d+)$/.exec(event.messageId)?.[1]
    steps.push({ id: event.toolId, sessionId, at: Date.now(), check: check ? Number(check) : null, tool: event.name, input: event.input ?? {}, status: 'running', output: null })
    if (steps.length > MAX_STEPS) steps.splice(0, steps.length - MAX_STEPS)
  } else if (event.type === 'tool-result') {
    const step = steps.find((s) => s.id === event.toolId)
    if (!step) return
    step.status = event.status === 'done' ? 'done' : 'error'
    step.output = event.output.slice(0, 400)
  } else return
  sendSteps?.(steps.slice())
}

export const tradingFeature: Feature = {
  id: 'trading',
  register: (ctx) => {
    const push = throttle(() => {
      if (engine) ctx.send('trading:changed', engine.deskShown ? engine.snapshot() : engine.summary())
    }, PUSH_EVERY_MS)
    stopPushes = push.cancel
    sendSteps = (list) => ctx.send('trading:steps', list)
    /**
     * The windows with the desk on screen, by webContents id (the CLI's desk
     * is one more), each with what stops watching for it going away: a window
     * that closes or reloads with the desk open never says it closed it.
     */
    const desks = new Map<number, () => void>()

    const trading = new TradingEngine({
      // A running session's desk refreshes every few seconds; quotes that live 15 s would hold it still.
      prices: new YahooMarketData({ quoteTtlMs: 4000 }),
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
        recordStep(sessionId, event)
        for (const fn of agentListeners) fn(sessionId, event)
      },
      requireDisclaimer: () => disclaimerRequired
    })
    engine = trading
    trading.load()
    registerToolSource(tradingToolSource(trading))
    setTradingHalted(() => trading.getConfig().halted)

    claudeServer = new ClaudeTradingServer({ engine: trading, settings: () => store.getSettings(), mayTradeLive: claudeLiveMoney })

    const { ipcMain } = ctx
    ipcMain.handle('trading:steps', () => steps.slice())
    /**
     * Sets up the Claude Code pane: Eaon's trading MCP server running, a
     * config file pointing Claude Code at it with this run's key, and the
     * command the pane types to start Claude Code. Nothing is typed into
     * Claude Code itself — the user hands it the session (TRADE_COMMAND).
     */
    ipcMain.handle('trading:claude-launch', async (): Promise<ClaudeTradingLaunch> => {
      const settings = store.getSettings()
      const cwd = join(settings.work.defaultFolder || join(homedir(), 'Eaon'), 'Trading')
      const { url, token } = await claudeServer!.start()
      const dir = join(cwd, '.eaon')
      mkdirSync(dir, { recursive: true })
      const configPath = join(dir, 'claude-mcp.json')
      // The key lets anything that reads it place orders: only the user may read it.
      writeFileSync(configPath, JSON.stringify({ mcpServers: { [CLAUDE_SERVER_NAME]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2), { mode: 0o600 })
      try {
        chmodSync(configPath, 0o600)
      } catch {
        /* Windows: the folder is the user's own */
      }
      // A wait for the next check takes up to four minutes; Claude Code mustn't give up on it first.
      prepareOutsidePane(CLAUDE_PANE, process.env.MCP_TOOL_TIMEOUT ? {} : { MCP_TOOL_TIMEOUT: String(10 * 60_000) })
      const command = [
        'claude',
        '--mcp-config',
        '.eaon/claude-mcp.json',
        // Eaon's trading tools run without asking each time: a session decides on its own, and the limits stand in front of every order.
        '--allowedTools',
        `mcp__${CLAUDE_SERVER_NAME}`,
        '--append-system-prompt',
        `'${CLAUDE_CONTEXT}'`
      ].join(' ')
      return {
        paneId: CLAUDE_PANE,
        cwd,
        command,
        installed: Boolean(onPath('claude')),
        installHint: 'npm install -g @anthropic-ai/claude-code',
        tradeCommand: TRADE_COMMAND,
        liveMoney: claudeLiveMoney()
      }
    })
    ipcMain.handle('trading:claude-live-money', (_e, on: boolean) => {
      store.setJson(FILES.claude, { ...store.getJson<Record<string, unknown>>(FILES.claude, {}), liveMoney: on === true })
      return claudeLiveMoney()
    })
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
    // Not in the original list: lets the desk say it is on screen, for 30-second refreshes and whole snapshots.
    const closeDesk = (id: number): void => {
      desks.get(id)?.()
      desks.delete(id)
      trading.setDeskOpen(desks.size > 0)
    }
    ipcMain.handle('trading:desk-open', (event, open: boolean) => {
      const sender = event.sender
      if (open !== true) return closeDesk(sender.id)
      if (!desks.has(sender.id)) {
        const gone = (): void => closeDesk(sender.id)
        const navigated = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
          if (details.isMainFrame && !details.isSameDocument) closeDesk(sender.id)
        }
        sender.once('destroyed', gone)
        sender.on('did-start-navigation', navigated)
        desks.set(sender.id, () => {
          sender.removeListener('destroyed', gone)
          sender.removeListener('did-start-navigation', navigated)
        })
      }
      trading.setDeskOpen(true)
      // What it has may be a summary pushed while it was closed: the whole snapshot, now.
      ctx.send('trading:changed', trading.snapshot())
    })

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
    sendSteps = null
    claudeServer?.stop()
    claudeServer = null
    // Synchronous: a running check is aborted and recorded as interrupted before the store flushes.
    engine?.stop()
  }
}
