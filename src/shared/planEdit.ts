import type { PlanProposal } from './types'

/**
 * Editing the plan the agent proposed (plan mode) before it builds. The steps
 * are cleaned the way anything typed into them has to be, and what the agent
 * is told on approval says which steps the person changed, so it follows the
 * edited plan rather than the one it wrote.
 */

export const MAX_PLAN_STEPS = 40
export const MAX_STEP_CHARS = 500

/** Steps as typed: trimmed, blanks dropped, long ones cut, no more than MAX_PLAN_STEPS. */
export function cleanPlanSteps(steps: readonly string[]): string[] {
  return steps
    .map((s) => s.replace(/\s+/g, ' ').trim().slice(0, MAX_STEP_CHARS))
    .filter(Boolean)
    .slice(0, MAX_PLAN_STEPS)
}

/** A step moved up (-1) or down (1); the same list when it is already at that end. */
export function moveStep<T>(list: readonly T[], index: number, by: -1 | 1): T[] {
  const to = index + by
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return [...list]
  const next = [...list]
  ;[next[index], next[to]] = [next[to], next[index]]
  return next
}

/** True when the cleaned steps differ from the ones the agent proposed. */
export const planChanged = (before: readonly string[], after: readonly string[]): boolean => before.length !== after.length || before.some((s, i) => s !== after[i])

/** What the agent is sent when the person approves: the plan as it stands, said to be theirs when they changed it. */
export function planApprovalMessage(plan: Pick<PlanProposal, 'title' | 'steps' | 'edited'>): string {
  const tail = 'Keep the checklist updated as you go.'
  if (!plan.edited) return `Approved — carry out the plan. ${tail}`
  const steps = plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
  return [`Approved — but I changed the plan, so carry out this version, not your first one${plan.title ? ` (${plan.title})` : ''}:`, '', steps, '', `Do these steps in this order and nothing else. ${tail}`].join('\n')
}
