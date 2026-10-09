import { execFile } from 'node:child_process'
import os from 'node:os'
import { app, shell } from 'electron'
import { CLI_TOOLS, type CliAccountsState, type CliTool } from '@shared/cliAccounts'
import { store } from '../../store'
import { loadPty } from '../terminals/ptyManager'
import type { Feature } from '../types'
import { claudeAuthStatus, claudeGetUsage, cliEnv, codexRead, findCli, loginArgs, logoutArgs } from './cli'
import { accountsRoot, CliAccounts, type LoginProcess } from './service'

/**
 * Settings → Accounts and the ADE's usage meter: which Claude Code and Codex
 * account Eaon's terminals use, and how much of each plan is left. See
 * service.ts for the accounts and cli.ts for how the CLIs are asked.
 *
 * Channels (all `cli-accounts:`): `state`, `refresh`, `use`, `rename`,
 * `remove`, `add`, `sign-in`, `login-input`, `login-cancel`, `login-dismiss`, `open-url`,
 * and the `changed` event.
 */

const FILE = 'cli-accounts.json'
/** While a window is showing the meter, the active accounts are read this often. */
const BACKGROUND_MS = 10 * 60_000
const LOGOUT_TIMEOUT_MS = 20_000

let accounts: CliAccounts | null = null
let timer: ReturnType<typeof setInterval> | null = null

/** The folder variables every ADE pane gets, so `claude` and `codex` run as the chosen accounts. */
export function cliAccountEnv(): Record<string, string> {
  return accounts?.terminalEnv() ?? {}
}

const isTool = (value: unknown): value is CliTool => CLI_TOOLS.includes(value as CliTool)

/** The CLI's sign-in in a wide terminal: it can open the browser, print its link, and ask for a code. */
function startLogin(tool: CliTool, bin: string, dir: string): LoginProcess {
  const proc = loadPty().spawn(bin, loginArgs(tool), { name: 'xterm-256color', cols: 400, rows: 40, cwd: os.tmpdir(), env: cliEnv(tool, dir) })
  return {
    write: (data) => proc.write(data),
    kill: () => {
      try {
        proc.kill()
      } catch {
        /* already gone */
      }
    },
    onData: (listener) => void proc.onData(listener),
    onExit: (listener) => void proc.onExit(({ exitCode }) => listener(exitCode))
  }
}

function logout(tool: CliTool, bin: string, dir: string): Promise<void> {
  return new Promise((resolve) => {
    execFile(bin, logoutArgs(tool), { cwd: os.tmpdir(), env: cliEnv(tool, dir), timeout: LOGOUT_TIMEOUT_MS, windowsHide: true }, () => resolve())
  })
}

export const cliAccountsFeature: Feature = {
  id: 'cli-accounts',
  register: ({ ipcMain, send, getWindows }) => {
    let changedTimer: ReturnType<typeof setTimeout> | null = null
    const service = new CliAccounts({
      runner: { find: (tool) => findCli(tool), claudeUsage: claudeGetUsage, claudeStatus: claudeAuthStatus, codexRead, logout },
      root: accountsRoot(app.getPath('userData')),
      load: () => store.getJson(FILE, {}),
      save: (saved) => store.setJson(FILE, saved),
      startLogin,
      // Coalesced: a refresh of four accounts is one update.
      changed: () => {
        if (changedTimer) return
        changedTimer = setTimeout(() => {
          changedTimer = null
          send('cli-accounts:changed', service.state())
        }, 50)
      }
    })
    accounts = service

    ipcMain.handle('cli-accounts:state', (): CliAccountsState => service.state())
    ipcMain.handle('cli-accounts:refresh', async (_e, options: { tool?: unknown; all?: unknown; force?: unknown } = {}) => {
      await service.refresh({ tool: isTool(options.tool) ? options.tool : undefined, all: options.all === true, force: options.force === true })
      return service.state()
    })
    ipcMain.handle('cli-accounts:use', (_e, tool: unknown, id: unknown) => {
      if (!isTool(tool) || typeof id !== 'string') throw new Error('Bad account')
      service.use(tool, id)
      return service.state()
    })
    ipcMain.handle('cli-accounts:rename', (_e, tool: unknown, id: unknown, label: unknown) => {
      if (!isTool(tool) || typeof id !== 'string' || typeof label !== 'string') throw new Error('Bad account')
      service.rename(tool, id, label)
      return service.state()
    })
    ipcMain.handle('cli-accounts:remove', async (_e, tool: unknown, id: unknown) => {
      if (!isTool(tool) || typeof id !== 'string') throw new Error('Bad account')
      await service.remove(tool, id)
      return service.state()
    })
    ipcMain.handle('cli-accounts:add', (_e, tool: unknown) => {
      if (!isTool(tool)) throw new Error('Bad tool')
      service.addAccount(tool)
      return service.state()
    })
    ipcMain.handle('cli-accounts:sign-in', (_e, tool: unknown, id: unknown) => {
      if (!isTool(tool) || typeof id !== 'string') throw new Error('Bad account')
      service.signIn(tool, id)
      return service.state()
    })
    ipcMain.handle('cli-accounts:login-input', (_e, text: unknown) => {
      if (typeof text === 'string' && text.length < 4000) service.loginInput(text)
    })
    ipcMain.handle('cli-accounts:login-cancel', () => service.cancelLogin())
    ipcMain.handle('cli-accounts:login-dismiss', () => service.dismissLogin())
    // Only the sign-in page the CLI itself printed.
    ipcMain.handle('cli-accounts:open-url', async () => {
      const login = service.state().login
      if (login.state === 'running' && login.url) await shell.openExternal(login.url)
    })

    // In the background only while someone could be looking: a window up and the meter on.
    timer = setInterval(() => {
      if (!store.getSettings().cliUsage.meter) return
      if (!getWindows().some((w) => w.isVisible() && !w.isMinimized())) return
      void service.refresh()
    }, BACKGROUND_MS)
    timer.unref?.()
  },
  dispose: () => {
    if (timer) clearInterval(timer)
    timer = null
    accounts?.dispose()
  }
}
