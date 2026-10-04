import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import type { StreamEvent } from '@shared/types'
import type { Feature, FeatureContext } from '@main/features/types'
import { store } from '@main/store'
import '@main/agent/sources'
import { killBackgroundProcesses } from '@main/localTools'
import { setMcpStatusListener, shutdownMcp, syncMcpServers } from '@main/mcp'
import { refreshLocalProviders } from '@main/providers/localDiscovery'
import { refreshCatalogInBackground } from '@main/providers/modelCatalog'
import { registerToolSource } from '@main/agent/tools'
import { providerAuthFeature } from '@main/features/providerAuth'
import { pluginsFeature } from '@main/features/plugins'
import { skillsFeature } from '@main/features/skills'
import { workersFeature } from '@main/features/workers'
import { requireTradingDisclaimer, tradingFeature } from '@main/features/trading'
import { emailFeature } from '@main/features/email'
import { installCodingTools } from '../coding/tools'
import { stopLanguageServers } from '../coding/lsp'
import { recordTradingActivity } from '../core/tradingActivity'
import { serveTradingResearch } from '../core/tradingResearch'
import { events, ipc } from './ipc'
import { cliHome } from './paths'

/**
 * Starts the desktop app's main process without a window: the store, the
 * agent's tool sources, MCP servers, providers, and the features the CLI
 * offers. What this leaves out is what needs a window or a native module
 * built for Electron — the ADE's terminals, computer use, the agent's own
 * browser, voice, the Code tab, chat apps.
 *
 * `engines` decides whether this process runs the long-lived engines
 * (workers and trading). Only one process per profile may: two would wake
 * the same worker twice and place every session's orders twice. The first
 * TUI takes them; later sessions reach them through the owner (see
 * `bus/`), and short commands (`eaon quote`, `eaon mcp`) never start
 * them.
 */

export interface BootOptions {
  engines: boolean
  /** Start enabled MCP servers. One-shot commands that never call a tool skip it. */
  mcp?: boolean
}

/** Where stream events from headless runs (a worker's turn shown live) go. */
const streamListeners = new Set<(event: StreamEvent) => void>()
export function onHeadlessStream(fn: (event: StreamEvent) => void): () => void {
  streamListeners.add(fn)
  return () => streamListeners.delete(fn)
}

const featureContext: FeatureContext = {
  ipcMain: ipc as unknown as FeatureContext['ipcMain'],
  getWindow: () => null,
  getWindows: () => [],
  send: (channel, ...args) => {
    events.emit(channel, ...args)
  },
  emitStream: (event) => {
    for (const fn of streamListeners) fn(event)
  }
}

let booted: BootOptions | null = null
let discovery: Promise<unknown> = Promise.resolve()

/**
 * Settles when local runtimes (Ollama, LM Studio…) have been asked for their
 * models, or after `capMs`. One-shot commands wait for it; the app doesn't,
 * and redraws when the models arrive.
 */
export function localModelsReady(capMs = 3000): Promise<void> {
  return Promise.race([discovery, new Promise((r) => setTimeout(r, capMs))]).then(() => undefined)
}
let features: Feature[] = []

/** The profile folder holds keys and chats: only the user may open it. */
function prepareHome(): void {
  const home = cliHome()
  if (!existsSync(home)) mkdirSync(home, { recursive: true })
  if (process.platform !== 'win32') {
    try {
      chmodSync(home, 0o700)
    } catch {
      /* not ours to change (a shared EAON_CLI_HOME); leave it */
    }
  }
}

export async function boot(options: BootOptions): Promise<void> {
  if (booted) return
  booted = options
  prepareHome()
  store.migrateWorkspaces()

  // Always: sign-in, plugins and skills are part of every chat.
  await register([providerAuthFeature, pluginsFeature, skillsFeature])
  // opencode-grade editing, diffs and diagnostics on top of the app's file tools.
  installCodingTools()
  if (options.engines) await startEngines()

  setMcpStatusListener((statuses) => events.emit('mcp:status', statuses))
  if (options.mcp !== false) void syncMcpServers()
  discovery = refreshLocalProviders(true).then(
    (changed) => {
      if (changed) events.emit('providers:changed')
    },
    () => undefined
  )
  void refreshCatalogInBackground().then((changed) => {
    if (changed) events.emit('providers:changed')
  })
}

async function register(list: Feature[]): Promise<void> {
  for (const feature of list) {
    try {
      await feature.register(featureContext)
      features.push(feature)
    } catch (error) {
      console.error(`[features] ${feature.id} failed to start:`, error)
    }
  }
}

let enginesStarted = false

/**
 * Starts the workers and trading engines (and agent email, which workers
 * use) in this process. Called at boot by the session that holds the
 * engines lock, or later by a session taking over from one that closed.
 */
export async function startEngines(): Promise<void> {
  if (enginesStarted) return
  enginesStarted = true
  // No order and no session until the user accepts the trading disclaimer in the app.
  requireTradingDisclaimer()
  await register([workersFeature, tradingFeature, emailFeature])
  // A worker's own browser runs on BetterWright inside Electron; there is no
  // Electron here, so the tool is withdrawn rather than offered and failing.
  registerToolSource({ id: 'worker-browser', tools: () => [] })
  // The trading agent's every step, for the desk's activity feed in every terminal.
  recordTradingActivity()
  // Its research tools, for Claude Code when it runs a session.
  serveTradingResearch()
}

export function isBooted(): boolean {
  return booted !== null
}

export function runsEngines(): boolean {
  return enginesStarted
}

let shuttingDown: Promise<void> | null = null

/** What the desktop's before-quit does: features stop, MCP servers and background commands are reaped, writes land. */
export function shutdown(): Promise<void> {
  if (shuttingDown) return shuttingDown
  const cap = <T>(promise: Promise<T>, ms: number): Promise<unknown> => Promise.race([promise, new Promise((r) => setTimeout(r, ms))])
  shuttingDown = (async () => {
    killBackgroundProcesses()
    stopLanguageServers()
    for (const feature of features) {
      try {
        feature.dispose?.()
      } catch {
        /* quitting regardless */
      }
    }
    await Promise.all([
      cap(shutdownMcp(), 4500).catch(() => undefined),
      cap(Promise.all(features.map((f) => f.shutdown?.().catch(() => undefined))), 3000)
    ])
    await cap(store.flushWrites(), 3000)
  })()
  return shuttingDown
}
