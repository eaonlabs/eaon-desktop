// Conversations, projects, and statistics — the chat data the sidebar and
// message list render. Mutations go through these actions so persistence
// stays a single subscription in persist.ts.

import { create } from "zustand";
import type { ChatMessage, Conversation, Project, Statistics } from "../core/types";
import { DEFAULT_STATISTICS } from "../core/persistence";
import { uid } from "../core/utils";

interface ConversationsStore {
  conversations: Conversation[];
  projects: Project[];
  currentId: string | null;
  statistics: Statistics;

  hydrate: (data: {
    conversations: Conversation[];
    projects: Project[];
    currentId: string | null;
    statistics: Statistics;
  }) => void;

  current: () => Conversation | null;
  select: (id: string | null) => void;
  /** Creates and selects a new empty conversation; returns its id. */
  newConversation: (projectId?: string | null) => string;
  rename: (id: string, title: string) => void;
  remove: (id: string) => void;
  removeAll: () => void;
  setPinned: (id: string, pinned: boolean) => void;
  setProject: (id: string, projectId: string | null) => void;
  markRead: (id: string) => void;

  /** Append a message to a conversation (bumps updatedAt; flags unread for
   *  assistant messages landing in a non-selected conversation). */
  appendMessage: (conversationId: string, message: ChatMessage) => void;
  /** Streaming-rate updater — replaces one message in place by id. */
  updateMessage: (
    conversationId: string,
    messageId: string,
    mutate: (message: ChatMessage) => ChatMessage,
  ) => void;
  /** Drops the message and everything after it (edit & resend, regenerate). */
  truncateFrom: (conversationId: string, messageId: string) => void;
  setTitle: (conversationId: string, title: string) => void;

  newProject: (name: string) => string;
  renameProject: (id: string, name: string) => void;
  removeProject: (id: string) => void;

  recordPrompt: (modelKey: string) => void;
  recordGenerated: (modelKey: string, chars: number) => void;
}

export const useConversations = create<ConversationsStore>((set, get) => ({
  conversations: [],
  projects: [],
  currentId: null,
  statistics: structuredClone(DEFAULT_STATISTICS),

  hydrate: (data) => set(data),

  current: () => {
    const { conversations, currentId } = get();
    return conversations.find((c) => c.id === currentId) ?? null;
  },

  select: (id) => {
    set({ currentId: id });
    if (id) get().markRead(id);
  },

  newConversation: (projectId = null) => {
    const id = uid();
    const now = Date.now();
    const conversation: Conversation = {
      id,
      title: "New chat",
      messages: [],
      createdAt: now,
      updatedAt: now,
      projectId,
    };
    set((s) => ({ conversations: [conversation, ...s.conversations], currentId: id }));
    return id;
  },

  rename: (id, title) =>
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === id ? { ...c, title } : c)),
    })),

  remove: (id) =>
    set((s) => ({
      conversations: s.conversations.filter((c) => c.id !== id),
      currentId: s.currentId === id ? null : s.currentId,
    })),

  removeAll: () => set({ conversations: [], currentId: null }),

  setPinned: (id, pinned) =>
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === id ? { ...c, isPinned: pinned } : c)),
    })),

  setProject: (id, projectId) =>
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === id ? { ...c, projectId } : c)),
    })),

  markRead: (id) =>
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === id && c.hasUnread ? { ...c, hasUnread: false } : c,
      ),
    })),

  appendMessage: (conversationId, message) =>
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              messages: [...c.messages, message],
              updatedAt: Date.now(),
              hasUnread:
                message.role === "assistant" && s.currentId !== conversationId
                  ? true
                  : c.hasUnread,
            }
          : c,
      ),
    })),

  updateMessage: (conversationId, messageId, mutate) =>
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              messages: c.messages.map((m) => (m.id === messageId ? mutate(m) : m)),
            }
          : c,
      ),
    })),

  truncateFrom: (conversationId, messageId) =>
    set((s) => ({
      conversations: s.conversations.map((c) => {
        if (c.id !== conversationId) return c;
        const index = c.messages.findIndex((m) => m.id === messageId);
        return index === -1 ? c : { ...c, messages: c.messages.slice(0, index) };
      }),
    })),

  setTitle: (conversationId, title) =>
    set((s) => ({
      conversations: s.conversations.map((c) =>
        c.id === conversationId ? { ...c, title } : c,
      ),
    })),

  newProject: (name) => {
    const id = uid();
    set((s) => ({ projects: [...s.projects, { id, name, createdAt: Date.now() }] }));
    return id;
  },

  renameProject: (id, name) =>
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, name } : p)),
    })),

  removeProject: (id) =>
    set((s) => ({
      projects: s.projects.filter((p) => p.id !== id),
      conversations: s.conversations.map((c) =>
        c.projectId === id ? { ...c, projectId: null } : c,
      ),
    })),

  recordPrompt: (modelKey) =>
    set((s) => {
      const per = s.statistics.perModel[modelKey] ?? { prompts: 0, chars: 0 };
      return {
        statistics: {
          ...s.statistics,
          promptsSent: s.statistics.promptsSent + 1,
          perModel: { ...s.statistics.perModel, [modelKey]: { ...per, prompts: per.prompts + 1 } },
        },
      };
    }),

  recordGenerated: (modelKey, chars) =>
    set((s) => {
      const per = s.statistics.perModel[modelKey] ?? { prompts: 0, chars: 0 };
      return {
        statistics: {
          ...s.statistics,
          charsGenerated: s.statistics.charsGenerated + chars,
          perModel: { ...s.statistics.perModel, [modelKey]: { ...per, chars: per.chars + chars } },
        },
      };
    }),
}));
