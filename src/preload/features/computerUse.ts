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
  /** Opens the macOS privacy pane for `kind`; for Accessibility, also adds Eaon to its list. */
  openPermission: (kind: PermissionKind): Promise<void> => ipcRenderer.invoke('computer-use:open-permission', kind),
  /** Same as the emergency-stop shortcut. */
  stop: (): Promise<void> => ipcRenderer.invoke('computer-use:stop')
}
