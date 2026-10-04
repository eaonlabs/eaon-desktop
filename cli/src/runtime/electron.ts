/**
 * What the CLI build gets for `import … from 'electron'`.
 *
 * The CLI runs the desktop app's main-process code as it is — the agent
 * loop, providers, MCP, workers, trading — under plain Node. esbuild aliases
 * `electron` to this file (scripts/build-cli.mjs), the same trick the
 * main-process tests use with test/stubs/electron.ts. The parts that matter
 * outside a window are real here: `userData` is the CLI's profile,
 * `safeStorage` is a keychain-backed vault, `shell` opens things and moves
 * deleted files to the Trash, and `powerSaveBlocker` keeps a Mac awake
 * during a run. Window-only APIs are inert.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { cliOsCrypt } from './osCrypt'
import { CLI_APP_NAME, cliHome } from './paths'

declare const __EAON_CLI_VERSION__: string
const VERSION = typeof __EAON_CLI_VERSION__ === 'string' ? __EAON_CLI_VERSION__ : '0.0.0-dev'

function pathFor(name: string): string {
  const home = homedir()
  switch (name) {
    case 'userData':
      return cliHome()
    case 'home':
      return home
    case 'temp':
      return tmpdir()
    case 'downloads':
      return join(home, 'Downloads')
    case 'documents':
      return join(home, 'Documents')
    case 'desktop':
      return join(home, 'Desktop')
    case 'appData':
      return dirname(cliHome())
    case 'crashDumps':
      return join(cliHome(), 'crashes')
    default:
      return join(cliHome(), name)
  }
}

export const app = {
  name: CLI_APP_NAME,
  getName: () => CLI_APP_NAME,
  getPath: pathFor,
  getVersion: () => VERSION,
  getAppPath: () => process.cwd(),
  isPackaged: false,
  isReady: () => true,
  setName: () => {},
  on: () => app,
  once: () => app,
  emit: () => false,
  whenReady: () => Promise.resolve(),
  quit: () => process.emit('SIGTERM'),
  exit: (code = 0) => process.exit(code),
  relaunch: () => {},
  requestSingleInstanceLock: () => true,
  setLoginItemSettings: () => {},
  getLoginItemSettings: () => ({ openAtLogin: false }),
  commandLine: { appendSwitch: () => {}, hasSwitch: () => false, getSwitchValue: () => '' },
  dock: undefined
}

export const safeStorage = cliOsCrypt(CLI_APP_NAME)

/* ------------------------------------------------------------------ shell */

function openWith(target: string, reveal = false): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', reveal ? ['-R', target] : [target]]
      : process.platform === 'win32'
        ? ['explorer.exe', reveal ? [`/select,${target}`] : [target]]
        : ['xdg-open', [reveal ? dirname(target) : target]]
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    /* nothing to open it with */
  }
}

/** A name in `dir` that isn't taken yet: "notes.txt", "notes 2.txt", … */
function freeName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 2; ; i++) if (!existsSync(join(dir, `${stem} ${i}${ext}`))) return `${stem} ${i}${ext}`
}

/**
 * Moves a file to the Trash, as `shell.trashItem` does, so the agent's
 * deletes stay recoverable. A move across volumes, or a platform with no
 * Trash we can reach, falls back to a Trash folder inside the CLI profile.
 */
async function trashItem(path: string): Promise<void> {
  if (process.platform === 'win32') {
    const literal = path.replace(/'/g, "''")
    const script = `Add-Type -AssemblyName Microsoft.VisualBasic; if (Test-Path -LiteralPath '${literal}' -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${literal}','OnlyErrorDialogs','SendToRecycleBin') } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${literal}','OnlyErrorDialogs','SendToRecycleBin') }`
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' })
      child.on('error', () => resolve(false))
      child.on('close', (code) => resolve(code === 0))
    })
    if (ok) return
  } else {
    const trash = process.platform === 'darwin' ? join(homedir(), '.Trash') : join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'Trash')
    const filesDir = process.platform === 'darwin' ? trash : join(trash, 'files')
    try {
      mkdirSync(filesDir, { recursive: true })
      const name = freeName(filesDir, basename(path))
      renameSync(path, join(filesDir, name))
      if (process.platform !== 'darwin') {
        // freedesktop.org Trash spec: the info file lets a file manager restore it.
        mkdirSync(join(trash, 'info'), { recursive: true })
        writeFileSync(join(trash, 'info', `${name}.trashinfo`), `[Trash Info]\nPath=${encodeURI(path)}\nDeletionDate=${new Date().toISOString().slice(0, 19)}\n`)
      }
      return
    } catch {
      /* another volume, or no Trash: keep it in the profile instead */
    }
  }
  const fallback = join(cliHome(), 'Trash')
  mkdirSync(fallback, { recursive: true })
  try {
    renameSync(path, join(fallback, freeName(fallback, basename(path))))
  } catch {
    await rm(path, { recursive: true, force: true })
  }
}

export const shell = {
  openExternal: async (url: string) => openWith(url),
  openPath: async (path: string) => {
    openWith(path)
    return ''
  },
  showItemInFolder: (path: string) => openWith(path, true),
  trashItem,
  beep: () => process.stdout.write('\x07')
}

/* ------------------------------------------------------------ notifications */

type NotifyHook = (title: string, body: string) => void
/** The TUI sets this to show notifications as toasts. */
export function setNotificationHook(hook: NotifyHook | null): void {
  ;(globalThis as { __eaonNotify?: NotifyHook | null }).__eaonNotify = hook
}

export class Notification {
  static isSupported(): boolean {
    return typeof (globalThis as { __eaonNotify?: NotifyHook | null }).__eaonNotify === 'function'
  }
  private handlers = new Map<string, () => void>()
  constructor(public options: { title: string; body?: string }) {}
  on(event: string, handler: () => void): this {
    this.handlers.set(event, handler)
    return this
  }
  show(): void {
    ;(globalThis as { __eaonNotify?: NotifyHook | null }).__eaonNotify?.(this.options.title, this.options.body ?? '')
  }
  close(): void {}
}

/* ------------------------------------------------------ keeping the Mac up */

const blockers = new Map<number, ChildProcess | null>()
let nextBlocker = 1

/** `caffeinate` on macOS for as long as a run holds the blocker; nothing elsewhere. */
export const powerSaveBlocker = {
  start(_type: string): number {
    const id = nextBlocker++
    let child: ChildProcess | null = null
    if (process.platform === 'darwin') {
      try {
        child = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' })
        child.on('error', () => {})
      } catch {
        child = null
      }
    }
    blockers.set(id, child)
    return id
  },
  stop(id: number): void {
    blockers.get(id)?.kill()
    blockers.delete(id)
  },
  isStarted: (id: number) => blockers.has(id)
}

/* -------------------------------------------------- inert window-only APIs */

export const dialog = {
  showMessageBox: async () => ({ response: -1, checkboxChecked: false }),
  showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined })
}
export const crashReporter = { start: () => {} }
export const nativeTheme = { shouldUseDarkColors: true, themeSource: 'system', on: () => {} }
export const ipcMain = { handle: () => {}, on: () => {}, removeHandler: () => {} }
export const protocol = { handle: () => {} }
export const net = { fetch: (input: string | URL | Request, init?: RequestInit) => fetch(input, init) }

export class BrowserWindow {
  static getAllWindows = (): BrowserWindow[] => []
  static getFocusedWindow = (): BrowserWindow | null => null
  webContents = { on: () => {}, send: () => {}, setWindowOpenHandler: () => {}, isOffscreen: () => false, isDestroyed: () => true }
  setAlwaysOnTop(): void {}
  setVisibleOnAllWorkspaces(): void {}
  once(): void {}
  on(): void {}
  loadURL(): Promise<void> {
    return Promise.resolve()
  }
  isDestroyed(): boolean {
    return true
  }
  isFocused(): boolean {
    return false
  }
  destroy(): void {}
  close(): void {}
  show(): void {}
  showInactive(): void {}
  focus(): void {}
}

export const powerMonitor = { on: () => {}, getSystemIdleTime: () => 0 }
export const systemPreferences = {
  getMediaAccessStatus: () => 'not-determined',
  isTrustedAccessibilityClient: () => false,
  askForMediaAccess: async () => false
}
const primaryDisplay = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  workArea: { x: 0, y: 25, width: 1440, height: 875 },
  size: { width: 1440, height: 900 },
  scaleFactor: 2,
  workAreaSize: { width: 1440, height: 875 }
}
export const screen = {
  getPrimaryDisplay: () => primaryDisplay,
  getAllDisplays: () => [primaryDisplay],
  dipToScreenPoint: (p: { x: number; y: number }) => p,
  screenToDipPoint: (p: { x: number; y: number }) => p
}
export const desktopCapturer = { getSources: async () => [] }
export const globalShortcut = { register: () => false, unregister: () => {}, unregisterAll: () => {}, isRegistered: () => false }
export const nativeImage = {
  createFromBuffer: () => ({ getSize: () => ({ width: 1, height: 1 }), resize: () => ({ toJPEG: () => Buffer.alloc(0) }), toJPEG: () => Buffer.alloc(0), toPNG: () => Buffer.alloc(0) }),
  createFromPath: () => ({ isEmpty: () => true })
}
export class Tray {
  constructor(_icon: unknown) {}
  setToolTip(): void {}
  setContextMenu(): void {}
  on(): void {}
  destroy(): void {}
}
export const Menu = {
  buildFromTemplate: (template: unknown[]) => ({ items: template, popup: () => {} }),
  setApplicationMenu: () => {}
}

export default {
  app,
  safeStorage,
  shell,
  dialog,
  crashReporter,
  nativeTheme,
  ipcMain,
  protocol,
  net,
  BrowserWindow,
  Notification,
  powerSaveBlocker,
  powerMonitor,
  systemPreferences,
  screen,
  desktopCapturer,
  globalShortcut,
  nativeImage,
  Tray,
  Menu
}
