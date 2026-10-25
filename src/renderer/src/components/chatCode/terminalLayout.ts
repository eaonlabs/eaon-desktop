/**
 * How Chat's terminals are laid out, kept free of React and the store so the
 * test harness can run it. A tab is one shell; tabs split beside each other
 * share a group (shown together), and within a group the ones split down
 * share a column. Both are named by their first pane's id, which stays the
 * name after that pane closes.
 */

export interface PaneTab {
  id: string
  title: string
  /** Panes split beside each other share a group, named by the first pane's id; a pane alone is its own. */
  group?: string
  /** Within a group, panes split down share a column, named by its first pane's id. */
  col?: string
  /** In the dock's terminal surface of this id rather than in the drawer. */
  dock?: string
}

export type SplitDir = 'right' | 'down'

/** The group a pane is in. */
export const groupOf = (tab: PaneTab): string => tab.group ?? tab.id
/** The column of its group a pane is in. */
export const colOf = (tab: PaneTab): string => tab.col ?? tab.id

/** "Terminal 3": one past the highest number in use, so closing one never gives two the same name. */
export function nextTitle(tabs: PaneTab[]): string {
  const used = tabs.map((t) => /^Terminal(?: (\d+))?$/.exec(t.title)).filter(Boolean).map((m) => Number(m?.[1] ?? 1))
  return `Terminal ${used.length ? Math.max(...used) + 1 : 1}`
}

/**
 * `tab` split off `id`: down puts it under that pane in its column; right
 * puts it in a column of its own after that pane's whole column. Returns the
 * tabs in their new order, `tab` given its group and column.
 */
export function splitTabs<T extends PaneTab>(tabs: T[], id: string, dir: SplitDir, tab: T): T[] {
  const from = tabs.find((t) => t.id === id)
  if (!from) return tabs
  const group = groupOf(from)
  const placed: T = { ...tab, group, ...(dir === 'down' ? { col: colOf(from) } : {}) }
  const next = tabs.map((t) => (t.id === group && !t.group ? { ...t, group } : t))
  const at = dir === 'down' ? next.findIndex((t) => t.id === id) : next.reduce((last, t, i) => (groupOf(t) === group && colOf(t) === colOf(from) ? i : last), -1)
  next.splice(at + 1, 0, placed)
  return next
}

/** A group's panes as columns, each column's panes top to bottom. */
export function columnsOf<T extends PaneTab>(panes: T[]): T[][] {
  return [...new Set(panes.map(colOf))].map((col) => panes.filter((p) => colOf(p) === col))
}
