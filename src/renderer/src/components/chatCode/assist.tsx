import { useMemo, type JSX } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import type { GitAssistModel } from '@shared/gitAssist'
import { useApp } from '../../state/store'

/**
 * Shared bits of the model's help with git (a commit message, a pull request's
 * words, a review of the changes): which model is asked, and the button and
 * the line saying what is sent that sit next to every one of them.
 */

export interface AssistModel extends GitAssistModel {
  /** The model's name, and its provider's, for saying where the diff goes. */
  label: string
}

export const NO_MODEL = 'Connect a model in Settings → Model providers to use this.'

/** The model picked for Chat, which is the one asked; null while none is connected. */
export function useAssistModel(): AssistModel | null {
  const model = useApp((s) => s.currentModel())
  const provider = useApp((s) => (model ? (s.providers.find((p) => p.id === model.providerId)?.name ?? '') : ''))
  return useMemo(() => (model ? { providerId: model.providerId, modelId: model.id, label: provider ? `${model.label} (${provider})` : model.label } : null), [model, provider])
}

/** The sparkle button: writes something with the model, and says so while it works. */
export function AssistButton({
  children,
  busy,
  disabled,
  title,
  onClick,
  className = 'btn btn--ghost btn--sm'
}: {
  children: string
  busy: boolean
  disabled?: boolean
  title?: string
  onClick: () => void
  className?: string
}): JSX.Element {
  return (
    <button type="button" className={`${className} assist-btn`} disabled={disabled || busy} title={title} onClick={onClick}>
      {busy ? <Loader2 size={13} className="spinner" /> : <Sparkles size={13} strokeWidth={2} />}
      <span>{busy ? 'Writing…' : children}</span>
    </button>
  )
}

/** What goes to the model, said before it does (and after, with what was really sent). */
export function AssistHint({ children }: { children: string }): JSX.Element {
  return <p className="assist-hint">{children}</p>
}

/** The error a failed request shows, with the bridge's prefix off. */
export const assistError = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
