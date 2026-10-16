import { FREE_DEFAULT_MODEL, FREE_PROVIDER_ID, shouldOffer, type FreeCreditsStatus, type OfferPlan, type RedeemResult } from '@shared/freeCredits'
import { isProviderUsable } from '@shared/modelSelection'
import { freeCreditsStatus, noteOffered, redeemFreeCode } from '../freeCredits'
import { clearProviderHealth, getProvider } from '../providers'
import { alreadyStarred, shouldAsk } from '../starPrompt'
import { store } from '../store'
import type { Feature } from './types'

/**
 * The Eaon Free offer (components/FreeCreditsOffer.tsx) and its settings:
 * claiming lists the provider for a week, and makes its Claude Haiku the
 * model in use when there isn't a working one already.
 *
 * When the star popup is due as well (on a fresh install, always), it comes
 * up first and the offer follows it, whatever the answer. The offer never
 * depends on a star: GitHub forbids rewarding stars with credits.
 */
/** Whether the star popup is due now; when it is, showing it counts as an ask (main/starPrompt.ts). */
async function starDue(): Promise<boolean> {
  const star = (): ReturnType<typeof store.getSettings>['starPrompt'] => store.getSettings().starPrompt
  if (!shouldAsk(star(), Date.now())) return false
  if (await alreadyStarred()) {
    store.patchSettings({ starPrompt: { ...star(), status: 'starred' } })
    return false
  }
  store.patchSettings({ starPrompt: { ...star(), asked: star().asked + 1, lastAskedAt: Date.now() } })
  return true
}

export const freeCreditsFeature: Feature = {
  id: 'free-credits',
  register: ({ ipcMain, send }) => {
    const state = (): ReturnType<typeof store.getSettings>['freeCredits'] => store.getSettings().freeCredits

    ipcMain.handle('free-credits:status', (): FreeCreditsStatus => freeCreditsStatus())

    /**
     * Which cards to show now. The star popup comes with the offer when it is
     * due, and on its own the first time it asks: someone who claimed the
     * credits from Settings before the offer came up still sees it once.
     * Showing either counts, however it is closed.
     */
    ipcMain.handle('free-credits:should-offer', async (): Promise<OfferPlan> => {
      // The end-to-end tests turn the cards off, except the one that tests them.
      if (process.env.EAON_OFFERS === 'off') return { offer: false, starFirst: false }
      const offer = shouldOffer(state(), Date.now())
      if (!offer && store.getSettings().starPrompt.asked > 0) return { offer: false, starFirst: false }
      if (offer) store.patchSettings({ freeCredits: { ...state(), offered: state().offered + 1, lastOfferedAt: Date.now() } })
      const starFirst = await starDue()
      if (offer || starFirst) noteOffered()
      return { offer, starFirst }
    })

    /** Lists Eaon Free and, without a working model, makes it the one in use. */
    const claim = (): void => {
      const settings = state().claimed ? store.getSettings() : store.patchSettings({ freeCredits: { ...state(), claimed: true, claimedAt: Date.now() } })
      // Someone without a working model starts on the free one; a choice that works is left alone.
      const current = settings.selectedProviderId ? getProvider(settings.selectedProviderId) : undefined
      const working = Boolean(current && isProviderUsable(current) && !current.health?.issue && current.models.some((m) => m.id === settings.selectedModelId))
      const next = working ? settings : store.patchSettings({ selectedProviderId: FREE_PROVIDER_ID, selectedModelId: FREE_DEFAULT_MODEL })
      send('settings:changed', next)
    }

    ipcMain.handle('free-credits:claim', (): FreeCreditsStatus => {
      if (!state().claimed) claim()
      return freeCreditsStatus()
    })

    /** An event code (a hackathon's): checked with the gateway, then Eaon Free runs on it until it ends. */
    ipcMain.handle('free-credits:redeem', async (_e, code: unknown): Promise<RedeemResult> => {
      const result = await redeemFreeCode(typeof code === 'string' ? code : '')
      if (result.ok) {
        // A refusal from before the code (the free week over, an ended code)
        // is lasting, so it would keep Eaon Free "Needs attention" until a
        // request happened to succeed.
        clearProviderHealth(FREE_PROVIDER_ID)
        claim()
        send('providers:changed')
      }
      return result
    })
  }
}
