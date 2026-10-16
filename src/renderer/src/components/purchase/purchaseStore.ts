import { create } from 'zustand'
import type { WorkerRoutine } from '@shared/workers'

/**
 * The purchase schedule dialog: opened by /purchase in a worker's composer
 * (or its + menu), or to change one from the worker's routines.
 */
export const usePurchaseDialog = create<{
  open: boolean
  /** The worker that places the orders; the dialog asks when there is none yet. */
  workerId: string | null
  /** The schedule being edited; null for a new one. */
  routine: WorkerRoutine | null
  show: (options?: { workerId?: string | null; routine?: WorkerRoutine | null }) => void
  close: () => void
}>((set) => ({
  open: false,
  workerId: null,
  routine: null,
  show: (options = {}) => set({ open: true, workerId: options.workerId ?? null, routine: options.routine ?? null }),
  close: () => set({ open: false, routine: null })
}))
