import { create } from 'zustand'
import { useApp } from '../../state/store'

/**
 * Whether the tour is showing. The setup's own state lives in settings
 * (`settings.onboarding`), so it survives a restart halfway through; the tour
 * is short enough to start again from the top.
 */
interface OnboardingState {
  tourOpen: boolean
  startTour: () => void
  /** `done`: reached the end. `skipped`: closed before it. Either way it isn't offered again on its own. */
  endTour: (how: 'done' | 'skipped') => void
}

export const useOnboarding = create<OnboardingState>((set) => ({
  tourOpen: false,
  startTour: () => {
    // The tour points at the app itself, so it starts from Chat rather than Settings or a page.
    const app = useApp.getState()
    if (app.view !== 'chat') app.setView('chat')
    set({ tourOpen: true })
  },
  endTour: (how) => {
    set({ tourOpen: false })
    void useApp.getState().patchSettings({ onboarding: { tour: how } })
  }
}))
