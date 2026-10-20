import type { Settings } from '@shared/types'

/**
 * The ADE's agent pickers as Settings → Agent providers arranges them: the
 * agents hidden there left out, the rest in the order dragged there (ones
 * never placed keep their own order, after). The shell is always offered.
 */
export function arrangeAgents<T extends { id: string }>(agents: T[], prefs: Settings['agentProviders'] | undefined): T[] {
  if (!prefs) return agents
  const hidden = new Set(prefs.hidden)
  const rank = new Map(prefs.order.map((id, i) => [id, i]))
  return agents
    .filter((a) => a.id === 'shell' || !hidden.has(a.id))
    .map((a, i) => ({ a, i }))
    .sort((x, y) => (rank.get(x.a.id) ?? 1e6 + x.i) - (rank.get(y.a.id) ?? 1e6 + y.i))
    .map(({ a }) => a)
}
