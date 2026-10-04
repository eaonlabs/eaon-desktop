import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Chat } from '@shared/types'

/**
 * The CLI's chats: one file per chat under `<profile>/chats/`.
 *
 * The desktop keeps every chat in one `chats.json` and has one process to
 * write it. The CLI can have several sessions open on one profile at once,
 * and whole-list saves from two processes would each erase the other's new
 * chats. With a file per chat, two sessions only collide if both write the
 * same chat, which the TUI avoids by opening a chat in one place at a time.
 */

export interface ChatSummary {
  id: string
  title: string
  updatedAt: number
  createdAt: number
  pinned: boolean
  archived: boolean
  messages: number
  modelId: string | null
  /** Where it came from, if it was continued from the desktop app. */
  origin?: 'desktop'
}

const dir = (): string => join(app.getPath('userData'), 'chats')
const fileOf = (id: string): string => join(dir(), `${id.replace(/[^\w.-]/g, '_')}.json`)

/** Summaries by file, reused while the file's mtime hasn't moved. */
const summaries = new Map<string, { mtimeMs: number; summary: ChatSummary }>()
const queues = new Map<string, Promise<void>>()
const pending = new Map<string, Chat>()

function summarize(chat: Chat & { origin?: 'desktop' }): ChatSummary {
  return {
    id: chat.id,
    title: chat.title,
    updatedAt: chat.updatedAt,
    createdAt: chat.createdAt,
    pinned: chat.pinned,
    archived: chat.archived,
    messages: chat.messages.length,
    modelId: chat.modelId,
    ...(chat.origin ? { origin: chat.origin } : {})
  }
}

export const chatStore = {
  dir,

  /** Every chat, newest first; pinned ones on top. Archived chats are left out unless asked for. */
  list(includeArchived = false): ChatSummary[] {
    const out: ChatSummary[] = []
    if (!existsSync(dir())) return pending.size ? [...pending.values()].map(summarize) : out
    for (const name of readdirSync(dir())) {
      if (!name.endsWith('.json')) continue
      const file = join(dir(), name)
      try {
        const { mtimeMs } = statSync(file)
        const cached = summaries.get(file)
        if (cached && cached.mtimeMs === mtimeMs) {
          out.push(cached.summary)
          continue
        }
        const summary = summarize(JSON.parse(readFileSync(file, 'utf8')) as Chat)
        summaries.set(file, { mtimeMs, summary })
        out.push(summary)
      } catch {
        /* half-written by another session, or damaged: skip it this time */
      }
    }
    // Saves still queued count too, so a chat started a moment ago is listed.
    for (const chat of pending.values()) {
      const at = out.findIndex((c) => c.id === chat.id)
      if (at === -1) out.push(summarize(chat))
      else out[at] = summarize(chat)
    }
    return out
      .filter((c) => includeArchived || !c.archived)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
  },

  load(id: string): Chat | null {
    const queued = pending.get(id)
    if (queued) return structuredClone(queued)
    try {
      return JSON.parse(readFileSync(fileOf(id), 'utf8')) as Chat
    } catch {
      return null
    }
  },

  /** Saves off the event loop. Saves that pile up while one is writing collapse into the newest. */
  save(chat: Chat): void {
    const already = pending.has(chat.id)
    pending.set(chat.id, structuredClone(chat))
    if (already) return
    if (!existsSync(dir())) mkdirSync(dir(), { recursive: true })
    const target = fileOf(chat.id)
    const tmp = `${target}.${process.pid}.tmp`
    const run = (queues.get(chat.id) ?? Promise.resolve())
      .then(() => {
        const latest = pending.get(chat.id)
        pending.delete(chat.id)
        return latest ? writeFile(tmp, JSON.stringify(latest), 'utf8').then(() => rename(tmp, target)) : undefined
      })
      .catch((error) => console.error(`[chats] could not save ${chat.id}:`, error))
    queues.set(chat.id, run)
  },

  async remove(id: string): Promise<void> {
    pending.delete(id)
    await (queues.get(id) ?? Promise.resolve())
    await rm(fileOf(id), { force: true })
  },

  async flush(): Promise<void> {
    await Promise.all([...queues.values()])
  }
}
