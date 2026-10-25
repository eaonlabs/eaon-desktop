import { ipcRenderer } from 'electron'
import type { ProviderLogos } from '@shared/providerLogos'

/** Renderer bridge for provider logos (main/features/providerLogos.ts). Exposed as `window.api.providerLogos`. */
export const providerLogosApi = {
  list: (): Promise<ProviderLogos> => ipcRenderer.invoke('provider-logos:list'),
  /** Opens a file picker and keeps the image as the provider's logo. */
  choose: (providerId: string): Promise<{ ok: true; logos: ProviderLogos } | { ok: false; reason: string } | { ok: false; canceled: true }> =>
    ipcRenderer.invoke('provider-logos:choose', providerId),
  /** Drops the person's own image: back to the built-in logo, the one found, or initials. */
  reset: (providerId: string): Promise<ProviderLogos> => ipcRenderer.invoke('provider-logos:reset', providerId),
  /** Looks up every custom provider that's due (never looked up for its base URL, or not for a while). */
  sweep: (): Promise<void> => ipcRenderer.invoke('provider-logos:sweep'),
  /** Looks a custom provider's logo up from its base URL again, now. */
  lookUp: (providerId: string): Promise<ProviderLogos> => ipcRenderer.invoke('provider-logos:look-up', providerId),
  onChanged: (fn: (logos: ProviderLogos) => void): (() => void) => {
    const listener = (_event: unknown, logos: ProviderLogos): void => fn(logos)
    ipcRenderer.on('provider-logos:changed', listener)
    return () => ipcRenderer.removeListener('provider-logos:changed', listener)
  }
}
