import { create } from 'zustand'
import type { PaneDevice, PaneState } from '@shared/simulatorPane'
import { isMac } from '../../../lib/platform'
import { useIde } from '../ideStore'

/**
 * The Device pane's own state (SimulatorSurface): which simulator it shows,
 * how big, and whether it shows the browser's page on a phone instead. The
 * device and the view choices last between launches; the rest is per run.
 */

const DEVICE_KEY = 'eaon.simulator.device'
const VIEW_KEY = 'eaon.simulator.view'

export type PaneMode = 'simulator' | 'web'

interface View {
  mode: PaneMode
  /** The device's outline drawn around its screen. */
  frame: boolean
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? { ...fallback, ...(JSON.parse(raw) as T) } : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Not kept: the choice lasts for this run.
  }
}

interface SimulatorState {
  pane: PaneState | null
  /** The chosen device, when it still exists; else the running one, else the newest iPhone. */
  udid: string | null
  view: View
  /** Zoom on top of fitting the device in the pane: 1 fits. */
  zoom: number
  /** A device starting or stopping, from the pane. */
  busy: { udid: string; doing: 'boot' | 'shutdown' } | null
  recording: string | null
  refresh: () => Promise<void>
  select: (udid: string) => void
  setView: (patch: Partial<View>) => void
  setZoom: (zoom: number) => void
  boot: (udid: string) => Promise<void>
  shutdown: (udid: string) => Promise<void>
  setRecording: (udid: string | null) => void
}

/** The device to show: the chosen one, else one running, else the newest iPhone. */
export function pickDevice(devices: PaneDevice[], chosen: string | null): string | null {
  if (chosen && devices.some((d) => d.udid === chosen)) return chosen
  return (devices.find((d) => d.state === 'Booted') ?? devices.find((d) => /^iPhone/.test(d.name)) ?? devices[0])?.udid ?? null
}

let refreshing: Promise<void> | null = null

export const useSimulator = create<SimulatorState>((set, get) => ({
  pane: null,
  udid: read<{ udid: string | null }>(DEVICE_KEY, { udid: null }).udid,
  view: read<View>(VIEW_KEY, { mode: isMac ? 'simulator' : 'web', frame: true }),
  zoom: 1,
  busy: null,
  recording: null,

  refresh() {
    // One at a time: the pane polls, and a slow simctl shouldn't stack calls.
    if (refreshing) return refreshing
    refreshing = window.api.simulator
      .state()
      .then((pane) => set({ pane, udid: pickDevice(pane.devices, get().udid) }))
      .catch(() => {})
      .finally(() => {
        refreshing = null
      })
    return refreshing
  },

  select(udid) {
    write(DEVICE_KEY, { udid })
    set({ udid, zoom: 1 })
  },

  setView(patch) {
    const view = { ...get().view, ...patch }
    write(VIEW_KEY, view)
    set({ view })
  },

  setZoom: (zoom) => set({ zoom: Math.min(3, Math.max(0.4, zoom)) }),

  async boot(udid) {
    set({ busy: { udid, doing: 'boot' } })
    try {
      await window.api.simulator.boot(udid)
    } finally {
      set({ busy: null })
      await get().refresh()
    }
  },

  async shutdown(udid) {
    set({ busy: { udid, doing: 'shutdown' } })
    try {
      await window.api.simulator.shutdown(udid)
    } finally {
      set({ busy: null, recording: get().recording === udid ? null : get().recording })
      await get().refresh()
    }
  },

  setRecording: (recording) => set({ recording })
}))

// The agent showing a device (its ios_simulator tool): the conversation's dock opens on it.
window.api?.simulator?.onReveal((udid) => {
  const sim = useSimulator.getState()
  sim.select(udid)
  sim.setView({ mode: 'simulator' })
  void sim.refresh()
  useIde.getState().openSurface('device')
})
