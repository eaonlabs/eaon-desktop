import { create } from 'zustand'
import type { ChannelLink, ChannelStatus } from '@shared/channels'

/**
 * Chat apps as the renderer sees them: the connections main owns and each
 * one's live status. Settings edits them; the Workers tab shows which apps a
 * worker is connected to.
 */
interface ChannelsState {
  ready: boolean
  links: ChannelLink[]
  statuses: Record<string, ChannelStatus>
  /** A worker whose page asked to be connected, so Settings opens with it chosen. */
  focusWorkerId: string | null
  init: () => Promise<void>
  /** Replaces one link after a command returns it, before the broadcast arrives. */
  put: (link: ChannelLink) => void
  focusWorker: (workerId: string | null) => void
}

/** The change listeners are attached once; the list itself can be loaded again after a failure. */
let bound = false
let loading = false

const byId = (statuses: ChannelStatus[]): Record<string, ChannelStatus> => Object.fromEntries(statuses.map((s) => [s.linkId, s]))

export const useChannels = create<ChannelsState>((set) => ({
  ready: false,
  links: [],
  statuses: {},
  focusWorkerId: null,

  async init() {
    const api = window.api.channels
    if (!bound) {
      bound = true
      api.onChanged((links) => set({ links }))
      api.onStatus((statuses) => set({ statuses: byId(statuses) }))
    }
    if (loading || useChannels.getState().ready) return
    loading = true
    try {
      const { links, statuses } = await api.list()
      set({ links, statuses: byId(statuses), ready: true })
    } catch {
      // Stays not-ready, so the next visit to a page that needs it tries again
      // (it used to be marked bound first and never retried).
    } finally {
      loading = false
    }
  },

  put(link) {
    set((s) => ({ links: s.links.some((l) => l.id === link.id) ? s.links.map((l) => (l.id === link.id ? link : l)) : [...s.links, link] }))
  },

  focusWorker(focusWorkerId) {
    set({ focusWorkerId })
  }
}))
