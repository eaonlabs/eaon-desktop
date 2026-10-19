import { ipcRenderer } from 'electron'
import type { LockedSupport, LockedTerminal, LockedTerminalDraft, RcInfo, RcShare } from '@shared/rc'

/** Renderer bridge for Eaon Remote (rc.eaon.dev). Exposed as `window.api.rc`. */
export const rcApi = {
  info: (): Promise<RcInfo> => ipcRenderer.invoke('rc:info'),
  /** Asks the server for a code and opens the website to approve it; resolves with the code to check. */
  link: (): Promise<RcInfo> => ipcRenderer.invoke('rc:link'),
  cancelLink: (): Promise<RcInfo> => ipcRenderer.invoke('rc:cancel-link'),
  setEnabled: (enabled: boolean): Promise<RcInfo> => ipcRenderer.invoke('rc:set-enabled', enabled),
  /** Unlinks this computer here and on the server. */
  unlink: (): Promise<RcInfo> => ipcRenderer.invoke('rc:unlink'),
  /** Who this computer (or one of its terminals) is shared with on the website. */
  shares: (): Promise<RcShare[]> => ipcRenderer.invoke('rc:shares'),
  /** Takes a share back: their connection ends now. */
  revokeShare: (id: string): Promise<boolean> => ipcRenderer.invoke('rc:revoke-share', id),
  /** Locked terminals: a terminal for a friend, sandboxed to one folder. */
  lockedSupport: (): Promise<LockedSupport> => ipcRenderer.invoke('rc:locked-support'),
  lockedPickFolder: (): Promise<string | null> => ipcRenderer.invoke('rc:locked-pick-folder'),
  lockedList: (): Promise<LockedTerminal[]> => ipcRenderer.invoke('rc:locked-list'),
  /** Makes one and its invite link for the friend. */
  lockedCreate: (draft: LockedTerminalDraft): Promise<{ terminal: LockedTerminal; url: string }> => ipcRenderer.invoke('rc:locked-create', draft),
  /** Ends it: their terminal stops and its private home is deleted. */
  lockedRevoke: (id: string): Promise<boolean> => ipcRenderer.invoke('rc:locked-revoke', id),
  onStatus: (handler: (info: RcInfo) => void): (() => void) => {
    const listener = (_e: unknown, info: RcInfo): void => handler(info)
    ipcRenderer.on('rc:status', listener)
    return () => ipcRenderer.removeListener('rc:status', listener)
  }
}
