import { useState, type JSX } from 'react'
import type { ProviderIssue } from '@shared/providers'
import { useApp } from '../../state/store'
import { CLIPBOARD_FAILED, copyText } from '../../lib/clipboard'
import { notify } from '../Notice'
import { actionLabel } from './ModelPicker'
import { useSetupAction } from './setupActions'

/**
 * The fix for a failed reply, under its error: "Sign in again" for an
 * expired session, "Fix key" for a rejected one, "Choose a model" when the
 * model is gone, "Try again" for a passing failure, and "Copy details" with
 * the provider's own words (secrets already scrubbed in main).
 *
 * A failure with no known fix (an error nothing recognised, or one saved
 * before failures carried an issue) still offers Try again: a reply that
 * failed before saying anything has no action bar to ask again from.
 */
export function ProviderErrorActions({ issue, retryId }: { issue: ProviderIssue | undefined; retryId: string | null }): JSX.Element | null {
  const runAction = useSetupAction()
  const openModelMenu = useApp((s) => s.openModelMenu)
  const retryReply = useApp((s) => s.retryReply)
  const onRetry = retryId ? () => retryReply(retryId) : undefined
  const [copied, setCopied] = useState(false)
  const action = issue?.action ?? (onRetry ? 'retry' : null)
  const run = (): void => {
    if (action === 'retry') onRetry?.()
    else if (action === 'choose-model') openModelMenu()
    else if (action) runAction(action, issue?.providerId ?? null)
  }
  const showAction = action && (action !== 'retry' || onRetry)
  const detail = issue?.detail
  if (!showAction && !detail) return null
  return (
    <span className="msg__error-actions">
      {showAction && (
        <button className="btn btn--sm" onClick={run}>
          {actionLabel(action)}
        </button>
      )}
      {detail && (
        <button
          className="btn btn--sm btn--ghost"
          onClick={() =>
            // The clipboard refuses while the window isn't focused; that says so rather than doing nothing.
            void copyText(detail).then((ok) => {
              if (!ok) return notify(CLIPBOARD_FAILED, 'error')
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }
        >
          {copied ? 'Copied' : 'Copy details'}
        </button>
      )}
    </span>
  )
}
