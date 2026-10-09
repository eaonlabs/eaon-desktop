import { useEffect, useState } from 'react'
import { DatabaseBackup, TriangleAlert, X } from 'lucide-react'
import type { StoreHealth, StoreProblem } from '@shared/storeHealth'

/**
 * Tells the user about their saved data when something happened to it: a
 * file Eaon repaired or restored at startup (with the damaged copy one click
 * away), or saves that are failing right now (a full disk). Main keeps the
 * list (storeFiles.ts); every window shows it. A failing save can be hidden
 * here but not dismissed: it stays until the save goes through.
 */

function title(problem: StoreProblem): string {
  switch (problem.kind) {
    case 'unsaved':
      return problem.code === 'ENOSPC' || problem.code === 'EDQUOT' ? 'Your disk is full' : `${problem.label}: changes aren’t being saved`
    case 'restored':
      return `${problem.label} restored from an earlier save`
    case 'reset':
      return `${problem.label} couldn’t be recovered`
    default:
      return `${problem.label} repaired`
  }
}

export function StoreNotice(): JSX.Element | null {
  const [health, setHealth] = useState<StoreHealth>({ problems: [] })
  /** Unsaved notices hidden in this window; one comes back if its message changes. */
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    let live = true
    void window.api.storage
      .health()
      .then((next) => live && setHealth(next))
      .catch(() => undefined)
    const off = window.api.storage.onHealth(setHealth)
    return () => {
      live = false
      off()
    }
  }, [])

  const shown = health.problems.filter((p) => !hidden.has(`${p.id}:${p.detail}`))
  if (shown.length === 0) return null
  const [problem, ...rest] = shown
  const failing = problem.kind === 'unsaved'

  const close = (): void => {
    if (failing) setHidden((prev) => new Set(prev).add(`${problem.id}:${problem.detail}`))
    else void window.api.storage.dismiss(problem.id)
  }

  return (
    <div className="update-toast store-notice" role={failing ? 'alert' : 'status'} data-kind={problem.kind}>
      <span className="update-toast__icon store-notice__icon">
        {failing ? <TriangleAlert size={16} strokeWidth={1.9} /> : <DatabaseBackup size={16} strokeWidth={1.9} />}
      </span>
      <div className="update-toast__body">
        <div className="update-toast__title">{title(problem)}</div>
        <p className="update-toast__desc">
          {problem.detail}
          {rest.length > 0 && ` (${rest.length} more ${rest.length === 1 ? 'notice' : 'notices'} after this one.)`}
        </p>
        <div className="update-toast__actions">
          {failing ? (
            <button className="btn btn--sm" onClick={() => void window.api.storage.reveal(problem.id)}>
              Show data folder
            </button>
          ) : (
            <>
              <button className="btn btn--primary btn--sm" onClick={close}>
                OK
              </button>
              {problem.copy && (
                <button className="btn btn--ghost btn--sm" onClick={() => void window.api.storage.reveal(problem.id)}>
                  Show damaged copy
                </button>
              )}
            </>
          )}
        </div>
      </div>
      <button className="icon-btn update-toast__close" aria-label={failing ? 'Hide' : 'Dismiss'} onClick={close}>
        <X size={14} strokeWidth={1.9} />
      </button>
    </div>
  )
}
