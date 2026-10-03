/**
 * The composer's "/" and "@" menus, without the React: finding the word
 * being typed, ranking what matches it, and swapping it for the pick. Kept
 * free of the DOM and the store so it can be tested on its own.
 */

export type TriggerChar = '/' | '@'

/** A "/word" or "@word" under the caret. `start`..`end` is the whole word, trigger included. */
export interface Trigger {
  char: TriggerChar
  query: string
  start: number
  end: number
}

/** Longer than any command or name; past this it's a sentence, not a lookup. */
const MAX_QUERY = 40

/**
 * The trigger word the caret is in, if any. It must start a word (the start
 * of the text, or after whitespace), so "and/or", a URL's path and an email
 * address never open a menu, and the rest of the word may not hold another
 * trigger character (a path like "/usr/bin").
 */
export function findTrigger(text: string, caret: number, chars: readonly TriggerChar[] = ['/', '@']): Trigger | null {
  if (caret < 0 || caret > text.length) return null
  let start = caret
  while (start > 0 && !/\s/.test(text[start - 1])) start--
  let end = caret
  while (end < text.length && !/\s/.test(text[end])) end++
  const char = text[start] as TriggerChar
  if (!chars.includes(char) || caret === start) return null
  const query = text.slice(start + 1, caret)
  if (query.length > MAX_QUERY || query.includes('/') || query.includes('@')) return null
  return { char, query, start, end }
}

export interface Rankable {
  title: string
  /** Other words it answers to: a command's name ("plan"), a plugin's id. */
  keywords?: string
}

/**
 * Items matching `query`, best first: a title that starts with it, then a
 * word in the title that does, then a keyword, then the title containing it
 * anywhere. Ties keep the order given, which is the menu's own order. An
 * empty query keeps everything.
 */
export function rankItems<T extends Rankable>(items: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...items]
  const scored: { item: T; score: number; index: number }[] = []
  items.forEach((item, index) => {
    const title = item.title.toLowerCase()
    const keywords = (item.keywords ?? '').toLowerCase()
    const score = title.startsWith(q)
      ? 0
      : title.split(/[\s\-_/.]+/).some((word) => word.startsWith(q))
        ? 1
        : keywords.split(/\s+/).some((word) => word.startsWith(q))
          ? 2
          : title.includes(q) || keywords.includes(q)
            ? 3
            : -1
    if (score >= 0) scored.push({ item, score, index })
  })
  return scored.sort((a, b) => a.score - b.score || a.index - b.index).map((s) => s.item)
}

/**
 * The text with the trigger word replaced by `insert` (nothing, for a
 * command that only does something), and where the caret goes. A space
 * follows inserted text unless one is already there, so typing carries on.
 */
export function replaceTrigger(text: string, trigger: Pick<Trigger, 'start' | 'end'>, insert: string): { text: string; caret: number } {
  const before = text.slice(0, trigger.start)
  let after = text.slice(trigger.end)
  if (!insert) {
    // Removing "/plan " from "/plan fix it" shouldn't leave the space behind.
    if (/^\s/.test(after) && (before === '' || /\s$/.test(before))) after = after.slice(1)
    return { text: before + after, caret: before.length }
  }
  const spaced = /^\s/.test(after) ? insert : `${insert} `
  return { text: before + spaced + after, caret: before.length + insert.length + 1 }
}

/** `text` without a mention: "@Notion " and the space after it, wherever it appears. */
export function removeMention(text: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text
    .replace(new RegExp(`(^|\\s)@${escaped}(?![\\w-])\\s?`, 'gi'), '$1')
    .replace(/^\s+/, '')
}
