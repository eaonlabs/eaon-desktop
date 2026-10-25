import { FREE_DEFAULT_MODEL, FREE_PROVIDER_ID, shouldOffer, type FreeCreditsStatus, type OfferPlan, type RedeemResult } from '@shared/freeCredits'
import { resolveSelection } from '@shared/modelSelection'
import type { Settings } from '@shared/types'
import { forgetFreeModelServed, freeCreditsStatus, freeModelServed, noteOffered, redeemFreeCode } from '../freeCredits'
import { clearProviderHealth, listProviders } from '../providers'
import { alreadyStarred, shouldAsk } from '../starPrompt'
import { store } from '../store'
import type { Feature } from './types'

/**
 * The Eaon Free offer (components/FreeCreditsOffer.tsx) and its settings:
 * claiming lists the provider for a week, and makes its Claude Haiku the
 * model in use when there isn't a working one already. Both wait on the
 * gateway serving that model (freeModelServed).
 *
 * When the star popup is due as well (on a fresh install, always), it comes
 * up first and the offer follows it, whatever the answer. The offer never
 * depends on a star: GitHub forbids rewarding stars with credits.
 */
/**
 * Claims the credits. Someone with no working model starts on the free one,
 * if the gateway serves it; a choice that works is left alone. So is the
 * default a choice-less install already runs on (Eaon Lite, say), which is
 * saved as the choice here: Eaon Free sorts first, so once listed it would
 * become the new default and quietly move them onto it.
 */
export function claimFreeCredits(served: boolean): Settings {
  const before = store.getSettings()
  const current = resolveSelection({ providerId: before.selectedProviderId, modelId: before.selectedModelId }, listProviders(), {
    favorites: before.favoriteModels,
    recents: before.recentModels
  })
  const freeCredits = store.getSettings().freeCredits
  const settings = freeCredits.claimed ? before : store.patchSettings({ freeCredits: { ...freeCredits, claimed: true, claimedAt: Date.now() } })
  if (current.model && current.status === 'default') return store.patchSettings({ selectedProviderId: current.model.providerId, selectedModelId: current.model.id })
  if (current.model || !served) return settings
  return store.patchSettings({ selectedProviderId: FREE_PROVIDER_ID, selectedModelId: FREE_DEFAULT_MODEL })
}

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
      // Only an offer the gateway can honour today.
      const offer = shouldOffer(state(), Date.now()) && (await freeModelServed())
      if (!offer && store.getSettings().starPrompt.asked > 0) return { offer: false, starFirst: false }
      if (offer) store.patchSettings({ freeCredits: { ...state(), offered: state().offered + 1, lastOfferedAt: Date.now() } })
      const starFirst = await starDue()
      if (offer || starFirst) noteOffered()
      return { offer, starFirst }
    })

    const claim = async (): Promise<void> => {
      send('settings:changed', claimFreeCredits(await freeModelServed()))
    }

    ipcMain.handle('free-credits:claim', async (): Promise<FreeCreditsStatus> => {
      if (!state().claimed) await claim()
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
        // The code's key may open models the plain offer doesn't have.
        forgetFreeModelServed()
        await claim()
        send('providers:changed')
      }
      return result
    })
  }
}
