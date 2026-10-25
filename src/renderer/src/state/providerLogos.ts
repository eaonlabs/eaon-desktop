import { useMemo } from 'react'
import { create } from 'zustand'
import { chosenLogo, type LogoImage, type ProviderLogos } from '@shared/providerLogos'

/**
 * Provider logos that aren't built in (main/providers/logos.ts): the
 * person's own, and the ones found from custom providers' base URLs. Loaded
 * once at startup and kept current from main, so every logo in the app
 * (icons/brand.tsx) changes as soon as one is picked or found.
 */
interface ProviderLogosState {
  logos: ProviderLogos
  set: (logos: ProviderLogos) => void
}

export const useProviderLogos = create<ProviderLogosState>((set) => ({
  logos: {},
  set: (logos) => set({ logos })
}))

let started = false

export function startProviderLogos(): void {
  if (started || typeof window === 'undefined' || !window.api?.providerLogos) return
  started = true
  window.api.providerLogos.onChanged((logos) => useProviderLogos.getState().set(logos))
  void window.api.providerLogos
    .list()
    .then((logos) => useProviderLogos.getState().set(logos))
    .catch(() => undefined)
}

/** The logo to draw for a provider instead of its built-in one or initials, if there is one. */
export function useProviderLogo(providerId: string): LogoImage | null {
  const record = useProviderLogos((s) => s.logos[providerId])
  return useMemo(() => chosenLogo(record), [record])
}

/** The same, outside React. */
export const providerLogoNow = (providerId: string): LogoImage | null => chosenLogo(useProviderLogos.getState().logos[providerId])
