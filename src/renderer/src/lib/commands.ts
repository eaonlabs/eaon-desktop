import { rankItems, type PaletteItem } from '@shared/palette'

/**
 * The command palette's registry: what it can run, as data. A feature adds
 * its actions with `registerPaletteSource` and takes them away with the
 * function that returns; nothing else has to know about the palette.
 *
 *   const off = registerPaletteSource('my-feature', () => [
 *     { id: 'my-feature:go', title: 'Do the thing', group: 'My feature', run: () => doThing() }
 *   ])
 *
 * A source is called each time the palette opens and as the query changes, so
 * what it lists can follow the app (the chats there are now, a switch's state
 * now); it is given the query for lists too long to offer whole.
 */

export interface PaletteAction extends PaletteItem {
  run: () => void
  /** The id of a shortcut (shared/keybindings) to show beside it, as its key is now. */
  shortcut?: string
  /** What a switch is now ("On", "Off"), shown at the right. */
  state?: string
  /** The choice in force, such as the theme in use. */
  current?: boolean
  /** A line under the title: what a setting does. */
  detail?: string
}

export type PaletteSource = (query: string) => PaletteAction[]

const sources = new Map<string, PaletteSource>()

/** Adds (or replaces) a source of actions; returns the function that removes it. */
export function registerPaletteSource(id: string, source: PaletteSource): () => void {
  sources.set(id, source)
  return () => {
    if (sources.get(id) === source) sources.delete(id)
  }
}

/** Every action the sources list now, in the order they were registered. */
export function paletteActions(query: string): PaletteAction[] {
  const out: PaletteAction[] = []
  for (const [id, source] of sources) {
    try {
      out.push(...source(query))
    } catch (error) {
      // One source failing leaves the rest of the palette working.
      console.error(`[palette] ${id}:`, error)
    }
  }
  return out
}

/** The actions that answer `query`, best first. */
export function searchPalette(query: string, limit = 60): PaletteAction[] {
  return rankItems(paletteActions(query), query, limit)
}

/* ------------------------------------------------------------------ recents */

const RECENT_KEY = 'eaon.palette.recent'
const RECENT_LIMIT = 6

/** The ids of the actions run last, newest first. Kept in this window's storage only; nothing breaks without it. */
export function recentActionIds(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string').slice(0, RECENT_LIMIT) : []
  } catch {
    return []
  }
}

export function rememberAction(id: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recentActionIds().filter((x) => x !== id)].slice(0, RECENT_LIMIT)))
  } catch {
    // Not remembered; the list just opens in its usual order.
  }
}
