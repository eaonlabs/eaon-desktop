import { create } from 'zustand'
import type { GuestTerminalView } from '@shared/rc'

/**
 * Friends' terminals you can watch (GuestWatch.tsx): the ones they've
 * started this run, from a locked share or in one of your sessions. When one
 * starts, the panel opens on it, so you see what they do from the first
 * keystroke; closing it leaves a pill to bring it back while one still runs.
 */
interface GuestWatchState {
  views: GuestTerminalView[]
  open: boolean
  active: string | null
  init: () => void
  show: (paneId?: string) => void
  hide: () => void
}

let started = false

export const useGuestWatch = create<GuestWatchState>((set, get) => ({
  views: [],
  open: false,
  active: null,

  init() {
    if (started) return
    started = true
    const apply = (views: GuestTerminalView[], popUp: boolean): void => {
      const before = new Map(get().views.map((v) => [v.paneId, v.startedAt]))
      // Started since the window last heard: a new terminal, or one they started again.
      const fresh = popUp ? views.find((v) => v.running && before.get(v.paneId) !== v.startedAt) : undefined
      if (fresh) return set({ views, open: true, active: fresh.paneId })
      const active = views.some((v) => v.paneId === get().active) ? get().active : (views[0]?.paneId ?? null)
      set({ views, active, open: get().open && views.length > 0 })
    }
    // What already runs when the window opens is there to watch, not popped up over your work.
    void window.api.rc
      .guestTerminals()
      .then((views) => apply(views, false))
      .catch(() => undefined)
    window.api.rc.onGuestTerminals((views) => apply(views, true))
  },

  show(paneId) {
    const views = get().views
    if (!views.length) return
    set({ open: true, active: paneId && views.some((v) => v.paneId === paneId) ? paneId : (get().active ?? views[0].paneId) })
  },

  hide() {
    set({ open: false })
  }
}))
