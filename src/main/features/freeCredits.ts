import { FREE_DEFAULT_MODEL, FREE_PROVIDER_ID, type FreeCreditsStatus, type RedeemResult } from '@shared/freeCredits'
import { resolveSelection } from '@shared/modelSelection'
import type { Settings } from '@shared/types'
import { freeCreditsStatus, redeemFreeCode } from '../freeCredits'
import { clearProviderHealth, getProvider, listProviders, refreshModels } from '../providers'
import { store } from '../store'
import type { Feature } from './types'

/**
 * Eaon Event (shared/freeCredits.ts): an event's code, checked with the
 * gateway, lists the provider until the code ends. Redeeming it makes one of
 * its models the one in use when there isn't a working one already.
 */

/**
 * After a code: someone with no working model starts on Eaon Event (its
 * Claude Haiku when the code's list has it, else its first model); a choice
 * that works is left alone. So is the default a choice-less install already
 * runs on (Eaon Lite, say), which is saved as the choice here: Eaon Event
 * sorts first, so once listed it would become the new default and quietly
 * move them onto it.
 */
export function chooseEventModel(): Settings {
  const before = store.getSettings()
  // Looked at as it was before the code listed Eaon Event, unless Eaon Event is the choice already (a new code for it).
  const chosenEvent = before.selectedProviderId === FREE_PROVIDER_ID
  const providers = listProviders().filter((p) => chosenEvent || p.id !== FREE_PROVIDER_ID)
  const current = resolveSelection({ providerId: before.selectedProviderId, modelId: before.selectedModelId }, providers, {
    favorites: before.favoriteModels,
    recents: before.recentModels
  })
  if (current.model && current.status === 'default') return store.patchSettings({ selectedProviderId: current.model.providerId, selectedModelId: current.model.id })
  if (current.model) return before
  const models = getProvider(FREE_PROVIDER_ID)?.models ?? []
  const pick = models.find((m) => m.id === FREE_DEFAULT_MODEL) ?? models[0]
  return pick ? store.patchSettings({ selectedProviderId: FREE_PROVIDER_ID, selectedModelId: pick.id }) : before
}

export const freeCreditsFeature: Feature = {
  id: 'free-credits',
  register: ({ ipcMain, send }) => {
    ipcMain.handle('free-credits:status', (): FreeCreditsStatus => freeCreditsStatus())

    /** An event code (a hackathon's): checked with the gateway, then Eaon Event runs on it until it ends. */
    ipcMain.handle('free-credits:redeem', async (_e, code: unknown): Promise<RedeemResult> => {
      const result = await redeemFreeCode(typeof code === 'string' ? code : '')
      if (result.ok) {
        // A refusal from before (an ended code) is lasting, so it would keep
        // Eaon Event "Needs attention" until a request happened to succeed.
        clearProviderHealth(FREE_PROVIDER_ID)
        // What the code opens is the gateway's to say: its list, with the code's key.
        await refreshModels(FREE_PROVIDER_ID).catch(() => undefined)
        send('settings:changed', chooseEventModel())
        send('providers:changed')
      }
      return result
    })
  }
}
