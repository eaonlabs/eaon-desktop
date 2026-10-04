import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Where the CLI keeps its own profile, and where Eaon Desktop keeps its.
 *
 * The CLI never writes into the desktop app's folder. Both run the same
 * engines (workers, trading sessions, the order ledger), and two processes
 * writing one ledger, or two workers engines waking the same worker, would
 * double every order and every turn. The CLI reads the desktop's files and
 * imports what it needs into its own profile instead (`core/desktop.ts`).
 */

/** The desktop app's name, which is also the folder and keychain names Electron derives from it. */
export const DESKTOP_APP_NAME = 'Eaon'
/** The CLI's own name, for its folder and its keychain entry. */
export const CLI_APP_NAME = 'Eaon CLI'

function appDataRoot(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support')
  if (process.platform === 'win32') return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
}

/** The CLI's profile folder: what Electron would call its `userData`. `EAON_CLI_HOME` moves it. */
export function cliHome(): string {
  if (process.env.EAON_CLI_HOME) return process.env.EAON_CLI_HOME
  // Linux folders under ~/.config are conventionally lower case without spaces.
  return join(appDataRoot(), process.platform === 'linux' ? 'eaon-cli' : CLI_APP_NAME)
}

/** Eaon Desktop's `userData`. `EAON_DESKTOP_DATA` points somewhere else (tests, a second copy). */
export function desktopHome(): string {
  return process.env.EAON_DESKTOP_DATA || join(appDataRoot(), DESKTOP_APP_NAME)
}
