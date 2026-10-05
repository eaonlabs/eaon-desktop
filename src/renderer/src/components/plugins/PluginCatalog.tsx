import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ExternalLink, Plus, TriangleAlert } from 'lucide-react'
import { useApp } from '../../state/store'
import { SearchField, Section } from '../ui'
import { MCP_CATALOG, MCP_OAUTH_REDIRECT_URI, type McpCatalogEntry } from '@shared/mcpCatalog'
import type { McpServerStatus } from '@shared/types'
import { PluginLogo } from './PluginLogo'
import { pluginServerId, refreshServers, useConnectedPlugins, useMcpStatuses } from './usePlugins'

/**
 * The built-in plugin catalog: each entry is a hosted MCP server the model can
 * call once it is connected. Connecting one writes an MCP server row (and, for
 * tokens and sign-ins, an encrypted vault entry), so from that point it is an
 * ordinary server — nothing here is a parallel tool system.
 *
 * Shared between Settings → Plugins and the main Plugins page so there is
 * exactly one implementation of this list.
 */

const AUTH_LABEL: Record<McpCatalogEntry['authMode'], string> = {
  none: 'No sign-in',
  oauth: 'Sign in',
  pastedToken: 'API token'
}

export function PluginCatalog(): JSX.Element {
  const setView = useApp((s) => s.setView)
  const connected = useConnectedPlugins()
  const statuses = useMcpStatuses()
  const [open, setOpen] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const connectedIds = useMemo(() => new Set(connected.map((c) => c.entry.id)), [connected])
  const q = query.trim().toLowerCase()
  const matches = (entry: McpCatalogEntry): boolean =>
    !q || entry.displayName.toLowerCase().includes(q) || entry.summary.toLowerCase().includes(q)
  const mine = MCP_CATALOG.filter((entry) => connectedIds.has(entry.id) && matches(entry))
  // Brokers get their own group: what each lets an agent do matters more than the rest of the list.
  const brokers = MCP_CATALOG.filter((entry) => entry.category === 'trading' && !connectedIds.has(entry.id) && matches(entry))
  const rest = MCP_CATALOG.filter((entry) => entry.category !== 'trading' && !connectedIds.has(entry.id) && matches(entry))

  const row = (entry: McpCatalogEntry): JSX.Element => (
    <PluginRow
      key={entry.id}
      entry={entry}
      connected={connectedIds.has(entry.id)}
      status={statuses.find((s) => s.serverId === pluginServerId(entry.id))}
      expanded={open === entry.id}
      onToggle={() => setOpen(open === entry.id ? null : entry.id)}
    />
  )

  return (
    <>
      <h1 className="settings__h1">Plugins</h1>
      <p className="settings__lede">
        Connect outside services so models can read and act on your behalf, with your consent. Chat and Workers can use
        them.
      </p>

      <div className="plugin-catalog__search">
        <SearchField value={query} onChange={setQuery} placeholder={`Search ${MCP_CATALOG.length} plugins`} />
      </div>

      {mine.length > 0 && (
        <Section label="Connected">
          <div className="plugin-list">{mine.map(row)}</div>
        </Section>
      )}

      {brokers.length > 0 && (
        <Section label="Brokers — let a worker trade for you">
          <div className="plugin-list">{brokers.map(row)}</div>
        </Section>
      )}

      <Section label={mine.length > 0 || brokers.length > 0 || q ? 'Available' : undefined}>
        {rest.length > 0 ? (
          <div className="plugin-list">{rest.map(row)}</div>
        ) : (
          <div className="plugin-list">
            <div className="plugin-empty">{q ? `No plugins match “${query.trim()}”` : 'Every plugin is connected'}</div>
          </div>
        )}
      </Section>

      <Section label="Custom servers">
        <div className="plugin-list">
          <div className="plugin-row">
            <div className="plugin-row__body">
              <div className="plugin-row__desc">
                Connect to any MCP server by URL or command. Servers that ask for a browser sign-in get one.
              </div>
            </div>
            <button className="btn btn--ghost btn--sm" onClick={() => setView('integrations')}>
              <Plus size={14} strokeWidth={2} />
              Add
            </button>
          </div>
        </div>
      </Section>
    </>
  )
}

/** The row's one-glance state, from the live connection when there is one. */
function describe(connected: boolean, status: McpServerStatus | undefined): { tone: string; text: string } | null {
  if (!connected) return null
  switch (status?.state) {
    case 'ready':
      return { tone: 'ok', text: `Connected · ${status.toolCount} tool${status.toolCount === 1 ? '' : 's'}` }
    case 'starting':
      return { tone: 'busy', text: 'Connecting…' }
    case 'needs-auth':
      return { tone: 'warn', text: 'Sign in again' }
    case 'error':
      return { tone: 'error', text: 'Can’t connect' }
    default:
      return { tone: 'busy', text: 'Paused' }
  }
}

function PluginRow({
  entry,
  connected,
  status,
  expanded,
  onToggle
}: {
  entry: McpCatalogEntry
  connected: boolean
  status: McpServerStatus | undefined
  expanded: boolean
  onToggle: () => void
}): JSX.Element {
  const state = describe(connected, status)
  return (
    <div className="plugin-row-group">
      <button className="plugin-row" onClick={onToggle} aria-expanded={expanded}>
        <PluginLogo logo={entry.logoAssetName} name={entry.displayName} />
        <span className="plugin-row__body">
          <span className="plugin-row__name">{entry.displayName}</span>
          <span className="plugin-row__desc">{entry.summary}</span>
        </span>
        {state ? (
          <span className="plugin-row__status" data-tone={state.tone}>
            <span className="plugin-row__dot" />
            {state.text}
          </span>
        ) : (
          <span className="plugin-row__meta">{AUTH_LABEL[entry.authMode]}</span>
        )}
        <ChevronDown size={16} strokeWidth={1.9} className="plugin-row__chevron" data-open={expanded || undefined} />
      </button>

      {expanded && (
        <div className="plugin-row__panel">
          <PluginConnect entry={entry} connected={connected} status={status} />
        </div>
      )}
    </div>
  )
}

/**
 * The connect controls for one catalog entry — sign in, paste a token, or one
 * click — exactly as its catalog row shows them. Exported so the worker
 * editor can connect a broker in place without a second implementation.
 */
export function PluginConnect({
  entry,
  connected,
  status,
  hideNote = false
}: {
  entry: McpCatalogEntry
  connected: boolean
  status: McpServerStatus | undefined
  /** The caller already says what the broker does. */
  hideNote?: boolean
}): JSX.Element {
  return (
    <>
      {entry.tradingNote && !hideNote && <p className="plugin-row__hint plugin-row__trading">{entry.tradingNote}</p>}
      {entry.authMode === 'none' ? (
        <OpenPanel entry={entry} connected={connected} />
      ) : entry.authMode === 'oauth' ? (
        <OAuthPanel entry={entry} connected={connected} status={status} />
      ) : (
        <TokenPanel entry={entry} connected={connected} />
      )}
      {connected && status?.state === 'error' && status.error && <ErrorNote text={status.error} />}
    </>
  )
}

function ErrorNote({ text }: { text: string }): JSX.Element {
  return (
    <p className="plugin-row__note plugin-row__note--error">
      <TriangleAlert size={14} strokeWidth={1.9} />
      {text}
    </p>
  )
}

/** Runs an action with busy/error state; refreshes the server rows afterwards. */
function useAction(): {
  busy: boolean
  error: string | null
  setError: (e: string | null) => void
  run: (action: () => Promise<unknown>) => Promise<void>
} {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err))
    } finally {
      // Busy ends even when the refresh itself fails; it used to stay on
      // "Connecting…" until the page was reloaded.
      try {
        await refreshServers()
      } catch {
        /* the rows keep what they had; the action's own error, if any, is shown */
      } finally {
        setBusy(false)
      }
    }
  }
  return { busy, error, setError, run }
}

function OpenPanel({ entry, connected }: { entry: McpCatalogEntry; connected: boolean }): JSX.Element {
  const { busy, error, run } = useAction()
  return (
    <>
      <p className="plugin-row__hint">No account needed — {entry.displayName} is public. Its tools become available in Chat and to Workers.</p>
      <div className="plugin-row__actions">
        {connected ? (
          <button className="btn" disabled={busy} onClick={() => void run(() => window.api.pluginAuth.disconnect(entry.id))}>
            Disconnect
          </button>
        ) : (
          <button className="btn btn--primary" disabled={busy} onClick={() => void run(() => window.api.pluginAuth.enable(entry.id))}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        )}
      </div>
      {error && <ErrorNote text={error} />}
    </>
  )
}

function TokenPanel({ entry, connected }: { entry: McpCatalogEntry; connected: boolean }): JSX.Element {
  const [token, setToken] = useState('')
  const { busy, error, run } = useAction()
  const submit = (value: string): Promise<void> =>
    run(async () => {
      await window.api.pluginAuth.connectToken(entry.id, value)
      setToken('')
    })

  return (
    <>
      <div className="plugin-row__form">
        {!connected && (
          <input
            className="input"
            type="password"
            value={token}
            spellCheck={false}
            placeholder={entry.tokenFieldPlaceholder}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && token.trim() && void submit(token.trim())}
          />
        )}
        {connected ? (
          <button className="btn" disabled={busy} onClick={() => void submit('')}>
            Disconnect
          </button>
        ) : (
          <button className="btn" disabled={busy || !token.trim()} onClick={() => void submit(token.trim())}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        )}
      </div>

      {entry.tokenHint && <p className="plugin-row__note">{entry.tokenHint}</p>}
      {error && <ErrorNote text={error} />}

      {entry.tokenCreationURL && !connected && (
        <button className="plugin-row__link" onClick={() => void window.api.app.openExternal(entry.tokenCreationURL!)}>
          Create a token
          <ExternalLink size={13} strokeWidth={1.9} />
        </button>
      )}
    </>
  )
}

function OAuthPanel({
  entry,
  connected,
  status
}: {
  entry: McpCatalogEntry
  connected: boolean
  status: McpServerStatus | undefined
}): JSX.Element {
  const { busy, error, setError, run } = useAction()
  // Shown up front for vendors verified to have no self-registration, or
  // after a sign-in reports the server wants one.
  const [askClient, setAskClient] = useState(Boolean(entry.noDynamicRegistration))
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [waiting, setWaiting] = useState(false)

  useEffect(() => {
    if (!askClient) return
    void window.api.pluginAuth.clientId(entry.id).then((id) => id && setClientId((current) => current || id))
  }, [askClient, entry.id])

  const signedIn = connected && status?.state !== 'needs-auth'
  const needsSecret = entry.manualClientNeedsSecret === true
  const clientReady = !askClient || (clientId.trim() && (!needsSecret || clientSecret.trim()))

  const signIn = (): Promise<void> =>
    run(async () => {
      setWaiting(true)
      const result = await window.api.pluginAuth.signIn(
        { pluginId: entry.id },
        askClient ? { clientId: clientId.trim(), clientSecret: clientSecret.trim() || undefined } : undefined
      )
      if (result.needsClientId) setAskClient(true)
      if (!result.ok) setError(result.error ?? 'Sign-in failed')
      else setClientSecret('')
    }).finally(() => setWaiting(false))

  if (signedIn) {
    return (
      <>
        <p className="plugin-row__hint">
          Signed in through your browser. The token is kept encrypted on this computer and refreshed automatically.
        </p>
        <div className="plugin-row__actions">
          <button className="btn" disabled={busy} onClick={() => void run(() => window.api.pluginAuth.disconnect(entry.id))}>
            Disconnect
          </button>
        </div>
        {error && <ErrorNote text={error} />}
      </>
    )
  }

  return (
    <>
      {connected && status?.state === 'needs-auth' ? (
        <p className="plugin-row__hint">Your sign-in to {entry.displayName} has expired. Sign in again to keep using it.</p>
      ) : (
        <p className="plugin-row__hint">
          {askClient
            ? `${entry.displayName} doesn’t let apps register themselves, so you create one and paste its details here once.`
            : `Opens ${entry.displayName} in your browser to approve access. Nothing to copy or paste.`}
        </p>
      )}

      {askClient && (
        <>
          {entry.manualClientIdHint ? (
            <p className="plugin-row__hint">{entry.manualClientIdHint}</p>
          ) : (
            <p className="plugin-row__hint">
              Use the redirect URL <code>{MCP_OAUTH_REDIRECT_URI}</code>.
            </p>
          )}
          <div className={`plugin-row__fields ${needsSecret ? '' : 'plugin-row__fields--single'}`}>
            <input
              className="input"
              value={clientId}
              spellCheck={false}
              placeholder="Client ID"
              aria-label="Client ID"
              onChange={(e) => setClientId(e.target.value)}
            />
            {needsSecret && (
              <input
                className="input"
                type="password"
                value={clientSecret}
                spellCheck={false}
                placeholder="Client secret"
                aria-label="Client secret"
                onChange={(e) => setClientSecret(e.target.value)}
              />
            )}
          </div>
        </>
      )}

      <div className="plugin-row__actions">
        {waiting ? (
          <>
            <button className="btn btn--primary" disabled>
              Waiting for your browser…
            </button>
            <button className="btn" onClick={() => void window.api.pluginAuth.cancelSignIn({ pluginId: entry.id })}>
              Cancel
            </button>
          </>
        ) : (
          <button className="btn btn--primary" disabled={busy || !clientReady} onClick={() => void signIn()}>
            {connected ? 'Sign in again' : `Sign in to ${entry.displayName}`}
          </button>
        )}
        {connected && !waiting && (
          <button className="btn" onClick={() => void run(() => window.api.pluginAuth.disconnect(entry.id))}>
            Disconnect
          </button>
        )}
        {askClient && entry.manualClientIdSetupURL && (
          <button className="plugin-row__link" onClick={() => void window.api.app.openExternal(entry.manualClientIdSetupURL!)}>
            Create the app
            <ExternalLink size={13} strokeWidth={1.9} />
          </button>
        )}
      </div>
      {error && <ErrorNote text={error} />}
    </>
  )
}
