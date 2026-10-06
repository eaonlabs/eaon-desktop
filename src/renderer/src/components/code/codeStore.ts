import { create } from 'zustand'
import type { EaonCodeStatus } from '@shared/eaonCode'
import { useApp } from '../../state/store'
import { useAdeSessions } from './sessionsStore'

/**
 * The ADE's state: which folder its terminals run in (the open session's —
 * see sessionsStore), the project folders opened before, and Eaon Code's
 * install status (for its Settings page and the "Eaon Code" terminal agent).
 *
 * The ADE is terminals only. It used to also drive an Eaon Code agent over
 * RPC — opening a folder started that process — and none of that runs now:
 * each pane runs its own CLI agent (Eaon Code, Claude Code, Codex…) as itself.
 */

interface CodeState {
  initialised: boolean
  status: EaonCodeStatus | null
  checking: boolean
  cwd: string | null
  recents: string[]
  toast: string | null

  init: () => Promise<void>
  refreshStatus: (refresh?: boolean) => Promise<EaonCodeStatus>
  chooseFolder: () => Promise<void>
  openFolder: (cwd: string) => Promise<void>
  forgetFolder: (cwd: string) => Promise<void>
  dismissToast: () => void
}

const api = (): typeof window.api.eaonCode => window.api.eaonCode

export const useCode = create<CodeState>((set, get) => ({
  initialised: false,
  status: null,
  checking: false,
  cwd: null,
  recents: [],
  toast: null,

  async init() {
    if (get().initialised) return
    set({ initialised: true })
    const recents = await api().recents()
    const cwd = useApp.getState().settings?.eaonCode.lastCwd ?? recents[0] ?? null
    set({ recents, cwd })
    void get().refreshStatus(false)
  },

  async refreshStatus(refresh = true) {
    set({ checking: true })
    try {
      const status = await api().status(refresh)
      set({ status })
      return status
    } finally {
      set({ checking: false })
    }
  },

  async chooseFolder() {
    const picked = await api().pickFolder()
    if (picked) await get().openFolder(picked)
  },

  // A folder opened is its own session in the ADE (made the first time).
  async openFolder(cwd) {
    try {
      await useAdeSessions.getState().openFolder(cwd)
    } catch (error) {
      set({ toast: (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') })
    }
  },

  async forgetFolder(cwd) {
    const recents = await api().forgetRecent(cwd)
    set({ recents })
    // Forgetting the open folder closes it: its terminals keep running, but
    // the ADE falls back to the next recent (or asks for one).
    if (get().cwd === cwd) {
      const next = recents[0] ?? null
      set({ cwd: next })
      if (next) void api().useFolder(next)
    }
  },

  dismissToast() {
    set({ toast: null })
  }
}))
