import { useState } from 'react'
import { MousePointer2 } from 'lucide-react'
import { leaseOwnerName } from '@shared/computerUse'
import { useComputerLease } from './useComputerLease'

/**
 * Whoever is controlling the computer, and who is waiting for it, on every
 * screen of the app. There is one real mouse and keyboard; when an agent is
 * using them the user should know, and be able to have them back at once —
 * "Take back control" ends that agent's use of the computer for its run
 * (it carries on with whatever doesn't need the screen) and refuses the
 * agents waiting. The always-on-top pill (main process) says the same while
 * Eaon is out of sight.
 */
export function ComputerLeaseIndicator(): JSX.Element | null {
  const lease = useComputerLease()
  const [busy, setBusy] = useState(false)
  const { holder, waiting } = lease
  if (!holder && waiting.length === 0) return null

  const takeBack = (): void => {
    setBusy(true)
    void window.api.computerUse.takeBack().finally(() => setBusy(false))
  }

  return (
    <div className="computer-lease" role="status" aria-live="polite">
      <span className="computer-lease__icon" aria-hidden="true">
        <MousePointer2 size={14} strokeWidth={1.9} />
      </span>
      <div className="computer-lease__body">
        <div className="computer-lease__title">{holder ? `${leaseOwnerName(holder)} is using your computer` : 'The computer is free'}</div>
        {waiting.length > 0 && (
          <div className="computer-lease__sub">
            Waiting for the computer: {waiting.map((w) => leaseOwnerName(w)).join(', ')}
          </div>
        )}
      </div>
      <button className="btn btn--sm" onClick={takeBack} disabled={busy} title="Stop agents from using your mouse and keyboard for the rest of their current turn">
        Take back control
      </button>
    </div>
  )
}
