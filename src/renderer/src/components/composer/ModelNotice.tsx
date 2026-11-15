import { useState, type JSX } from 'react'
import { CircleAlert } from 'lucide-react'
import type { ResolvedSelection } from '@shared/modelSelection'
import { LinkAccounts } from '../LinkAccounts'
import { actionLabel } from './ModelPicker'
import { useSetupAction } from './setupActions'

/**
 * Above the composer when the chosen model can't be used now (unavailable,
 * or a connected provider that needs fixing, such as an expired sign-in):
 * one line saying why, with its fix. Shown before anything is typed, so
 * nobody writes a long prompt into a box that can't send it; the draft stays
 * in the box while they fix it. With nothing connected at all there is no
 * notice: the model button says Connect a model instead (Composer.tsx).
 */
export function ModelNotice({ selection, onChooseModel }: { selection: ResolvedSelection; onChooseModel: () => void }): JSX.Element | null {
  const runAction = useSetupAction()
  const [linking, setLinking] = useState(false)

  if (selection.status === 'selected' && selection.attention) {
    return (
      <div className="model-notice" data-tone="warn" role="status">
        <CircleAlert size={15} strokeWidth={2} className="model-notice__icon" />
        <div className="model-notice__body">
          <span className="model-notice__text">{selection.attention}</span>
        </div>
        {selection.action && (
          <button className="btn btn--sm" onClick={() => runAction(selection.action!, selection.provider?.id ?? null)}>
            {actionLabel(selection.action)}
          </button>
        )}
      </div>
    )
  }

  if (selection.status === 'unavailable') {
    const name = selection.wanted?.label ?? 'The chosen model'
    const via = selection.wanted?.providerName ? ` on ${selection.wanted.providerName}` : ''
    return (
      <div className="model-notice" data-tone="warn" role="alert">
        <CircleAlert size={15} strokeWidth={2} className="model-notice__icon" />
        <div className="model-notice__body">
          <span className="model-notice__title">
            {name}
            {via} is unavailable
          </span>
          <span className="model-notice__text">{selection.reason} Your message stays here until it can be sent.</span>
        </div>
        <div className="model-notice__actions">
          {selection.action && selection.action !== 'choose-model' && (
            <button className="btn btn--sm" onClick={() => runAction(selection.action!, selection.wanted?.providerId ?? null)}>
              {actionLabel(selection.action)}
            </button>
          )}
          <button className="btn btn--sm" onClick={onChooseModel}>
            Choose another model
          </button>
        </div>
      </div>
    )
  }

  if (selection.status !== 'none') return null

  // Something is connected but broken (an expired sign-in): its fix comes first.
  if (selection.provider && selection.action && selection.action !== 'connect') {
    return (
      <div className="model-notice" data-tone="warn" role="alert">
        <CircleAlert size={15} strokeWidth={2} className="model-notice__icon" />
        <div className="model-notice__body">
          <span className="model-notice__title">No model can be used right now</span>
          <span className="model-notice__text">{selection.reason}</span>
        </div>
        <div className="model-notice__actions">
          <button className="btn btn--sm btn--primary" onClick={() => runAction(selection.action!, selection.provider!.id)}>
            {actionLabel(selection.action)}
          </button>
          <button className="btn btn--sm" onClick={() => setLinking(true)}>
            Link another account
          </button>
        </div>
        <LinkAccounts open={linking} onClose={() => setLinking(false)} />
      </div>
    )
  }

  // Nothing connected at all: no notice. The model button says Connect a model, and
  // sending opens the ways to connect one (Composer.tsx).
  return null
}
