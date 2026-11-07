import type { Feature } from './types'
import { askSideQuestion } from '../agent/sideQuestion'
import type { SideQuestionRequest, SideQuestionResult, SideQuestionText } from '@shared/sideQuestion'

/**
 * Side questions (shared/sideQuestion.ts). Channels: `side-question:ask`
 * (answers once it is done, and streams the words to the asking window as
 * `side-question:text` while it writes) and `side-question:cancel`.
 */

const asking = new Map<string, AbortController>()

/** A request from the renderer, checked: the ids and the question are text, and the history a list. */
function checked(value: unknown): SideQuestionRequest {
  const r = value as Partial<SideQuestionRequest> | null
  if (!r || typeof r.id !== 'string' || !r.id || typeof r.providerId !== 'string' || typeof r.modelId !== 'string' || typeof r.question !== 'string') {
    throw new Error('Expected a question.')
  }
  return {
    id: r.id.slice(0, 100),
    providerId: r.providerId,
    modelId: r.modelId,
    question: r.question,
    history: Array.isArray(r.history) ? r.history : [],
    summary: typeof r.summary === 'string' ? r.summary : null
  }
}

export const sideQuestionFeature: Feature = {
  id: 'side-question',
  register: ({ ipcMain }) => {
    ipcMain.handle('side-question:ask', async (event, raw: unknown): Promise<SideQuestionResult> => {
      const request = checked(raw)
      asking.get(request.id)?.abort()
      const stopped = new AbortController()
      asking.set(request.id, stopped)
      // The words go out in bursts, not one message a token.
      let pending = ''
      let timer: NodeJS.Timeout | null = null
      const flush = (): void => {
        timer = null
        if (pending && !event.sender.isDestroyed()) event.sender.send('side-question:text', { id: request.id, text: pending } satisfies SideQuestionText)
        pending = ''
      }
      try {
        return await askSideQuestion(
          request,
          (delta) => {
            pending += delta
            timer ??= setTimeout(flush, 60)
          },
          stopped.signal
        )
      } finally {
        if (timer) clearTimeout(timer)
        flush()
        if (asking.get(request.id) === stopped) asking.delete(request.id)
      }
    })
    ipcMain.handle('side-question:cancel', (_e, id: unknown) => {
      if (typeof id === 'string') asking.get(id)?.abort()
    })
  }
}
