import { ipcRenderer } from 'electron'
import type { CreateVmRequest, VmChange, VmDevice, VmDeviceState, VmExecResult, VmLogin, VmStatus, VmToolsResult } from '@shared/vms'

/**
 * Renderer bridge for virtual machines (the Computers page and its live
 * view). Exposed as `window.api.vms`. Keep every channel this feature uses in
 * this file.
 */
const call = <T>(device: VmDevice, method: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke('vms:call', device, method, ...args)

export const vmsApi = {
  /** This computer and the worker computer (when one is linked), with what each can run and its VMs. */
  devices: (): Promise<VmDeviceState[]> => ipcRenderer.invoke('vms:devices'),
  create: (device: VmDevice, request: CreateVmRequest): Promise<VmStatus> => call(device, 'create', request),
  /** Stops making a VM and deletes what there was of it. */
  cancel: (device: VmDevice, id: string): Promise<void> => call(device, 'cancel', id),
  start: (device: VmDevice, id: string): Promise<VmStatus> => call(device, 'start', id),
  /** Asks the guest to shut down; `force` turns it off at once. */
  stop: (device: VmDevice, id: string, force?: boolean): Promise<VmStatus> => call(device, 'stop', id, force),
  remove: (device: VmDevice, id: string): Promise<void> => call(device, 'remove', id),
  update: (device: VmDevice, id: string, change: VmChange): Promise<VmStatus> => call(device, 'update', id, change),
  snapshot: (device: VmDevice, id: string, name?: string): Promise<VmStatus> => call(device, 'snapshot', id, name),
  restore: (device: VmDevice, id: string, snapshotId: string): Promise<VmStatus> => call(device, 'restore', id, snapshotId),
  deleteSnapshot: (device: VmDevice, id: string, snapshotId: string): Promise<VmStatus> => call(device, 'deleteSnapshot', id, snapshotId),
  /** The account inside, for its lock screen. */
  login: (device: VmDevice, id: string): Promise<VmLogin> => call(device, 'login', id),
  exec: (device: VmDevice, id: string, command: string, timeoutMs?: number): Promise<VmExecResult> => call(device, 'exec', id, command, timeoutMs),
  /** Installs QEMU (and KVM access) on a Linux computer. */
  installTools: (device: VmDevice): Promise<VmToolsResult> => call(device, 'installTools'),
  /** A macOS restore image (.ipsw) on this computer, or null if none was chosen. */
  pickIpsw: (): Promise<string | null> => ipcRenderer.invoke('vms:pick-ipsw'),
  onChanged: (handler: (device: VmDevice, vms: VmStatus[]) => void): (() => void) => {
    const listener = (_e: unknown, device: VmDevice, vms: VmStatus[]): void => handler(device, vms)
    ipcRenderer.on('vms:changed', listener)
    return () => ipcRenderer.removeListener('vms:changed', listener)
  },
  /** Opens the VM's screen; its VNC bytes then arrive through `onScreenData` for this session. */
  openScreen: (device: VmDevice, id: string): Promise<{ session: string; password: string | null }> => ipcRenderer.invoke('vms:vnc-open', device, id),
  sendScreen: (session: string, data: Uint8Array): void => ipcRenderer.send('vms:vnc-send', session, data),
  closeScreen: (session: string): Promise<void> => ipcRenderer.invoke('vms:vnc-close', session),
  onScreenData: (handler: (session: string, data: Uint8Array) => void): (() => void) => {
    const listener = (_e: unknown, session: string, data: Uint8Array): void => handler(session, data)
    ipcRenderer.on('vms:vnc-data', listener)
    return () => ipcRenderer.removeListener('vms:vnc-data', listener)
  },
  onScreenClosed: (handler: (session: string) => void): (() => void) => {
    const listener = (_e: unknown, session: string): void => handler(session)
    ipcRenderer.on('vms:vnc-closed', listener)
    return () => ipcRenderer.removeListener('vms:vnc-closed', listener)
  }
}
