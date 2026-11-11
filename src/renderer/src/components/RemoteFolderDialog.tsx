import { useEffect, useState, type JSX } from 'react'
import { Plus, Server } from 'lucide-react'
import { Modal, Select } from './ui'
import type { SshHost } from '@shared/adeRemote'

const clean = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')

/** What the host picker offers to add one, as a value no host id can be. */
const ADD = '\u0000add'

/**
 * A project's folder on another machine: pick a host from ~/.ssh/config (or
 * add one), and a folder there. Connecting checks the folder is really on the
 * host. Eaon uses your SSH keys and agent, as Terminal would, and never asks
 * for a password. What comes back is the `ssh://` folder a project keeps.
 */
export function RemoteFolderDialog({ onPicked, onClose }: { onPicked: (cwd: string, label: string) => void; onClose: () => void }): JSX.Element {
  const [hosts, setHosts] = useState<SshHost[]>([])
  const [hostId, setHostId] = useState('')
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ hostname: '', user: '', port: '', identityFile: '' })
  const [folder, setFolder] = useState('~')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.api.ade.hosts().then(
      (list) => {
        setHosts(list)
        setHostId((current) => (list.some((h) => h.id === current) ? current : (list[0]?.id ?? '')))
        setAdding(list.length === 0)
      },
      (e) => setError(clean(e))
    )
  }, [])

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
      const found = await window.api.ade.resolveRemote({ hostId: id, path: folder })
      if (!found.ok) setError(found.error)
      else onPicked(found.cwd, found.label)
    } catch (e) {
      setError(clean(e))
    } finally {
      setBusy(false)
    }
  }

  const close = (): void => {
    if (!busy) onClose()
  }
  const ready = adding ? form.hostname.trim().length > 0 : Boolean(hostId)

  return (
    <Modal
      open
      onClose={close}
      title="Project on another machine"
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
          Chats in this project read, edit and run commands in that folder on the other machine, over SSH. Eaon connects with your SSH keys and agent, as Terminal would; a key that needs a passphrase has to be
          in the agent (ssh-add).
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
              <input autoFocus className="input" spellCheck={false} placeholder="build-box.local" value={form.hostname} onChange={(e) => setForm({ ...form, hostname: e.target.value })} />
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
        {error && (
          <p className="ade-dialog__error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  )
}
