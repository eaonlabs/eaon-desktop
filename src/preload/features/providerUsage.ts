import { ipcRenderer } from 'electron'
import type { ProviderUsageState } from '@shared/providerUsage'

/** Settings → Usage & limits: every signed-in tool's limits and token totals. Exposed as `window.api.providerUsage`. */
export const providerUsageApi = {
  /** As last read, read again when a few minutes old. */
  state: (): Promise<ProviderUsageState> => ipcRenderer.invoke('provider-usage:state'),
  /** Asks every provider again now. */
  refresh: (): Promise<ProviderUsageState> => ipcRenderer.invoke('provider-usage:refresh'),
  /** Tokens by model over the last 90 days, from the coding CLIs' logs. */
  cliModels: (): Promise<{ tool: string; model: string; tokens: number }[]> => ipcRenderer.invoke('provider-usage:cli-models'),
  onChanged: (listener: (state: ProviderUsageState) => void): (() => void) => {
    const handler = (_e: unknown, state: ProviderUsageState): void => listener(state)
    ipcRenderer.on('provider-usage:changed', handler)
    return () => ipcRenderer.removeListener('provider-usage:changed', handler)
  }
}
