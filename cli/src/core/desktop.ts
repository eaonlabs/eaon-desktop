import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Chat, McpServer, Settings } from '@shared/types'
import type { Worker, WorkerDraft } from '@shared/workers'
import type { TradingConfig, TradingSchedule, TradingScheduleDraft, TradingSnapshot } from '@shared/trading'
import { secrets } from '@main/secrets'
import { store, type ProviderOverride } from '@main/store'
import { TradingEngine } from '@main/features/trading/engine'
import { YahooMarketData } from '@main/features/trading/marketData'
import { hasHandler, invoke } from '../runtime/ipc'
import { decryptForeign } from '../runtime/osCrypt'
import { DESKTOP_APP_NAME, desktopHome } from '../runtime/paths'
import { chatStore } from './chats'

/**
 * Eaon Desktop, seen from the CLI: where it is, whether it is running, what
 * is in its store, and bringing parts of it over.
 *
 * Everything here **reads** the desktop's folder and nothing ever writes to
 * it. The desktop owns its files and may be running while the CLI is: its
 * in-memory copies would overwrite anything written behind its back, and
 * both apps running the same engines on the same ledger would place every
 * order twice. So the CLI imports into its own profile instead — keys,
 * providers, model choices, MCP servers and the trading setup — and shows
 * the rest (chats, workers, the trading desk) read-only, with a way to
 * continue a chat or copy a worker into the CLI.
 *
 * Two things are deliberately not carried over as they are: the real-money
 * confirmation (it has to be typed again in the CLI) and trading schedules'
 * on switch (an imported schedule starts off, or the same window would trade
 * the same Alpaca account from both apps).
 */

/* ------------------------------------------------------------- finding it */

export interface DesktopInfo {
  /** The desktop's userData folder. */
  home: string
  /** Running right now, as far as a quick check can tell (always false on Windows; see `isDesktopRunning`). */
  running: boolean
  /** The `store/*.json` files present. */
  files: string[]
  /** Whether a key vault (`keys.dat`) exists. */
  hasKeys: boolean
}

const storeDir = (): string => join(desktopHome(), 'store')

/**
 * Chromium's single-instance lock: a symlink named `SingletonLock` whose
 * target is `<hostname>-<pid>`. It is left behind after a crash, so the pid
 * is checked too.
 */
function lockHeld(home: string): boolean {
  if (process.platform === 'win32') return false
  let target: string
  try {
    target = readlinkSync(join(home, 'SingletonLock'))
  } catch {
    return false
  }
  const pid = Number(target.slice(target.lastIndexOf('-') + 1))
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else — still running.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function findDesktop(): DesktopInfo | null {
  const home = desktopHome()
  if (!existsSync(storeDir())) return null
  let files: string[] = []
  try {
    files = readdirSync(storeDir())
      .filter((name) => name.endsWith('.json'))
      .sort()
  } catch {
    /* unreadable: report it as empty */
  }
  return { home, running: lockHeld(home), files, hasKeys: existsSync(join(home, 'keys.dat')) }
}

/** Whether the desktop app is running. On Windows this asks `tasklist`, which takes a moment. */
export function isDesktopRunning(): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(lockHeld(desktopHome()))
  return new Promise((resolve) => {
    const child = spawn('tasklist', ['/FI', 'IMAGENAME eq Eaon.exe', '/NH'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.on('error', () => resolve(false))
    child.on('close', () => resolve(/\bEaon\.exe\b/i.test(out)))
  })
}

/* -------------------------------------------------------------- reading it */

/** One of the desktop's store files, or `fallback` when it is missing or unreadable (mid-write, damaged). */
export function readDesktopJson<T>(name: string, fallback: T): T {
  try {
    const file = join(storeDir(), name)
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** The desktop's saved settings as written — only what the user changed, so fields can be missing. */
export function desktopSettings(): Settings | null {
  const saved = readDesktopJson<Settings | null>('settings.json', null)
  return saved && typeof saved === 'object' ? saved : null
}

/** The desktop's chats, newest first, archived ones left out. */
export function desktopChats(): Chat[] {
  const chats = readDesktopJson<unknown>('chats.json', [])
  return (Array.isArray(chats) ? (chats as Chat[]) : [])
    .filter((chat) => chat && typeof chat.id === 'string' && Array.isArray(chat.messages) && !chat.archived)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

export function desktopWorkers(): Worker[] {
  const workers = readDesktopJson<unknown>('workers.json', [])
  return Array.isArray(workers) ? (workers as Worker[]).filter((w) => w && typeof w.id === 'string' && typeof w.name === 'string') : []
}

export function desktopMcpServers(): McpServer[] {
  const servers = readDesktopJson<unknown>('mcp.json', [])
  return Array.isArray(servers) ? (servers as McpServer[]).filter((s) => s && typeof s.id === 'string') : []
}

export function desktopProviders(): Record<string, ProviderOverride> {
  const config = readDesktopJson<unknown>('providers.json', {})
  return config && typeof config === 'object' && !Array.isArray(config) ? (config as Record<string, ProviderOverride>) : {}
}

const TRADING_FILES = {
  config: 'trading-config.json',
  orders: 'trading-orders.json',
  equity: 'trading-equity.json',
  schedules: 'trading-schedules.json',
  sessions: 'trading-sessions.json',
  sim: 'trading-sim.json',
  exits: 'trading-exits.json'
}

const noop = (): void => {}

/**
 * The desktop's trading desk as last saved: ledger, equity curve, sessions,
 * schedules and stats. Built by a trading engine that only ever loads —
 * never `start()` or `refresh()`: a refresh runs the protective exits, which
 * would sell holdings on the desktop's behalf while the desktop watches the
 * same exits itself. So there is no live account here (`account` is null and
 * positions are empty); the desk shows what the files hold.
 */
export function desktopTradingSnapshot(): TradingSnapshot | null {
  if (!Object.values(TRADING_FILES).some((name) => existsSync(join(storeDir(), name)))) return null
  const engine = new TradingEngine({
    prices: new YahooMarketData(),
    runAgent: async () => ({ text: '', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    getSettings: () => store.getSettings(),
    getKeys: () => null,
    saveKeys: noop,
    loadConfig: () => readDesktopJson<unknown>(TRADING_FILES.config, null),
    saveConfig: noop,
    loadOrders: () => readDesktopJson<unknown>(TRADING_FILES.orders, []),
    saveOrders: noop,
    loadEquity: () => readDesktopJson<unknown>(TRADING_FILES.equity, {}),
    saveEquity: noop,
    loadSchedules: () => readDesktopJson<unknown>(TRADING_FILES.schedules, []),
    saveSchedules: noop,
    loadSessions: () => readDesktopJson<unknown>(TRADING_FILES.sessions, []),
    saveSessions: noop,
    loadSim: () => readDesktopJson<unknown>(TRADING_FILES.sim, null),
    saveSim: noop,
    loadExits: () => readDesktopJson<unknown>(TRADING_FILES.exits, {}),
    saveExits: noop
  })
  engine.load()
  return engine.snapshot()
}

/* ------------------------------------------------- taking one thing across */

/**
 * Continues a desktop chat in the CLI: a copy with a new id in the CLI's own
 * chat store (the desktop's stays as it is). Null when there is no such chat.
 */
export function continueDesktopChat(id: string): (Chat & { origin: 'desktop' }) | null {
  const original = desktopChats().find((chat) => chat.id === id)
  if (!original) return null
  const now = Date.now()
  const copy: Chat & { origin: 'desktop' } = {
    ...structuredClone(original),
    id: randomUUID(),
    workspaceId: 'work',
    projectId: null,
    archived: false,
    unread: false,
    updatedAt: now,
    origin: 'desktop'
  }
  chatStore.save(copy)
  return copy
}

/**
 * Makes a copy of a desktop worker in the CLI, paused, so it never runs in
 * both apps at once. Its thread, memory and routines stay with the desktop;
 * the copy starts fresh with the same character, job, model, access and
 * trading setup. Null when the CLI's workers engine isn't running in this
 * process or there is no such worker.
 */
export async function copyDesktopWorker(id: string): Promise<Worker | null> {
  if (!hasHandler('workers:save')) return null
  const original = desktopWorkers().find((worker) => worker.id === id)
  if (!original) return null
  const draft: WorkerDraft = {
    name: original.name,
    color: original.color,
    personality: original.personality ?? '',
    purpose: original.purpose ?? '',
    model: original.model ?? null,
    access: original.access,
    trading: original.trading ?? null
  }
  const created = await invoke<Worker>('workers:save', draft)
  await invoke('workers:set-paused', created.id, true)
  return { ...created, paused: true }
}

/* ------------------------------------------------------------ importing */

export interface ImportPlan {
  /** Saved keys; null when the vault is encrypted, so the count isn't known until it is unlocked. */
  keys: number | null
  providers: number
  mcpServers: number
  settings: boolean
  trading: { config: boolean; schedules: number }
}

export interface ImportChoices {
  keys: boolean
  providers: boolean
  settings: boolean
  mcp: boolean
  trading: boolean
}

export interface ImportReport {
  keys?: { added: number; updated: number; error?: string }
  providers?: number
  settings?: boolean
  mcpServers?: number
  trading?: { config: boolean; schedules: number; disabled: number }
  errors: string[]
}

const MARKER = 'desktop-import.json'

interface ImportMarker {
  at: number
  declined?: boolean
  choices?: ImportChoices
  counts?: Omit<ImportReport, 'errors'> & { errors: number }
}

const isOsCrypt = (raw: Buffer): boolean => {
  const prefix = raw.subarray(0, 3).toString('utf8')
  return prefix === 'v10' || prefix === 'v11'
}

/** Desktop servers worth bringing: everything except the bundled ones, which the CLI has itself. */
const importableServers = (): McpServer[] => desktopMcpServers().filter((server) => !server.official)

/** What an import would bring over. Nothing is decrypted to work it out. */
export function planImport(): ImportPlan {
  let keys: number | null = 0
  try {
    const raw = readFileSync(join(desktopHome(), 'keys.dat'))
    if (isOsCrypt(raw)) keys = null
    else {
      const vault = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
      keys = Object.values(vault).filter((value) => typeof value === 'string' && value).length
    }
  } catch {
    keys = existsSync(join(desktopHome(), 'keys.dat')) ? null : 0
  }
  const schedules = readDesktopJson<unknown>(TRADING_FILES.schedules, [])
  return {
    keys,
    providers: Object.keys(desktopProviders()).length,
    mcpServers: importableServers().length,
    settings: desktopSettings() !== null,
    trading: {
      config: existsSync(join(storeDir(), TRADING_FILES.config)),
      schedules: Array.isArray(schedules) ? schedules.length : 0
    }
  }
}

/** Decrypts the desktop's vault and writes every entry into the CLI's. Values never leave this function. */
async function importKeys(onStatus: (line: string) => void): Promise<{ added: number; updated: number }> {
  const file = join(desktopHome(), 'keys.dat')
  if (!existsSync(file)) return { added: 0, updated: 0 }
  const raw = readFileSync(file)
  if (isOsCrypt(raw) && process.platform === 'darwin') {
    onStatus(`macOS will ask to let Eaon CLI read “${DESKTOP_APP_NAME} Safe Storage” from your keychain. Choose Allow (or Always Allow) to bring your keys over.`)
  }
  const parsed: unknown = JSON.parse(await decryptForeign(raw, DESKTOP_APP_NAME, desktopHome()))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error("The desktop app's key vault isn't in the expected shape.")
  let added = 0
  let updated = 0
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string' || !value) continue
    const current = secrets.get(id)
    if (current === value) continue
    secrets.set(id, value)
    if (current) updated++
    else added++
  }
  return { added, updated }
}

/** Desktop overrides on top of the CLI's, provider by provider. */
function importProviders(): number {
  const incoming = desktopProviders()
  const ids = Object.keys(incoming)
  if (ids.length === 0) return 0
  store.saveProviderConfig({ ...store.getProviderConfig(), ...incoming })
  return ids.length
}

/** The model and agent choices; never the look, the shortcuts or how the window opens. */
const SETTINGS_TO_COPY = [
  'selectedModelId',
  'selectedProviderId',
  'favoriteModels',
  'effort',
  'approvalMode',
  'work',
  'context',
  'mcp',
  'installedPlugins',
  'disabledPlugins',
  'disabledSkills',
  'notifications'
] as const

function importSettings(): boolean {
  const saved = desktopSettings()
  if (!saved) return false
  const patch: Record<string, unknown> = {}
  for (const key of SETTINGS_TO_COPY) if (saved[key] !== undefined) patch[key] = saved[key]
  if (Object.keys(patch).length === 0) return false
  store.patchSettings(patch as Partial<Settings>)
  return true
}

function importMcpServers(): number {
  const incoming = importableServers()
  if (incoming.length === 0) return 0
  const byId = new Map(store.getMcpServers().map((server) => [server.id, server]))
  for (const server of incoming) byId.set(server.id, server)
  store.saveMcpServers([...byId.values()])
  return incoming.length
}

/** A schedule the CLI already has from an earlier import: same name and strategy. */
const sameSchedule = (a: Pick<TradingSchedule, 'name' | 'strategy'>, b: Pick<TradingSchedule, 'name' | 'strategy'>): boolean =>
  a.name === b.name && a.strategy === b.strategy

/**
 * The trading setup: broker, limits, the simulator's settings and the model,
 * plus the schedules — all switched off. When this process runs the trading
 * engine, the changes go through it (it holds the config in memory and
 * would write over the file); otherwise straight to the store.
 */
async function importTrading(): Promise<{ config: boolean; schedules: number; disabled: number }> {
  const config = readDesktopJson<Partial<TradingConfig> | null>(TRADING_FILES.config, null)
  const rawSchedules = readDesktopJson<unknown>(TRADING_FILES.schedules, [])
  const schedules = (Array.isArray(rawSchedules) ? (rawSchedules as TradingSchedule[]) : []).filter((s) => s && typeof s.id === 'string')
  const disabled = schedules.filter((s) => s.enabled !== false).length
  const live = hasHandler('trading:set-config')

  if (config && typeof config === 'object') {
    if (live) {
      const { liveConfirmedAt: _confirmed, ...patch } = config
      await invoke('trading:set-config', patch)
    } else {
      store.setJson(TRADING_FILES.config, { ...config, liveConfirmedAt: null })
    }
  }

  if (schedules.length > 0) {
    if (live) {
      const snapshot = await invoke<TradingSnapshot>('trading:snapshot')
      for (const schedule of schedules) {
        const existing = snapshot.schedules.find((s) => sameSchedule(s, schedule))
        const { id: _id, createdAt: _createdAt, ...rest } = schedule
        const draft: TradingScheduleDraft = { ...rest, enabled: false, ...(existing ? { id: existing.id } : {}) }
        await invoke('trading:save-schedule', draft)
      }
    } else {
      const current = store.getJson<unknown>(TRADING_FILES.schedules, [])
      const mine = (Array.isArray(current) ? (current as TradingSchedule[]) : []).filter((s) => !schedules.some((d) => d.id === s.id || sameSchedule(s, d)))
      store.setJson(TRADING_FILES.schedules, [...mine, ...schedules.map((s) => ({ ...s, enabled: false }))])
    }
  }
  return { config: Boolean(config), schedules: schedules.length, disabled }
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Brings the chosen parts of the desktop's setup into the CLI's profile.
 * Each part stands alone: one that fails is reported in `errors` and the
 * others still go ahead. The report holds counts and ids, never a key.
 */
export async function importFromDesktop(choices: ImportChoices, opts: { onStatus?: (line: string) => void } = {}): Promise<ImportReport> {
  const onStatus = opts.onStatus ?? noop
  const report: ImportReport = { errors: [] }
  if (!findDesktop()) {
    report.errors.push(`Eaon Desktop wasn't found at ${desktopHome()}.`)
    return report
  }

  if (choices.keys) {
    try {
      report.keys = await importKeys(onStatus)
    } catch (error) {
      report.keys = { added: 0, updated: 0, error: errorText(error) }
      report.errors.push(`Keys: ${errorText(error)}`)
    }
  }
  const step = async <T>(name: string, run: () => T | Promise<T>): Promise<T | undefined> => {
    try {
      return await run()
    } catch (error) {
      report.errors.push(`${name}: ${errorText(error)}`)
      return undefined
    }
  }
  if (choices.providers) report.providers = await step('Providers', importProviders)
  if (choices.settings) report.settings = await step('Settings', importSettings)
  if (choices.mcp) report.mcpServers = await step('MCP servers', importMcpServers)
  if (choices.trading) report.trading = await step('Trading', importTrading)

  const { errors, ...counts } = report
  const marker: ImportMarker = { at: Date.now(), choices, counts: { ...counts, errors: errors.length } }
  store.setJson(MARKER, marker)
  return report
}

/* ------------------------------------------------------------- first run */

/**
 * Whether the TUI should offer an import on start: `ask` when the desktop
 * is installed and the user hasn't imported or said no yet.
 */
export function firstRunImportState(): 'ask' | 'done' | 'declined' | 'no-desktop' {
  const marker = store.getJson<ImportMarker | null>(MARKER, null)
  if (marker?.declined) return 'declined'
  if (marker) return 'done'
  return findDesktop() ? 'ask' : 'no-desktop'
}

export function declineFirstRunImport(): void {
  store.setJson(MARKER, { at: Date.now(), declined: true } satisfies ImportMarker)
}
