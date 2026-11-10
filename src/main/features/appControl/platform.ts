import { accessSync, constants, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app } from 'electron'
import type { HelperLaunch } from './helper'

/**
 * Which engine each OS runs, and where it is.
 *
 * - macOS: a small Swift program (native/app-control/mac, built by
 *   scripts/build-app-control.mjs) on the AX API. Eaon's child, so its
 *   Accessibility access is Eaon's.
 * - Windows: a PowerShell script hosting C# on UI Automation, which ships
 *   with Windows.
 * - Linux: a Python script on AT-SPI through PyGObject (python3-gi and the
 *   Atspi typelib, which desktop distributions install with the desktop).
 *
 * All three speak the same line protocol (protocol.ts).
 */

/** <Resources>/app-control when packaged, resources/app-control next to out/ in development. */
export function resourcesDir(): string {
  if (process.env.EAON_APP_CONTROL_DIR) return process.env.EAON_APP_CONTROL_DIR
  return app.isPackaged ? join(process.resourcesPath, 'app-control') : fileURLToPath(new URL('../../resources/app-control', import.meta.url))
}

function runnable(path: string): boolean {
  try {
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

export const ENGINE_NAMES: Record<string, string> = {
  darwin: 'macOS Accessibility',
  win32: 'Windows UI Automation',
  linux: 'AT-SPI'
}

export function engineName(platform: NodeJS.Platform = process.platform): string {
  return ENGINE_NAMES[platform] ?? ENGINE_NAMES.linux
}

/** How to start this OS's engine, or why it can't be. */
export function engineLaunch(platform: NodeJS.Platform = process.platform): { launch: HelperLaunch | null; detail: string | null } {
  const dir = resourcesDir()
  if (platform === 'darwin') {
    const binary = process.env.EAON_APP_CONTROL_HELPER || join(dir, 'darwin', 'eaon-app-control')
    if (!runnable(binary)) return { launch: null, detail: 'This build doesn’t include the macOS engine (scripts/build-app-control.mjs builds it).' }
    return { launch: { command: binary, args: [] }, detail: null }
  }
  if (platform === 'win32') {
    const script = join(dir, 'win32', 'eaon-app-control.ps1')
    if (!existsSync(script)) return { launch: null, detail: 'This build doesn’t include the Windows engine.' }
    const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    return { launch: { command: existsSync(shell) ? shell : 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script] }, detail: null }
  }
  const script = join(dir, 'linux', 'eaon_app_control.py')
  if (!existsSync(script)) return { launch: null, detail: 'This build doesn’t include the Linux engine.' }
  // -I: ignore PYTHON* variables and the user's site-packages, so nothing but the system's gi is imported.
  return { launch: { command: 'python3', args: ['-I', script], env: { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' } }, detail: null }
}
