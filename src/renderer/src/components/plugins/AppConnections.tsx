import { useState, type JSX } from 'react'
import { ChevronDown, ExternalLink, Landmark, Link2 } from 'lucide-react'
import { CONNECTORS, type ConnectorSpec } from '@shared/workerConnectors'
import { workerApp, workerAppsEnabled } from '@shared/workerApps'
import { Section } from '../ui'
import { PluginLogo } from './PluginLogo'
import { ConnectForm, useConnections } from '../workers/connections'
import { HuePair } from '../workers/WorkerApps'

/**
 * The Plugins page's section for the workers' everyday apps: the services
 * behind them (shared/workerConnectors.ts) laid out like the plugins above —
 * a row each, opening to the steps that set it up and the form that
 * connects it — plus the Hue bridge, and the apps that need nothing at all.
 * Labs builds only.
 */
export function AppConnections(): JSX.Element | null {
  const statuses = useConnections()
  const [open, setOpen] = useState<string | null>(null)
  if (!workerAppsEnabled()) return null
  const toggle = (id: string): void => setOpen(open === id ? null : id)
  return (
    <Section label="For your workers’ apps">
      <p className="plugin-row__hint app-conn__lede">
        Real connections behind the apps your workers handle. Connect a service once here; then on a worker’s page, open <strong>Apps</strong> and link the app to it.
      </p>
      <div className="plugin-list">
        {CONNECTORS.map((spec) => (
          <ConnectorRow key={spec.id} spec={spec} status={statuses?.[spec.id]} expanded={open === spec.id} onToggle={() => toggle(spec.id)} />
        ))}
        <div className="plugin-row-group">
          <button className="plugin-row" onClick={() => toggle('hue')} aria-expanded={open === 'hue'}>
            <PluginLogo name="Philips Hue" logo="philipshue.png" />
            <span className="plugin-row__body">
              <span className="plugin-row__name">Philips Hue</span>
              <span className="plugin-row__desc">Lights, straight through the Hue bridge on your home network.</span>
            </span>
            <span className="plugin-row__meta">Press the bridge’s button</span>
            <ChevronDown size={16} strokeWidth={1.9} className="plugin-row__chevron" data-open={open === 'hue' || undefined} />
          </button>
          {open === 'hue' && (
            <div className="plugin-row__panel">
              <p className="plugin-row__note">This computer has to be on the same network as the bridge.</p>
              <HuePair />
            </div>
          )}
        </div>
        <div className="plugin-row app-conn__free">
          <span className="app-conn__stack">
            {['venmo.png', 'cashapp.png', 'uber.png', 'lyft.png', 'googlemaps.png', 'waze.png'].map((logo) => (
              <PluginLogo key={logo} name={logo} logo={logo} size={24} />
            ))}
          </span>
          <span className="plugin-row__body">
            <span className="plugin-row__name">Venmo, Cash App, Uber, Lyft, Google Maps, Waze</span>
            <span className="plugin-row__desc">
              No setup. A worker sends you a link with the payment, ride or route filled in, and nothing happens until you tap it and confirm in the app.
            </span>
          </span>
          <span className="plugin-row__status" data-tone="ok">
            <span className="plugin-row__dot" />
            Ready
          </span>
        </div>
      </div>
      <p className="plugin-row__note app-conn__foot">
        Everything else — DoorDash, Uber Eats, Amazon, Walmart, Target, Starbucks, Chipotle — has no public API, so a worker uses the website in its own browser: you sign it in once from its Apps.
      </p>
    </Section>
  )
}

function ConnectorRow({
  spec,
  status,
  expanded,
  onToggle
}: {
  spec: ConnectorSpec
  status: { connected: boolean; detail: string | null } | undefined
  expanded: boolean
  onToggle: () => void
}): JSX.Element {
  const powers = spec.apps.map((id) => workerApp(id)?.name).filter(Boolean)
  return (
    <div className="plugin-row-group">
      <button className="plugin-row" onClick={onToggle} aria-expanded={expanded}>
        <PluginLogo name={spec.name} logo={spec.logo} icon={spec.logo ? undefined : <Landmark size={18} strokeWidth={1.9} />} />
        <span className="plugin-row__body">
          <span className="plugin-row__name">{spec.name}</span>
          <span className="plugin-row__desc">{spec.unlocks}</span>
        </span>
        {status?.connected ? (
          <span className="plugin-row__status" data-tone="ok">
            <span className="plugin-row__dot" />
            {status.detail ?? 'Connected'}
          </span>
        ) : (
          <span className="plugin-row__meta">{spec.fields.length > 1 ? 'Address and token' : spec.fields[0].label}</span>
        )}
        <ChevronDown size={16} strokeWidth={1.9} className="plugin-row__chevron" data-open={expanded || undefined} />
      </button>
      {expanded && (
        <div className="plugin-row__panel">
          {powers.length > 0 && (
            <p className="plugin-row__note">
              <Link2 size={14} strokeWidth={1.9} />
              For {powers.join(', ')}
            </p>
          )}
          {status?.connected ? (
            <div className="plugin-row__actions">
              <button className="btn" onClick={() => void window.api.workers.disconnect(spec.id)}>
                Disconnect
              </button>
            </div>
          ) : (
            <>
              <ol className="app-conn__steps">
                {spec.steps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
              <button className="plugin-row__link" onClick={() => void window.api.app.openExternal(spec.site.url)}>
                {spec.site.label}
                <ExternalLink size={13} strokeWidth={1.9} />
              </button>
              {spec.cost && <p className="plugin-row__note">{spec.cost}</p>}
              <ConnectForm id={spec.id} onDone={onToggle} showHow={false} />
            </>
          )}
        </div>
      )}
    </div>
  )
}
