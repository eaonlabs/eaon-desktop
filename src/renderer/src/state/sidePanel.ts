import { useEffect } from 'react'
import { useApp } from './store'

/**
 * Below this width the sidebar, the conversation and a side panel (the
 * browser beside Chat, Eaon's own browser, a worker's browser) don't fit
 * side by side: 252 + 400 + 320. Mirrors the media query in pages.css.
 */
export const SIDE_PANEL_NARROW = 980

/**
 * Makes room for a side panel in a narrow window by hiding the sidebar while
 * the panel is open, and brings the sidebar back when the panel closes (if
 * this hid it). Without it the panel kept its 320px and the conversation was
 * squeezed to a sliver: one letter per line, Send off the composer. The
 * sidebar's open state isn't saved, so nothing outlives the session.
 */
export function useRoomForSidePanel(panelOpen: boolean): void {
  useEffect(() => {
    if (!panelOpen) return
    const narrow = window.matchMedia(`(max-width: ${SIDE_PANEL_NARROW - 1}px)`)
    let hidden = false
    const fit = (): void => {
      const app = useApp.getState()
      if (narrow.matches && app.sidebarOpen) {
        app.toggleSidebar()
        hidden = true
      }
    }
    fit()
    narrow.addEventListener('change', fit)
    return () => {
      narrow.removeEventListener('change', fit)
      if (hidden && !useApp.getState().sidebarOpen) useApp.getState().toggleSidebar()
    }
  }, [panelOpen])
}
