import { ipcRenderer } from 'electron'
import type { ProviderAuthStatus, ProviderMeta } from '@shared/providers'

/**
 * Renderer bridge for the providerAuth feature. Exposed as `window.api.providerAuth`.
 * Keep every channel this feature uses in this one file.
 */
export const providerAuthApi = {
  /** Catalog extras: URL templates, which providers list models, sign-in labels. */
  meta: (): Promise<Record<string, ProviderMeta>> => ipcRenderer.invoke('provider-auth:meta'),
  /** Sign-in state for every provider that has a browser sign-in. */
  status: (): Promise<ProviderAuthStatus[]> => ipcRenderer.invoke('provider-auth:status'),
  /** Starts a sign-in; resolves when it finishes, fails, or is cancelled. */
  signIn: (providerId: string): Promise<ProviderAuthStatus> => ipcRenderer.invoke('provider-auth:sign-in', providerId),
  cancel: (providerId: string): Promise<void> => ipcRenderer.invoke('provider-auth:cancel', providerId),
  signOut: (providerId: string): Promise<ProviderAuthStatus | null> => ipcRenderer.invoke('provider-auth:sign-out', providerId),
  /** The redirect URL or code, pasted when the browser could not reach Eaon's callback. */
  submitCode: (providerId: string, input: string): Promise<void> => ipcRenderer.invoke('provider-auth:submit-code', providerId, input),
  /** Saves (or clears, with null) the client id of the OAuth app registered with the provider. */
  setClientId: (providerId: string, clientId: string | null): Promise<ProviderAuthStatus | null> =>
    ipcRenderer.invoke('provider-auth:set-client-id', providerId, clientId),
  /** Opens a sign-in page (the device-code page, after the code has been shown). */
  open: (url: string): Promise<void> => ipcRenderer.invoke('provider-auth:open', url),
  onStatus: (handler: (status: ProviderAuthStatus) => void): (() => void) => {
    const listener = (_e: unknown, payload: ProviderAuthStatus): void => handler(payload)
    ipcRenderer.on('provider-auth:status', listener)
    return () => ipcRenderer.removeListener('provider-auth:status', listener)
  }
}
