import { useState, type JSX } from 'react'
import { CircleAlert } from 'lucide-react'
import { ENGINE_LABEL } from '@shared/engines'
import type { ChatEngineChoice } from './chatEngine'

/**
 * Above the composer when Chat is set to an agent engine's model (Codex) that
 * can't run now: not installed, too old, or not signed in. Signing in happens
 * right here; the draft stays in the box meanwhile.
 */
export function EngineNotice({ choice, onChooseModel }: { choice: ChatEngineChoice; onChooseModel: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = ENGINE_LABEL[choice.engine]
  const canSignIn = choice.action === 'sign-in' || choice.action === 'reconnect'
  return (
    <div className="model-notice" data-tone="warn" role="status">
      <CircleAlert size={15} strokeWidth={2} className="model-notice__icon" />
      <div className="model-notice__body">
        <span className="model-notice__text">
          {choice.reason ?? `${name} can’t run right now.`}
          {error ? ` ${error}` : ''}
        </span>
      </div>
      {canSignIn && (
        <button
          className="btn btn--sm"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            setError(null)
            window.api.engines
              .login(choice.engine)
              .catch((e: unknown) => setError((e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+':\s*(?:\w*Error:\s*)?/, '')))
              .finally(() => setBusy(false))
          }}
        >
          {busy ? 'Waiting for the browser…' : `Sign in to ${name}`}
        </button>
      )}
      <button className="btn btn--sm btn--ghost" onClick={onChooseModel}>
        Choose another model
      </button>
    </div>
  )
}
