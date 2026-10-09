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

/** How often a reply that is still streaming is saved, so a crash loses seconds of it and not all of it. */
export const CHECKPOINT_MS = 5_000
/** The first save of a reply comes sooner, so a crash in its opening seconds still keeps what was said. */
export const CHECKPOINT_FIRST_MS = 1_500

/**
 * Saves the chats while a reply streams. A reply used to be saved only when
 * it ended (or its chat was renamed), so a crash, a kill or a power cut in
 * the middle of a long agent run lost everything it had produced since the
 * message was sent: the relaunch showed "No response". `touch` is called for
 * every event of the stream; the first starts a timer and the rest add
 * nothing, so this is a throttle, not a debounce (which a steady stream of
 * tokens would keep pushing back forever). When the timer fires, `save` takes
 * whatever the store holds then.
 */
export class Checkpoint {
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Nothing of this reply has been saved yet: its first checkpoint is the early one. */
  private first = true

  constructor(
    private readonly save: () => void,
    private readonly everyMs = CHECKPOINT_MS,
    private readonly firstMs = CHECKPOINT_FIRST_MS
  ) {}

  touch(): void {
    if (this.timer) return
    const wait = this.first ? Math.min(this.firstMs, this.everyMs) : this.everyMs
    this.timer = setTimeout(() => {
      this.timer = null
      this.first = false
      this.save()
    }, wait)
  }

  /** A regular save is happening (or the reply ended): it covers what the checkpoint would have saved, and the next reply starts early again. */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.first = true
  }
}
