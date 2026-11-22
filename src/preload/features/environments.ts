import { ipcRenderer } from 'electron'
import type { BringBackResult, CloudEnvironment, ExeAccount, GrabRequest, GrabResult, PrepareProgress, PrepareRequest, PrepareResult, ProviderStatus, SessionPlace } from '@shared/environments'

/**
 * Renderer bridge for cloud environments (Settings → Environments, the
 * picker under the message box, the ADE's New session). Exposed as
 * `window.api.environments`. Keep every channel this feature uses in this file.
 */
export const environmentsApi = {
  /** Who this computer's SSH key is on exe.dev, and their VMs; or why it can't be used. */
  exeAccount: (): Promise<ExeAccount> => ipcRenderer.invoke('environments:exe-account'),
  /** The CLI sniffer: each VM provider's command-line tool on this computer, signed in or not, and its machines. */
  providers: (): Promise<ProviderStatus[]> => ipcRenderer.invoke('environments:providers'),
  /** A provider's machine, picked, as an environment (not saved yet). */
  grab: (req: GrabRequest): Promise<GrabResult> => ipcRenderer.invoke('environments:grab', req),
  /** An environment being removed: what Eaon made to reach its machine (a Freestyle token) is taken back. */
  forget: (env: CloudEnvironment): Promise<{ ok: true } | { ok: false; error: string }> => ipcRenderer.invoke('environments:forget', env),
  /** Whether an environment can be reached, in words. */
  check: (env: CloudEnvironment): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('environments:check', env),
  /** Makes the place a session runs in, with a copy of the project; steps come to `onProgress`. */
  prepare: (req: PrepareRequest): Promise<PrepareResult> => ipcRenderer.invoke('environments:prepare', req),
  /** Stops a preparation (the VM made for it is deleted). */
  cancel: (key: string): Promise<void> => ipcRenderer.invoke('environments:cancel', key),
  onProgress: (handler: (progress: PrepareProgress) => void): (() => void) => {
    const listener = (_e: unknown, progress: PrepareProgress): void => handler(progress)
    ipcRenderer.on('environments:progress', listener)
    return () => ipcRenderer.removeListener('environments:progress', listener)
  },
  /** What a session did on its machine, as a branch in the project here. */
  bringBack: (place: SessionPlace, name: string): Promise<BringBackResult> => ipcRenderer.invoke('environments:bring-back', place, name),
  /** Deletes an exe.dev VM, and everything on it. */
  removeVm: (name: string): Promise<{ ok: true } | { ok: false; error: string }> => ipcRenderer.invoke('environments:remove-vm', name)
}
