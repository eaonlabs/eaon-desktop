import { ipcRenderer } from 'electron'
import type { FreeCreditsStatus, OfferPlan, RedeemResult } from '@shared/freeCredits'

/**
 * Renderer bridge for Eaon Free. Exposed as `window.api.freeCredits`.
 */
export const freeCreditsApi = {
  status: (): Promise<FreeCreditsStatus> => ipcRenderer.invoke('free-credits:status'),
  /** Whether to show the offer card now, and the star popup before it (both count as shown). */
  shouldOffer: (): Promise<OfferPlan> => ipcRenderer.invoke('free-credits:should-offer'),
  /** Starts the free week: lists Eaon Free and, without a working model, makes it the one in use. */
  claim: (): Promise<FreeCreditsStatus> => ipcRenderer.invoke('free-credits:claim'),
  /** Redeems an event code (a hackathon's): checked with Eaon, then Eaon Free runs on it until it ends. */
  redeem: (code: string): Promise<RedeemResult> => ipcRenderer.invoke('free-credits:redeem', code)
}
