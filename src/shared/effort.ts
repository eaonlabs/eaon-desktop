import type { EffortLevel } from './types'

/**
 * Reasoning effort, shared by the model menu and the request code so both
 * agree on what a model will actually be asked for.
 *
 * The levels are the ones providers themselves use — `none`, `minimal`,
 * `low`, `medium`, `high`, `xhigh`, `max` — under Eaon's older ids (`light`
 * is low, `extra-high` is xhigh, `ultra` is max) so saved settings and chats
 * keep working. Each model lists the subset it accepts (`ModelInfo.efforts`,
 * from models.dev's `reasoning_options`); the user's choice is one global
 * preference, clamped per model rather than overwritten when they switch.
 */

/** Lowest to highest. */
export const EFFORT_ORDER: EffortLevel[] = ['none', 'minimal', 'light', 'medium', 'high', 'extra-high', 'ultra']

export const EFFORT_LABEL: Record<EffortLevel, string> = {
  none: 'Off',
  minimal: 'Minimal',
  light: 'Low',
  medium: 'Medium',
  high: 'High',
  'extra-high': 'Extra high',
  ultra: 'Max'
}

/** What each level is called on the wire (OpenAI, Anthropic, OpenRouter and most compatible hosts). */
export const WIRE_EFFORT: Record<EffortLevel, string> = {
  none: 'none',
  minimal: 'minimal',
  light: 'low',
  medium: 'medium',
  high: 'high',
  'extra-high': 'xhigh',
  ultra: 'max'
}

/** models.dev / provider effort names back to Eaon levels. `default` has no equivalent and is dropped. */
export const EFFORT_FROM_WIRE: Record<string, EffortLevel> = Object.fromEntries(
  Object.entries(WIRE_EFFORT).map(([level, wire]) => [wire, level as EffortLevel])
)

/** Sorts and de-duplicates a list of levels into `EFFORT_ORDER`. */
export function orderEfforts(levels: Iterable<EffortLevel>): EffortLevel[] {
  const set = new Set(levels)
  return EFFORT_ORDER.filter((level) => set.has(level))
}

/**
 * The level a model will actually get: the chosen one if it takes it,
 * otherwise the nearest level below (a model that stops at High gets High for
 * Max, never its cheapest setting), otherwise the lowest it has. `undefined`
 * when the model takes no effort at all.
 */
export function clampEffort(requested: EffortLevel | undefined, efforts: EffortLevel[] | undefined): EffortLevel | undefined {
  if (!efforts || efforts.length === 0) return undefined
  const wanted = requested && EFFORT_ORDER.includes(requested) ? requested : 'medium'
  if (efforts.includes(wanted)) return wanted
  for (let i = EFFORT_ORDER.indexOf(wanted); i >= 0; i--) if (efforts.includes(EFFORT_ORDER[i])) return EFFORT_ORDER[i]
  return orderEfforts(efforts)[0]
}
