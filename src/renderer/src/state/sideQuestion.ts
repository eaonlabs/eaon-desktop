import { create } from 'zustand'
import { SIDE_QUESTION_MAX, sideContext } from '@shared/sideQuestion'
import { errorText } from '../lib/errors'
import { useApp } from './store'

/**
 * The side question on screen ("/btw …" in Chat's message box,
 * shared/sideQuestion.ts): the question, the answer as it is written, and
 * whether it is still being worked on. One at a time, and never part of any
 * chat: closing the card is the end of it.
 */

export interface SideCard {
  id: string
  question: string
  answer: string
  status: 'asking' | 'done' | 'error'
  error?: string
}

interface SideState {
  card: SideCard | null
  ask: (question: string) => void
  close: () => void
}

let listening = false

const newId = (): string => `side-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

export const useSideQuestion = create<SideState>((set, get) => {
  const fail = (question: string, error: string): void => set({ card: { id: newId(), question, answer: '', status: 'error', error } })
  return {
    card: null,

    ask: (raw) => {
      const question = raw.trim().slice(0, SIDE_QUESTION_MAX)
      if (!question) return
      get().close()
      const app = useApp.getState()
      const settings = app.settings
      // A Codex model runs in Codex, not through a provider Eaon can send a one-off request to.
      if (settings?.selectedEngine) {
        fail(question, 'Side questions need a model from a provider. This chat is on a Codex model, which can’t answer one. Choose another model in the model menu to ask one.')
        return
      }
      const selection = app.modelSelection()
      const model = selection.model
      if (!model || selection.status === 'none' || selection.status === 'unavailable') {
        fail(question, selection.reason ?? 'Choose a model first.')
        return
      }
      const { history, summary } = sideContext(app.activeChat())
      const id = newId()
      set({ card: { id, question, answer: '', status: 'asking' } })
      if (!listening) {
        listening = true
        window.api.sideQuestion.onText((piece) => {
          const card = get().card
          if (card && card.id === piece.id && card.status === 'asking') set({ card: { ...card, answer: card.answer + piece.text } })
        })
      }
      void window.api.sideQuestion
        .ask({ id, providerId: model.providerId, modelId: model.id, question, history, summary })
        .then((result) => {
          const card = get().card
          if (!card || card.id !== id) return
          set({ card: result.ok ? { ...card, answer: result.text, status: 'done' } : { ...card, status: 'error', error: result.error } })
        })
        .catch((error: unknown) => {
          const card = get().card
          if (card && card.id === id) set({ card: { ...card, status: 'error', error: errorText(error) } })
        })
    },

    close: () => {
      const card = get().card
      if (!card) return
      if (card.status === 'asking') void window.api.sideQuestion.cancel(card.id)
      set({ card: null })
    }
  }
})
