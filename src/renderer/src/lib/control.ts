import type { ControlAction } from '@shared/control'
import { useCode } from '../components/code/codeStore'
import { openInAde } from '../components/code/terminal/terminalStore'
import { useApp, type View } from '../state/store'
import type { AppTab } from '@shared/tabs'

/**
 * Carries out what Eaon CLI asked of the window (main/control): the tabs, the
 * ADE's folders and terminals, a setting. Each goes through the same store
 * function the matching click would, so the app behaves as if it were clicked.
 */

const TABS: Record<string, AppTab> = { chat: 'chat', ide: 'ide', workers: 'workers', ade: 'ade' }

function goToTab(tab: AppTab): void {
  useApp.getState().setTab(tab)
  if (useApp.getState().view !== 'chat') useApp.getState().setView('chat')
}

export async function carryOut(action: ControlAction): Promise<void> {
  const app = useApp.getState()
  switch (action.type) {
    case 'navigate': {
      const tab = TABS[action.to]
      if (tab) return goToTab(tab)
      if (action.to === 'settings') {
        if (action.settingsPage) app.setSettingsPage(action.settingsPage)
        else app.setView('settings')
        return
      }
      return app.setView(action.to as View)
    }
    case 'open-folder': {
      goToTab('ade')
      const code = useCode.getState()
      await code.init()
      await code.openFolder(action.path)
      return
    }
    case 'new-terminal': {
      if (action.folder) {
        const code = useCode.getState()
        await code.init()
        await code.openFolder(action.folder)
      }
      await openInAde(action.agent)
      return
    }
    case 'settings':
      await app.patchSettings(action.patch)
      return
  }
}

export function installControl(): () => void {
  return window.api.control.onAction((action) => {
    void carryOut(action).catch((error) => console.error('control action failed', action, error))
  })
}
