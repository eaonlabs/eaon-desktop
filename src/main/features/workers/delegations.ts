import {
  MAX_DELEGATION_DEPTH,
  MAX_OPEN_DELEGATIONS,
  type DelegationState,
  type WorkerDelegation
} from '@shared/workers'

/**
 * Delegations as data: who handed what to whom, where it stands, and what came
 * back. The engine moves them through their states; this file holds the rules
 * that don't need the engine — loading, which states are still open, and
 * whether a new delegation would loop or nest too deep.
 */

const OPEN: DelegationState[] = ['assigned', 'running', 'waiting']
const STATES: DelegationState[] = [...OPEN, 'completed', 'failed', 'cancelled']

export const isOpenDelegation = (d: Pick<WorkerDelegation, 'state'>): boolean => OPEN.includes(d.state)

/** Finished delegations kept for the user to look back on. */
const KEEP_CLOSED = 200

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Saved delegations, repaired; ones whose workers are gone end as cancelled rather than hanging open. */
export function normalizeDelegations(raw: unknown, workerIds: Set<string>, now: number): WorkerDelegation[] {
  const seen = new Set<string>()
  const out: WorkerDelegation[] = []
  for (const item of Array.isArray(raw) ? raw : []) {
    const v = item as Partial<WorkerDelegation> | null
    if (!v || typeof v.id !== 'string' || seen.has(v.id) || !v.parent || !v.recipient) continue
    if (typeof v.parent.workerId !== 'string' || typeof v.recipient.workerId !== 'string') continue
    seen.add(v.id)
    const delegation: WorkerDelegation = {
      id: v.id,
      parent: {
        workerId: v.parent.workerId,
        name: str(v.parent.name) || 'A worker',
        threadId: str(v.parent.threadId) || 'main',
        executionId: typeof v.parent.executionId === 'string' ? v.parent.executionId : null
      },
      recipient: {
        workerId: v.recipient.workerId,
        name: str(v.recipient.name) || 'A worker',
        threadId: typeof v.recipient.threadId === 'string' ? v.recipient.threadId : null
      },
      objective: str(v.objective),
      context: str(v.context),
      files: Array.isArray(v.files) ? v.files.filter((f): f is string => typeof f === 'string') : [],
      requiredOutput: str(v.requiredOutput),
      deadlineAt: num(v.deadlineAt),
      state: STATES.includes(v.state as DelegationState) ? (v.state as DelegationState) : 'failed',
      result: typeof v.result === 'string' ? v.result : null,
      resultFiles: Array.isArray(v.resultFiles) ? v.resultFiles.filter((f): f is string => typeof f === 'string') : [],
      failureReason: typeof v.failureReason === 'string' ? v.failureReason : null,
      createdAt: num(v.createdAt) ?? now,
      updatedAt: num(v.updatedAt) ?? now,
      completedAt: num(v.completedAt),
      deliveredAt: num(v.deliveredAt),
      chain: Array.isArray(v.chain) ? v.chain.filter((c): c is string => typeof c === 'string') : [v.parent.workerId]
    }
    if (isOpenDelegation(delegation) && !(workerIds.has(delegation.parent.workerId) && workerIds.has(delegation.recipient.workerId))) {
      delegation.state = 'cancelled'
      delegation.failureReason = workerIds.has(delegation.recipient.workerId) ? `${delegation.parent.name} was removed.` : `${delegation.recipient.name} was removed.`
      delegation.completedAt = now
      delegation.updatedAt = now
    }
    out.push(delegation)
  }
  return pruneDelegations(out)
}

/** Every open delegation, plus the most recent closed ones. */
export function pruneDelegations(list: WorkerDelegation[]): WorkerDelegation[] {
  const closed = list.filter((d) => !isOpenDelegation(d))
  if (closed.length <= KEEP_CLOSED) return list
  const drop = new Set(closed.sort((a, b) => (a.completedAt ?? a.updatedAt) - (b.completedAt ?? b.updatedAt)).slice(0, closed.length - KEEP_CLOSED).map((d) => d.id))
  return list.filter((d) => !drop.has(d.id))
}

/**
 * Why `parentId` may not delegate to `recipientId` right now, or null. `chain`
 * is the new delegation's line of workers, from the first one that delegated
 * down to the parent itself (just `[parent]` when the parent acts on its
 * own), so A → B → A is refused, as is nesting deeper than
 * MAX_DELEGATION_DEPTH and more than MAX_OPEN_DELEGATIONS at once.
 */
export function delegationRefusal(
  list: WorkerDelegation[],
  input: { parentId: string; recipientId: string; recipientName: string; chain: string[] }
): string | null {
  if (input.parentId === input.recipientId) return 'That is you — delegate to a colleague, or do it yourself.'
  if (input.chain.includes(input.recipientId)) {
    return `${input.recipientName} is already waiting on the job this one is part of, so handing it back would loop. Report your result with finish_handoff instead.`
  }
  if (input.chain.length > MAX_DELEGATION_DEPTH) {
    return `This job has already been handed down ${input.chain.length - 1} times. Do this part yourself, or report back with finish_handoff.`
  }
  const open = list.filter(isOpenDelegation)
  if (open.length >= MAX_OPEN_DELEGATIONS) return `There are already ${MAX_OPEN_DELEGATIONS} delegated jobs open across your team. Wait for some to finish.`
  return null
}
