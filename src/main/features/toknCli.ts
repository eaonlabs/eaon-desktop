import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'
import type { ToknCliStatus } from '@shared/toknCli'
import { adoptLoginShellPath, terminalPathDirs } from '../shellEnv'
import { store } from '../store'
import type { Feature, FeatureContext } from './types'
import { requestLinkCode, toknAccount, toknHost } from './usage/tokn'

/**
 * The tokn command (github.com/toknlabs/Tokn), which ships inside Eaon in
 * resources/tokn-cli (scripts/fetch-tokn-cli.mjs). It reads what Claude Code,
 * Codex and the other coding CLIs used on this computer and publishes it to
 * the same Tokn profile Eaon's own usage goes to.
 *
 * Installing it means a small launcher named `tokn` in a folder the user's
 * terminal searches, which runs the bundled copy with Eaon's own Node
 * (ELECTRON_RUN_AS_NODE), so it needs no Node on the computer. A `tokn`
 * that is already there and isn't Eaon's (from npm) is left alone. The
 * launcher is rewritten when Eaon moves or updates, and removed when
 * Settings turns it off.
 *
 * Linking: once Eaon is signed in to Tokn, unless tracking the coding CLIs
 * was turned off (the setup, or Settings → Usage), Eaon asks Tokn for a
 * one-time link code and runs `tokn link --code`; the command gets its own
 * token, as if it had been linked by hand. Then `tokn sync` runs every hour
 * while Eaon is open. tokn reads the CLIs' own logs, so what they used while
 * Eaon was closed is counted at the next sync.
 *
 * Channels (all `tokn-cli:`): `status`, `link`, `sync`, and the `changed` event.
 */

/** Marks a launcher as Eaon's, so Eaon only ever rewrites or removes its own. */
const MARKER = 'Installed by Eaon Desktop'
const SYNC_EVERY_MS = 60 * 60_000
/** The first sync after launch waits for the window and everything else to settle. */
const FIRST_SYNC_AFTER_MS = 2 * 60_000
const LINK_TIMEOUT_MS = 60_000
const SYNC_TIMEOUT_MS = 10 * 60_000

let ctx: FeatureContext | null = null
let activity: ToknCliStatus['activity'] = { state: 'idle', at: null, error: null }
let syncTimer: ReturnType<typeof setInterval> | null = null
let firstSync: ReturnType<typeof setTimeout> | null = null
let installed: Promise<void> = Promise.resolve()

const settings = (): { install: boolean; sync: boolean } => store.getSettings().toknCli

/** The bundled package: <Resources>/tokn-cli when packaged, resources/tokn-cli next to out/ in development. */
function bundle(): { script: string; version: string } | null {
  const roots = [
    process.env.EAON_TOKN_CLI_DIR || null,
    app.isPackaged ? join(process.resourcesPath, 'tokn-cli') : null,
    fileURLToPath(new URL('../../resources/tokn-cli', import.meta.url))
  ]
  for (const root of roots) {
    if (!root) continue
    const script = join(root, 'dist', 'index.js')
    if (!existsSync(script)) continue
    try {
      const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown }).version
      return { script, version: typeof version === 'string' ? version : '?' }
    } catch {
      return { script, version: '?' }
    }
  }
  return null
}

/** Where tokn keeps its link (`tokn` itself honours TOKN_CONFIG_DIR too). */
const configFile = (): string => join(process.env.TOKN_CONFIG_DIR || join(homedir(), '.tokn'), 'config.json')

/** The account the command is linked to, from its own config. */
function linkedAs(): { handle: string } | null {
  try {
    const config = JSON.parse(readFileSync(configFile(), 'utf8')) as { token?: unknown; user?: { handle?: unknown } }
    if (typeof config.token !== 'string' || !config.token) return null
    return { handle: typeof config.user?.handle === 'string' ? config.user.handle : '' }
  } catch {
    return null
  }
}

/**
 * When tokn last published, and as whom, from its own config. A tokn from
 * npm shares the config, so its own scheduled syncs count too.
 */
export function toknCliLastSync(): { handle: string; at: string } | null {
  try {
    const config = JSON.parse(readFileSync(configFile(), 'utf8')) as { token?: unknown; user?: { handle?: unknown }; lastSyncAt?: unknown }
    if (typeof config.token !== 'string' || !config.token) return null
    if (typeof config.lastSyncAt !== 'string' || Number.isNaN(Date.parse(config.lastSyncAt))) return null
    return { handle: typeof config.user?.handle === 'string' ? config.user.handle : '', at: config.lastSyncAt }
  } catch {
    return null
  }
}

/**
 * Whether tokn publishes on its own (`tokn autosync on`: a scheduler, and a
 * Claude Code hook). Then Eaon's hourly sync only doubles it, and the second
 * of two close syncs is turned away by Tokn as "syncing too often".
 */
function syncsItself(): boolean {
  try {
    const config = JSON.parse(readFileSync(configFile(), 'utf8')) as { autosync?: { enabled?: unknown } }
    return config.autosync?.enabled === true
  } catch {
    return false
  }
}

const syncedListeners = new Set<() => void>()
/** Told after each `tokn sync` that went through, so Settings → Usage reads the profile again. */
export function onToknCliSynced(listener: () => void): () => void {
  syncedListeners.add(listener)
  return () => syncedListeners.delete(listener)
}

const windows = process.platform === 'win32'
const launcherName = windows ? 'tokn.cmd' : 'tokn'

/**
 * Folders a launcher may go in, best first. On Windows, the per-user
 * WindowsApps folder: on PATH by default, and no administrator needed.
 * Elsewhere the per-user ~/.local/bin, then Homebrew's folders, which a
 * terminal searches on most Macs.
 */
function launcherDirs(): string[] {
  if (process.env.EAON_TOKN_BIN_DIR) return [process.env.EAON_TOKN_BIN_DIR]
  if (windows) return process.env.LOCALAPPDATA ? [join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps')] : []
  return [join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
}

/**
 * The folders a terminal searches; on Windows (and when the shell couldn't be
 * asked), PATH as Eaon has it. With EAON_TOKN_BIN_DIR (the end-to-end suite),
 * only that folder, so a tokn installed on the computer running the tests
 * doesn't change what they see.
 */
function terminalDirs(): string[] {
  if (process.env.EAON_TOKN_BIN_DIR) return [process.env.EAON_TOKN_BIN_DIR]
  return terminalPathDirs() ?? (process.env.PATH ?? '').split(delimiter).filter(Boolean)
}

function isOurs(path: string): boolean {
  try {
    return readFileSync(path, 'utf8').includes(MARKER)
  } catch {
    return false
  }
}

function writable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** The `tokn` a terminal would run, if any. */
function findCommand(): ToknCliStatus['command'] {
  const names = windows ? ['tokn.cmd', 'tokn.exe', 'tokn.bat', 'tokn'] : ['tokn']
  for (const dir of [...terminalDirs(), ...launcherDirs()]) {
    for (const name of names) {
      const path = join(dir, name)
      if (!existsSync(path)) continue
      return { kind: isOurs(path) ? 'eaon' : 'other', path }
    }
  }
  return null
}

const shQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

/** The launcher's text: run the bundled tokn with this Eaon's own Node. */
function launcherText(script: string): string {
  const exe = process.execPath
  if (windows) {
    return [
      '@echo off',
      `rem ${MARKER}: the tokn command that comes with Eaon, run with Eaon's own Node.`,
      'rem Eaon rewrites this when it moves or updates, and removes it when Settings turns it off.',
      'setlocal',
      `if not exist "${script}" (`,
      '  echo tokn came with Eaon Desktop, which is not where it was. Open Eaon to put it back, or install it with: npm install -g toknhq 1>&2',
      '  exit /b 1',
      ')',
      'set ELECTRON_RUN_AS_NODE=1',
      `"${exe}" "${script}" %*`,
      ''
    ].join('\r\n')
  }
  return [
    '#!/bin/sh',
    `# ${MARKER}: the tokn command that comes with Eaon, run with Eaon's own Node.`,
    '# Eaon rewrites this when it moves or updates, and removes it when Settings turns it off.',
    `if [ ! -f ${shQuote(script)} ]; then`,
    `  echo "tokn came with Eaon Desktop, which isn't where it was. Open Eaon to put it back, or install it with: npm install -g toknhq" >&2`,
    '  exit 1',
    'fi',
    `ELECTRON_RUN_AS_NODE=1 exec ${shQuote(exe)} ${shQuote(script)} "$@"`,
    ''
  ].join('\n')
}

/**
 * Puts Eaon's launcher on PATH, or brings an old one up to date. Leaves a
 * `tokn` that isn't Eaon's alone, and does nothing for a build without the
 * bundle.
 */
export function installLauncher(): void {
  const found = bundle()
  if (!found) return
  const command = findCommand()
  if (command?.kind === 'other') return
  const text = launcherText(found.script)
  const terminal = new Set(terminalDirs())
  // Where it already is, else the first folder a terminal searches that can be written to, else ~/.local/bin.
  const dirs = launcherDirs()
  const target =
    command?.kind === 'eaon'
      ? command.path
      : join(dirs.find((dir) => terminal.has(dir) && (existsSync(dir) ? writable(dir) : dir.startsWith(homedir()))) ?? dirs[0], launcherName)
  if (!target) return
  try {
    if (existsSync(target) && readFileSync(target, 'utf8') === text) return
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, text, { mode: 0o755 })
  } catch (error) {
    console.warn('[tokn-cli] could not install the tokn command:', error)
  }
}

/** Removes Eaon's launchers, and only those. */
export function removeLauncher(): void {
  for (const dir of new Set([...launcherDirs(), ...terminalDirs()])) {
    const path = join(dir, launcherName)
    if (existsSync(path) && isOurs(path)) rmSync(path, { force: true })
  }
}

export function toknCliStatus(): ToknCliStatus {
  const command = findCommand()
  const terminal = process.env.EAON_TOKN_BIN_DIR ? terminalDirs() : terminalPathDirs()
  const dir = command?.kind === 'eaon' ? join(command.path, '..') : null
  return {
    version: bundle()?.version ?? null,
    command,
    // Only said when the shell could be asked: otherwise there's no knowing.
    needsPath: dir && terminal && !terminal.includes(dir) ? dir : null,
    linked: linkedAs(),
    // Idle, the last sync is whichever ran last: Eaon's, or tokn's own scheduled one.
    activity: activity.state === 'idle' && !activity.error ? { ...activity, at: latestSync(activity.at) } : activity
  }
}

function latestSync(eaonAt: number | null): number | null {
  const own = toknCliLastSync()
  const at = own ? Date.parse(own.at) : 0
  return Math.max(eaonAt ?? 0, at) || null
}

function changed(): void {
  ctx?.send('tokn-cli:changed', toknCliStatus())
}

/** Runs the bundled tokn with `args`, no terminal attached; resolves with its exit code and output. */
function runTokn(args: string[], timeoutMs: number): Promise<{ code: number; output: string }> {
  const found = bundle()
  if (!found) return Promise.resolve({ code: 1, output: 'tokn isn’t included in this build of Eaon.' })
  // A local Tokn while developing it: the command talks to the same one.
  const host = process.env.EAON_TOKN_HOST ? { TOKN_HOST: toknHost() } : {}
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [found.script, ...args],
      { env: { ...process.env, ...host, ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1', TOKN_NO_UPDATE_CHECK: '1' }, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1) : 0
        resolve({ code, output: `${stdout}${stderr}`.trim() })
      }
    )
  })
}

/** The last line worth showing from tokn's output. */
const lastLine = (output: string): string =>
  output
    .split('\n')
    .map((line) => line.replace(/^[\s✓✗•·]+/u, '').trim())
    .filter(Boolean)
    .pop()
    ?.slice(0, 200) ?? ''

/**
 * Links the command to the account Eaon is signed in with, unless it is
 * linked already (to whichever account: that was the person's choice).
 */
export async function linkToknCli(): Promise<ToknCliStatus> {
  if (linkedAs() || activity.state !== 'idle') return toknCliStatus()
  if (!toknAccount()) {
    activity = { state: 'idle', at: Date.now(), error: 'Sign in with Tokn first.' }
    changed()
    return toknCliStatus()
  }
  activity = { state: 'linking', at: Date.now(), error: null }
  changed()
  try {
    const code = await requestLinkCode()
    if (!code) throw new Error('Tokn can’t link the tokn command from Eaon yet. Run `tokn link` in a terminal instead.')
    const result = await runTokn(['link', `--code=${code}`, '--no-browser'], LINK_TIMEOUT_MS)
    if (result.code !== 0 || !linkedAs()) throw new Error(lastLine(result.output) || 'tokn couldn’t be linked.')
    activity = { state: 'idle', at: Date.now(), error: null }
  } catch (error) {
    activity = { state: 'idle', at: Date.now(), error: error instanceof Error ? error.message : String(error) }
  }
  changed()
  if (linkedAs()) void syncToknCli()
  return toknCliStatus()
}

/** `tokn sync`: publishes what the coding CLIs used on this computer. */
export async function syncToknCli(): Promise<ToknCliStatus> {
  if (!linkedAs() || activity.state !== 'idle') return toknCliStatus()
  activity = { state: 'syncing', at: Date.now(), error: null }
  changed()
  const result = await runTokn(['sync'], SYNC_TIMEOUT_MS)
  // "Nothing to sync" and "no sessions found" are not failures: there's just nothing yet.
  // Nor is "syncing too often": another sync (tokn's own, scheduled) has just published.
  const nothing = /nothing to sync|no claude sessions|syncing too often/i.test(result.output)
  activity = { state: 'idle', at: Date.now(), error: result.code === 0 || nothing ? null : lastLine(result.output) || 'tokn sync didn’t finish.' }
  changed()
  if (!activity.error) syncedListeners.forEach((listener) => listener())
  return toknCliStatus()
}

/** Hourly syncs while linking is on and the command is linked. */
function schedule(): void {
  if (syncTimer) clearInterval(syncTimer)
  if (firstSync) clearTimeout(firstSync)
  syncTimer = null
  firstSync = null
  if (!settings().sync) return
  // Checked each time, since `tokn autosync` can be turned on or off in a terminal at any time.
  const run = (): void => {
    if (!syncsItself()) void syncToknCli()
  }
  firstSync = setTimeout(run, FIRST_SYNC_AFTER_MS)
  syncTimer = setInterval(run, SYNC_EVERY_MS)
}

/** Settings changed: install or remove the launcher, link, and (re)start the hourly sync. */
export async function applyToknCliSettings(): Promise<ToknCliStatus> {
  await installed
  const { install, sync } = settings()
  if (install) installLauncher()
  else removeLauncher()
  schedule()
  changed()
  if (sync && toknAccount() && !linkedAs()) return linkToknCli()
  return toknCliStatus()
}

/** Eaon just signed in to Tokn: link the command too, unless tracking the coding CLIs is off. */
export function afterToknSignIn(): void {
  if (settings().sync) void linkToknCli()
}

/**
 * Migration 5: tracking the coding CLIs went from asked-for to on
 * by default. A profile from before has it off unless the setup's switch was
 * used while signed in, so it is turned on, except where Eaon is signed in
 * to Tokn already: off there may have been the person's no, and stays.
 */
export function trackCodingClisByDefault(): void {
  if (settings().sync || toknAccount()) return
  store.patchSettings({ toknCli: { ...settings(), sync: true } })
}

export const toknCliFeature: Feature = {
  id: 'tokn-cli',
  register: (context) => {
    ctx = context
    const { ipcMain } = context
    // A terminal's PATH is only known once the login shell has answered.
    if (process.env.EAON_TOKN_CLI !== 'off') {
      installed = adoptLoginShellPath().then(() => {
        if (settings().install) installLauncher()
        // Signed in, tracking on, and not linked yet (a link that failed last time): link now.
        if (settings().sync && toknAccount() && !linkedAs()) void linkToknCli()
      })
      schedule()
    }
    ipcMain.handle('tokn-cli:status', async () => {
      await installed
      return toknCliStatus()
    })
    ipcMain.handle('tokn-cli:link', () => linkToknCli())
    ipcMain.handle('tokn-cli:sync', () => syncToknCli())
    ipcMain.handle('tokn-cli:apply', () => applyToknCliSettings())
  }
}
