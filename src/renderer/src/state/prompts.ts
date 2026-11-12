import { create } from 'zustand'
import type { SavedPrompt } from '@shared/savedPrompts'

/**
 * The prompt library as main has it (features/savedPrompts), for the
 * composer's library dialog and its "/" menu. Opened once, by the first
 * composer that mounts; every window then follows changes made in any other.
 */
interface PromptsStore {
  list: SavedPrompt[]
  ensure: () => void
}

let listening = false

export const usePrompts = create<PromptsStore>((set) => ({
  list: [],
  ensure: () => {
    if (listening) return
    listening = true
    window.api.prompts.onChanged((list) => set({ list }))
    window.api.prompts
      .list()
      .then((list) => set({ list }))
      .catch((error) => {
        listening = false
        console.error('[prompts] could not read the prompt library:', error)
      })
  }
}))
