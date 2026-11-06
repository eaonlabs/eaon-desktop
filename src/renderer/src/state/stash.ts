import { create } from 'zustand'

/**
 * Prompts put aside for later: ⌘S in the composer saves what is in the box
 * and clears it; ⌘S in an empty box brings one back. Kept in this window's
 * storage, newest first, across chats and restarts.
 */

export interface StashedPrompt {
  id: string
  text: string
  attachments: string[]
  at: number
}

const KEY = 'eaon.promptStash'
/** The oldest go once there are this many. */
export const STASH_CAP = 20

function load(): StashedPrompt[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((p) => p && typeof p.text === 'string' && Array.isArray(p.attachments)).slice(0, STASH_CAP) : []
  } catch {
    return []
  }
}

function save(list: StashedPrompt[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    // Storage full or blocked: the stash lasts until the window closes.
  }
}

export const useStash = create<{ list: StashedPrompt[] }>(() => ({ list: typeof localStorage === 'undefined' ? [] : load() }))

/** The list with a prompt added at the front; the same prompt stashed again moves up rather than doubling. */
export function withStashed(list: StashedPrompt[], prompt: StashedPrompt): StashedPrompt[] {
  const rest = list.filter((p) => !(p.text === prompt.text && p.attachments.join('\n') === prompt.attachments.join('\n')))
  return [prompt, ...rest].slice(0, STASH_CAP)
}

export function stashPrompt(text: string, attachments: string[]): void {
  const prompt: StashedPrompt = { id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, text, attachments, at: Date.now() }
  const list = withStashed(useStash.getState().list, prompt)
  useStash.setState({ list })
  save(list)
}

/** Takes a prompt out of the stash to put it back in the box. */
export function takeStashed(id: string): StashedPrompt | undefined {
  const list = useStash.getState().list
  const found = list.find((p) => p.id === id)
  if (!found) return undefined
  const rest = list.filter((p) => p.id !== id)
  useStash.setState({ list: rest })
  save(rest)
  return found
}

export function dropStashed(id: string): void {
  const rest = useStash.getState().list.filter((p) => p.id !== id)
  useStash.setState({ list: rest })
  save(rest)
}

/** A stashed prompt's line in the menu: its first line, cut short. */
export function stashTitle(prompt: StashedPrompt): string {
  const first = prompt.text.trim().split('\n')[0].trim()
  if (first) return first.length > 70 ? `${first.slice(0, 69)}…` : first
  const files = prompt.attachments.length
  return files === 1 ? '1 file' : `${files} files`
}
