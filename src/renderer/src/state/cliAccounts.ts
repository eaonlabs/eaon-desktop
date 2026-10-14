import { create } from 'zustand'
import type { CliAccountsState, CliTool } from '@shared/cliAccounts'
import { useApp } from './store'

/**
 * Claude Code and Codex accounts and their plan usage, mirrored from main
 * (features/cliAccounts). One subscription for the whole renderer, opened by
 * whichever of the meter or Settings → Accounts mounts first.
 */

interface CliAccountsStore {
  state: CliAccountsState | null
  /** Loads once and follows main's updates. */
  ensure: () => void
  refresh: (options?: { tool?: CliTool; all?: boolean; force?: boolean }) => Promise<void>
}

let listening = false

export const useCliAccounts = create<CliAccountsStore>((set) => ({
  state: null,
  ensure: () => {
    if (listening) return
    listening = true
    window.api.cliAccounts.onChanged((state) => set({ state }))
    // A limit notification clicked: the accounts, where switching is one click.
    window.api.cliAccounts.onShow(() => useApp.getState().setSettingsPage('accounts'))
    void window.api.cliAccounts.state().then((state) => set({ state }))
  },
  refresh: async (options = {}) => {
    try {
      set({ state: await window.api.cliAccounts.refresh(options) })
    } catch {
      /* the figures stay as they were; main keeps the failure on the account */
    }
  }
}))

export { untilText, resetClock } from '@shared/cliAccounts'

/** "just now", "3 min ago". */
export function agoText(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}
