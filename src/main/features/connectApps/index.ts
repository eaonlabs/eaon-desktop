import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type { ConnectAppId, ConnectChoice, RestartResult } from '@shared/connectApps'
import { ensureGatewayRunning, gatewayInfo } from '../../gateway'
import { onPath } from '../../shellEnv'
import type { Feature } from '../types'
import { openTerminal, writeLaunchScript } from './launch'
import { ConnectApps } from './service'
import { StateFile } from './state'

/** Runs a program with `input` on stdin; resolves with stdout, rejects with stderr. */
function runWithInput(command: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill(), 30_000)
    child.stdout.on('data', (chunk) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr.trim().split('\n').slice(-3).join('\n') || `${command} exited with ${code}`))
    })
    child.stdin.end(input ?? '')
  })
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Whether a Mac app's main process is running, by its executable's name. */
const macAppRunning = (name: string): Promise<boolean> =>
  runWithInput('/usr/bin/pgrep', ['-x', name]).then(
    () => true,
    () => false
  )

/**
 * Quits a Mac app if it's open, and opens it. The quit is a SIGTERM, which an
 * Electron app like ChatGPT takes as an ordinary Quit (its windows close and
 * its own quit handlers run). Asking it to quit over AppleScript would need
 * Apple Events permission, and a "Eaon wants to control ChatGPT" prompt.
 */
async function restartMacApp(name: string): Promise<RestartResult> {
  try {
    const wasOpen = await macAppRunning(name)
    if (wasOpen) {
      await runWithInput('/usr/bin/pkill', ['-TERM', '-x', name]).catch(() => undefined)
      for (let i = 0; i < 60 && (await macAppRunning(name)); i++) await sleep(250)
      if (await macAppRunning(name)) {
        return { ok: false, error: `${name} didn't quit. It may be asking you something; check it, then try again.` }
      }
    }
    await runWithInput('/usr/bin/open', ['-a', name])
    return { ok: true, action: wasOpen ? 'reopened' : 'opened' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

let service: ConnectApps | null = null

function connectApps(): ConnectApps {
  return (service ??= new ConnectApps({
    // EAON_CONNECT_APPS_HOME: a stand-in home folder, so a capture or smoke run never edits the real apps' settings.
    home: process.env['EAON_CONNECT_APPS_HOME'] || homedir(),
    platform: process.platform,
    state: StateFile.in(app.getPath('userData')),
    info: gatewayInfo,
    ensureRunning: ensureGatewayRunning,
    which: onPath,
    run: runWithInput,
    openTerminal: (name, title, spec) =>
      openTerminal(writeLaunchScript(join(app.getPath('userData'), 'connect-apps'), name, spec, process.platform), title),
    ...(process.platform === 'darwin' ? { restartApp: restartMacApp, appRunning: macAppRunning } : {})
  }))
}

/** Settings → Connect apps: pointing Claude Code, Codex, OpenCode… at Eaon's gateway. */
export const connectAppsFeature: Feature = {
  id: 'connect-apps',
  register: ({ ipcMain }) => {
    ipcMain.handle('connect-apps:list', () => connectApps().list())
    ipcMain.handle('connect-apps:connect', (_e, id: ConnectAppId, choice?: Partial<ConnectChoice>) => connectApps().connect(id, choice))
    ipcMain.handle('connect-apps:disconnect', (_e, id: ConnectAppId) => connectApps().disconnect(id))
    ipcMain.handle('connect-apps:launch', (_e, id: ConnectAppId, choice?: Partial<ConnectChoice>) => connectApps().launch(id, choice))
    ipcMain.handle('connect-apps:manual', (_e, id: ConnectAppId, choice?: Partial<ConnectChoice>) => connectApps().manual(id, choice))
    ipcMain.handle('connect-apps:running', (_e, id: ConnectAppId) => connectApps().running(id))
    ipcMain.handle('connect-apps:restart', (_e, id: ConnectAppId) => connectApps().restart(id))
    // Connections an older Eaon made, or made before the gateway's port or key changed, are put
    // right on their own. A few seconds in, once providers (and so the models) have loaded.
    setTimeout(() => {
      void connectApps()
        .refreshStale()
        .then((fixed) => {
          if (fixed.length) console.log(`[connect-apps] reconnected ${fixed.join(', ')}`)
        })
    }, 5_000).unref()
  }
}
