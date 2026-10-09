import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, nativeTheme } from 'electron'
import { ensureGatewayRunning } from '../gateway'
import { onPath } from '../shellEnv'
import { store } from '../store'

/**
 * Eaon CLI: a fork of OpenCode (github.com/sst/opencode) that codes with the
 * open-source models downloaded in Eaon, and nothing else. The fork lives in
 * its own repository; scripts/build-eaon-cli.sh builds it into
 * resources/eaon-cli/<platform>/, which ships inside the app like llama-server.
 *
 * It reaches the models through the gateway's `/local/v1` routes, which serve
 * the downloaded models and never stand a cloud model in for one. A pane
 * running it is told where they are (`EAON_LOCAL_URL`, `EAON_LOCAL_KEY`); run
 * from any other terminal, it reads the same from Eaon's settings. The pane's
 * environment also says whether the app is light or dark, and its colours are
 * the app's own (the `eaon` theme in the fork).
 */

const platformDir = (): string => `${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
const binaryName = (): string => (process.platform === 'win32' ? 'eaon-cli.exe' : 'eaon-cli')

function executable(path: string | null | undefined): path is string {
  if (!path) return false
  try {
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The Eaon CLI binary: one named in EAON_CLI_BINARY, the app's own, or `eaon-cli` on PATH. */
export function eaonCliBinary(): string | null {
  const candidates = [
    process.env.EAON_CLI_BINARY || null,
    // Packaged: extraResources copies resources/eaon-cli to <Resources>/eaon-cli.
    app.isPackaged ? join(process.resourcesPath, 'eaon-cli', platformDir(), binaryName()) : null,
    // Development: the project's resources folder, next to out/.
    fileURLToPath(new URL(`../../resources/eaon-cli/${platformDir()}/${binaryName()}`, import.meta.url))
  ]
  return candidates.find(executable) ?? onPath('eaon-cli')
}

/**
 * What an Eaon CLI pane needs in its environment: where the downloaded models
 * are served. The server is started first if it is off (and from then on
 * starts with Eaon, so an Eaon CLI opened outside the ADE finds it too).
 */
export async function eaonCliEnv(): Promise<Record<string, string>> {
  const info = await ensureGatewayRunning()
  return {
    EAON_LOCAL_URL: `http://127.0.0.1:${info.port}/local/v1`,
    EAON_LOCAL_KEY: info.token,
    // Light or dark as the app is, so the CLI's colours match the pane around it.
    EAON_THEME_MODE: appIsDark() ? 'dark' : 'light'
  }
}

/** Whether the app is drawn dark right now: its own setting, else the system's. */
export function appIsDark(): boolean {
  const mode = store.getSettings().appearance.mode
  return mode === 'system' ? nativeTheme.shouldUseDarkColors : mode === 'dark'
}
