import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { app, clipboard, screen, shell, systemPreferences } from 'electron'
import { APP_CONTROL_CLI, type AppControlEnvelope, type AppControlSource } from '@shared/appControl'
import { registerToolSource } from '../agent/tools'
import type { ControlClient } from '../control/server'
import type { ControlTool } from '../control/tools'
import { ensureGatewayRunning } from '../gateway'
import { appControlToken } from '../gateway/models'
import { store } from '../store'
import { parseArgv } from './appControl/argv'
import { commandInfo, findCommand } from './appControl/commands'
import { appControlPromptNote } from './appControl/guide'
import { HelperEngine } from './appControl/helper'
import { disposeOverlay, flashOverlay } from './appControl/overlay'
import { engineLaunch, engineName, resourcesDir } from './appControl/platform'
import { AppControlFailure } from './appControl/protocol'
import { AppControlService, toError } from './appControl/service'
import { appControlTool } from './appControl/tool'
import type { Feature } from './types'

/**
 * App control (appControl/): agents read and operate desktop apps through
 * the accessibility tree. This wires it into the app:
 *
 * - `app_control`, a Work-mode tool for Eaon's own agents, while
 *   Settings → App control is on;
 * - `app_control` on the control API (`/control`), for Claude Code through
 *   Eaon's MCP server and for `eaon-apps`, the command ADE terminals get on
 *   their PATH, while its "coding agents" switch is on too;
 * - Settings → App control: status, the permission, a read-only try-it
 *   panel and the activity list.
 *
 * Channels (all `app-control:`): `status`, `commands`, `try`, `activity`,
 * `clear-activity`, `open-permission`, and the `activity-added` event.
 */

const settings = () => store.getSettings().appControl

let engine: HelperEngine | null = null

function currentEngine(): HelperEngine | null {
  if (engine) return engine
  const { launch } = engineLaunch()
  if (!launch) return null
  engine = new HelperEngine(process.platform, () => engineLaunch().launch)
  return engine
}

/** Eaon's own processes: its windows belong to the main one, and helpers are never apps worth acting on. */
function ownPids(): ReadonlySet<number> {
  const pids = new Set<number>([process.pid])
  try {
    for (const metric of app.getAppMetrics()) pids.add(metric.pid)
  } catch {
    // Before ready: the main process is the one that matters.
  }
  return pids
}

export const appControl = new AppControlService({
  platform: process.platform,
  engine: () => currentEngine(),
  engineInfo: () => ({ name: engineName(), detail: engineLaunch().detail }),
  settings,
  ownPids,
  clipboard: {
    readText: () => clipboard.readText(),
    writeText: (text) => clipboard.writeText(text),
    clear: () => clipboard.clear(),
    hasImage: () => !clipboard.readImage().isEmpty()
  },
  displays: () =>
    screen.getAllDisplays().map((display) => ({
      id: display.id,
      primary: display.id === screen.getPrimaryDisplay().id,
      bounds: [display.bounds.x, display.bounds.y, display.bounds.width, display.bounds.height],
      workArea: [display.workArea.x, display.workArea.y, display.workArea.width, display.workArea.height],
      scale: display.scaleFactor
    })),
  flash: (bounds, label) => flashOverlay(bounds, label),
  appVersion: app.getVersion()
})

registerToolSource({
  id: 'app-control',
  tools: (query) => {
    // Like computer use: the main agent only, not swarm sub-agents.
    if (!(query.mode === 'work' && query.depth === 0 && query.settings.appControl?.enabled)) return []
    return [appControlTool(appControl)]
  },
  guidance: () => appControlPromptNote()
})

/* --------------------------------------------------------- terminal agents */

const CLIENT_NAMES: Record<ControlClient, string> = {
  'claude-code': 'Claude Code',
  'eaon-cli': 'Eaon CLI',
  'app-control': APP_CONTROL_CLI
}

/**
 * The control API's tool. Takes `argv` (what `eaon-apps` was given, parsed
 * here) or `command` with `args`, and answers with the envelope, failures
 * included, so the caller always has one JSON object to read.
 */
export const appControlControlTool: ControlTool = {
  name: 'app_control',
  risk: 'write',
  description: [
    "Read and operate the user's desktop apps through their accessibility tree (no screenshots, no pointer). Send {\"command\": \"snapshot\", \"args\": {\"app\": \"Calculator\", \"interactive\": true}} or {\"argv\": [\"snapshot\", \"Calculator\", \"-i\"]}.",
    'Observe (snapshot, find), act on refs (click, type, set-value, select, menu, press), verify (each action returns `after`; wait). Start with {"command": "guide"} for every command.'
  ].join(' '),
  input: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'A command, e.g. snapshot, find, click, type, menu, press, wait, guide' },
      args: { type: 'object', description: "The command's arguments, e.g. {\"app\": \"Notes\", \"interactive\": true} or {\"ref\": \"@s4k2p9xq:e12\"}" },
      argv: { type: 'array', items: { type: 'string' }, description: 'Instead of command and args: eaon-apps arguments' }
    },
    additionalProperties: false
  },
  run: async (input, client): Promise<AppControlEnvelope> => {
    let command = typeof input.command === 'string' ? input.command : ''
    let args = input.args && typeof input.args === 'object' && !Array.isArray(input.args) ? (input.args as Record<string, unknown>) : {}
    if (Array.isArray(input.argv)) {
      try {
        ;({ command, args } = parseArgv(input.argv.map(String)))
      } catch (error) {
        return { version: 1, ok: false, command: String(input.argv[0] ?? ''), error: toError(error) }
      }
    }
    if (!command) command = 'guide'
    const always = ['guide', 'status', 'version'].includes(findCommand(command)?.name ?? '')
    if (!always && !(settings().enabled && settings().terminalAgents)) {
      return {
        version: 1,
        ok: false,
        command,
        error: { code: 'DISABLED', message: "Coding agents can't use app control right now.", hint: 'The user can turn it on in Eaon → Settings → App control → Coding agents in the ADE.' }
      }
    }
    const source: AppControlSource = { kind: 'terminal', name: client ? CLIENT_NAMES[client] : 'A terminal agent' }
    return appControl.run(command, args, source)
  }
}

/** Where the `eaon-apps` launcher lives: Eaon's data folder, rewritten each start (Eaon may have moved). */
const binDir = (): string => join(app.getPath('userData'), 'app-control', 'bin')

function writeLauncher(): void {
  const cli = join(resourcesDir(), 'cli', 'eaon-apps.mjs')
  const dir = binDir()
  mkdirSync(dir, { recursive: true })
  if (process.platform === 'win32') {
    writeFileSync(join(dir, `${APP_CONTROL_CLI}.cmd`), `@echo off\r\nrem Installed by Eaon Desktop: app control from ADE terminals.\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${cli}" %*\r\n`)
    return
  }
  const quote = (path: string): string => `'${path.replace(/'/g, `'\\''`)}'`
  const file = join(dir, APP_CONTROL_CLI)
  writeFileSync(file, `#!/bin/sh\n# Installed by Eaon Desktop: app control from ADE terminals.\nELECTRON_RUN_AS_NODE=1 exec ${quote(process.execPath)} ${quote(cli)} "$@"\n`)
  chmodSync(file, 0o755)
}

/**
 * What an ADE terminal gets while coding agents may use app control: the
 * launcher on PATH, and where and how to reach Eaon. Starts the Local API
 * Server if it is off (the control API is part of it), as Eaon CLI panes do.
 */
export async function appControlPaneEnv(): Promise<Record<string, string>> {
  const current = settings()
  if (!current.enabled || !current.terminalAgents) return {}
  try {
    const info = await ensureGatewayRunning()
    return {
      EAON_APPS_URL: `http://127.0.0.1:${info.port}/control/v1/tools/app_control`,
      EAON_APPS_KEY: appControlToken() ?? '',
      PATH: [binDir(), process.env.PATH ?? ''].filter(Boolean).join(delimiter)
    }
  } catch {
    return {}
  }
}

/* --------------------------------------------------------------- settings */

/** What the try-it panel may run: it only looks. */
const TRY_COMMANDS = new Set(['status', 'list-apps', 'list-windows', 'snapshot', 'find', 'get', 'is', 'list-surfaces', 'focused', 'list-displays'])

export const appControlFeature: Feature = {
  id: 'app-control',
  register: ({ ipcMain, send }) => {
    try {
      writeLauncher()
    } catch {
      // Without it `eaon-apps` isn't found; Claude Code's MCP tool still works.
    }
    appControl.trace.onEntry((entry) => send('app-control:activity-added', entry))
    ipcMain.handle('app-control:status', () => appControl.status())
    ipcMain.handle('app-control:commands', () => commandInfo())
    ipcMain.handle('app-control:activity', (_e, limit?: number) => appControl.trace.recent(typeof limit === 'number' ? limit : 100))
    ipcMain.handle('app-control:clear-activity', () => appControl.trace.clear())
    ipcMain.handle('app-control:try', async (_e, command: string, args: Record<string, unknown>) => {
      const name = findCommand(String(command))?.name
      if (!name || !TRY_COMMANDS.has(name)) {
        return { version: 1, ok: false, command: String(command), error: toError(new AppControlFailure('INVALID_ARGS', 'The try-it panel only reads.')) }
      }
      return appControl.run(name, args && typeof args === 'object' ? args : {}, { kind: 'settings', name: 'Settings' })
    })
    ipcMain.handle('app-control:open-permission', async () => {
      if (process.platform !== 'darwin') return
      // Asking adds Eaon to the list, so the user has a switch to turn on rather than a "+" to hunt for.
      systemPreferences.isTrustedAccessibilityClient(true)
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
    })
  },
  dispose: () => {
    engine?.dispose()
    engine = null
    disposeOverlay()
  }
}
