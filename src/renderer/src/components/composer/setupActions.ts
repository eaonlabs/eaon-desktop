import { useCallback } from 'react'
import type { SetupAction } from '@shared/modelSelection'
import { useApp } from '../../state/store'

/**
 * What the fix buttons next to an unavailable model or a provider that needs
 * attention do, wherever they appear (the composer, the model picker, a
 * failed reply). A sign-in starts the provider's own flow and opens its
 * settings, where a device code or "paste the redirect URL" is shown; a key
 * problem opens the key field; a local runtime opens its address.
 *
 * `connect` (Link accounts) and `choose-model` (open the picker) belong to
 * the caller, which owns that dialog or menu, and are ignored here.
 */
export function useSetupAction(): (action: SetupAction, providerId: string | null) => void {
  const openProviderSettings = useApp((s) => s.openProviderSettings)
  const refreshProviders = useApp((s) => s.refreshProviders)
  const setView = useApp((s) => s.setView)
  return useCallback(
    (action, providerId) => {
      switch (action) {
        case 'reconnect':
        case 'sign-in':
          openProviderSettings(providerId)
          if (providerId) void window.api.providerAuth.signIn(providerId).finally(() => void refreshProviders())
          return
        case 'turn-on':
          if (providerId) void window.api.providers.update(providerId, { enabled: true }).then(() => refreshProviders())
          return
        case 'get-local-model':
          setView('models')
          return
        case 'fix-key':
        case 'add-key':
        case 'open-settings':
        case 'start-local':
          openProviderSettings(providerId)
          return
        default:
          return
      }
    },
    [openProviderSettings, refreshProviders, setView]
  )
}
