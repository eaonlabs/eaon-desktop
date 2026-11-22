import { useEffect, useState, type JSX } from 'react'
import { Check, ChevronDown, Copy, Loader2, RefreshCw } from 'lucide-react'
import type { ProviderId, ProviderMachine, ProviderStatus } from '@shared/environments'
import { CLIPBOARD_FAILED, copyText } from '../../lib/clipboard'
import { notify } from '../Notice'
import './environments.css'

const clean = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')

/** A provider's mark: its initials on a tile of its colour. */
const MARKS: Record<ProviderId, { text: string; color: string }> = {
  exe: { text: 'exe', color: '#3b3b46' },
  codespaces: { text: 'GH', color: '#24292f' },
  aws: { text: 'AWS', color: '#ff9900' },
  gcp: { text: 'GC', color: '#4285f4' },
  azure: { text: 'Az', color: '#0078d4' },
  digitalocean: { text: 'DO', color: '#0069ff' },
  hetzner: { text: 'Hz', color: '#d50c2d' },
  linode: { text: 'Li', color: '#00a95c' },
  vultr: { text: 'Vu', color: '#007bfc' },
  coder: { text: 'Co', color: '#1c1c1c' },
  tailscale: { text: 'TS', color: '#242424' },
  lima: { text: 'Lm', color: '#2f8f4e' },
  orbstack: { text: 'Ob', color: '#6e3ff3' }
}

export function ProviderMark({ id, size = 26 }: { id: ProviderId; size?: number }): JSX.Element {
  const mark = MARKS[id]
  return (
    <span className="provider-mark" style={{ width: size, height: size, background: mark.color, fontSize: mark.text.length > 2 ? size * 0.32 : size * 0.4 }} aria-hidden>
      {mark.text}
    </span>
  )
}

/** The sniffer's answer, asked once when shown and again on Look again. */
export function useProviders(on: boolean): { providers: ProviderStatus[] | null; error: string | null; refresh: () => void } {
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!on) return
    let live = true
    setProviders(null)
    setError(null)
    void window.api.environments.providers().then(
      (list) => live && setProviders(list),
      (e) => live && setError(clean(e))
    )
    return () => {
      live = false
    }
  }, [on, tick])
  return { providers, error, refresh: () => setTick((n) => n + 1) }
}

/** A command to run in Terminal, with a button that copies it. */
export function FixCommand({ command }: { command: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <span className="fix-command">
      <code>{command}</code>
      <button
        type="button"
        className="icon-btn fix-command__copy"
        title="Copy"
        aria-label={`Copy ${command}`}
        onClick={() =>
          void copyText(command).then((ok) => {
            if (!ok) return notify(CLIPBOARD_FAILED, 'error')
            setCopied(true)
            setTimeout(() => setCopied(false), 1400)
          })
        }
      >
        {copied ? <Check size={12} strokeWidth={2.4} /> : <Copy size={12} strokeWidth={2} />}
      </button>
    </span>
  )
}

const summary = (p: ProviderStatus): string => {
  if (p.state === 'ready') {
    const count = p.machines.length
    const who = p.account ? `${p.account} · ` : ''
    return `${who}${count === 0 ? 'no machines yet' : count === 1 ? '1 machine' : `${count} machines`}`
  }
  return p.message ?? (p.state === 'missing' ? 'Not on this computer' : 'Not signed in')
}

export interface Picked {
  provider: ProviderStatus
  machine: ProviderMachine
}

/**
 * The VM providers found on this computer (the CLI sniffer), each with what
 * it can see: signed in, its machines to pick from; signed out, the command
 * that fixes it; not there, folded away with how to get it.
 */
export function ProvidersPanel({ picked, onPick }: { picked: Picked | null; onPick: (pick: Picked) => void }): JSX.Element {
  const { providers, error, refresh } = useProviders(true)
  const [moreOpen, setMoreOpen] = useState(false)
  const found = providers?.filter((p) => p.state !== 'missing') ?? []
  const missing = providers?.filter((p) => p.state === 'missing') ?? []
  return (
    <div className="providers">
      <div className="providers__head">
        <span className="providers__title">Found on this computer</span>
        <button type="button" className="btn btn--sm btn--ghost" onClick={refresh} disabled={providers === null}>
          {providers === null ? <Loader2 size={13} strokeWidth={2} className="spinner" /> : <RefreshCw size={13} strokeWidth={2} />}
          {providers === null ? 'Looking…' : 'Look again'}
        </button>
      </div>
      {error && (
        <p className="ade-dialog__error" role="alert">
          {error}
        </p>
      )}
      {providers === null && !error && (
        <div className="providers__loading">
          <Loader2 size={14} strokeWidth={2} className="spinner" />
          Looking for aws, gcloud, az, gh, doctl, hcloud, tailscale, limactl and more…
        </div>
      )}
      {providers !== null && found.length === 0 && <p className="providers__none">None of the providers’ command-line tools are on this computer yet.</p>}
      <div className="providers__list">
        {found.map((p) => (
          <div key={p.id} className="provider" data-state={p.state}>
            <div className="provider__row">
              <ProviderMark id={p.id} />
              <span className="provider__body">
                <span className="provider__name">
                  {p.name}
                  {p.cli && <span className="provider__cli">{p.cli}</span>}
                </span>
                <span className="provider__status">{summary(p)}</span>
              </span>
              {p.state !== 'ready' && <span className="provider__dot" data-state={p.state} aria-hidden />}
            </div>
            {p.state !== 'ready' && p.fix && (
              <div className="provider__fix">
                In Terminal: <FixCommand command={p.fix} />
              </div>
            )}
            {p.state === 'ready' && p.machines.length > 0 && (
              <div className="provider__machines" role="radiogroup" aria-label={`${p.name}’s machines`}>
                {p.machines.map((m) => {
                  const on = picked?.provider.id === p.id && picked.machine.id === m.id
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      className="machine"
                      data-on={on || undefined}
                      data-blocked={m.why ? true : undefined}
                      onClick={() => onPick({ provider: p, machine: m })}
                      title={m.why ?? undefined}
                    >
                      <span className="machine__dot" data-running={m.running || undefined} aria-hidden />
                      <span className="machine__body">
                        <span className="machine__name">{m.name}</span>
                        <span className="machine__detail">{m.why ?? [m.status, m.detail].filter(Boolean).join(' · ')}</span>
                      </span>
                      {on && <Check size={14} strokeWidth={2.2} className="machine__check" />}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        ))}
      </div>
      {missing.length > 0 && (
        <div className="providers__more" data-open={moreOpen || undefined}>
          <button type="button" className="providers__more-toggle" aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>
            <span className="providers__more-marks">
              {missing.slice(0, 6).map((p) => (
                <ProviderMark key={p.id} id={p.id} size={18} />
              ))}
            </span>
            {missing.length} more {missing.length === 1 ? 'provider' : 'providers'} Eaon can use once its tool is installed
            <ChevronDown size={13} strokeWidth={2} className="providers__more-chevron" />
          </button>
          {moreOpen && (
            <div className="providers__missing">
              {missing.map((p) => (
                <div key={p.id} className="provider provider--missing">
                  <div className="provider__row">
                    <ProviderMark id={p.id} size={22} />
                    <span className="provider__body">
                      <span className="provider__name">{p.name}</span>
                      <span className="provider__status">{p.message ?? 'Not on this computer'}</span>
                    </span>
                  </div>
                  {p.fix && (
                    <div className="provider__fix">
                      <FixCommand command={p.fix} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
