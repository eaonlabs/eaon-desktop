import { create } from 'zustand'
import { WHATS_NEW_RELEASE } from '@shared/whatsNew'
import { useApp } from '../../state/store'

/** The tour of the app, or of what's new in this release (shared/whatsNew.ts). */
export type TourKind = 'app' | 'whatsNew'

/**
 * Whether a tour is showing, and which. The setup's own state lives in
 * settings (`settings.onboarding`), so it survives a restart halfway through;
 * the tours are short enough to start again from the top.
 */
interface OnboardingState {
  tourOpen: boolean
  tour: TourKind
  startTour: (tour?: TourKind) => void
  /** `done`: reached the end. `skipped`: closed before it. Either way it isn't offered again on its own. */
  endTour: (how: 'done' | 'skipped') => void
}

/**
 * The setup or the tour is on screen. The corner cards (the star popup, the
 * Eaon Free offer) don't count that time, so a fresh install meets them
 * after the setup, not on top of it.
 */
export function onboardingShowing(): boolean {
  // Before settings load, whether the setup is coming isn't known yet: counted as showing.
  const setup = useApp.getState().settings?.onboarding.setup
  return setup === undefined || setup === 'pending' || useOnboarding.getState().tourOpen
}

/** onboardingShowing as a hook: a corner card steps aside while the setup or a tour is up, and comes back after. */
export function useOnboardingShowing(): boolean {
  const setup = useApp((s) => s.settings?.onboarding.setup)
  const tour = useOnboarding((s) => s.tourOpen)
  return setup === undefined || setup === 'pending' || tour
}

export const useOnboarding = create<OnboardingState>((set, get) => ({
  tourOpen: false,
  tour: 'app',
  startTour: (tour = 'app') => {
    if (get().tourOpen) return
    // The tour points at the app itself, so it starts from Chat rather than Settings or a page.
    const app = useApp.getState()
    if (app.view !== 'chat') app.setView('chat')
    set({ tourOpen: true, tour })
    // What's new is shown once on its own, whether or not it's watched to the end; after that it's in the Help menu.
    if (tour === 'whatsNew' && app.settings?.onboarding.whatsNew !== WHATS_NEW_RELEASE) void app.patchSettings({ onboarding: { whatsNew: WHATS_NEW_RELEASE } })
  },
  endTour: (how) => {
    const { tour } = get()
    set({ tourOpen: false })
    if (tour === 'app') void useApp.getState().patchSettings({ onboarding: { tour: how } })
  }
}))
