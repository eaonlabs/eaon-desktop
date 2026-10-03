import { ipcRenderer } from 'electron'
import type { ComputerTestResult, ComputerUseStatus, PermissionKind } from '@shared/computerUse'

/**
 * Renderer bridge for the computerUse feature. Exposed as `window.api.computerUse`.
 * Keep every channel this feature uses in this one file.
 */
export const computerUseApi = {
  /** Permissions, input backend, displays; cheap enough to poll while Settings is open. */
  status: (): Promise<ComputerUseStatus> => ipcRenderer.invoke('computer-use:status'),
  /** Takes a screenshot exactly as the agent would receive it. */
  test: (): Promise<ComputerTestResult> => ipcRenderer.invoke('computer-use:test'),
  /** Asks macOS for `kind` (which adds Eaon to its list, and may show the system prompt), then opens its privacy pane. */
  openPermission: (kind: PermissionKind): Promise<void> => ipcRenderer.invoke('computer-use:open-permission', kind),
  /** Quits and reopens Eaon so a new Screen Recording grant applies; false when it cannot (development). */
  relaunch: (): Promise<boolean> => ipcRenderer.invoke('computer-use:relaunch'),
  /** Clears Eaon's Accessibility entry (a stale one from an older copy) and asks again. */
  resetAccessibility: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('computer-use:reset-accessibility'),
  /** Same as the emergency-stop shortcut. */
  stop: (): Promise<void> => ipcRenderer.invoke('computer-use:stop')
}
