import { ipcRenderer } from 'electron'
import type { BrowserControlStatus } from '@shared/browserUse'

/** Settings → Browser control (main/features/browserUse.ts). */
export const browserControlApi = {
  status: (): Promise<BrowserControlStatus> => ipcRenderer.invoke('browser-control:status'),
  /** Installs Browser Use and turns browser control on; `onProgress` gets each step. */
  setup: (): Promise<BrowserControlStatus> => ipcRenderer.invoke('browser-control:setup'),
  onProgress: (handler: (step: string) => void): (() => void) => {
    const listener = (_e: unknown, step: string): void => handler(step)
    ipcRenderer.on('browser-control:progress', listener)
    return () => ipcRenderer.removeListener('browser-control:progress', listener)
  },
  /** Opens the browser's page with the "Allow remote debugging" switch. */
  openInspect: (browserId: string | null): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('browser-control:open-inspect', browserId),
  disconnect: (): Promise<BrowserControlStatus> => ipcRenderer.invoke('browser-control:disconnect'),
  /** Removes Browser Use and its Python, and turns browser control off. */
  remove: (): Promise<BrowserControlStatus> => ipcRenderer.invoke('browser-control:remove')
}
