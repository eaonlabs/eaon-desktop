import type { Chat } from '@shared/types'

/**
 * What a window has to save: the chats whose object is not the one main
 * last had (the store replaces a chat's object whenever it changes, so
 * identity is enough), and the ones that are gone.
 */
export function chatChanges(synced: ReadonlyMap<string, Chat>, chats: readonly Chat[]): { upserts: Chat[]; removed: string[] } {
  const upserts = chats.filter((chat) => synced.get(chat.id) !== chat)
  const present = new Set(chats.map((chat) => chat.id))
  const removed = [...synced.keys()].filter((id) => !present.has(id))
  return { upserts, removed }
}
