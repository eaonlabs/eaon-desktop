import { useEffect, useState, type JSX } from 'react'
import { ExternalLink } from 'lucide-react'
import { connectorSpec, type ConnectorId, type ConnectorStatuses } from '@shared/workerConnectors'
import { workerAppsEnabled } from '@shared/workerApps'
import { errorText } from './workersStore'

/**
 * Connections for the workers' apps (shared/workerConnectors.ts), shared by
 * the Plugins page and a worker's Apps sheet: their live status, the form
 * that connects one, and "connect this" from anywhere opening its form.
 */


/**
 * The connection statuses, kept current. Null until the first answer. Every
 * row of the Apps sheet asks, so they share one subscription and one
 * question: one listener each was thirty on the same IPC channel (Electron
 * warns past ten).
 */
export function useConnections(): ConnectorStatuses | null {
  const [statuses, setStatuses] = useState<ConnectorStatuses | null>(cachedStatuses)
  useEffect(() => {
    // A release build has no connections, nor the handlers that answer for them.
    if (!workerAppsEnabled()) return
    watchers.add(setStatuses)
    if (!unsubscribe) {
      unsubscribe = window.api.workers.onConnectionsChanged(publish)
      void window.api.workers.connections().then(publish, () => undefined)
    } else if (cachedStatuses) setStatuses(cachedStatuses)
    return () => {
      watchers.delete(setStatuses)
      if (watchers.size === 0) {
        unsubscribe?.()
        unsubscribe = null
      }
    }
  }, [])
  return statuses
}
let cachedStatuses: ConnectorStatuses | null = null
const watchers = new Set<(statuses: ConnectorStatuses) => void>()
let unsubscribe: (() => void) | null = null
function publish(statuses: ConnectorStatuses): void {
  cachedStatuses = statuses
  for (const watcher of watchers) watcher(statuses)
}

/** "Connect Home Assistant" from an app's row opens its form in the Connections list above. */
export const openListeners = new Set<(id: ConnectorId) => void>()
export function openConnection(id: ConnectorId): void {
  for (const listener of openListeners) listener(id)
}

export function ConnectForm({ id, onDone, showHow = true }: { id: ConnectorId; onDone: () => void; showHow?: boolean }): JSX.Element {
  const spec = connectorSpec(id)!
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = spec.fields.every((f) => values[f.key]?.trim())
  return (
    <form
      className="conn-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (!ready || busy) return
        setBusy(true)
        setError(null)
        window.api.workers
          .connect(id, values)
          .then(onDone)
          .catch((err: unknown) => setError(errorText(err)))
          .finally(() => setBusy(false))
      }}
    >
      {showHow && <span className="app-row__note">
        {spec.how}{' '}
        <button type="button" className="link-btn" onClick={() => void window.api.app.openExternal(spec.helpUrl)}>
          How <ExternalLink size={11} strokeWidth={2} />
        </button>
      </span>}
      {spec.cost && showHow && <span className="app-row__note conn-form__cost">{spec.cost}</span>}
      {spec.fields.map((field, i) => (
        <label key={field.key} className="conn-form__field">
          <span>{field.label}</span>
          <input
            className="input"
            autoFocus={i === 0}
            type={field.secret ? 'password' : 'text'}
            autoComplete="off"
            spellCheck={false}
            placeholder={field.placeholder}
            value={values[field.key] ?? ''}
            onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
          />
        </label>
      ))}
      {error && <span className="app-row__error">{error}</span>}
      <div className="conn-form__actions">
        <button type="button" className="btn btn--sm btn--ghost" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn btn--sm btn--primary" disabled={!ready || busy}>
          {busy ? 'Checking…' : 'Connect'}
        </button>
      </div>
    </form>
  )
}
