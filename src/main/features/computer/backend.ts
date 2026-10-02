import { screen } from 'electron'
import type { InputBackend } from './input'
import { LinuxInput } from './linux'
import { MacInput } from './mac'
import { WindowsInput } from './windows'

/**
 * The input backend for this platform, created on first use. One instance for
 * the app's lifetime: its helper process is the expensive part (the JXA
 * bridge, PowerShell's C# compile) and is shared by every turn.
 */

let backend: InputBackend | null = null

export function inputBackend(): InputBackend {
  if (backend) return backend
  if (process.platform === 'darwin') backend = new MacInput()
  else if (process.platform === 'win32') {
    // Windows' SetCursorPos takes physical pixels; Electron knows each
    // monitor's scale, so the conversion happens here rather than in the helper.
    backend = new WindowsInput(
      (p) => screen.dipToScreenPoint(p),
      (p) => screen.screenToDipPoint(p)
    )
  } else backend = new LinuxInput(() => screen.getPrimaryDisplay().scaleFactor)
  return backend
}

/**
 * Kills the helper mid-action (emergency stop). The next call starts a fresh
 * one, so nothing queued in the old helper — the rest of a long `type` — runs.
 */
export function interruptInput(): void {
  backend?.dispose()
}

/** Tests swap in a recording backend so approval paths are checked without real input. */
export function setInputBackend(replacement: InputBackend | null): void {
  backend?.dispose()
  backend = replacement
}

export function disposeInput(): void {
  backend?.dispose()
  backend = null
}
