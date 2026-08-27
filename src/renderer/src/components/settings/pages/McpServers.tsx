import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useApp } from '../../../state/store'
import { Card, Modal, Row, Section, Select, Switch } from '../../ui'
import type { McpServer, McpServerStatus } from '@shared/types'

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
  const models = useApp(useShallow((s) => s.availableModels()))
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

  const upsert = (server: McpServer): void => {
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
            <input
              className="input"
              style={{ width: 110 }}
              type="number"
              min={1}
              value={mcp.toolCallTimeoutSeconds}
              onChange={(e) =>
                void patchSettings({ mcp: { toolCallTimeoutSeconds: Number(e.target.value) || 30 } })
              }
            />
          </Row>

          <Row
            title="Smart MCP tool routing"
            description="When enabled, Eaon selects relevant MCP servers before loading tools. Disable to always load the full MCP tool list."
          >
            <Switch
              label="Smart MCP tool routing"
              checked={mcp.smartRouting}
              onChange={(on) => void patchSettings({ mcp: { smartRouting: on } })}
            />
          </Row>

          <Row
            title="Use a dedicated model for routing"
            description="When smart routing is on, run the routing step with a separate (often smaller) model instead of the chat model. Turn off to always use the active chat model for routing."
          >
            <Switch
              label="Use a dedicated model for routing"
              checked={mcp.useDedicatedRoutingModel}
              dimmed={!mcp.smartRouting}
              onChange={(on) => void patchSettings({ mcp: { useDedicatedRoutingModel: on } })}
            />
          </Row>

          <Row
            title="Routing model"
            description="Choose provider and model in one place. Only lightweight models are listed so routing stays fast and cheap."
          >
            <Select
              width={200}
              value={mcp.routingModelId ?? ''}
              onChange={(value) => void patchSettings({ mcp: { routingModelId: value || null } })}
              options={
                models.length > 0
                  ? models.map((m) => ({ value: m.id, label: m.label }))
                  : [{ value: '', label: 'Select routing model...' }]
              }
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
      ? '#34d399'
      : status.state === 'starting'
        ? '#fbbf24'
        : status.state === 'error'
          ? 'var(--danger)'
          : 'var(--text-4)'

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
            <div className="row__desc" style={{ color: 'var(--danger)' }}>
              {status.error}
            </div>
          )}
        </div>
        <div className="row__trail">
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
  const [argsText, setArgsText] = useState((server?.args ?? []).join(' '))
  const [envText, setEnvText] = useState(
    Object.entries(server?.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')
  )

  const save = (): void => {
    const id = draft.id || draft.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')
    if (!id) return
    const env: Record<string, string> = {}
    for (const line of envText.split('\n')) {
      const eq = line.indexOf('=')
      if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }
    onSave({
      ...draft,
      id,
      name: draft.name.trim() || id,
      args: argsText.split(/\s+/).filter(Boolean),
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
