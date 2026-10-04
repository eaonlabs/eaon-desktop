import { ipcRenderer } from 'electron'
import type { GatewayDefaults, GatewayInfo } from '@shared/gateway'

/**
 * Renderer bridge for Eaon's gateway (the Local API Server, as apps see it).
 * Exposed as `window.api.gateway`.
 */
export const gatewayApi = {
  /** Base URLs, key, models and defaults, for pointing an app at Eaon. */
  info: (): Promise<GatewayInfo> => ipcRenderer.invoke('gateway:info'),
  /** Starts the server if it is off (and sets it to start with Eaon). */
  start: (): Promise<GatewayInfo> => ipcRenderer.invoke('gateway:start'),
  /** The models that stand in for names Eaon doesn't have: the default and the small/fast one. */
  setDefaults: (defaults: GatewayDefaults): Promise<GatewayInfo> => ipcRenderer.invoke('gateway:set-defaults', defaults)
}
