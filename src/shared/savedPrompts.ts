import { matchesSearch } from './searchWords'

/**
 * The prompt library: prompts the user keeps by name, to find and use again
 * from the composer (its + menu, or "/"). They stay until deleted. That
 * separates them from ⌘S, which sets what is in the box aside and takes it
 * out of the list when it comes back (renderer state/stash.ts).
 *
 * Kept in `saved-prompts.json` by main/features/savedPrompts.ts. Everything
 * here is pure, so it is tested under plain Node.
 */

export interface SavedPrompt {
  id: string
  name: string
  text: string
  createdAt: number
  updatedAt: number
}

export const PROMPT_NAME_LIMIT = 80
export const PROMPT_TEXT_LIMIT = 20_000
export const PROMPT_COUNT_LIMIT = 200

const cleanName = (name: unknown): string => (typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, PROMPT_NAME_LIMIT) : '')
const cleanText = (text: unknown): string => (typeof text === 'string' ? text.replace(/\r\n?/g, '\n').trim().slice(0, PROMPT_TEXT_LIMIT) : '')

/** A name for a prompt that has none yet: its first line, cut short. */
export function nameFor(text: string): string {
  const first = cleanText(text).split('\n').find((line) => line.trim()) ?? ''
  const line = first.replace(/\s+/g, ' ').trim()
  if (!line) return 'Untitled prompt'
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line
}

/** The library as it was read: whatever is damaged is dropped, the rest kept, newest first. */
export function parseSavedPrompts(raw: unknown): SavedPrompt[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const list: SavedPrompt[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const id = typeof e.id === 'string' && e.id ? e.id : ''
    const text = cleanText(e.text)
    if (!id || !text || seen.has(id)) continue
    seen.add(id)
    const createdAt = typeof e.createdAt === 'number' && Number.isFinite(e.createdAt) ? e.createdAt : 0
    list.push({
      id,
      name: cleanName(e.name) || nameFor(text),
      text,
      createdAt,
      updatedAt: typeof e.updatedAt === 'number' && Number.isFinite(e.updatedAt) ? e.updatedAt : createdAt
    })
  }
  return list.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, PROMPT_COUNT_LIMIT)
}

export type PromptChange = { ok: true; list: SavedPrompt[]; prompt: SavedPrompt } | { ok: false; message: string }

/**
 * Saves a prompt: a new one, or (with `id`) a change to one that is there.
 * The name defaults to the prompt's first line. Saved or changed prompts go
 * to the top of the list.
 */
export function savePrompt(list: SavedPrompt[], input: { id?: string; name?: unknown; text: unknown }, newId: () => string, now: number): PromptChange {
  const text = cleanText(input.text)
  if (!text) return { ok: false, message: 'A saved prompt needs some text.' }
  const name = cleanName(input.name) || nameFor(text)
  if (input.id) {
    const found = list.find((p) => p.id === input.id)
    if (!found) return { ok: false, message: 'That prompt is gone.' }
    const prompt: SavedPrompt = { ...found, name, text, updatedAt: now }
    return { ok: true, prompt, list: [prompt, ...list.filter((p) => p.id !== found.id)] }
  }
  if (list.length >= PROMPT_COUNT_LIMIT) return { ok: false, message: `You can keep ${PROMPT_COUNT_LIMIT} saved prompts. Delete some to make room.` }
  const prompt: SavedPrompt = { id: newId(), name, text, createdAt: now, updatedAt: now }
  return { ok: true, prompt, list: [prompt, ...list] }
}

export const removePrompt = (list: SavedPrompt[], id: string): SavedPrompt[] => list.filter((p) => p.id !== id)

/**
 * The prompts a search finds. Each word searched for has to begin a word in
 * the name or the text (searchWords.ts); names that match come before prompts
 * that match only in their text. With nothing searched for, the whole list.
 */
export function searchPrompts(list: readonly SavedPrompt[], query: string): SavedPrompt[] {
  if (!query.trim()) return [...list]
  const scored: { prompt: SavedPrompt; score: number; index: number }[] = []
  list.forEach((prompt, index) => {
    const score = matchesSearch(query, prompt.name) ? 0 : matchesSearch(query, prompt.text) ? 1 : -1
    if (score >= 0) scored.push({ prompt, score, index })
  })
  return scored.sort((a, b) => a.score - b.score || a.index - b.index).map((s) => s.prompt)
}

/** A prompt's text on one line, for a list: cut short. */
export function previewOf(text: string, limit = 110): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line
}
