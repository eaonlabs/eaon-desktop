/**
 * What the app tells the user about its saved data (see main/storeFiles.ts):
 * a file it had to repair, restore or start over when it read it, and a save
 * that is failing (a full disk). Shown as a notice in every window.
 */

export interface StoreProblem {
  id: string
  /**
   * `repaired`: damaged entries were set aside, or a cut-off file was read up
   * to the cut. `restored`: the previous save was used instead. `reset`:
   * nothing was recoverable, so it starts empty. `unsaved`: saving is failing
   * right now; the changes are held in memory and retried.
   */
  kind: 'repaired' | 'restored' | 'reset' | 'unsaved'
  /** The file under the store folder, e.g. `chats.json`. */
  file: string
  /** What the user calls it: "Chats", "Settings". */
  label: string
  /** One or two plain sentences: what happened and what to do. */
  detail: string
  /** The damaged file's copy, when one was kept. */
  copy?: string
  /** The error code behind a failing save (ENOSPC, EACCES). */
  code?: string
  at: number
}

export interface StoreHealth {
  problems: StoreProblem[]
}
