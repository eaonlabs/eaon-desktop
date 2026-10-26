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

    /** Whether the popup came up this run already: once a run is enough. */
    let askedThisRun = false
    const ask = async (): Promise<boolean> => {
      if (askedThisRun || !shouldAsk(state(), Date.now())) return false
      // Someone who starred it long ago, on their own, is not asked.
      if (await alreadyStarred()) {
        patch({ status: 'starred' })
        return false
      }
      patch({ asked: state().asked + 1, lastAskedAt: Date.now() })
      askedThisRun = true
      return true
    }

    /** Whether to show the popup now. Showing it counts as an ask, however it is closed. */
    ipcMain.handle('star:should-ask', (): Promise<boolean> => ask())

    /**
     * The first time ever, it comes early: after half a minute of use, as a
     * welcome (an update's "Enjoying Eaon?"). After that, only the usual
     * 10 to 20 minutes in. The end-to-end tests turn it off.
     */
    ipcMain.handle('star:should-ask-first', async (): Promise<boolean> => {
      if (process.env.EAON_OFFERS === 'off' || state().asked > 0) return false
      return ask()
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
