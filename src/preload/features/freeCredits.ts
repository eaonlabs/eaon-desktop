import { ipcRenderer } from 'electron'
import type { FreeCreditsStatus, RedeemResult } from '@shared/freeCredits'

/**
 * Renderer bridge for Eaon Event, an event's code. Exposed as `window.api.freeCredits`.
 */
export const freeCreditsApi = {
  status: (): Promise<FreeCreditsStatus> => ipcRenderer.invoke('free-credits:status'),
  /** Redeems an event code (a hackathon's): checked with Eaon, then Eaon Event runs on it until it ends. */
  redeem: (code: string): Promise<RedeemResult> => ipcRenderer.invoke('free-credits:redeem', code)
}
