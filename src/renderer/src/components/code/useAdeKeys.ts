import { useEffect } from 'react'
import { adeKeyAction, paneAfter, sessionAfter } from '@shared/adeKeys'
import { visibleSessions } from '@shared/adeSessions'
import { useCode } from './codeStore'
import { orderedGroups, openNewSession, useAdeSessions } from './sessionsStore'
import { terminals } from './terminal/registry'
import { useTerminals } from './terminal/terminalStore'
import { onboardingShowing } from '../onboarding/onboardingStore'
import { notify } from '../Notice'
import { isMac } from '../../lib/platform'

/**
 * The ADE's keyboard shortcuts (shared/adeKeys.ts says which chord is which):
 * the next and previous terminal, a terminal filling the view, a session by
 * its place in the sidebar, a new session. On the window, so they work with a
 * terminal focused (it lets them through, registry.ts) and with the sidebar
 * focused. Mounted while the ADE is on screen.
 */
export function useAdeKeys(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.repeat || event.defaultPrevented) return
      const action = adeKeyAction(event, isMac)
      if (!action) return
      // Not under the setup or a tour, nor from inside a dialog or an open list, where moving off would throw away what's being filled in.
      if (onboardingShowing()) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('[role="dialog"], [aria-modal="true"], [role="listbox"], [role="menu"]')) return
      // A text field of the app's (a terminal's name, a search box) keeps its own keys; a terminal's is not one.
      if (target?.closest('input, textarea, [contenteditable="true"]') && !target.closest('.xterm')) return

      const cwd = useCode.getState().cwd
      const terminalsNow = useTerminals.getState()
      const panes = cwd ? (terminalsNow.layout[cwd] ?? []) : []

      switch (action.do) {
        case 'pane': {
          const next = paneAfter(
            panes.map((p) => p.id),
            terminals.lastFocused(),
            action.step
          )
          if (!next) return
          event.preventDefault()
          // A terminal filling the view moves on to the next one, still filling it.
          if (terminalsNow.maximized && panes.some((p) => p.id === terminalsNow.maximized)) useTerminals.setState({ maximized: next })
          focusPane(next)
          return
        }
        case 'maximize': {
          const last = terminals.lastFocused()
          const id = last && panes.some((p) => p.id === last) ? last : (panes[0]?.id ?? null)
          if (!id) return
          event.preventDefault()
          terminalsNow.toggleMaximized(id)
          focusPane(id)
          return
        }
        case 'new-session':
          event.preventDefault()
          void openNewSession()
          return
        default: {
          event.preventDefault()
          const { sessions, collapsed } = useAdeSessions.getState()
          const list = visibleSessions(orderedGroups(sessions, useCode.getState().recents), collapsed)
          const session =
            action.do === 'session'
              ? list[action.index]
              : sessionAfter(
                  list,
                  list.find((s) => s.cwd === cwd)?.id ?? null,
                  action.step
                )
          if (!session) return
          if (session.missing) {
            notify(`${session.cwd} isn’t there any more. Bring the folder back, or remove the session from its menu.`, 'error')
            return
          }
          void useAdeSessions
            .getState()
            .show(session)
            .then(() => {
              // Its terminals are drawn a frame on; the first takes the keyboard.
              const first = useTerminals.getState().layout[session.cwd]?.[0]
              if (first) focusPane(first.id)
            })
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/** A terminal takes the keyboard, once the view has put it on screen (a maximised one is drawn a frame later). */
function focusPane(paneId: string): void {
  requestAnimationFrame(() => requestAnimationFrame(() => terminals.focus(paneId)))
}
