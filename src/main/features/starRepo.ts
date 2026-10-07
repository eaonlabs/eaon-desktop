import { shell } from 'electron'
import type { StarAnswer, StarResult } from '@shared/star'
import { alreadyStarred, shouldAsk, starRepository } from '../starPrompt'
import { store } from '../store'
import type { Feature } from './types'

/**
 * The popup that asks whether to star Eaon on GitHub. Main keeps the count of
 * launches and asks, so the question survives restarts and is asked rarely;
 * the renderer only draws it (components/StarPrompt.tsx).
 */
export const starRepoFeature: Feature = {
  id: 'star-repo',
  register: ({ ipcMain }) => {
    const state = (): ReturnType<typeof store.getSettings>['starPrompt'] => store.getSettings().starPrompt
    const patch = (next: Partial<ReturnType<typeof state>>): void => void store.patchSettings({ starPrompt: { ...state(), ...next } })

    // One more launch, counted once per run.
    patch({ launches: state().launches + 1 })

    /** Whether to show the popup now. Showing it counts as an ask, however it is closed. */
    ipcMain.handle('star:should-ask', async (): Promise<boolean> => {
      if (!shouldAsk(state(), Date.now())) return false
      // Someone who starred it long ago, on their own, is not asked.
      if (await alreadyStarred()) {
        patch({ status: 'starred' })
        return false
      }
      patch({ asked: state().asked + 1, lastAskedAt: Date.now() })
      return true
    })

    ipcMain.handle('star:answer', async (_e, answer: StarAnswer): Promise<StarResult | null> => {
      if (answer === 'never') {
        patch({ status: 'declined' })
        return null
      }
      if (answer === 'later') return null
      const result = await starRepository((url) => shell.openExternal(url))
      // Opened but not starred (no GitHub CLI): they may still press the star on the page, so it is not asked again.
      patch({ status: 'starred' })
      return result
    })
  }
}
