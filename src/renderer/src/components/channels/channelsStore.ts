import { create } from 'zustand'
import type { ChannelLink, ChannelStatus } from '@shared/channels'
import { reportError } from '../ErrorBoundary'

/**
 * Chat apps as the renderer sees them: the connections main owns and each
 * one's live status. Settings edits them; the Workers tab shows which apps a
 * worker is connected to.
 */
interface ChannelsState {
  ready: boolean
  /** Why the connections couldn't be loaded; the next `init` tries again. */
  error: string | null
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
let loading: Promise<void> | null = null

const byId = (statuses: ChannelStatus[]): Record<string, ChannelStatus> => Object.fromEntries(statuses.map((s) => [s.linkId, s]))

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export const useChannels = create<ChannelsState>((set, get) => ({
  ready: false,
  error: null,
  links: [],
  statuses: {},
  focusWorkerId: null,

  init() {
    if (get().ready) return Promise.resolve()
    // Calls made while one is on its way share it. A failed one is forgotten,
    // so the next call — Settings → Chat apps or a worker's page opening
    // again — tries again instead of the list staying empty for good.
    loading ??= load().finally(() => {
      loading = null
    })
    return loading
  },

  put(link) {
    set((s) => ({ links: s.links.some((l) => l.id === link.id) ? s.links.map((l) => (l.id === link.id ? link : l)) : [...s.links, link] }))
  },

  focusWorker(focusWorkerId) {
    set({ focusWorkerId })
  }
}))

async function load(): Promise<void> {
  const set = useChannels.setState
  try {
    const api = window.api.channels
    // Once per window, whatever happens to the list below.
    if (!bound) {
      bound = true
      api.onChanged((links) => set({ links }))
      api.onStatus((statuses) => set({ statuses: byId(statuses) }))
    }
    const { links, statuses } = await api.list()
    set({ links, statuses: byId(statuses), ready: true, error: null })
  } catch (error) {
    reportError({ message: errorText(error), stack: error instanceof Error ? error.stack : undefined, source: 'chat apps' })
    set({ error: errorText(error) })
  }
}
