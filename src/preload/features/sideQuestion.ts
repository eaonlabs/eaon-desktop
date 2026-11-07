import { ipcRenderer } from 'electron'
import type { SideQuestionRequest, SideQuestionResult, SideQuestionText } from '@shared/sideQuestion'

/** Renderer bridge for side questions ("/btw"). Exposed as `window.api.sideQuestion`. */
export const sideQuestionApi = {
  /** Asks the question; resolves with the whole answer once it is written. */
  ask: (request: SideQuestionRequest): Promise<SideQuestionResult> => ipcRenderer.invoke('side-question:ask', request),
  cancel: (id: string): Promise<void> => ipcRenderer.invoke('side-question:cancel', id),
  /** The answer as it is written, a few words at a time. */
  onText: (handler: (piece: SideQuestionText) => void): (() => void) => {
    const listener = (_event: unknown, piece: SideQuestionText): void => handler(piece)
    ipcRenderer.on('side-question:text', listener)
    return () => ipcRenderer.removeListener('side-question:text', listener)
  }
}
