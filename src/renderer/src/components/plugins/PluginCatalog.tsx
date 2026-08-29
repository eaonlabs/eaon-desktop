import { useEffect, useState } from 'react'
import { ChevronDown, ExternalLink, Plus, TriangleAlert } from 'lucide-react'
import { useApp } from '../../state/store'
import { Section } from '../ui'
import { MCP_CATALOG, type McpCatalogEntry } from '@shared/mcpCatalog'

/**
 * The built-in plugin catalog: each entry is a hosted MCP server the model can
 * call once it has credentials. Connecting one writes an MCP server row and
 * stores its token in the encrypted vault, so from that point it is an ordinary
 * server — nothing here is a parallel tool system.
 *
 * Shared between Settings → Plugins and the main Plugins page (reached from the
 * sidebar) so there is exactly one implementation of this list rather than two
 * that can drift — the sidebar page used to show a second, fictional catalog
 * (Gmail, Google Drive, Granola, …) with "Install" buttons that only flipped a
 * local settings flag and connected to nothing.
 */

// Bundled at build time and looked up by the catalog's `logoAssetName`, so the
// data stays a plain list of strings rather than 31 import statements.
const LOGOS = import.meta.glob('../../assets/plugins/*', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>

function logoFor(name: string): string | undefined {
  const path = Object.keys(LOGOS).find((key) => key.endsWith(`/${name}`))
  return path ? LOGOS[path] : undefined
}

export function PluginCatalog(): JSX.Element {
  const setView = useApp((s) => s.setView)
  const [connected, setConnected] = useState<string[]>([])
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    void window.api.plugins.connected().then(setConnected)
  }, [])

  return (
    <>
      <h1 className="settings__h1">Plugins</h1>
      <p className="settings__lede">
        Connect outside services so models can read and act on your behalf, with your consent.
      </p>

      <Section>
        <div className="plugin-list">
          {MCP_CATALOG.map((entry) => (
            <PluginRow
              key={entry.id}
              entry={entry}
              connected={connected.includes(entry.id)}
              expanded={open === entry.id}
              onToggle={() => setOpen(open === entry.id ? null : entry.id)}
              onChange={setConnected}
            />
          ))}
        </div>
      </Section>

      <Section label="Custom servers">
        <div className="plugin-list">
          <div className="plugin-row">
            <div className="plugin-row__body">
              <div className="plugin-row__desc">Connect to any MCP server by URL, not just the ones above.</div>
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

function PluginRow({
  entry,
  connected,
  expanded,
  onToggle,
  onChange
}: {
  entry: McpCatalogEntry
  connected: boolean
  expanded: boolean
  onToggle: () => void
  onChange: (ids: string[]) => void
}): JSX.Element {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const logo = logoFor(entry.logoAssetName)
  const oauthOnly = entry.authMode === 'oauth'

  const submit = async (value: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.api.plugins.connect(entry.id, value)
      onChange(await window.api.plugins.connected())
      setToken('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="plugin-row-group">
      <button className="plugin-row" onClick={onToggle} aria-expanded={expanded}>
        <span className="plugin-row__logo">
          {logo ? <img src={logo} alt="" /> : <span className="plugin-row__fallback">{entry.displayName[0]}</span>}
        </span>
        <span className="plugin-row__body">
          <span className="plugin-row__name">{entry.displayName}</span>
          <span className="plugin-row__desc">{entry.summary}</span>
        </span>
        {connected && (
          <span className="plugin-row__status">
            <span className="plugin-row__dot" />
            Connected
          </span>
        )}
        <ChevronDown size={16} strokeWidth={1.9} className="plugin-row__chevron" data-open={expanded || undefined} />
      </button>

      {expanded && (
        <div className="plugin-row__panel">
          {oauthOnly ? (
            // Honest rather than a button that goes nowhere: these vendors only
            // accept a browser sign-in, and this app has no OAuth flow yet.
            <p className="plugin-row__note">
              <TriangleAlert size={14} strokeWidth={1.9} />
              {entry.displayName} only accepts a browser sign-in, which Eaon doesn&rsquo;t support yet — there is no
              API key to paste. It will connect here once that lands.
            </p>
          ) : (
            <>
              <div className="plugin-row__form">
                <input
                  className="input"
                  type="password"
                  value={token}
                  spellCheck={false}
                  placeholder={entry.tokenFieldPlaceholder}
                  onChange={(e) => setToken(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && token.trim() && void submit(token.trim())}
                />
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
              {error && (
                <p className="plugin-row__note plugin-row__note--error">
                  <TriangleAlert size={14} strokeWidth={1.9} />
                  {error}
                </p>
              )}

              {entry.tokenCreationURL && (
                <button
                  className="plugin-row__link"
                  onClick={() => void window.api.app.openExternal(entry.tokenCreationURL!)}
                >
                  Create a token
                  <ExternalLink size={13} strokeWidth={1.9} />
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
