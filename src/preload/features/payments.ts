import { ipcRenderer } from 'electron'
import type { CardInput, PaymentLimits, PaymentsMode, PaymentsStatus } from '@shared/payments'

/**
 * Renderer bridge for agent payments. Exposed as `window.api.payments`.
 * The card number goes in once through `setCard` and never comes back.
 */
export const paymentsApi = {
  status: (): Promise<PaymentsStatus> => ipcRenderer.invoke('payments:status'),
  setCard: (input: CardInput): Promise<PaymentsStatus> => ipcRenderer.invoke('payments:set-card', input),
  removeCard: (): Promise<PaymentsStatus> => ipcRenderer.invoke('payments:remove-card'),
  /** 'auto' is refused until the waiver is accepted; use `acceptWaiver` to turn it on. */
  setMode: (mode: PaymentsMode): Promise<PaymentsStatus> => ipcRenderer.invoke('payments:set-mode', mode),
  acceptWaiver: (version: number, checks: boolean[]): Promise<PaymentsStatus> => ipcRenderer.invoke('payments:accept-waiver', version, checks),
  revokeWaiver: (): Promise<PaymentsStatus> => ipcRenderer.invoke('payments:revoke-waiver'),
  setLimits: (patch: Partial<PaymentLimits>): Promise<PaymentsStatus> => ipcRenderer.invoke('payments:set-limits', patch),
  setCurrency: (currency: string): Promise<PaymentsStatus> => ipcRenderer.invoke('payments:set-currency', currency),
  onChanged: (handler: (status: PaymentsStatus) => void): (() => void) => {
    const listener = (_e: unknown, status: PaymentsStatus): void => handler(status)
    ipcRenderer.on('payments:changed', listener)
    return () => ipcRenderer.removeListener('payments:changed', listener)
  }
}
