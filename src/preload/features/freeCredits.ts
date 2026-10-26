import { ipcRenderer } from 'electron'
import type { FreeCreditsStatus, OfferPlan, RedeemResult } from '@shared/freeCredits'

/**
 * Renderer bridge for Eaon Free. Exposed as `window.api.freeCredits`.
 */
export const freeCreditsApi = {
  status: (): Promise<FreeCreditsStatus> => ipcRenderer.invoke('free-credits:status'),
  /** Whether to show the offer card now, and the star popup before it (both count as shown). */
  shouldOffer: (): Promise<OfferPlan> => ipcRenderer.invoke('free-credits:should-offer'),
  /** Whether Eaon is serving Eaon Free's model now, so the week can be claimed. */
  served: (): Promise<boolean> => ipcRenderer.invoke('free-credits:served'),
  /**
   * Starts the free week: lists Eaon Free and, without a working model, makes
   * it the one in use. Only while the gateway serves its model; otherwise
   * nothing changes and the status that comes back is still unclaimed.
   */
  claim: (): Promise<FreeCreditsStatus> => ipcRenderer.invoke('free-credits:claim'),
  /** Redeems an event code (a hackathon's): checked with Eaon, then Eaon Free runs on it until it ends. */
  redeem: (code: string): Promise<RedeemResult> => ipcRenderer.invoke('free-credits:redeem', code)
}
