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

let bound = false

const byId = (statuses: ChannelStatus[]): Record<string, ChannelStatus> => Object.fromEntries(statuses.map((s) => [s.linkId, s]))

export const useChannels = create<ChannelsState>((set) => ({
  ready: false,
  links: [],
  statuses: {},
  focusWorkerId: null,

  async init() {
    if (bound) return
    bound = true
    const api = window.api.channels
    api.onChanged((links) => set({ links }))
    api.onStatus((statuses) => set({ statuses: byId(statuses) }))
    const { links, statuses } = await api.list()
    set({ links, statuses: byId(statuses), ready: true })
  },

  put(link) {
    set((s) => ({ links: s.links.some((l) => l.id === link.id) ? s.links.map((l) => (l.id === link.id ? link : l)) : [...s.links, link] }))
  },

  focusWorker(focusWorkerId) {
    set({ focusWorkerId })
  }
}))
