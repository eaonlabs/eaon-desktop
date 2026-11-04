import { basename } from 'node:path'
import type { AppInfo } from '@shared/appControl'
import { riskReason } from '../computer/actions'
import { failure } from './protocol'
import type { RefSummary } from './refs'

/**
 * What app control never does, whoever asks: read or act on Eaon itself
 * (an agent pressing Approve in its own approval prompt), on password
 * managers and the system's sign-in and authorization prompts, or type into
 * a password field. And which of the things it does do are risky enough
 * that Eaon's own agents ask first even in "Approve for me".
 */

interface Protected {
  name: string
  bundleIds?: string[]
  /** Executable or process names, compared without case or extension. */
  processes?: string[]
}

const PROTECTED: Protected[] = [
  { name: 'Eaon', bundleIds: ['dev.eaon.desktop', 'dev.eaon.desktop.beta'], processes: ['eaon', 'eaon desktop'] },
  { name: 'macOS sign-in and authorization prompts', bundleIds: ['com.apple.SecurityAgent', 'com.apple.loginwindow', 'com.apple.LocalAuthentication.UIAgent', 'com.apple.coreservices.uiagent', 'com.apple.ScreenSaver.Engine'] },
  { name: 'Keychain Access', bundleIds: ['com.apple.keychainaccess'] },
  { name: 'Passwords', bundleIds: ['com.apple.Passwords'] },
  { name: '1Password', bundleIds: ['com.1password.1password', 'com.agilebits.onepassword7', 'com.agilebits.onepassword-osx'], processes: ['1password'] },
  { name: 'Bitwarden', bundleIds: ['com.bitwarden.desktop'], processes: ['bitwarden'] },
  { name: 'KeePassXC', bundleIds: ['org.keepassxc.keepassxc'], processes: ['keepassxc', 'keepass'] },
  { name: 'Dashlane', bundleIds: ['com.dashlane.dashlanephonefinal', 'com.dashlane.Dashlane'], processes: ['dashlane'] },
  { name: 'LastPass', bundleIds: ['com.lastpass.LastPass'], processes: ['lastpass'] },
  { name: 'Enpass', bundleIds: ['in.sinew.Enpass-Desktop'], processes: ['enpass'] },
  { name: 'Proton Pass', bundleIds: ['me.proton.pass.electron'], processes: ['proton pass'] },
  { name: 'Windows sign-in and UAC prompts', processes: ['consent', 'credentialuibroker', 'logonui', 'lockapp'] },
  { name: 'Polkit and keyring prompts', processes: ['polkit-gnome-authentication-agent-1', 'polkit-kde-authentication-agent-1', 'gcr-prompter', 'seahorse', 'lxpolkit'] }
]

export const PROTECTED_NAMES = PROTECTED.map((entry) => entry.name)

const processName = (app: AppInfo): string => basename(app.path ?? app.name).replace(/\.(app|exe)$/i, '').toLowerCase()

/** Which protected entry an app is, or null. Eaon's own process counts whatever it's called (a dev build is "Electron"). */
export function protectedEntry(app: AppInfo, ownPids: ReadonlySet<number>): string | null {
  if (ownPids.has(app.pid)) return 'Eaon'
  const bundle = app.bundleId?.toLowerCase()
  const name = app.name.toLowerCase()
  const proc = processName(app)
  for (const entry of PROTECTED) {
    if (bundle && entry.bundleIds?.some((id) => id.toLowerCase() === bundle)) return entry.name
    if (entry.processes?.some((p) => p === name || p === proc)) return entry.name
  }
  return null
}

/** Throws PROTECTED for an app agents may not touch. */
export function assertAllowed(app: AppInfo, ownPids: ReadonlySet<number>): void {
  const entry = protectedEntry(app, ownPids)
  if (!entry) return
  if (entry === 'Eaon') {
    throw failure('PROTECTED', "App control doesn't read or operate Eaon itself.", 'Use Eaon\'s own tools for the app, and leave its approval prompts to the user.')
  }
  throw failure('PROTECTED', `App control doesn't read or operate ${entry}: it holds passwords or approves access.`, 'Ask the user to do this step themselves.')
}

/** Typing or setting a value in a password field is the user's job. */
export function assertNotSecret(summary: RefSummary | undefined): void {
  if (summary?.secure) {
    throw failure('PROTECTED', "App control doesn't type into password fields.", 'Ask the user to enter it themselves.')
  }
}

const TERMINAL_APPS = /\b(terminal|iterm2?|warp|ghostty|alacritty|kitty|wezterm|hyper|tabby|konsole|gnome-terminal|xterm|tilix|windows terminal|windowsterminal|powershell|cmd|conhost|wt)\b/i

/**
 * Why a command needs the user even in "Approve for me", or null: shortcuts
 * that quit, log out or delete; what reads like a destructive shell command,
 * typed into a terminal; force-quitting an app (unsaved work is lost).
 */
export function commandRisk(command: string, args: Record<string, unknown>, appName: string | null, platform: NodeJS.Platform): string | null {
  if (command === 'press') return riskReason({ action: 'key', keys: typeof args.keys === 'string' ? args.keys : '' }, platform)
  if ((command === 'type' || command === 'set-value') && typeof (args.text ?? args.value) === 'string') {
    // Words in a document are only words; in a terminal they run.
    if (!appName || !TERMINAL_APPS.test(appName)) return null
    const text = String(args.text ?? args.value)
    return riskReason({ action: 'type', text }, platform) ?? (/\n|\r/.test(text) ? 'types a command into a terminal and runs it' : null)
  }
  if (command === 'quit-app' && args.force === true) return 'force-quits an app, losing unsaved work'
  return null
}
