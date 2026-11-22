import { useEffect, useState, type JSX } from 'react'
import { Check, Copy, Loader2, RefreshCw } from 'lucide-react'
import type { ProviderId, ProviderMachine, ProviderStatus } from '@shared/environments'
import { CLIPBOARD_FAILED, copyText } from '../../lib/clipboard'
import { notify } from '../Notice'
import './environments.css'

const clean = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')

const files = import.meta.glob('../../assets/environments/*.{png,svg}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
const LOGOS: Record<string, string> = Object.fromEntries(Object.entries(files).map(([path, url]) => [path.split('/').pop()!.replace(/\.(png|svg)$/, ''), url]))
// Azure's is the one Model providers already ships.
const azure = Object.values(import.meta.glob('../../assets/providers/azure.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>)[0]

/**
 * Each provider's logo (assets/environments): a white mark on a tile of the
 * brand's colour, or (`full`) the logo as the provider draws it, filling the
 * tile. `text` stands in should the file be missing.
 */
const MARKS: Record<ProviderId, { color: string; text: string; full?: boolean }> = {
  exe: { color: '#ffffff', text: 'exe', full: true },
  freestyle: { color: '#121212', text: 'Fs' },
  codespaces: { color: '#24292f', text: 'GH' },
  aws: { color: '#232f3e', text: 'AWS' },
  gcp: { color: '#4285f4', text: 'GC' },
  azure: { color: '#ffffff', text: 'Az', full: true },
  digitalocean: { color: '#0080ff', text: 'DO' },
  hetzner: { color: '#d50c2d', text: 'Hz' },
  linode: { color: '#0096d6', text: 'Li' },
  vultr: { color: '#007bfc', text: 'Vu' },
  coder: { color: '#090b0b', text: 'Co' },
  tailscale: { color: '#242424', text: 'TS' },
  lima: { color: '#2f6f4a', text: 'Lm' },
  orbstack: { color: '#ffffff', text: 'Ob', full: true }
}

export function ProviderMark({ id, size = 26 }: { id: ProviderId; size?: number }): JSX.Element {
  const mark = MARKS[id]
  const src = id === 'azure' ? azure : LOGOS[id]
  return (
    <span className="provider-mark" data-full={mark.full || undefined} data-id={id} style={{ width: size, height: size, background: mark.color, fontSize: mark.text.length > 2 ? size * 0.32 : size * 0.4 }} aria-hidden>
      {src ? <img src={src} alt="" draggable={false} /> : mark.text}
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
 * The VM providers found on this computer (the CLI sniffer), in the add
 * dialog: each one signed in is a group of its machines to pick from; one
 * signed out says the command that fixes it. The ones not installed are in
 * Settings → Environments, not here.
 */
export function ProvidersPanel({ picked, onPick, focus = null }: { picked: Picked | null; onPick: (pick: Picked) => void; focus?: ProviderId | null }): JSX.Element {
  const { providers, error, refresh } = useProviders(true)
  const rank = (p: ProviderStatus): number => (p.id === focus ? 0 : p.state === 'ready' && p.machines.length > 0 ? 1 : p.state === 'ready' ? 3 : 2)
  const found = (providers?.filter((p) => p.state !== 'missing') ?? []).sort((a, b) => rank(a) - rank(b))
  return (
    <div className="providers">
      {error && (
        <p className="envd-result" role="alert">
          {error}
        </p>
      )}
      <div className="prov-groups">
        {providers === null && [0, 1, 2].map((i) => <div key={i} className="prov-group prov-group--ghost" />)}
        {providers !== null && found.length === 0 && <p className="providers__none">None of the providers’ command-line tools are on this computer yet.</p>}
        {found.map((p) => (
          <div key={p.id} className="prov-group" data-state={p.state}>
            <div className="prov-group__head">
              <ProviderMark id={p.id} size={22} />
              <span className="prov-group__name">{p.name}</span>
              <span className="prov-group__meta">{p.state === 'ready' ? (p.account ?? (p.cli ? `via ${p.cli}` : '')) : p.state === 'signed-out' ? 'Not signed in' : 'Didn’t answer'}</span>
            </div>
            {p.state === 'ready' && p.machines.length === 0 && <div className="prov-group__empty">No machines yet</div>}
            {p.state === 'ready' && p.machines.length > 0 && (
              <div className="prov-group__machines" role="radiogroup" aria-label={`${p.name}’s machines`}>
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
                    >
                      <span className="machine__dot" data-running={m.running || undefined} aria-hidden />
                      <span className="machine__body">
                        <span className="machine__name">{m.name}</span>
                        <span className="machine__detail">{m.why ?? [m.status, m.detail].filter(Boolean).join(' · ')}</span>
                      </span>
                      <span className="machine__radio" aria-hidden>
                        {on && <Check size={12} strokeWidth={3} />}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
            {p.state !== 'ready' && (
              <div className="prov-group__fix">
                <span>{p.message ?? 'It needs signing in.'}</span>
                {p.fix && <FixCommand command={p.fix} />}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="providers__foot">
        <button type="button" className="providers__again" onClick={refresh} disabled={providers === null}>
          {providers === null ? <Loader2 size={12} strokeWidth={2.2} className="spinner" /> : <RefreshCw size={12} strokeWidth={2.2} />}
          {providers === null ? 'Looking…' : 'Look again'}
        </button>
        <span>Not listed? Install its CLI, then look again.</span>
      </div>
    </div>
  )
}
