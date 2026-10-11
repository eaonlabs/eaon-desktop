import { ipcRenderer } from 'electron'
import type { RcInfo } from '@shared/rc'

/** Renderer bridge for Eaon Remote (rc.eaon.dev). Exposed as `window.api.rc`. */
export const rcApi = {
  info: (): Promise<RcInfo> => ipcRenderer.invoke('rc:info'),
  /** Asks the server for a code and opens the website to approve it; resolves with the code to check. */
  link: (): Promise<RcInfo> => ipcRenderer.invoke('rc:link'),
  cancelLink: (): Promise<RcInfo> => ipcRenderer.invoke('rc:cancel-link'),
  setEnabled: (enabled: boolean): Promise<RcInfo> => ipcRenderer.invoke('rc:set-enabled', enabled),
  /** Unlinks this computer here and on the server. */
  unlink: (): Promise<RcInfo> => ipcRenderer.invoke('rc:unlink'),
  onStatus: (handler: (info: RcInfo) => void): (() => void) => {
    const listener = (_e: unknown, info: RcInfo): void => handler(info)
    ipcRenderer.on('rc:status', listener)
    return () => ipcRenderer.removeListener('rc:status', listener)
  }
}
