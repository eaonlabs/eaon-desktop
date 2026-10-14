import { execFile } from 'node:child_process'
import os from 'node:os'
import { app, Notification, shell } from 'electron'
import { CLI_TOOLS, limitNoticeText, type CliAccountsState, type CliTool, type LimitNotice } from '@shared/cliAccounts'
import { store } from '../../store'
import { loadPty } from '../terminals/ptyManager'
import type { Feature } from '../types'
import { claudeAuthStatus, claudeGetUsage, cliEnv, codexRead, findCli, loginArgs, logoutArgs } from './cli'
import { setCliAccounts } from './current'
import { accountsRoot, CliAccounts, type LoginProcess } from './service'

export { cliAccountEnv, cliToolEnv, onCliAccountChange } from './current'

/**
 * Settings → Accounts and the ADE's usage meter: which Claude Code and Codex
 * account Eaon's terminals (and its Codex engine) use, and how much of each
 * plan is left. See service.ts for the accounts and cli.ts for how the CLIs
 * are asked.
 *
 * Channels (all `cli-accounts:`): `state`, `refresh`, `use`, `rename`,
 * `remove`, `add`, `sign-in`, `login-input`, `login-cancel`, `login-dismiss`, `open-url`,
 * and the `changed` and `show` events.
 */

const FILE = 'cli-accounts.json'
/**
 * How often the background timer looks. While a window is up the active
 * accounts are read each time and the others every half hour; with none up,
 * only the active ones, every half hour, for the limit alerts.
 */
const BACKGROUND_MS = 10 * 60_000
const LOGOUT_TIMEOUT_MS = 20_000

let accounts: CliAccounts | null = null
let timer: ReturnType<typeof setInterval> | null = null
/** Held until clicked or closed: a collected notification loses its handlers. */
const notifications = new Set<Notification>()

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
      },
      alert: (notice) => alert(notice),
      autoSwitch: (tool) => tool === 'codex' && store.getSettings().cliUsage.autoSwitchCodex
    })
    accounts = service
    setCliAccounts(service)

    /**
     * A limit, as a system notification: when it resets, and the account
     * with room to move to — a button where the system has them (macOS),
     * otherwise a click opens the switcher.
     */
    const alert = (notice: LimitNotice): void => {
      if (!store.getSettings().cliUsage.alerts || !Notification.isSupported()) return
      const { title, body } = limitNoticeText(notice, Date.now())
      const offer = notice.switchTo && !notice.switched ? notice.switchTo : null
      const notification = new Notification({ title, body, ...(offer ? { actions: [{ type: 'button' as const, text: `Switch to ${offer.name}` }] } : {}) })
      notifications.add(notification)
      const done = (): void => void notifications.delete(notification)
      notification.on('action', () => {
        done()
        if (offer) service.use(notice.tool, offer.id)
      })
      notification.on('click', () => {
        done()
        const window = getWindows()[0]
        if (window) {
          if (window.isMinimized()) window.restore()
          window.show()
          window.focus()
        }
        send('cli-accounts:show', notice.tool)
      })
      notification.on('close', done)
      notification.show()
    }

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

    // While someone could be looking (a window up, the meter on), every account;
    // otherwise only what the alerts and the automatic switch need.
    timer = setInterval(() => {
      const { meter, alerts, autoSwitchCodex } = store.getSettings().cliUsage
      const visible = getWindows().some((w) => w.isVisible() && !w.isMinimized())
      if (visible && meter) void service.refresh({ background: 'visible' })
      else if (alerts || autoSwitchCodex) void service.refresh({ background: 'hidden' })
    }, BACKGROUND_MS)
    timer.unref?.()
  },
  dispose: () => {
    if (timer) clearInterval(timer)
    timer = null
    accounts?.dispose()
    setCliAccounts(null)
    notifications.clear()
  }
}
