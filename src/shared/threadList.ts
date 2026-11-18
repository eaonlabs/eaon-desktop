/**
 * The sidebar's thread list (the ADE's sessions, Chat's chats): one row per
 * thread, tagged with its project, the pinned ones first and then the most
 * recently active, with the ones working gathered under the list. The parts
 * that are plain logic live here, where they can be tested.
 */

/** Two letters for a project's tag: its first two words' initials ("Acme Web" → AW, `pixel-quest` → PQ), or a one-word name's first two letters. */
export function initialsOf(name: string): string {
  const words = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s._\-/\\]+/)
    .filter(Boolean)
  if (words.length === 0) return '?'
  const letters = words.length > 1 ? [...words[0]][0] + [...words[1]][0] : [...words[0]].slice(0, 2).join('')
  return letters.toUpperCase()
}

/** How many tints a project's tag can take (threads.css has one per number). */
export const BADGE_HUES = 8

/** A project's tint, the same for its name every time, so a project keeps its colour across lists and launches. */
export function hueOf(name: string): number {
  let hash = 0
  for (const ch of name) hash = (Math.imul(hash, 31) + ch.codePointAt(0)!) >>> 0
  return hash % BADGE_HUES
}

/** How long something has been working, as the row says it: 31s, 5m, 1h 5m. */
export function workingFor(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
}

/** Threads in the list's order: pinned first, then by `at` (most recent first). Ties keep the order they came in. */
export function threadOrder<T>(items: readonly T[], at: (item: T) => number, pinned: (item: T) => boolean): T[] {
  return items
    .map((item, index) => ({ item, index, at: at(item), pinned: pinned(item) }))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.at - a.at || a.index - b.index)
    .map((entry) => entry.item)
}

/**
 * The list's order while the pointer is on it: rows already shown keep their
 * places and new ones go first. Re-sorting by activity under the pointer
 * moved the row about to be clicked.
 */
export function heldOrder(ids: readonly string[], shown: readonly string[]): string[] {
  const place = new Map(shown.map((id, i) => [id, i]))
  const fresh = ids.filter((id) => !place.has(id))
  const known = ids.filter((id) => place.has(id)).sort((a, b) => place.get(a)! - place.get(b)!)
  return [...fresh, ...known]
}

/** Whether a search matches any of a thread's texts (case aside). An empty search matches everything. */
export function matchesSearch(query: string, texts: readonly (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return texts.some((text) => Boolean(text && text.toLowerCase().includes(q)))
}
