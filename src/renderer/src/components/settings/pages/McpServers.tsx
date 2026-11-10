import { useEffect, useState } from 'react'
import { ChevronDown, Download, Pencil, Plus, Trash2 } from 'lucide-react'
import { useApp } from '../../../state/store'
import { Card, ConfirmDialog, Modal, Row, Section, Select, Switch } from '../../ui'
import type { McpServer, McpServerStatus, McpTool } from '@shared/types'
import { toolEnabled, withAllTools, withTool } from '@shared/mcpTools'
import { joinArgs, splitArgs } from '@shared/plugins'
import { ImportList, useImportServers } from '../../ImportServers'

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
  // Removing forgets the server's settings and the tokens in its environment, so it asks first.
  const [removing, setRemoving] = useState<McpServer | null>(null)
  const [adding, setAdding] = useState(false)
  const [importing, setImporting] = useState(false)

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
        <div style={{ display: 'flex', gap: 8, marginTop: 24 }}>
          <button className="pill-btn" onClick={() => setImporting(true)}>
            <Download size={14} strokeWidth={2} />
            Import from another app
          </button>
          <button className="pill-btn" onClick={() => setAdding(true)}>
            <Plus size={14} strokeWidth={2} />
            Add MCP server
          </button>
        </div>
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
            title="Allow all MCP tool permissions"
            description="When enabled, all MCP tool calls will be automatically approved without showing permission dialogs. This setting applies globally to all conversations, including new chats."
          >
            <Switch
              label="Allow all MCP tool permissions"
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
                onDelete={() => setRemoving(server)}
                onToggle={(on) =>
                  void saveMcpServers(mcpServers.map((s) => (s.id === server.id ? { ...s, enabled: on } : s)))
                }
                onTools={(disabledTools) =>
                  void saveMcpServers(mcpServers.map((s) => (s.id === server.id ? { ...s, disabledTools } : s)))
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
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title="Remove this MCP server?"
        confirmLabel="Remove"
        onConfirm={() => removing && void saveMcpServers(mcpServers.filter((s) => s.id !== removing.id))}
      >
        “{removing?.name}” and its settings, including any tokens in its environment, are removed. You’d have to add it again to use it.
      </ConfirmDialog>
    </>
  )
}

function ServerCard({
  server,
  status,
  onEdit,
  onDelete,
  onToggle,
  onTools
}: {
  server: McpServer
  status: McpServerStatus
  onEdit: () => void
  onDelete: () => void
  onToggle: (on: boolean) => void
  onTools: (disabledTools: string[] | undefined) => void
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
      {status.state === 'ready' && status.toolCount > 0 && <ToolList server={server} status={status} onChange={onTools} />}
    </Card>
  )
}

/**
 * A server's tools, each on or off. A tool that is off is never offered to
 * the assistant, in chats or by workers, and a call to it is refused. The
 * server itself stays connected, so turning one back on is instant.
 */
function ToolList({ server, status, onChange }: { server: McpServer; status: McpServerStatus; onChange: (disabledTools: string[] | undefined) => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [tools, setTools] = useState<McpTool[]>([])

  // Read when opened and whenever the server's tool count moves (it reconnected, or announced new tools).
  useEffect(() => {
    if (!open) return
    let live = true
    void window.api.mcp.allTools().then((all) => live && setTools(all.filter((t) => t.serverId === server.id)))
    return () => {
      live = false
    }
  }, [open, server.id, status.toolCount])

  const off = (server.disabledTools ?? []).filter((name) => tools.length === 0 || tools.some((t) => t.name === name)).length
  const names = tools.map((t) => t.name)
  return (
    <div className="mcp-tools">
      <button type="button" className="mcp-tools__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronDown size={14} strokeWidth={2} className="mcp-tools__chevron" data-open={open || undefined} aria-hidden="true" />
        Tools
        <span className="mcp-tools__count">
          {status.toolCount}
          {server.disabledTools?.length ? ` · ${off} off` : ''}
        </span>
      </button>
      {open && (
        <div className="mcp-tools__list">
          {tools.length === 0 ? (
            <div className="row__desc">Loading tools…</div>
          ) : (
            <>
              <div className="mcp-tools__bulk">
                <button type="button" className="mcp-tools__link" onClick={() => onChange(withAllTools(server, names, true))}>
                  Turn all on
                </button>
                <button type="button" className="mcp-tools__link" onClick={() => onChange(withAllTools(server, names, false))}>
                  Turn all off
                </button>
              </div>
              {tools.map((tool) => (
                <div key={tool.name} className="mcp-tools__row">
                  <div className="mcp-tools__body">
                    <span className="mcp-tools__name">{tool.name}</span>
                    {tool.destructive && <span className="badge">Can delete</span>}
                    {tool.readOnly && <span className="badge">Read only</span>}
                    {tool.description && <span className="mcp-tools__desc">{tool.description}</span>}
                  </div>
                  <Switch label={`${tool.name} on ${server.name}`} checked={toolEnabled(server, tool.name)} onChange={(on) => onChange(withTool(server, tool.name, on))} />
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
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
      title={server ? 'Edit MCP server' : 'Add MCP server'}
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
      <input aria-label="Name"
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
          <input aria-label="Command"
            className="input"
            style={{ marginBottom: 16, fontFamily: 'var(--font-mono)' }}
            value={draft.command}
            spellCheck={false}
            placeholder="npx"
            onChange={(e) => setDraft({ ...draft, command: e.target.value })}
          />
          <div className="field-label">Arguments</div>
          <input aria-label="Arguments"
            className="input"
            style={{ marginBottom: 16, fontFamily: 'var(--font-mono)' }}
            value={argsText}
            spellCheck={false}
            placeholder="-y @modelcontextprotocol/server-filesystem ~/Documents"
            onChange={(e) => setArgsText(e.target.value)}
          />
          <div className="field-label">Environment variables (KEY=value, one per line)</div>
          <textarea aria-label="Environment variables"
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
          <input aria-label="Server URL"
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

/** Import from another app, from Settings: the same list the setup offers, scanned fresh each time it opens. */
function ImportDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const state = useImportServers()
  const [done, setDone] = useState<string | null>(null)
  const bring = async (): Promise<void> => {
    const result = await state.run()
    if (!result) return
    setDone(result.added.length > 0 ? `Added ${result.added.join(', ')}.` : 'Nothing new to add.')
  }
  return (
    <Modal
      open
      onClose={onClose}
      width={520}
      title="Import from another app"
      actions={
        done ? (
          <button className="btn btn--provider" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button className="btn btn--provider-ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn--provider" disabled={state.count === 0 || state.working} onClick={() => void bring()}>
              Import {state.count > 0 ? state.count : ''} {state.count === 1 ? 'server' : 'servers'}
            </button>
          </>
        )
      }
    >
      {done ? (
        <p className="row__desc">{done}</p>
      ) : (
        <>
          <p className="row__desc" style={{ marginTop: 0 }}>
            The MCP servers set up in Claude, Cursor, Windsurf, VS Code and Gemini CLI. Only their server lists are read.
          </p>
          <ImportList state={state} />
          {state.error && <p className="row__desc" style={{ color: 'var(--danger)' }}>{state.error}</p>}
        </>
      )}
    </Modal>
  )
}
