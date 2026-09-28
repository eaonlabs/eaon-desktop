import { app, Menu, Tray, type NativeImage } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * Running in the background, so scheduled tasks fire when nobody has Eaon open.
 *
 * Off by default because it changes what the OS does at login. When the user
 * turns it on (Scheduled page):
 *
 * - macOS: a per-user LaunchAgent starts Eaon at login with `--background`,
 *   which skips the window. A login item cannot do this on macOS 13+: there
 *   the Service Management API passes no arguments and ignores "open hidden".
 *   Closing the window already leaves the app running on macOS.
 * - Windows: a login item with `--background`, and closing the window leaves
 *   Eaon in the notification area instead of quitting.
 * - Linux: not offered; the app does not ship there yet.
 *
 * Quitting (⌘Q, or Quit in the tray menu) still stops everything. The
 * scheduler's catch-up rule covers the gap at the next launch.
 */

export const BACKGROUND_FLAG = '--background'
export const LAUNCH_AGENT_LABEL = 'dev.eaon.desktop.background'

export function backgroundSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'win32'
}

/** True when this process was started by the login mechanism above. */
export function launchedInBackground(argv: string[] = process.argv): boolean {
  return argv.includes(BACKGROUND_FLAG)
}

/**
 * The command line that starts this same app in background mode. A packaged
 * app is its executable; a development build is Electron plus its entry
 * script. A `--user-data-dir` carries over so a test profile stays a test
 * profile.
 */
export function backgroundCommand(argv: string[] = process.argv, execPath = process.execPath, packaged = app.isPackaged): string[] {
  // launchd starts agents from /, so a relative script path would not resolve.
  const base = packaged ? [execPath] : [execPath, ...(argv[1] ? [resolve(argv[1])] : [])]
  const userData = argv.find((arg) => arg.startsWith('--user-data-dir='))
  return [...base, BACKGROUND_FLAG, ...(userData ? [userData] : [])]
}

const xml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

/** The LaunchAgent: run once at login in the GUI session, never restarted by launchd. */
export function launchAgentPlist(command: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${command.map((arg) => `    <string>${xml(arg)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
`
}

export function launchAgentPath(home = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`)
}

/**
 * Makes the OS start Eaon at login (or stop doing so). Only files are
 * touched — no `launchctl` — so turning it off never kills a running Eaon
 * that launchd started; the agent simply is not loaded at the next login.
 */
export function applyRunAtLogin(enabled: boolean): void {
  if (process.platform === 'darwin') {
    const path = launchAgentPath()
    if (!enabled) {
      rmSync(path, { force: true })
      return
    }
    const plist = launchAgentPlist(backgroundCommand())
    // Rewritten only when it changed, e.g. after the app moved.
    if (existsSync(path) && readFileSync(path, 'utf8') === plist) return
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, plist)
    return
  }
  if (process.platform === 'win32') {
    const [path, ...args] = backgroundCommand()
    app.setLoginItemSettings({ openAtLogin: enabled, path, args })
  }
}

/* ------------------------------------------------------------------ tray */

let tray: Tray | null = null

/**
 * Windows only: with background on, closing the window leaves Eaon here, so
 * there has to be a way back in and a way to really quit.
 */
export async function syncTray(enabled: boolean, openWindow: () => void): Promise<void> {
  if (process.platform !== 'win32') return
  if (!enabled) {
    tray?.destroy()
    tray = null
    return
  }
  if (tray) return
  let icon: NativeImage
  try {
    icon = await app.getFileIcon(process.execPath, { size: 'small' })
  } catch {
    return
  }
  tray = new Tray(icon)
  tray.setToolTip('Eaon — scheduled tasks keep running')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Eaon', click: openWindow },
      { type: 'separator' },
      { label: 'Quit Eaon', click: () => app.quit() }
    ])
  )
  tray.on('click', openWindow)
}
