import { useEffect, type JSX } from 'react'
import { tabsPromptDue } from '@shared/tabs'
import { useApp } from '../../state/store'
import { Modal } from '../ui'
import { TabsPicker } from '../settings/TabsPicker'
import { useOnboarding } from './onboardingStore'

/**
 * "Pick your tabs", once, for an install set up before the IDE had its own
 * tab: it updated into four tabs it never chose. The same list as the setup's
 * Tabs step, and each change shows in the top bar behind it at once. Done,
 * Escape and the close button all keep what's picked; it isn't asked again.
 *
 * Whether it's up is kept apart from whether it's due: the first change
 * saves the tabs, which alone would make it no longer due and close it.
 */
export function TabsPrompt(): JSX.Element | null {
  const due = useApp((s) => tabsPromptDue(s.settings))
  // Answered in another window: this one's goes too.
  const asked = useApp((s) => s.settings?.onboarding.tabsAsked === true)
  const patchSettings = useApp((s) => s.patchSettings)
  const open = useOnboarding((s) => s.tabsOpen)
  const setTabsOpen = useOnboarding((s) => s.setTabsOpen)
  const touring = useOnboarding((s) => s.tourOpen)

  useEffect(() => {
    if (due && !touring) setTabsOpen(true)
  }, [due, touring, setTabsOpen])
  useEffect(() => {
    if (asked) setTabsOpen(false)
  }, [asked, setTabsOpen])

  const close = (): void => {
    setTabsOpen(false)
    void patchSettings({ onboarding: { tabsAsked: true } })
  }

  // A tour started from the Help menu goes over it; it waits under, and comes back after.
  return (
    <Modal
      open={open && !touring}
      onClose={close}
      title="Pick your tabs"
      width={540}
      actions={
        <button type="button" className="btn btn--primary" autoFocus onClick={close}>
          Done
        </button>
      }
    >
      <p className="tabs-prompt__lead">The IDE has its own tab now, beside Chat, Workers and the ADE. Keep the ones you’ll use, in the order you want them.</p>
      <div className="tabs-prompt__list">
        <TabsPicker />
      </div>
      <p className="tabs-prompt__note">You can change this later in Settings → General → Tabs.</p>
    </Modal>
  )
}
