import { useEffect, useState } from 'react'
import { leaseOwnerName, type ComputerLeaseOwner, type ComputerLeaseState } from '@shared/computerUse'

const IDLE: ComputerLeaseState = { holder: null, waiting: [] }

/**
 * Who holds the computer's one mouse and keyboard now, and who is waiting
 * for it. Live: the main process pushes every change.
 */
export function useComputerLease(): ComputerLeaseState {
  const [state, setState] = useState<ComputerLeaseState>(IDLE)
  useEffect(() => {
    let alive = true
    void window.api.computerUse.lease().then(
      (next) => alive && setState(next),
      () => undefined
    )
    const stop = window.api.computerUse.onLeaseChanged((next) => setState(next))
    return () => {
      alive = false
      stop()
    }
  }, [])
  return state
}

/**
 * What a worker's page should say about the computer, from the lease: null
 * when this worker neither holds it nor waits. For the run the page is
 * showing, pass its `runId` (the reply's message id).
 */
export function workerComputerStatus(
  state: ComputerLeaseState,
  workerId: string,
  runId?: string
): { kind: 'using'; text: string } | { kind: 'waiting'; text: string } | null {
  const mine = (owner: ComputerLeaseOwner): boolean => owner.kind === 'worker' && owner.id === workerId && (!runId || owner.runId === runId)
  if (state.holder && mine(state.holder)) return { kind: 'using', text: 'Using the computer' }
  const waiting = state.waiting.find(mine)
  if (waiting && state.holder) return { kind: 'waiting', text: `Waiting for the computer — ${leaseOwnerName(state.holder)} is using it` }
  return null
}
