import { create } from 'zustand'
import type { CliAccountsState, CliTool } from '@shared/cliAccounts'

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

/** "4h 23m", "2d 5h", "12m", "now". */
export function untilText(at: number | null, now: number): string | null {
  if (at === null) return null
  const ms = at - now
  if (ms <= 0) return 'now'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${Math.max(1, minutes)}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** "just now", "3 min ago". */
export function agoText(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}
