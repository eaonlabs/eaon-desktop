import { create } from 'zustand'
import { AGENT_BROWSER } from '@shared/agentBrowser'

/**
 * Whether the live view of the chat agent's browser is open beside the chat.
 * The view itself (`useLiveBrowser`) streams frames only while it is mounted,
 * so a closed panel costs nothing.
 *
 * The panel opens by itself the first time the agent uses its browser in a
 * chat, unless the user closed it there before — then it stays closed and the
 * header button brings it back.
 */
interface AgentBrowserState {
  open: boolean
  /** Chats where the user closed the panel: it won't pop open there again. */
  dismissed: Set<string>
  /** Chats the agent has used its browser in this session. */
  used: Set<string>
  init: (activeChatId: () => string | null) => void
  setOpen: (open: boolean, chatId?: string | null) => void
}

let bound = false

export const useAgentBrowser = create<AgentBrowserState>((set, get) => ({
  open: false,
  dismissed: new Set(),
  used: new Set(),

  init(activeChatId) {
    if (bound) return
    bound = true
    window.api.agentBrowser.onStep((step) => {
      if (step.target !== AGENT_BROWSER) return
      const state = get()
      if (!state.used.has(step.chatId)) set({ used: new Set([...state.used, step.chatId]) })
      if (!step.done && !state.open && step.chatId === activeChatId() && !state.dismissed.has(step.chatId)) get().setOpen(true)
    })
  },

  setOpen(open, chatId) {
    const state = get()
    if (state.open === open) return
    set({
      open,
      ...(!open && chatId ? { dismissed: new Set([...state.dismissed, chatId]) } : {})
    })
  }
}))
