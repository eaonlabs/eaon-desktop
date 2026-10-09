import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The user's own Chromium browsers, and how Browser Use reaches one: over
 * the Chrome DevTools Protocol, once the user has allowed remote debugging
 * in it (chrome://inspect/#remote-debugging, a switch they turn on once).
 * The browser then writes DevToolsActivePort in its profile folder, and asks
 * the user to Allow each new debugging connection — no extension involved.
 */

export interface ChromiumBrowser {
  id: string
  name: string
  /** The macOS app name, for `open -a`. */
  app: string
  /** The inspect page, in the browser's own scheme. */
  inspect: string
  /** Its profile folder ("User Data"), per platform. */
  dirs: Partial<Record<'darwin' | 'win32' | 'linux', string>>
  /** Windows: the executable under Program Files / LocalAppData, to open the inspect page with. */
  winExe?: string
  /** Linux: the command. */
  linuxBin?: string
}

const mac = (path: string): string => join(homedir(), 'Library', 'Application Support', path)
const win = (path: string): string => join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), path)
const linux = (path: string): string => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), path)

export const BROWSERS: ChromiumBrowser[] = [
  {
    id: 'chrome',
    name: 'Chrome',
    app: 'Google Chrome',
    inspect: 'chrome://inspect/#remote-debugging',
    dirs: { darwin: mac('Google/Chrome'), win32: win('Google\\Chrome\\User Data'), linux: linux('google-chrome') },
    winExe: 'Google\\Chrome\\Application\\chrome.exe',
    linuxBin: 'google-chrome'
  },
  { id: 'comet', name: 'Comet', app: 'Comet', inspect: 'chrome://inspect/#remote-debugging', dirs: { darwin: mac('Comet'), win32: win('Perplexity\\Comet\\User Data') }, winExe: 'Perplexity\\Comet\\Application\\comet.exe' },
  { id: 'arc', name: 'Arc', app: 'Arc', inspect: 'chrome://inspect/#remote-debugging', dirs: { darwin: mac('Arc/User Data') } },
  { id: 'dia', name: 'Dia', app: 'Dia', inspect: 'chrome://inspect/#remote-debugging', dirs: { darwin: mac('Dia/User Data') } },
  {
    id: 'brave',
    name: 'Brave',
    app: 'Brave Browser',
    inspect: 'brave://inspect/#remote-debugging',
    dirs: { darwin: mac('BraveSoftware/Brave-Browser'), win32: win('BraveSoftware\\Brave-Browser\\User Data'), linux: linux('BraveSoftware/Brave-Browser') },
    winExe: 'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    linuxBin: 'brave-browser'
  },
  {
    id: 'edge',
    name: 'Edge',
    app: 'Microsoft Edge',
    inspect: 'edge://inspect/#remote-debugging',
    dirs: { darwin: mac('Microsoft Edge'), win32: win('Microsoft\\Edge\\User Data'), linux: linux('microsoft-edge') },
    winExe: 'Microsoft\\Edge\\Application\\msedge.exe',
    linuxBin: 'microsoft-edge'
  },
  {
    id: 'vivaldi',
    name: 'Vivaldi',
    app: 'Vivaldi',
    inspect: 'vivaldi://inspect/#remote-debugging',
    dirs: { darwin: mac('Vivaldi'), win32: win('Vivaldi\\User Data'), linux: linux('vivaldi') },
    linuxBin: 'vivaldi'
  },
  {
    id: 'chromium',
    name: 'Chromium',
    app: 'Chromium',
    inspect: 'chrome://inspect/#remote-debugging',
    dirs: { darwin: mac('Chromium'), win32: win('Chromium\\User Data'), linux: linux('chromium') },
    linuxBin: 'chromium'
  }
]

const platformKey = (): 'darwin' | 'win32' | 'linux' => (process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux')

export function profileDir(browser: ChromiumBrowser): string | null {
  return browser.dirs[platformKey()] ?? null
}

/** The browsers that have a profile on this computer, Chrome first. */
export function installedBrowsers(): ChromiumBrowser[] {
  return BROWSERS.filter((b) => {
    const dir = profileDir(b)
    return dir !== null && existsSync(dir)
  })
}

export function browserById(id: string | null | undefined): ChromiumBrowser | null {
  return BROWSERS.find((b) => b.id === id) ?? null
}

/**
 * The DevTools address of a running browser that allows remote debugging,
 * from the DevToolsActivePort file it writes (port, then the browser's
 * WebSocket path); null when it isn't running or hasn't been allowed.
 */
export function devtoolsUrl(dir: string): string | null {
  try {
    const [port, path] = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)
    if (!/^\d+$/.test(port?.trim() ?? '') || !path?.trim().startsWith('/devtools/browser/')) return null
    return `ws://127.0.0.1:${port.trim()}${path.trim()}`
  } catch {
    return null
  }
}

/**
 * Whether something answers on that address's port. A bare TCP connection:
 * opening the WebSocket itself would make the browser ask the user to Allow
 * a connection nobody is making yet. A stale file (the browser quit without
 * removing it) fails this.
 */
export async function listening(url: string, timeoutMs = 1500): Promise<boolean> {
  const { createConnection } = await import('node:net')
  const port = Number(new URL(url).port)
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const done = (ok: boolean): void => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** Opens the browser's page with the "Allow remote debugging" switch. */
export function openInspectPage(browser: ChromiumBrowser): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.platform === 'darwin') {
      execFile('open', ['-a', browser.app, browser.inspect], (error) => (error ? reject(new Error(`Couldn't open ${browser.name}.`)) : resolve()))
      return
    }
    let exe: string | undefined
    if (process.platform === 'win32') {
      const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean) as string[]
      exe = browser.winExe ? roots.map((r) => join(r, browser.winExe!)).find((p) => existsSync(p)) : undefined
    } else exe = browser.linuxBin
    if (!exe) return reject(new Error(`Open ${browser.inspect} in ${browser.name} yourself.`))
    // Started on its own: a browser that wasn't running yet would otherwise be waited on until it quits.
    const child = spawn(exe, [browser.inspect], { detached: true, stdio: 'ignore' })
    child.once('error', () => reject(new Error(`Couldn't open ${browser.name}. Open ${browser.inspect} in it yourself.`)))
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
