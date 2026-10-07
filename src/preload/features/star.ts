import { ipcRenderer } from 'electron'
import type { StarAnswer, StarResult } from '@shared/star'

/**
 * Renderer bridge for the star-repo feature. Exposed as `window.api.star`.
 */
export const starApi = {
  /** Whether to show the popup now (and it counts as shown). */
  shouldAsk: (): Promise<boolean> => ipcRenderer.invoke('star:should-ask'),
  /** `star` opens the repository and stars it if the GitHub CLI is signed in. */
  answer: (answer: StarAnswer): Promise<StarResult | null> => ipcRenderer.invoke('star:answer', answer)
}
