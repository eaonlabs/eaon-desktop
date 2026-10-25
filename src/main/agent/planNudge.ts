import type { TodoItem } from '@shared/types'

/**
 * Keeping the agent's checklist (update_plan) true to the work. Models set a
 * plan at the start of a task and then forget it: the pinned plan sat on its
 * first step while the work finished under it. The loop reminds the agent
 * when the plan has gone a while without an update, and once, when it is
 * about to finish with steps still open, asks it to mark them.
 */

/** Tool rounds without an update_plan before the agent is reminded of its open steps. */
export const PLAN_STALE_ROUNDS = 6

/** The steps not marked done. */
export const openSteps = (todos: TodoItem[] | undefined): TodoItem[] => (todos ?? []).filter((t) => t.status !== 'done')

const list = (todos: TodoItem[]): string => openSteps(todos).map((t) => `- ${t.text} (${t.status === 'in_progress' ? 'in progress' : 'to do'})`).join('\n')

/** Added to a tool result when the plan has gone stale mid-turn. */
export function planReminder(todos: TodoItem[]): string {
  return `\n\n[Your checklist hasn't been updated for a while. Still open:\n${list(todos)}\nIf any of these are done, call update_plan with the whole list and their real status.]`
}

/** Sent once when the agent stops with steps still open. */
export function planFinishNudge(todos: TodoItem[]): string {
  return `Your checklist still shows open steps:\n${list(todos)}\nCall update_plan now with each step's real status (done, or still open if it isn't). Then stop: your answer above stands, so don't repeat it.`
}
