import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

/**
 * Eaon worker host: the app Eaon Desktop installs on a worker computer (and keeps up to date).
 *
 *   electron eaon-host.mjs                       workers, each with its own browser
 *   ELECTRON_RUN_AS_NODE=1 electron eaon-host-node.mjs   workers without browsers
 *   electron eaon-host.mjs --smoke               can this computer run the browsers? (install.sh asks)
 *
 * Its settings are `~/.eaon-host/host.json` (port, link secret, name), its
 * profile `~/.eaon-host/data`. install.sh writes both, and runs it as a
 * service so it starts with the computer.
 */

declare const __EAON_HOST_RUNTIME__: 'electron' | 'node'
declare const __EAON_HOST_BUILD__: string
declare const __EAON_APP_VERSION__: string

const RUNTIME = __EAON_HOST_RUNTIME__
const home = process.env.EAON_HOST_HOME || join(homedir(), '.eaon-host')
const userData = join(home, 'data')

/** Opens a hidden window and paints a page, as a worker's browser will. Exit 0 when that works. */
async function smoke(): Promise<void> {
  const timer = setTimeout(() => {
    console.log('EAON_HOST_SMOKE timeout')
    app.exit(3)
  }, 45_000)
  try {
    await app.whenReady()
    const window = new BrowserWindow({ show: false, width: 640, height: 480, webPreferences: { sandbox: true, partition: 'smoke' } })
    await window.loadURL('data:text/html,<title>ok</title><h1>Eaon</h1>')
    let painted = false
    for (let i = 0; i < 10 && !painted; i++) {
      try {
        painted = !(await window.webContents.capturePage()).isEmpty()
      } catch {
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    clearTimeout(timer)
    console.log(painted ? 'EAON_HOST_SMOKE ok' : 'EAON_HOST_SMOKE blank')
    app.exit(painted ? 0 : 2)
  } catch (error) {
    console.log(`EAON_HOST_SMOKE failed ${error instanceof Error ? error.message : error}`)
    app.exit(1)
  }
}

async function main(): Promise<void> {
  // The define itself, not RUNTIME: esbuild drops the branch the other bundle never takes, imports included.
  if (__EAON_HOST_RUNTIME__ === 'electron') {
    app.setName('Eaon Host')
    app.setPath('userData', userData)
    // No screen to speak of: no GPU, and keys kept in the profile (0700) rather than a keyring nobody unlocks.
    app.commandLine.appendSwitch('disable-gpu')
    app.commandLine.appendSwitch('password-store', 'basic')
    // Workers' browsers send their traffic through BetterWright's policy proxy;
    // these keep QUIC and WebRTC from going around it. Before ready, as in the
    // desktop's main/index.ts (and betterwright/electron's configureElectronNetwork).
    app.commandLine.appendSwitch('disable-quic')
    app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp')
    ;(app as unknown as { dock?: { hide: () => void } }).dock?.hide()
    if (process.argv.includes('--smoke')) return smoke()
    // No windows is the normal state here.
    app.on('window-all-closed', () => undefined)
    await app.whenReady()
    // The permission rules the desktop gives its workers' browsers (every page here is a web page).
    const { installSessionPolicy } = await import('@main/security/hardening')
    installSessionPolicy(() => false)
  } else {
    process.env.EAON_CLI_HOME = userData
    // Keys stay in the profile (0700, files 0600) rather than a keychain item of
    // Eaon CLI's, which a service with no one logged in couldn't unlock anyway.
    const { safeStorage } = await import('electron')
    ;(safeStorage as { isEncryptionAvailable: () => boolean }).isEncryptionAvailable = () => false
  }

  let config: { port: number; secret: string; name?: string }
  try {
    config = JSON.parse(readFileSync(join(home, 'host.json'), 'utf8'))
    if (!config.secret || !config.port) throw new Error('incomplete')
  } catch {
    console.error(`[host] ${join(home, 'host.json')} is missing or incomplete. Link this computer from Eaon Desktop → Settings → Worker computer.`)
    process.exit(2)
  }

  const browserNote =
    RUNTIME === 'node' ? process.env.EAON_HOST_BROWSER_NOTE || 'This computer can’t run Eaon’s browser, so its workers work without one.' : null
  const { bootHost } = await import('./boot')
  const host = await bootHost({ home, config, runtime: RUNTIME, browserNote, build: __EAON_HOST_BUILD__, appVersion: __EAON_APP_VERSION__ })

  let quitting = false
  const quit = (): void => {
    if (quitting) return
    quitting = true
    void host.stop().finally(() => process.exit(0))
  }
  process.on('SIGTERM', quit)
  process.on('SIGINT', quit)
  process.on('uncaughtException', (error) => console.error('[host] uncaught:', error))
  process.on('unhandledRejection', (error) => console.error('[host] unhandled rejection:', error))
}

void main().catch((error) => {
  console.error('[host] failed to start:', error)
  process.exit(1)
})
