import { useEffect, useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useApp } from '../../../state/store'
import { Card, Modal, Row, Section, Select, Switch } from '../../ui'
import type { McpServer, McpServerStatus } from '@shared/types'
import { joinArgs, splitArgs } from '@shared/plugins'

const blank = (): McpServer => ({
  id: '',
  name: '',
  transport: 'stdio',
  command: 'npx',
  args: [],
  env: {},
  url: '',
  enabled: true,
  official: false
})

export function McpServersPage(): JSX.Element {
  const { settings, patchSettings, mcpServers, saveMcpServers } = useApp()
  const [statuses, setStatuses] = useState<McpServerStatus[]>([])
  const [editing, setEditing] = useState<McpServer | null>(null)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    void window.api.mcp.statuses().then(setStatuses)
    return window.api.mcp.onStatus(setStatuses)
  }, [])

  if (!settings) return <></>
  const mcp = settings.mcp

  const statusFor = (id: string): McpServerStatus =>
    statuses.find((s) => s.serverId === id) ?? { serverId: id, state: 'stopped', toolCount: 0 }

  const upsert = (draft: McpServer): void => {
    // A new server named like an existing one gets its own id; reusing the id
    // would silently replace that server.
    let id = draft.id
    if (!editing) for (let n = 2; mcpServers.some((s) => s.id === id); n++) id = `${draft.id}-${n}`
    const server = { ...draft, id }
    const exists = mcpServers.some((s) => s.id === server.id)
    void saveMcpServers(exists ? mcpServers.map((s) => (s.id === server.id ? server : s)) : [...mcpServers, server])
    setEditing(null)
    setAdding(false)
  }

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 className="settings__h1">MCP Servers</h1>
        <button className="pill-btn" style={{ marginTop: 24 }} onClick={() => setAdding(true)}>
          <Plus size={14} strokeWidth={2} />
          Add MCP Server
        </button>
      </div>

      <Section>
        <Card>
          <div className="row" style={{ paddingBottom: 4 }}>
            <div className="row__body">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="provider-detail__section-title" style={{ marginBottom: 0 }}>
                  MCP Servers
                </span>
                <span className="badge">Experimental</span>
              </div>
              <div className="row__desc">
                Model Context Protocol servers give the assistant extra tools it can call during a chat.
              </div>
            </div>
          </div>

          <Row
            title="Allow All MCP Tool Permissions"
            description="When enabled, all MCP tool calls will be automatically approved without showing permission dialogs. This setting applies globally to all conversations, including new chats."
          >
            <Switch
              label="Allow All MCP Tool Permissions"
              checked={mcp.allowAllToolPermissions}
              onChange={(on) => void patchSettings({ mcp: { allowAllToolPermissions: on } })}
            />
          </Row>

          <Row
            title="Tool call timeout (seconds)"
            description="Maximum time to wait for an MCP tool response before timing out."
          >
            <TimeoutField
              value={mcp.toolCallTimeoutSeconds}
              onChange={(toolCallTimeoutSeconds) => void patchSettings({ mcp: { toolCallTimeoutSeconds } })}
            />
          </Row>

          {/* What the switch really does (pluginTools.ts): past 12 tools, defer
              their schemas behind a lookup. No model picks servers, so the old
              "dedicated routing model" switch and picker, which nothing read,
              are gone. */}
          <Row
            title="Load MCP tools on demand"
            description="With more than 12 MCP tools, send the model their names and load a tool's full description only when it uses one. Saves tokens on every message. Turn off to always send every tool in full."
          >
            <Switch
              label="Load MCP tools on demand"
              checked={mcp.smartRouting}
              onChange={(on) => void patchSettings({ mcp: { smartRouting: on } })}
            />
          </Row>
        </Card>
      </Section>

      <Section>
        {mcpServers.length === 0 ? (
          <Card>
            <Row title="No MCP servers" description="Add one to give the assistant extra tools." />
          </Card>
        ) : (
          mcpServers.map((server) => (
            <div key={server.id} style={{ marginBottom: 14 }}>
              <ServerCard
                server={server}
                status={statusFor(server.id)}
                onEdit={() => setEditing(server)}
                onDelete={() => void saveMcpServers(mcpServers.filter((s) => s.id !== server.id))}
                onToggle={(on) =>
                  void saveMcpServers(mcpServers.map((s) => (s.id === server.id ? { ...s, enabled: on } : s)))
                }
              />
            </div>
          ))
        )}
      </Section>

      <ServerDialog
        key={editing?.id ?? (adding ? 'new' : 'closed')}
        open={adding || editing !== null}
        server={editing}
        onClose={() => {
          setAdding(false)
          setEditing(null)
        }}
        onSave={upsert}
      />
    </>
  )
}

function ServerCard({
  server,
  status,
  onEdit,
  onDelete,
  onToggle
}: {
  server: McpServer
  status: McpServerStatus
  onEdit: () => void
  onDelete: () => void
  onToggle: (on: boolean) => void
}): JSX.Element {
  const dotColor =
    status.state === 'ready'
      ? 'var(--diff-add-fg)'
      : status.state === 'starting'
        ? 'var(--text-3)'
        : status.state === 'error' || status.state === 'needs-auth'
          ? 'var(--danger)'
          : 'var(--text-4)'
  const [signingIn, setSigningIn] = useState(false)
  const [signInError, setSignInError] = useState<string | null>(null)

  // Any HTTP server that answers 401 gets the same browser sign-in as the
  // catalog plugins; the result lands in the vault, keyed by this server.
  const signIn = async (): Promise<void> => {
    setSigningIn(true)
    setSignInError(null)
    try {
      const result = await window.api.pluginAuth.signIn({ serverId: server.id })
      if (!result.ok) setSignInError(result.error ?? 'Sign-in failed')
    } finally {
      setSigningIn(false)
    }
  }

  return (
    <Card>
      <div className="row">
        <div className="row__body">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor, flex: 'none' }} />
            <span className="provider-card__name">{server.name}</span>
            {server.official && <span className="badge">Official</span>}
            {status.state === 'ready' && (
              <span className="badge badge--ok">
                {status.toolCount} tool{status.toolCount === 1 ? '' : 's'}
              </span>
            )}
          </div>
          <div className="row__desc" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            Transport: {server.transport.toUpperCase()}
            {server.transport === 'stdio' ? (
              <>
                <br />
                Command: {server.command}
                <br />
                Args: {server.args.join(', ') || '—'}
                {Object.keys(server.env).length > 0 && (
                  <>
                    <br />
                    Env: {Object.keys(server.env).map((k) => `${k}=******`).join(', ')}
                  </>
                )}
              </>
            ) : (
              <>
                <br />
                URL: {server.url || '—'}
              </>
            )}
          </div>
          {status.state === 'error' && status.error && (
            <div className="row__desc" style={{ color: 'var(--danger)', whiteSpace: 'pre-line' }}>
              {status.error}
            </div>
          )}
          {status.state === 'needs-auth' && (
            <div className="row__desc">This server asks you to sign in through your browser.</div>
          )}
          {signInError && (
            <div className="row__desc" style={{ color: 'var(--danger)' }}>
              {signInError}
            </div>
          )}
        </div>
        <div className="row__trail">
          {status.state === 'needs-auth' &&
            (signingIn ? (
              <button className="btn btn--sm" onClick={() => void window.api.pluginAuth.cancelSignIn({ serverId: server.id })}>
                Cancel sign-in
              </button>
            ) : (
              <button className="btn btn--primary btn--sm" onClick={() => void signIn()}>
                Sign in
              </button>
            ))}
          <button className="icon-btn" aria-label="Edit server" onClick={onEdit}>
            <Pencil size={15} strokeWidth={1.9} />
          </button>
          <button className="icon-btn" aria-label="Remove server" onClick={onDelete}>
            <Trash2 size={15} strokeWidth={1.9} />
          </button>
          <Switch label={server.name} checked={server.enabled} onChange={onToggle} />
        </div>
      </div>
    </Card>
  )
}

function ServerDialog({
  open,
  server,
  onClose,
  onSave
}: {
  open: boolean
  server: McpServer | null
  onClose: () => void
  onSave: (server: McpServer) => void
}): JSX.Element {
  const [draft, setDraft] = useState<McpServer>(server ?? blank())
  const [argsText, setArgsText] = useState(joinArgs(server?.args ?? []))
  const [envText, setEnvText] = useState(
    Object.entries(server?.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')
  )

  const save = (): void => {
    const id = draft.id || draft.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'server'
    if (!draft.name.trim()) return
    const env: Record<string, string> = {}
    for (const line of envText.split('\n')) {
      const eq = line.indexOf('=')
      if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }
    onSave({
      ...draft,
      id,
      name: draft.name.trim() || id,
      args: splitArgs(argsText),
      env
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      width={480}
      title={server ? 'Edit MCP Server' : 'Add MCP Server'}
      actions={
        <>
          <button className="btn btn--provider-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--provider" disabled={!draft.name.trim()} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="field-label">Name</div>
      <input
        className="input"
        style={{ marginBottom: 16 }}
        value={draft.name}
        autoFocus
        placeholder="my-server"
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
      />

      <div className="field-label">Transport</div>
      <div style={{ marginBottom: 16 }}>
        <Select
          width={200}
          value={draft.transport}
          onChange={(transport) => setDraft({ ...draft, transport: transport as 'stdio' | 'http' })}
          options={[
            { value: 'stdio', label: 'STDIO (local process)' },
            { value: 'http', label: 'HTTP (remote URL)' }
          ]}
        />
      </div>

      {draft.transport === 'stdio' ? (
        <>
          <div className="field-label">Command</div>
          <input
            className="input"
            style={{ marginBottom: 16, fontFamily: 'var(--font-mono)' }}
            value={draft.command}
            spellCheck={false}
            placeholder="npx"
            onChange={(e) => setDraft({ ...draft, command: e.target.value })}
          />
          <div className="field-label">Arguments</div>
          <input
            className="input"
            style={{ marginBottom: 16, fontFamily: 'var(--font-mono)' }}
            value={argsText}
            spellCheck={false}
            placeholder="-y @modelcontextprotocol/server-filesystem ~/Documents"
            onChange={(e) => setArgsText(e.target.value)}
          />
          <div className="field-label">Environment variables (KEY=value, one per line)</div>
          <textarea
            className="input"
            style={{ minHeight: 76, fontFamily: 'var(--font-mono)', fontSize: 13 }}
            value={envText}
            spellCheck={false}
            placeholder={'API_TOKEN=abc123'}
            onChange={(e) => setEnvText(e.target.value)}
          />
        </>
      ) : (
        <>
          <div className="field-label">Server URL</div>
          <input
            className="input"
            style={{ fontFamily: 'var(--font-mono)' }}
            value={draft.url}
            spellCheck={false}
            placeholder="https://example.com/mcp"
            onChange={(e) => setDraft({ ...draft, url: e.target.value })}
          />
        </>
      )}
    </Modal>
  )
}

/**
 * Seconds, saved when the field is left or Enter is pressed. Saving on every
 * keystroke snapped an emptied field straight back to 30, so the number
 * could not be retyped.
 */
function TimeoutField({ value, onChange }: { value: number; onChange: (seconds: number) => void }): JSX.Element {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = (): void => {
    const seconds = Math.round(Number(draft))
    if (Number.isFinite(seconds) && seconds >= 1) {
      const clamped = Math.min(seconds, 3600)
      if (clamped !== value) onChange(clamped)
      setDraft(String(clamped))
    } else setDraft(String(value))
  }
  return (
    <input
      className="input"
      style={{ width: 110 }}
      type="number"
      min={1}
      max={3600}
      aria-label="Tool call timeout in seconds"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  )
}
