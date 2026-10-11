import { useEffect, useState, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Plus, Server } from 'lucide-react'
import { Modal, Select } from '../ui'
import { useAdeSessions } from './sessionsStore'
import { AgentMark } from './terminal/TerminalWorkspace'
import { useTerminals } from './terminal/terminalStore'
import type { SshHost } from '@shared/adeRemote'
import type { TerminalAgentId } from '@shared/terminals'

const clean = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')

/** What the host picker offers to add one, as a value no host id can be. */
const ADD = '\u0000add'

/**
 * A session on another machine: pick a host from ~/.ssh/config (or add one),
 * a folder there, and what to start. Its terminals are `ssh` to that folder,
 * so the agents run on the host, with its files and its tools; Eaon only
 * draws them. Connecting uses your SSH keys and agent, never a password typed
 * into Eaon.
 */
export function RemoteSessionDialog(): JSX.Element | null {
  const { open, setConnecting, createRemote } = useAdeSessions(
    useShallow((s) => ({ open: s.connecting, setConnecting: s.setConnecting, createRemote: s.createRemote }))
  )
  const agents = useTerminals((s) => s.agents)
  const [hosts, setHosts] = useState<SshHost[]>([])
  const [hostId, setHostId] = useState<string>('')
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ hostname: '', user: '', port: '', identityFile: '' })
  const [folder, setFolder] = useState('~')
  const [title, setTitle] = useState('')
  const [agent, setAgent] = useState<TerminalAgentId>('claude')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    setBusy(false)
    setFolder('~')
    setTitle('')
    void useTerminals.getState().refreshAgents().catch(() => undefined)
    void window.api.ade.hosts().then(
      (list) => {
        setHosts(list)
        setHostId((current) => (list.some((h) => h.id === current) ? current : (list[0]?.id ?? '')))
        setAdding(list.length === 0)
      },
      (e) => setError(clean(e))
    )
  }, [open])

  if (!open) return null
  const close = (): void => {
    if (!busy) setConnecting(false)
  }

  const submit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      let id = hostId
      if (adding) {
        const host = await window.api.ade.addHost({
          hostname: form.hostname,
          ...(form.user.trim() ? { user: form.user } : {}),
          ...(form.port.trim() ? { port: Number(form.port) } : {}),
          ...(form.identityFile.trim() ? { identityFile: form.identityFile } : {})
        })
        setHosts((list) => [...list, host])
        setHostId(host.id)
        setAdding(false)
        id = host.id
      }
      if (!id) throw new Error('Pick a host.')
      const failed = await createRemote({ hostId: id, path: folder, ...(title.trim() ? { title: title.trim() } : {}) }, agent)
      if (failed) setError(failed)
    } catch (e) {
      setError(clean(e))
    } finally {
      setBusy(false)
    }
  }

  // Whether a CLI is installed is known for this computer, not the host: offer them all.
  const choices = [...agents.filter((a) => a.id !== 'shell').map((a) => ({ id: a.id, label: a.label })), { id: 'shell' as TerminalAgentId, label: 'Shell' }]
  const ready = adding ? form.hostname.trim().length > 0 : Boolean(hostId)

  return (
    <Modal
      open
      onClose={close}
      title="Session over SSH"
      width={500}
      actions={
        <>
          <button type="button" className="btn btn--ghost" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={!ready || busy} onClick={() => void submit()}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </>
      }
    >
      <form
        className="ade-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <p className="ade-dialog__lede">
          Agents run on the other machine, in its folder, with its files and tools. Eaon connects with your SSH keys and agent, as Terminal would.
        </p>
        {!adding ? (
          <div className="field">
            <span className="field-label">Host</span>
            <Select
              value={hostId}
              options={[
                ...hosts.map((h) => ({ value: h.id, label: h.source === 'config' ? `${h.label}` : `${h.label} (added in Eaon)`, icon: <Server size={14} strokeWidth={1.8} /> })),
                { value: ADD, label: 'Add a host…', icon: <Plus size={14} strokeWidth={1.8} /> }
              ]}
              onChange={(value) => (value === ADD ? setAdding(true) : setHostId(value))}
            />
          </div>
        ) : (
          <div className="ade-remote__host">
            <label className="field">
              <span className="field-label">Host name or address</span>
              <input
                autoFocus
                className="input"
                spellCheck={false}
                placeholder="build-box.local"
                value={form.hostname}
                onChange={(e) => setForm({ ...form, hostname: e.target.value })}
              />
            </label>
            <div className="ade-remote__row">
              <label className="field">
                <span className="field-label">User</span>
                <input className="input" spellCheck={false} placeholder="optional" value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} />
              </label>
              <label className="field ade-remote__port">
                <span className="field-label">Port</span>
                <input className="input" inputMode="numeric" placeholder="22" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
              </label>
            </div>
            <label className="field">
              <span className="field-label">Key file</span>
              <input
                className="input"
                spellCheck={false}
                placeholder="optional, e.g. ~/.ssh/id_ed25519"
                value={form.identityFile}
                onChange={(e) => setForm({ ...form, identityFile: e.target.value })}
              />
            </label>
            {hosts.length > 0 && (
              <button type="button" className="ade-remote__back" onClick={() => setAdding(false)}>
                Pick a saved host instead
              </button>
            )}
          </div>
        )}
        <label className="field">
          <span className="field-label">Folder on the host</span>
          <input className="input" spellCheck={false} placeholder="~/projects/app" value={folder} onChange={(e) => setFolder(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Name</span>
          <input className="input" maxLength={120} placeholder="optional, the folder’s name otherwise" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="field">
          <span className="field-label">Start with</span>
          <div className="ade-dialog__agents" role="radiogroup" aria-label="Start with">
            {choices.map((a) => (
              <button
                key={a.id}
                type="button"
                role="radio"
                aria-checked={agent === a.id}
                className="ade-dialog__agent"
                data-on={agent === a.id || undefined}
                onClick={() => setAgent(a.id)}
              >
                <AgentMark agent={a.id} size={15} />
                {a.label}
              </button>
            ))}
          </div>
          <p className="ade-dialog__hint">It has to be installed on the host.</p>
        </div>
        {error && (
          <p className="ade-dialog__error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  )
}
