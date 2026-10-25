import type { JSX } from 'react'
import { ChevronRight } from 'lucide-react'
import { useElapsed } from './Loaders'

/** "18s", "1m 22s", "1h 4m": whole seconds, never under one. */
function duration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`
  return minutes % 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${Math.floor(minutes / 60)}h`
}

/**
 * Over a turn that did work: how long it has been at it, ticking while it
 * runs, and how long it took once done, on a hairline that sets the work
 * apart from the conversation above it. A finished turn from before turns
 * were timed has no length to give, and shows none.
 */
export function TurnHeader({
  startedAt,
  finishedAt,
  live,
  open,
  onToggle
}: {
  startedAt: number
  finishedAt?: number
  live: boolean
  /** A finished turn's work, folded under this line, is showing. */
  open?: boolean
  /** Given for a finished turn whose work folds under the line. */
  onToggle?: () => void
}): JSX.Element | null {
  const elapsed = useElapsed(startedAt, live)
  if (!live && !finishedAt) return null
  const text = live ? (elapsed < 1000 ? 'Working' : `Working for ${duration(elapsed)}`) : `Worked for ${duration(finishedAt! - startedAt)}`
  return (
    <div className="turn-head" data-live={live || undefined} data-folded={(onToggle && !open) || undefined}>
      {onToggle ? (
        <button type="button" className="turn-head__toggle" aria-expanded={open} onClick={onToggle} title={open ? 'Hide the work' : 'Show the work: what it read, ran and changed'}>
          <span className="turn-head__text">{text}</span>
          <ChevronRight size={13} strokeWidth={2} className="turn-head__chevron" />
        </button>
      ) : (
        <span className="turn-head__text">{text}</span>
      )}
    </div>
  )
}
