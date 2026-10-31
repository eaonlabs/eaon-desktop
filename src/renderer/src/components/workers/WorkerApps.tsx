import { useEffect, useState, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Check, KeyRound, Link2, Plus, X } from 'lucide-react'
import { APP_CATEGORIES, availableOn, needsSignIn, WORKER_APPS, workerApp, workerAppsEnabled, type WorkerApp, type WorkerAppLink } from '@shared/workerApps'
import type { Worker } from '@shared/workers'
import type { WorkerHostState } from '@shared/workerHost'
import { mcpCatalogEntry } from '@shared/mcpCatalog'
import { CONNECTORS, connectorSpec, type ConnectorId } from '@shared/workerConnectors'
import { ConnectForm, openConnection, openListeners, useConnections } from './connections'
import { useApp } from '../../state/store'
import { Modal } from '../ui'
import { PluginLogo } from '../plugins/PluginLogo'
import { AppMark, useSignInSheet } from './WorkerCards'
import { errorText, useWorkers } from './workersStore'

/**
 * Linking everyday apps to a worker (shared/workerApps.ts): picking them
 * when it is made, the Apps sheet on its page to link, sign in, pair and
 * unlink, and the chips on its profile. Labs builds only — every export
 * here renders nothing elsewhere.
 */

const here = (): string => (navigator.userAgent.includes('Mac') ? 'darwin' : navigator.userAgent.includes('Windows') ? 'win32' : 'linux')

/**
 * The platform the workers run on: this computer's, or a linked worker
 * computer's while they live there — Calendar and Reminders are a Mac's, so
 * a Raspberry Pi can't reach them for its workers.
 */
function useWorkersPlatform(): string {
  const [platform, setPlatform] = useState(here)
  useEffect(() => {
    if (!workerAppsEnabled()) return
    const update = (state: WorkerHostState): void => setPlatform(state.host && state.enabled ? (state.hello?.platform ?? here()) : here())
    void window.api.workerHost.state().then(update)
    return window.api.workerHost.onState(update)
  }, [])
  return platform
}

/** Tap apps on and off: the New worker page and the editor. */
export function AppPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }): JSX.Element | null {
  const platform = useWorkersPlatform()
  if (!workerAppsEnabled()) return null
  const toggle = (id: string): void => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id])
  return (
    <div className="app-picker">
      {APP_CATEGORIES.map((category) => {
        const apps = WORKER_APPS.filter((a) => a.category === category.id && availableOn(a, platform))
        if (apps.length === 0) return null
        return (
          <div key={category.id} className="app-picker__group">
            <span className="app-picker__label">{category.label}</span>
            <div className="app-picker__chips">
              {apps.map((app) => {
                const on = value.includes(app.id)
                return (
                  <button key={app.id} type="button" className="app-chip" data-on={on || undefined} aria-pressed={on} onClick={() => toggle(app.id)} title={app.can.join(', ')}>
                    <AppMark app={app} small />
                    {app.name}
                    {on && <Check size={13} strokeWidth={2.6} />}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** The apps on a worker's profile, each a chip that says whether it is signed in; a click opens the Apps sheet. */
export function AppFacts({ worker }: { worker: Worker }): JSX.Element | null {
  const open = useWorkers((s) => s.setAppsFor)
  if (!workerAppsEnabled()) return null
  const links = (worker.apps ?? []).filter((l) => workerApp(l.id))
  return (
    <>
      {links.map((link) => {
        const app = workerApp(link.id)!
        const waiting = needsSignIn(app) && link.signedIn !== 'yes'
        return (
          <button key={link.id} className="worker-fact worker-fact--app" onClick={() => open(worker.id)} title={waiting ? `${app.name} isn’t signed in yet` : app.can.join(', ')}>
            <AppMark app={app} small />
            {app.name}
            {waiting && ' · sign in'}
          </button>
        )
      })}
      <button className="worker-fact worker-fact--app worker-fact--add" onClick={() => open(worker.id)}>
        <Plus size={13} strokeWidth={2.2} />
        {links.length === 0 ? 'Link apps' : 'Apps'}
      </button>
    </>
  )
}

/** The Apps sheet: every app, grouped, with what this worker can do with each and where it stands. */
export function WorkerAppsSheet(): JSX.Element | null {
  const { appsFor, setAppsFor, worker } = useWorkers(useShallow((s) => ({ appsFor: s.appsFor, setAppsFor: s.setAppsFor, worker: s.workers.find((w) => w.id === s.appsFor) })))
  const platform = useWorkersPlatform()
  if (!workerAppsEnabled() || !appsFor || !worker) return null
  return (
    <Modal open onClose={() => setAppsFor(null)} title={`${worker.name}’s apps`} width={640}>
      <p className="apps-sheet__lead">
        Link the apps {worker.name} should handle. Where a service has a real API it uses that (Connections, below); otherwise it works the app like you would, in its own browser, signed in as you — you sign it in once, and your password never reaches the model. Anything that costs money, unlocks a door or moves a car waits for your OK.
      </p>
      <div className="apps-sheet">
        <Connections />
        {APP_CATEGORIES.map((category) => {
          // One linked already stays listed where it can't work, so it can be seen and unlinked.
          const apps = WORKER_APPS.filter((a) => a.category === category.id && (availableOn(a, platform) || worker.apps.some((l) => l.id === a.id)))
          if (apps.length === 0) return null
          return (
            <section key={category.id} className="apps-sheet__group">
              <h3 className="apps-sheet__title">
                {category.label}
                <span>{category.blurb}</span>
              </h3>
              {apps.map((app) => (
                <AppRow key={app.id} worker={worker} app={app} link={worker.apps.find((l) => l.id === app.id)} available={availableOn(app, platform)} />
              ))}
            </section>
          )
        })}
      </div>
    </Modal>
  )
}

function AppRow({ worker, app, link, available }: { worker: Worker; app: WorkerApp; link: WorkerAppLink | undefined; available: boolean }): JSX.Element {
  const [, openSignIn] = useSignInSheet()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [bankUrl, setBankUrl] = useState(link?.url ?? '')
  const connections = useConnections()
  const missing = link ? (app.connectors ?? []).filter((c) => !connections?.[c]?.connected) : []
  const through = link ? (app.connectors ?? []).filter((c) => connections?.[c]?.connected) : []
  const run = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const status = !link
    ? null
    : !available
      ? 'Needs a Mac'
      : app.via === 'browser' && needsSignIn(app)
      ? link.signedIn === 'yes'
        ? `Signed in${link.account ? ` as ${link.account}` : ''}`
        : 'Not signed in yet'
      : app.via === 'hub'
        ? (app.connectors ?? []).some((c) => connections?.[c]?.connected)
          ? `Through ${connectorSpec((app.connectors ?? []).find((c) => connections?.[c]?.connected)!)?.name}`
          : 'Needs a connection'
        : 'Linked'
  return (
    <div className="app-row" data-linked={link ? 'true' : undefined}>
      <AppMark app={app} />
      <div className="app-row__text">
        <span className="app-row__name">
          {app.name}
          {status && (
            <span className="app-row__status" data-ok={(available && (app.via === 'hub' ? through.length > 0 : link?.signedIn === 'yes' || link?.signedIn === 'n/a')) || undefined}>
              {status}
            </span>
          )}
        </span>
        <span className="app-row__can">{app.can.join(' · ')}</span>
        {app.note && link && available && <span className="app-row__note">{app.note}</span>}
        {link && !available && (
          <span className="app-row__note">
            {worker.name} runs on your worker computer now, and {app.name} is only reachable from a Mac. It works again once the workers are back on this Mac.
          </span>
        )}
        {app.id === 'bank' && link && (
          <form
            className="app-row__url"
            onSubmit={(e) => {
              e.preventDefault()
              void run(() => window.api.workers.linkApp(worker.id, app.id, { url: bankUrl.trim() }))
            }}
          >
            <input className="input" placeholder="https://yourbank.com/login" value={bankUrl} onChange={(e) => setBankUrl(e.target.value)} />
            <button type="submit" className="btn btn--sm" disabled={busy || !bankUrl.trim()}>
              Save
            </button>
          </form>
        )}
        {app.via === 'hue' && link && <HuePair />}
        {link && through.length > 0 && (
          <span className="app-row__conn" data-ok="true">
            <Link2 size={13} strokeWidth={2} />
            Works through {through.map((c) => connectorSpec(c)?.name).join(' and ')}
          </span>
        )}
        {link && missing.length > 0 && (app.via === 'hub' || through.length === 0) && app.via !== 'hue' && (
          <span className="app-row__conn">
            {app.via === 'hub' ? 'Needs' : 'Better with'}{' '}
            {missing.map((c, i) => (
              <span key={c}>
                {i > 0 && ' or '}
                <button className="link-btn" onClick={() => openConnection(c)}>
                  {connectorSpec(c)?.name}
                </button>
              </span>
            ))}
          </span>
        )}
        {error && <span className="app-row__error">{error}</span>}
      </div>
      <div className="app-row__actions">
        {link && app.via === 'browser' && needsSignIn(app) && (app.id !== 'bank' || link.url) && (
          <button className="btn btn--sm" onClick={() => openSignIn({ workerId: worker.id, threadId: 'main', appId: app.id })}>
            <KeyRound size={13} strokeWidth={2} />
            {link.signedIn === 'yes' ? 'Sign in again' : 'Sign in'}
          </button>
        )}
        {link ? (
          <button className="icon-btn" aria-label={`Unlink ${app.name}`} title={`Unlink ${app.name}`} disabled={busy} onClick={() => void run(() => window.api.workers.unlinkApp(worker.id, app.id))}>
            <X size={15} strokeWidth={2} />
          </button>
        ) : (
          <button className="btn btn--sm" disabled={busy} onClick={() => void run(() => window.api.workers.linkApp(worker.id, app.id))}>
            Link
          </button>
        )}
      </div>
    </div>
  )
}

/** Pairing the Hue bridge: press its button, then Pair. Shared by every worker that has Hue. */
export function HuePair(): JSX.Element {
  const [paired, setPaired] = useState<{ ip: string } | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  // The bridge's address, for when Philips' bridge finder can't find it (no internet, or asked too often).
  const [ip, setIp] = useState('')
  useEffect(() => {
    void window.api.workers
      .hueStatus()
      .then((s) => setPaired(s.paired))
      .catch(() => setPaired(null))
  }, [])
  if (paired === undefined) return <span className="app-row__note">Checking the Hue bridge…</span>
  if (paired) {
    return (
      <span className="app-row__note">
        Paired with the bridge at {paired.ip}.{note ? ` ${note}` : ''}{' '}
        <button className="link-btn" onClick={() => void window.api.workers.hueForget().then(() => (setPaired(null), setNote(null)))}>
          Forget it
        </button>
      </span>
    )
  }
  return (
    <span className="app-row__hue">
      <span className="app-row__note">Press the round button on top of your Hue bridge, then pair within 30 seconds.</span>
      <span className="app-row__hue-pair">
        <input
          className="input app-row__hue-ip"
          aria-label="Bridge IP address (optional)"
          placeholder="IP address, if it isn’t found"
          spellCheck={false}
          autoComplete="off"
          value={ip}
          onChange={(e) => setIp(e.target.value)}
        />
        <button
          className="btn btn--sm"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            setNote(null)
            window.api.workers
              .huePair(ip.trim() || undefined)
              .then((r) => {
                setPaired({ ip: r.ip })
                setNote(`Found ${r.lights} light${r.lights === 1 ? '' : 's'}.`)
              })
              .catch((e: unknown) => setNote(errorText(e)))
              .finally(() => setBusy(false))
          }}
        >
          {busy ? 'Pairing…' : 'Pair bridge'}
        </button>
      </span>
      {note && <span className="app-row__note">{note}</span>}
    </span>
  )
}

/**
 * Which plugins a worker may use: all of them (the default, and what every
 * worker made before this could) or only the ones ticked.
 */
export function PluginPicker({ value, onChange }: { value: string[] | null; onChange: (value: string[] | null) => void }): JSX.Element {
  const servers = useApp((s) => s.mcpServers).filter((s) => s.enabled)
  if (servers.length === 0) {
    return <p className="worker-editor__hint">No plugins connected yet. Connect them under Plugins and choose here which this worker may use.</p>
  }
  return (
    <div className="plugin-picker">
      <div className="plugin-picker__mode" role="radiogroup" aria-label="Plugins">
        <button type="button" role="radio" aria-checked={value === null} data-on={value === null || undefined} onClick={() => onChange(null)}>
          Every plugin
        </button>
        <button type="button" role="radio" aria-checked={value !== null} data-on={value !== null || undefined} onClick={() => onChange(value ?? servers.map((s) => s.id))}>
          Only these
        </button>
      </div>
      {value !== null && (
        <div className="plugin-picker__list">
          {servers.map((server) => {
            const on = value.includes(server.id)
            return (
              <button key={server.id} type="button" className="app-chip" data-on={on || undefined} aria-pressed={on} onClick={() => onChange(on ? value.filter((v) => v !== server.id) : [...value, server.id])}>
                <PluginLogo logo={server.pluginId ? mcpCatalogEntry(server.pluginId)?.logoAssetName : undefined} name={server.name} size={16} />
                {server.name}
                {on && <Check size={13} strokeWidth={2.6} />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * The services behind the apps: connected once, for every worker. Each says
 * what it unlocks and where its key comes from, checks the key really works
 * before keeping it, and never shows it again.
 */
function Connections(): JSX.Element {
  const statuses = useConnections()
  const [open, setOpen] = useState<ConnectorId | null>(null)
  useEffect(() => {
    const listener = (id: ConnectorId): void => {
      setOpen(id)
      requestAnimationFrame(() => document.getElementById(`conn-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
    }
    openListeners.add(listener)
    return () => void openListeners.delete(listener)
  }, [])
  return (
    <section className="apps-sheet__group">
      <h3 className="apps-sheet__title">
        Connections
        <span>Real APIs behind the apps, shared by every worker</span>
      </h3>
      {CONNECTORS.map((spec) => {
        const status = statuses?.[spec.id]
        return (
          <div key={spec.id} id={`conn-${spec.id}`} className="app-row conn-row" data-linked={status?.connected || undefined}>
            <PluginLogo name={spec.name} logo={spec.logo} size={38} />
            <div className="app-row__text">
              <span className="app-row__name">
                {spec.name}
                {status?.connected && <span className="app-row__status" data-ok>{status.detail ?? 'Connected'}</span>}
              </span>
              <span className="app-row__can">{spec.unlocks}</span>
              {open === spec.id && !status?.connected && <ConnectForm id={spec.id} onDone={() => setOpen(null)} />}
            </div>
            <div className="app-row__actions">
              {status?.connected ? (
                <button className="btn btn--sm" onClick={() => void window.api.workers.disconnect(spec.id)}>
                  Disconnect
                </button>
              ) : open !== spec.id ? (
                <button className="btn btn--sm" onClick={() => setOpen(spec.id)}>
                  Connect
                </button>
              ) : null}
            </div>
          </div>
        )
      })}
    </section>
  )
}

