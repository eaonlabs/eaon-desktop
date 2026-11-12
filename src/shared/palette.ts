import { matchesSearch } from './searchWords'

/**
 * What the command palette needs to find an action: its name, the group it is
 * listed under, and words people use for it that its name doesn't say. The
 * renderer's actions (lib/commands.ts) carry a `run` on top of this.
 */
export interface PaletteItem {
  id: string
  title: string
  group: string
  /** Searched, never shown: "dark mode" for a theme, "api key" for Model providers. */
  keywords?: string
}

/**
 * How well `item` answers `query`: 0 is a title that starts with it, 1 a title
 * with each word at the start of one of its words, 2 the title and its group,
 * 3 the keywords as well; null is no match. Words are matched as Settings
 * search matches them (shared/searchWords.ts).
 */
export function paletteScore(item: PaletteItem, query: string): number | null {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const title = item.title.toLowerCase()
  if (title.startsWith(q)) return 0
  if (matchesSearch(q, item.title)) return 1
  if (matchesSearch(q, `${item.group} ${item.title}`)) return 2
  if (matchesSearch(q, `${item.group} ${item.title} ${item.keywords ?? ''}`)) return 3
  return null
}

/**
 * The items that match, best first and otherwise in the order given, so the
 * order the sources list their actions in is the order of an empty search.
 * Repeated ids (a source registered twice) show once.
 */
export function rankItems<T extends PaletteItem>(items: readonly T[], query: string, limit = 50): T[] {
  const seen = new Set<string>()
  const scored: { item: T; score: number; at: number }[] = []
  items.forEach((item, at) => {
    if (seen.has(item.id)) return
    seen.add(item.id)
    const score = paletteScore(item, query)
    if (score !== null) scored.push({ item, score, at })
  })
  scored.sort((a, b) => a.score - b.score || a.at - b.at)
  return scored.slice(0, limit).map((entry) => entry.item)
}

/**
 * What the palette shows before anything is typed: the actions run last,
 * then the rest in the order the sources list them.
 */
export function withRecentsFirst<T extends PaletteItem>(items: readonly T[], recent: readonly string[], limit = 60): T[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  const head = recent.map((id) => byId.get(id)).filter((item): item is T => Boolean(item))
  const seen = new Set(head.map((item) => item.id))
  return [...head, ...items.filter((item) => !seen.has(item.id))].slice(0, limit)
}
