import { ipcRenderer } from 'electron'
import type { ModInfo, ModsList } from '@shared/mods'

export type ModInspectTarget = { kind: 'folder' } | { kind: 'file' } | { kind: 'url'; url: string } | { kind: 'indexed'; id: string }

export type ModInspectResult =
  | { ok: true; token: string; info: ModInfo }
  | { ok: false; error?: string; cancelled?: boolean }

/** Renderer bridge for mods (main/features/mods). Exposed as `window.api.mods`. */
export const modsApi = {
  list: (): Promise<ModsList> => ipcRenderer.invoke('mods:list'),
  installBundled: (id: string): Promise<ModsList> => ipcRenderer.invoke('mods:install-bundled', id),
  /** Reads a mod for review (a folder or file is picked in a dialog); install it with the token. */
  inspect: (target: ModInspectTarget): Promise<ModInspectResult> => ipcRenderer.invoke('mods:inspect', target),
  installStaged: (token: string): Promise<ModsList> => ipcRenderer.invoke('mods:install-staged', token),
  discardStaged: (token: string): Promise<void> => ipcRenderer.invoke('mods:discard-staged', token),
  uninstall: (id: string): Promise<ModsList> => ipcRenderer.invoke('mods:uninstall', id),
  setEnabled: (id: string, enabled: boolean): Promise<ModsList> => ipcRenderer.invoke('mods:set-enabled', id, enabled),
  addSource: (url: string): Promise<{ ok: true; list: ModsList } | { ok: false; error: string }> => ipcRenderer.invoke('mods:add-source', url),
  removeSource: (url: string): Promise<ModsList> => ipcRenderer.invoke('mods:remove-source', url),
  refresh: (): Promise<ModsList> => ipcRenderer.invoke('mods:refresh'),
  openFolder: (): Promise<void> => ipcRenderer.invoke('mods:open-folder'),
  /** A panel's saved notes, for the host frame to hand it. */
  panelLoad: (id: string): Promise<Record<string, string>> => ipcRenderer.invoke('mods:panel-load', id),
  panelSave: (id: string, key: string, value: string | null): Promise<void> => ipcRenderer.invoke('mods:panel-save', id, key, value),
  onChanged: (handler: (list: ModsList) => void): (() => void) => {
    const listener = (_e: unknown, payload: ModsList): void => handler(payload)
    ipcRenderer.on('mods:changed', listener)
    return () => ipcRenderer.removeListener('mods:changed', listener)
  }
}
