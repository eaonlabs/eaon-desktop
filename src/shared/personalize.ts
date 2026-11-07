/**
 * What the user told Eaon about themselves, to carry into every chat: custom
 * instructions (one text box in Settings → General) and memory (short facts
 * in Settings → Memory, which the model can add to with `remember`).
 *
 * Both are plain text in one local file (main/features/personalize.ts) and
 * ride in the chat's system prompt next to the project's and the mods'
 * instructions. Everything here is pure so it can be tested under plain Node.
 */

/** Characters of custom instructions kept; they are resent with every message, so they stay short. */
export const INSTRUCTIONS_LIMIT = 3000
/** Characters in one memory: a fact, not a note. */
export const MEMORY_TEXT_LIMIT = 300
/** Memories kept. A full memory says so rather than quietly dropping the oldest. */
export const MEMORY_COUNT_LIMIT = 100
/** Characters of memory sent with a message. The newest come first; older ones that don't fit are left out of the prompt but stay in Settings. */
export const MEMORY_PROMPT_LIMIT = 3000

export interface MemoryItem {
  id: string
  text: string
  createdAt: number
  updatedAt: number
  /** Written by the user in Settings, or saved by the model when asked to remember something. */
  source: 'you' | 'model'
}

export interface Personalize {
  /** Added to every chat's system prompt; nothing is added when it is empty. */
  instructions: string
  memory: { enabled: boolean; items: MemoryItem[] }
}

export const EMPTY_PERSONALIZE: Personalize = { instructions: '', memory: { enabled: false, items: [] } }

/** Custom instructions as kept: trimmed and capped. Line breaks stay, since people write lists. */
export function cleanInstructions(text: unknown): string {
  if (typeof text !== 'string') return ''
  return text.replace(/\r\n?/g, '\n').trim().slice(0, INSTRUCTIONS_LIMIT)
}

/** One memory as kept: a single line, trimmed and capped. */
export function cleanMemoryText(text: unknown): string {
  if (typeof text !== 'string') return ''
  return text.replace(/\s+/g, ' ').trim().slice(0, MEMORY_TEXT_LIMIT)
}

/** The file as it was read: anything missing or malformed becomes the default, so a damaged file never breaks a chat. */
export function parsePersonalize(raw: unknown): Personalize {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const memory = (value.memory && typeof value.memory === 'object' ? value.memory : {}) as Record<string, unknown>
  const items: MemoryItem[] = []
  const seen = new Set<string>()
  for (const entry of Array.isArray(memory.items) ? memory.items : []) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const text = cleanMemoryText(e.text)
    const id = typeof e.id === 'string' && e.id ? e.id : ''
    if (!text || !id || seen.has(id)) continue
    seen.add(id)
    const createdAt = typeof e.createdAt === 'number' && Number.isFinite(e.createdAt) ? e.createdAt : 0
    items.push({
      id,
      text,
      createdAt,
      updatedAt: typeof e.updatedAt === 'number' && Number.isFinite(e.updatedAt) ? e.updatedAt : createdAt,
      source: e.source === 'model' ? 'model' : 'you'
    })
  }
  return {
    instructions: cleanInstructions(value.instructions),
    memory: { enabled: memory.enabled === true, items: items.slice(0, MEMORY_COUNT_LIMIT) }
  }
}

const sameText = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

export type MemoryChange =
  | { ok: true; items: MemoryItem[]; item: MemoryItem }
  | { ok: false; reason: 'empty' | 'duplicate' | 'full' | 'missing'; message: string }

/** A new memory at the front of the list (newest first). */
export function addMemory(items: MemoryItem[], text: unknown, source: MemoryItem['source'], id: string, now: number): MemoryChange {
  const clean = cleanMemoryText(text)
  if (!clean) return { ok: false, reason: 'empty', message: 'There is nothing to remember in that.' }
  if (items.some((i) => sameText(i.text, clean))) return { ok: false, reason: 'duplicate', message: 'That is already in memory.' }
  if (items.length >= MEMORY_COUNT_LIMIT) {
    return { ok: false, reason: 'full', message: `Memory is full (${MEMORY_COUNT_LIMIT} items). Delete some in Settings → Memory to make room.` }
  }
  const item: MemoryItem = { id, text: clean, createdAt: now, updatedAt: now, source }
  return { ok: true, items: [item, ...items], item }
}

/** A memory's text changed in place. */
export function editMemory(items: MemoryItem[], id: string, text: unknown, now: number): MemoryChange {
  const target = items.find((i) => i.id === id)
  if (!target) return { ok: false, reason: 'missing', message: 'That memory is gone.' }
  const clean = cleanMemoryText(text)
  if (!clean) return { ok: false, reason: 'empty', message: 'A memory can’t be empty. Delete it instead.' }
  if (items.some((i) => i.id !== id && sameText(i.text, clean))) return { ok: false, reason: 'duplicate', message: 'That is already in memory.' }
  const item: MemoryItem = { ...target, text: clean, updatedAt: now }
  return { ok: true, items: items.map((i) => (i.id === id ? item : i)), item }
}

export const deleteMemory = (items: MemoryItem[], id: string): MemoryItem[] => items.filter((i) => i.id !== id)

/** The custom instructions as a block for the system prompt, or '' when there are none. */
export function instructionsBlock(instructions: string): string {
  const text = cleanInstructions(instructions)
  return text ? `The user's custom instructions, which apply to every chat:\n${text}` : ''
}

/**
 * The memories as a block for the system prompt, newest first, within
 * `limit` characters, or '' when there are none. Says how many were left out
 * so the model doesn't take a short list for the whole of it.
 */
export function memoryBlock(items: MemoryItem[], limit = MEMORY_PROMPT_LIMIT): string {
  if (items.length === 0) return ''
  const head = 'What the user wants you to remember across chats (use it when it helps; do not mention it unless it matters):'
  const lines: string[] = []
  let used = head.length
  for (const item of items) {
    const line = `- ${item.text}`
    if (used + line.length + 1 > limit) break
    lines.push(line)
    used += line.length + 1
  }
  if (lines.length === 0) return ''
  const left = items.length - lines.length
  return [head, ...lines, left > 0 ? `(${left} older ${left === 1 ? 'memory is' : 'memories are'} not shown here.)` : ''].filter(Boolean).join('\n')
}

/** Joins the parts of a chat's instructions, leaving out the empty ones. */
export const joinInstructions = (...parts: string[]): string => parts.filter((part) => part && part.trim()).join('\n\n')

/** What this file adds to a chat's instructions: the custom instructions, then memory when it is on. */
export function personalInstructions(p: Personalize): string {
  return joinInstructions(instructionsBlock(p.instructions), p.memory.enabled ? memoryBlock(p.memory.items) : '')
}
