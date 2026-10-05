import { useCallback, useEffect, useState, type JSX } from 'react'
import { Loader2, RefreshCw, TriangleAlert } from 'lucide-react'
import type { EngineModels, EngineStatus } from '@shared/engines'
import { ago, describeSource, engineReadiness } from '@shared/modelSelection'
import { BrandIcon } from '../../../icons/brand'

/**
 * Codex in Settings → Model providers. Codex isn't a provider (Eaon runs it
 * as its own engine, with its own sign-in and models, see shared/engines),
 * but it is where people look for it: someone with Codex signed in shouldn't
 * have to work out which ChatGPT card is "theirs". So it gets its own row
 * with the subscriptions, saying plainly what Eaon found — signed in,
 * signed out (with Sign in), or not installed (never shown as ready) — and
 * what it's for: Workers can run on it; Chat uses the ChatGPT card.
 *
 * The row appears only once the engine check has reported Codex, so a build
 * without the Codex engine shows nothing here.
 */

export const CODEX_ROW_ID = '__engine:codex'

export interface CodexEngineState {
  status: EngineStatus | null
  models: EngineModels | null
  checking: boolean
  signingIn: boolean
  error: string | null
  check: () => void
  signIn: () => void
}

export function useCodexEngine(): CodexEngineState {
  const [status, setStatus] = useState<EngineStatus | null>(null)
  const [models, setModels] = useState<EngineModels | null>(null)
  const [checking, setChecking] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (!window.api.engines) return
    const statuses = await window.api.engines.status().catch(() => [] as EngineStatus[])
    setStatus(statuses.find((s) => s.id === 'codex') ?? null)
    setModels(await window.api.engines.models('codex').catch(() => null))
  }, [])

  useEffect(() => {
    void load()
    return window.api.engines?.onChanged(() => void load())
  }, [load])

  const check = (): void => {
    setChecking(true)
    setError(null)
    void window.api.engines
      .refresh('codex', true)
      .then(load, (e: unknown) => setError(clean(e)))
      .finally(() => setChecking(false))
  }
  const signIn = (): void => {
    setSigningIn(true)
    setError(null)
    void window.api.engines
      .login('codex')
      .then(load, (e: unknown) => setError(clean(e)))
      .finally(() => setSigningIn(false))
  }
  return { status, models, checking, signingIn, error, check, signIn }
}

const clean = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function CodexEngineRow({ status, active, onClick }: { status: EngineStatus; active: boolean; onClick: () => void }): JSX.Element {
  const readiness = engineReadiness('codex', status)
  const state = readiness.state === 'ready' ? 'ready' : readiness.state === 'attention' ? 'attention' : null
  return (
    <button className="provider-row" data-active={active || undefined} onClick={onClick} title={`Codex · ${readiness.label}`}>
      <BrandIcon id="codex" name="Codex" size={24} />
      <span className="provider-row__label">
        Codex
        <span className="provider-row__sub">{readiness.label}</span>
      </span>
      {state && <span className="provider-row__badge" data-state={state} aria-label={readiness.label} />}
    </button>
  )
}

export function CodexEngineDetail({ engine, onOpenProvider }: { engine: CodexEngineState; onOpenProvider: (providerId: string) => void }): JSX.Element {
  const { status, models } = engine
  const readiness = engineReadiness('codex', status)
  const auth = status?.auth
  return (
    <>
      <div className="provider-detail__header">
        <BrandIcon id="codex" name="Codex" size={40} />
        <div className="provider-detail__heading">
          <span className="provider-detail__name">Codex</span>
          <span className="provider-detail__tagline">OpenAI’s coding agent, installed on this computer</span>
        </div>
      </div>

      <div className="provider-detail__section">
        <div className="provider-detail__title-row">
          <div className="provider-detail__section-title">Status</div>
          <button className="provider-link" onClick={engine.check} disabled={engine.checking}>
            {engine.checking ? <Loader2 size={12} strokeWidth={2} className="spinner" /> : <RefreshCw size={12} strokeWidth={2} />}
            Check again
          </button>
        </div>
        {!status?.installed ? (
          <p className="provider-detail__section-desc">
            Codex isn’t installed on this computer, so Eaon can’t run on it.
            {status?.updateHint ? (
              <>
                {' '}
                Install it with <code>{status.updateHint}</code>, then check again.
              </>
            ) : null}
          </p>
        ) : (
          <>
            <div className="provider-account">
              <span className="provider-account__dot" data-state={readiness.state} />
              <span className="provider-account__text">
                <span className="provider-account__label">
                  Codex · {readiness.state === 'ready' ? 'Signed in' : readiness.label}
                </span>
                <span className="provider-account__sub">
                  {[auth?.method, auth?.plan, status.version ? `version ${status.version}` : null, status.foundIn].filter(Boolean).join(' · ')}
                </span>
              </span>
              {(auth?.state === 'signed-out' || auth?.state === 'expired') && (
                <button className="btn btn--provider" disabled={engine.signingIn} onClick={engine.signIn}>
                  {engine.signingIn ? 'Waiting for your browser…' : auth.state === 'expired' ? 'Sign in again' : 'Sign in to Codex'}
                </button>
              )}
            </div>
            {readiness.reason && readiness.state !== 'ready' && (
              <div className="provider-status" data-tone="error">
                <TriangleAlert size={14} strokeWidth={1.9} />
                {readiness.reason}
              </div>
            )}
          </>
        )}
        {(engine.error || status?.error) && (
          <div className="provider-status" data-tone="error">
            <TriangleAlert size={14} strokeWidth={1.9} />
            {engine.error ?? status?.error}
          </div>
        )}
        <p className="provider-detail__section-desc" style={{ marginTop: 14, marginBottom: 0 }}>
          Workers can run on Codex with its own models and your ChatGPT plan. Chat runs on Eaon itself; to use your ChatGPT plan there,{' '}
          <button className="provider-link" onClick={() => onOpenProvider('chatgpt')}>
            sign in with ChatGPT
          </button>
          .
        </p>
      </div>

      {status?.installed && (
        <div className="provider-detail__section">
          <div className="provider-detail__section-title">Models</div>
          {models?.staleBecause && (
            <div className="provider-status" data-tone="error" style={{ marginTop: 0, marginBottom: 8 }}>
              <TriangleAlert size={14} strokeWidth={1.9} />
              Showing the list from {models.retrievedAt ? ago(models.retrievedAt) : 'before'}: {models.staleBecause}
            </div>
          )}
          {!models || models.models.length === 0 ? (
            <div className="empty-models">{auth?.state === 'signed-in' ? 'Codex hasn’t listed its models yet. Check again.' : 'Sign in to Codex to see its models.'}</div>
          ) : (
            models.models.map((model) => (
              <div className="model-row" key={model.id}>
                <span className="model-row__name" title={[model.id, describeSource(model.source, 'Codex')].filter(Boolean).join(' · ')}>
                  {model.label}
                </span>
                <span className="model-row__badges">{model.isDefault && <span className="model-row__tag">Default</span>}</span>
                <span className="model-row__spacer" />
              </div>
            ))
          )}
          {models?.retrievedAt && !models.staleBecause && <div className="provider-models__freshness">From Codex, {ago(models.retrievedAt)}</div>}
        </div>
      )}
    </>
  )
}
