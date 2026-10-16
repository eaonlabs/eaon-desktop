import { create } from 'zustand'
import type { ScheduledTask } from '@shared/scheduler'

/** The purchase schedule dialog: opened by /purchase in Chat, or to edit one from Scheduled. */
export const usePurchaseDialog = create<{
  open: boolean
  /** The schedule being edited; null for a new one. */
  task: ScheduledTask | null
  show: (task?: ScheduledTask | null) => void
  close: () => void
}>((set) => ({
  open: false,
  task: null,
  show: (task = null) => set({ open: true, task }),
  close: () => set({ open: false, task: null })
}))
