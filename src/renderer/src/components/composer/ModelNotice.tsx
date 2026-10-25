import { useEffect, useRef, useState, type JSX } from 'react'
import { CircleAlert, KeyRound, Link2, Laptop, Ticket } from 'lucide-react'
import type { DetectedApp } from '@shared/linkAccounts'
import { CLI_ENGINES, ENGINE_LABEL, type CliEngineId, type EngineStatus } from '@shared/engines'
import type { ResolvedSelection } from '@shared/modelSelection'
import { useApp } from '../../state/store'
import { LinkAccounts } from '../LinkAccounts'
import { RedeemCode } from '../RedeemCode'
import { actionLabel } from './ModelPicker'
import { useSetupAction } from './setupActions'

/**
 * Above the composer when the next message has nowhere to go: nothing is
 * connected yet (first run), or the chosen model can't be used now. Shown
 * before anything is typed, so nobody writes a long prompt into a box that
 * can't send it; the draft stays in the box while they fix it.
 *
 * On first run it also says what Eaon found on this computer: Codex signed
 * in (Chat can run on it straight away, with its sign-in and plan), or
 * Ollama installed but not running.
 */
export function ModelNotice({ selection, onChooseModel }: { selection: ResolvedSelection; onChooseModel: () => void }): JSX.Element | null {
  const setSettingsPage = useApp((s) => s.setSettingsPage)
  const setView = useApp((s) => s.setView)
  const patchSettings = useApp((s) => s.patchSettings)
  const providers = useApp((s) => s.providers)
  const runAction = useSetupAction()
  const [linking, setLinking] = useState(false)
  const refreshProviders = useApp((s) => s.refreshProviders)
  // The event code box, opened from "Have an event code?": someone at a
  // hackathon with no account or key gets in with the code they were handed.
  const [redeeming, setRedeeming] = useState(false)
  const codeBox = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (redeeming) codeBox.current?.querySelector('input')?.focus()
  }, [redeeming])
  const found = useDetected(selection.status === 'none')

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

  const ollama = providers.find((p) => p.id === 'ollama')
  return (
    <div className="model-notice" role="alert">
      <CircleAlert size={15} strokeWidth={2} className="model-notice__icon" />
      <div className="model-notice__body">
        <span className="model-notice__title">No usable model is connected</span>
        <span className="model-notice__text">Sign in to a supported account, add an API key, or choose a local model. What you type stays here.</span>
        {found.signedIn && (
          <span className="model-notice__hint">
            {ENGINE_LABEL[found.signedIn]} is signed in on this computer, so Chat can run on it with your {ENGINE_PLAN[found.signedIn]}.{' '}
            <button className="model-notice__link" onClick={() => void patchSettings({ selectedEngine: found.signedIn, selectedEngineModel: '' })}>
              Use {ENGINE_LABEL[found.signedIn]} in Chat
            </button>
          </span>
        )}
        {found.ollamaInstalled && ollama && ollama.models.length === 0 && (
          <span className="model-notice__hint">Ollama is installed but isn’t running or has no models. Open Ollama and pull a model; Eaon picks it up when you come back.</span>
        )}
        <div className="model-notice__actions model-notice__actions--row">
          <button className="btn btn--sm btn--primary" onClick={() => setLinking(true)}>
            <Link2 size={13} strokeWidth={2} />
            Sign in to an account
          </button>
          <button className="btn btn--sm" onClick={() => setSettingsPage('providers')}>
            <KeyRound size={13} strokeWidth={2} />
            Add an API key
          </button>
          <button className="btn btn--sm" onClick={() => setView('models')}>
            <Laptop size={13} strokeWidth={2} />
            Use a local model
          </button>
          {!redeeming && (
            <button className="btn btn--sm" onClick={() => setRedeeming(true)}>
              <Ticket size={13} strokeWidth={2} />
              Have an event code?
            </button>
          )}
        </div>
        {redeeming && (
          // Redeeming makes Eaon Free usable and main selects its model, so
          // refreshing the providers is what makes this notice go away.
          <div ref={codeBox} className="model-notice__code">
            <RedeemCode onRedeemed={refreshProviders} />
          </div>
        )}
      </div>
      <LinkAccounts open={linking} onClose={() => setLinking(false)} />
    </div>
  )
}

/** Whose plan Chat runs on with each agent CLI. */
const ENGINE_PLAN: Record<CliEngineId, string> = { codex: 'ChatGPT plan', copilot: 'GitHub Copilot plan', gemini: 'Google account' }

/**
 * What can be found on this computer without asking anyone: a signed-in
 * agent CLI, Codex first (from the engine check), and an installed Ollama (presence only).
 * Read when the notice first shows; a running Ollama and a downloaded local
 * model are picked up by provider discovery and make this notice go away.
 */
function useDetected(active: boolean): { signedIn: CliEngineId | null; ollamaInstalled: boolean } {
  const [state, setState] = useState<{ signedIn: CliEngineId | null; ollamaInstalled: boolean }>({ signedIn: null, ollamaInstalled: false })
  useEffect(() => {
    if (!active) return
    let alive = true
    const read = (statuses: EngineStatus[]): CliEngineId | null =>
      CLI_ENGINES.find((id) => statuses.some((s) => s.id === id && s.installed && !s.outdated && s.auth.state === 'signed-in')) ?? null
    void Promise.all([
      window.api.engines?.status().catch(() => [] as EngineStatus[]) ?? Promise.resolve([] as EngineStatus[]),
      window.api.linkAccounts.detect().catch(() => [] as DetectedApp[])
    ]).then(([statuses, apps]) => {
      if (alive) setState({ signedIn: read(statuses), ollamaInstalled: apps.some((a) => a.id === 'ollama' && a.installed) })
    })
    const off = window.api.engines?.onChanged(() => void window.api.engines.status().then((statuses) => alive && setState((s) => ({ ...s, signedIn: read(statuses) }))))
    return () => {
      alive = false
      off?.()
    }
  }, [active])
  return state
}
