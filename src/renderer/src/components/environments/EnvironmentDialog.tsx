import { useEffect, useMemo, useState, type JSX } from 'react'
import { Boxes, Check, Cloud, Loader2, Plus, RefreshCw, Server } from 'lucide-react'
import type { SshHost } from '@shared/adeRemote'
import { useShallow } from 'zustand/react/shallow'
import { shortId, type CloudEnvironment, type EnvironmentKind, type ExeAccount } from '@shared/environments'
import { useApp } from '../../state/store'
import { Details, Modal, Select } from '../ui'
import { ProvidersPanel, type Picked } from './Providers'
import './environments.css'

const clean = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')

/** What the host picker offers to add one, as a value no host id can be. */
const ADD_HOST = '\u0000add'
const NEW_VM = '\u0000new'
const DEFAULT = '\u0000default'

const CPUS = ['1', '2', '4', '8', '16']
const MEMORY = ['2', '4', '8', '16', '32']
const DISK = ['10', '20', '50', '100', '200']

/** exe.dev's account, asked once per dialog and again on Check again. */
export function useExeAccount(on: boolean): { account: ExeAccount | null; refresh: () => void } {
  const [account, setAccount] = useState<ExeAccount | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!on) return
    let live = true
    setAccount(null)
    void window.api.environments.exeAccount().then(
      (next) => live && setAccount(next),
      (error) => live && setAccount({ ok: false, reason: 'other', message: clean(error) })
    )
    return () => {
      live = false
    }
  }, [on, tick])
  return { account, refresh: () => setTick((n) => n + 1) }
}

/**
 * A new cloud environment, or one to change: exe.dev (a VM for each session,
 * or one of the user's) or any machine over SSH, with the folder sessions go
 * in. Saved into Settings → Environments; a new one becomes where the next
 * session runs.
 */
export function EnvironmentDialog({
  editing,
  initialPick,
  onClose,
  onSaved
}: {
  editing?: CloudEnvironment | null
  /** A provider's machine picked already (Settings → Environments' list): the dialog opens on it. */
  initialPick?: Picked | null
  onClose: () => void
  onSaved?: (env: CloudEnvironment) => void
}): JSX.Element {
  const { saved, patchSettings } = useApp(useShallow((s) => ({ saved: s.settings?.environments, patchSettings: s.patchSettings })))
  const environments = saved ?? []
  // What is being set up: exe.dev, a machine a provider's CLI found, or any machine over SSH.
  const [kind, setKind] = useState<EnvironmentKind | 'provider'>(initialPick ? 'provider' : (editing?.kind ?? 'exe'))
  const [picked, setPicked] = useState<Picked | null>(initialPick ?? null)
  const [pickedUser, setPickedUser] = useState(initialPick?.machine.user ?? '')
  const [name, setName] = useState(editing?.name ?? '')
  const [named, setNamed] = useState(Boolean(editing))
  // exe.dev
  const [vm, setVm] = useState<string>(editing?.exe?.vm ?? NEW_VM)
  const [cpu, setCpu] = useState(editing?.exe?.cpu ? String(editing.exe.cpu) : DEFAULT)
  const [memory, setMemory] = useState(editing?.exe?.memory ? String(editing.exe.memory) : DEFAULT)
  const [disk, setDisk] = useState(editing?.exe?.disk ? String(editing.exe.disk) : DEFAULT)
  const [image, setImage] = useState(editing?.exe?.image ?? '')
  const [setup, setSetup] = useState(editing?.exe?.setup ?? '')
  const [removeWithChat, setRemoveWithChat] = useState(editing?.exe?.removeWithChat !== false)
  // SSH
  const [hosts, setHosts] = useState<SshHost[] | null>(null)
  const [hostId, setHostId] = useState(editing?.ssh?.hostId ?? '')
  const [addingHost, setAddingHost] = useState(false)
  const [hostForm, setHostForm] = useState({ hostname: '', user: '', port: '', identityFile: '' })
  const [folder, setFolder] = useState(editing?.ssh?.folder ?? '~/eaon')
  // Check and save
  const [busy, setBusy] = useState<'check' | 'save' | null>(null)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { account, refresh } = useExeAccount(kind === 'exe')

  useEffect(() => {
    void window.api.ade.hosts().then(
      (list) => {
        setHosts(list)
        setHostId((current) => (list.some((h) => h.id === current) ? current : (list[0]?.id ?? '')))
      },
      () => setHosts([])
    )
  }, [])
  useEffect(() => setResult(null), [kind, vm, hostId, folder, addingHost, picked])

  const host = hosts?.find((h) => h.id === hostId) ?? null
  const suggested =
    kind === 'provider'
      ? picked
        ? picked.provider.id === 'exe'
          ? `exe.dev · ${picked.machine.name}`
          : `${picked.machine.name} (${picked.provider.name})`
        : 'Provider machine'
      : kind === 'exe'
        ? vm === NEW_VM
          ? 'exe.dev'
          : `exe.dev · ${vm}`
        : addingHost
          ? hostForm.hostname.trim() || 'SSH machine'
          : (host?.label ?? 'SSH machine')
  const shownName = named ? name : suggested
  const vms = account?.ok ? account.vms : []

  const whole = (value: string): number | undefined => (value === DEFAULT ? undefined : Number(value))

  /** The environment the form describes; a host typed in is added to the ADE's hosts first. */
  const build = async (): Promise<CloudEnvironment> => {
    const base = { id: editing?.id ?? `env-${shortId(8)}`, name: shownName.trim() || suggested, createdAt: editing?.createdAt ?? Date.now() }
    if (kind === 'provider') {
      if (!picked) throw new Error('Pick a machine.')
      const grabbed = await window.api.environments.grab({
        provider: picked.provider.id,
        machine: picked.machine.id,
        name: base.name,
        ...(pickedUser.trim() ? { user: pickedUser.trim() } : {}),
        folder: folder.trim() || '~/eaon'
      })
      if (!grabbed.ok) throw new Error(grabbed.error)
      return { ...grabbed.env, id: base.id }
    }
    if (kind === 'exe') {
      return {
        ...base,
        kind,
        exe: {
          vm: vm === NEW_VM ? null : vm,
          ...(vm === NEW_VM
            ? {
                ...(whole(cpu) ? { cpu: whole(cpu) } : {}),
                ...(whole(memory) ? { memory: whole(memory) } : {}),
                ...(whole(disk) ? { disk: whole(disk) } : {}),
                ...(image.trim() ? { image: image.trim() } : {}),
                ...(setup.trim() ? { setup } : {}),
                removeWithChat
              }
            : {})
        }
      }
    }
    let id = hostId
    if (addingHost) {
      const made = await window.api.ade.addHost({
        hostname: hostForm.hostname,
        ...(hostForm.user.trim() ? { user: hostForm.user } : {}),
        ...(hostForm.port.trim() ? { port: Number(hostForm.port) } : {}),
        ...(hostForm.identityFile.trim() ? { identityFile: hostForm.identityFile } : {})
      })
      setHosts((list) => [...(list ?? []), made])
      setHostId(made.id)
      setAddingHost(false)
      id = made.id
    }
    if (!id) throw new Error('Pick an SSH host.')
    return { ...base, kind, ssh: { hostId: id, folder: folder.trim() || '~/eaon' } }
  }

  const check = async (): Promise<void> => {
    setBusy('check')
    setError(null)
    try {
      setResult(await window.api.environments.check(await build()))
    } catch (e) {
      setError(clean(e))
    } finally {
      setBusy(null)
    }
  }

  const save = async (): Promise<void> => {
    setBusy('save')
    setError(null)
    try {
      const env = await build()
      const list = editing ? environments.map((e) => (e.id === env.id ? env : e)) : [...environments, env]
      // A new one is where the next session runs: it was just set up for that.
      await patchSettings({ environments: list, ...(editing ? {} : { environment: env.id }) })
      onSaved?.(env)
      onClose()
    } catch (e) {
      setError(clean(e))
    } finally {
      setBusy(null)
    }
  }

  const ready =
    kind === 'provider'
      ? Boolean(picked)
      : kind === 'exe'
      ? Boolean(account?.ok) && (vm === NEW_VM || vms.some((v) => v.name === vm))
      : addingHost
        ? hostForm.hostname.trim().length > 0
        : Boolean(hostId)

  const vmOptions = useMemo(
    () => [
      { value: NEW_VM, label: 'A new VM for each session' },
      ...vms.map((v) => ({ value: v.name, label: `${v.name}${v.status && !/running/i.test(v.status) ? ` (${v.status})` : ''}` }))
    ],
    [vms]
  )

  return (
    <Modal
      open
      onClose={() => busy === null && onClose()}
      title={editing ? `Edit ${editing.name}` : 'New environment'}
      width={540}
      actions={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy !== null}>
            Cancel
          </button>
          <button type="button" className="btn" onClick={() => void check()} disabled={!ready || busy !== null}>
            {busy === 'check' ? <Loader2 size={14} strokeWidth={2} className="spinner" /> : null}
            {busy === 'check' ? 'Checking…' : 'Check connection'}
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={!ready || busy !== null}>
            {busy === 'save' ? 'Saving…' : editing ? 'Save' : 'Add environment'}
          </button>
        </>
      }
    >
      <form
        className="env-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          if (ready && busy === null) void save()
        }}
      >
        {!editing && (
          <div className="env-kinds" role="radiogroup" aria-label="Kind of environment">
            <KindCard kind="exe" on={kind === 'exe'} onPick={setKind} icon={<Cloud size={18} strokeWidth={1.8} />} title="exe.dev" text="A fresh Linux VM for each session, with Claude Code and Codex ready." />
            <KindCard kind="provider" on={kind === 'provider'} onPick={setKind} icon={<Boxes size={18} strokeWidth={1.8} />} title="From a provider" text="A machine on AWS, Google Cloud, Azure, Codespaces, Tailscale and more." />
            <KindCard kind="ssh" on={kind === 'ssh'} onPick={setKind} icon={<Server size={18} strokeWidth={1.8} />} title="Any machine" text="A server or computer you reach over SSH, by its address." />
          </div>
        )}

        {kind === 'provider' ? (
          <>
            <ProvidersPanel
              picked={picked}
              onPick={(pick) => {
                setPicked(pick)
                setPickedUser(pick.machine.user ?? '')
              }}
            />
            {picked && (
              <>
                {picked.machine.why && <p className="env-dialog__hint env-dialog__hint--warn">{picked.machine.why}</p>}
                {picked.provider.id !== 'exe' && (
                  <div className="env-dialog__grid env-dialog__grid--two">
                    <label className="field">
                      <span className="field-label">Log in as</span>
                      <input className="input" spellCheck={false} placeholder="the provider’s default" value={pickedUser} onChange={(e) => setPickedUser(e.target.value)} />
                    </label>
                    <label className="field">
                      <span className="field-label">Folder for sessions</span>
                      <input className="input" spellCheck={false} placeholder="~/eaon" value={folder} onChange={(e) => setFolder(e.target.value)} />
                    </label>
                  </div>
                )}
              </>
            )}
          </>
        ) : kind === 'exe' ? (
          <>
            <ExeAccountLine account={account} onRefresh={refresh} />
            {account?.ok && (
              <>
                <div className="field">
                  <span className="field-label">Where sessions run</span>
                  <Select value={vm} options={vmOptions} onChange={setVm} label="Where sessions run" />
                </div>
                {vm === NEW_VM ? (
                  <>
                    <div className="env-dialog__grid">
                      <SizeField label="CPUs" value={cpu} options={CPUS} unit="" onChange={setCpu} />
                      <SizeField label="Memory" value={memory} options={MEMORY} unit=" GB" onChange={setMemory} />
                      <SizeField label="Disk" value={disk} options={DISK} unit=" GB" onChange={setDisk} />
                    </div>
                    <Details label={image.trim() || setup.trim() ? 'More options (set)' : 'More options'}>
                      <div className="env-dialog__more">
                        <label className="field">
                          <span className="field-label">Image</span>
                          <input className="input" spellCheck={false} placeholder="exeuntu, exe.dev’s own (git, Claude Code, Codex)" value={image} onChange={(e) => setImage(e.target.value)} />
                        </label>
                        <label className="field">
                          <span className="field-label">Setup script</span>
                          <textarea
                            className="input env-dialog__script"
                            rows={3}
                            spellCheck={false}
                            placeholder={'Runs once when a VM first starts, e.g.\nsudo apt-get install -y nodejs npm'}
                            value={setup}
                            onChange={(e) => setSetup(e.target.value)}
                          />
                        </label>
                      </div>
                    </Details>
                    <label className="env-dialog__check">
                      <input type="checkbox" checked={removeWithChat} onChange={(e) => setRemoveWithChat(e.target.checked)} />
                      <span>Delete a session’s VM when its chat is deleted</span>
                    </label>
                    <p className="env-dialog__hint">Each session gets its own VM, named after it. Sessions in the ADE keep theirs until you delete it in Settings → Environments.</p>
                  </>
                ) : (
                  <p className="env-dialog__hint">Each session gets a folder of its own in ~/eaon on {vm}, with a copy of the project.</p>
                )}
              </>
            )}
          </>
        ) : (
          <>
            {!addingHost ? (
              <div className="field">
                <span className="field-label">Host</span>
                {hosts === null ? (
                  <div className="env-dialog__loading">
                    <Loader2 size={14} strokeWidth={2} className="spinner" /> Reading ~/.ssh/config…
                  </div>
                ) : (
                  <Select
                    value={hostId || ADD_HOST}
                    label="Host"
                    options={[
                      ...hosts.map((h) => ({ value: h.id, label: h.source === 'config' ? h.label : `${h.label} (added in Eaon)`, icon: <Server size={14} strokeWidth={1.8} /> })),
                      { value: ADD_HOST, label: 'Add a host…', icon: <Plus size={14} strokeWidth={1.8} /> }
                    ]}
                    onChange={(value) => (value === ADD_HOST ? setAddingHost(true) : setHostId(value))}
                  />
                )}
              </div>
            ) : (
              <div className="env-dialog__host">
                <label className="field">
                  <span className="field-label">Host name or address</span>
                  <input autoFocus className="input" spellCheck={false} placeholder="build-box.example.com" value={hostForm.hostname} onChange={(e) => setHostForm({ ...hostForm, hostname: e.target.value })} />
                </label>
                <div className="env-dialog__grid">
                  <label className="field">
                    <span className="field-label">User</span>
                    <input className="input" spellCheck={false} placeholder="optional" value={hostForm.user} onChange={(e) => setHostForm({ ...hostForm, user: e.target.value })} />
                  </label>
                  <label className="field">
                    <span className="field-label">Port</span>
                    <input className="input" inputMode="numeric" placeholder="22" value={hostForm.port} onChange={(e) => setHostForm({ ...hostForm, port: e.target.value })} />
                  </label>
                  <label className="field">
                    <span className="field-label">Key file</span>
                    <input className="input" spellCheck={false} placeholder="optional" value={hostForm.identityFile} onChange={(e) => setHostForm({ ...hostForm, identityFile: e.target.value })} />
                  </label>
                </div>
                {(hosts?.length ?? 0) > 0 && (
                  <button type="button" className="env-dialog__link" onClick={() => setAddingHost(false)}>
                    Pick a saved host instead
                  </button>
                )}
              </div>
            )}
            <label className="field">
              <span className="field-label">Folder for sessions</span>
              <input className="input" spellCheck={false} placeholder="~/eaon" value={folder} onChange={(e) => setFolder(e.target.value)} />
            </label>
            <p className="env-dialog__hint">
              Each session gets its own folder in it, with a copy of the project. Eaon connects with your SSH keys and agent, as Terminal does; a key with a passphrase needs to be in the agent (ssh-add).
            </p>
          </>
        )}

        {(kind !== 'provider' || picked) && (
          <label className="field">
            <span className="field-label">Name</span>
            <input
              className="input"
              value={shownName}
              maxLength={60}
              placeholder={suggested}
              onChange={(e) => {
                setNamed(true)
                setName(e.target.value)
              }}
            />
          </label>
        )}

        {result && (
          <p className="env-dialog__result" data-ok={result.ok || undefined} role="status">
            {result.ok ? <Check size={14} strokeWidth={2.2} /> : null}
            {result.message}
          </p>
        )}
        {error && (
          <p className="ade-dialog__error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  )
}

function KindCard<K extends string>({ kind, on, onPick, icon, title, text }: { kind: K; on: boolean; onPick: (kind: K) => void; icon: JSX.Element; title: string; text: string }): JSX.Element {
  return (
    <button type="button" role="radio" aria-checked={on} className="env-kind" data-on={on || undefined} onClick={() => onPick(kind)}>
      {on && (
        <span className="env-kind__tick" aria-hidden>
          <Check size={11} strokeWidth={3} />
        </span>
      )}
      <span className="env-kind__icon">{icon}</span>
      <span className="env-kind__title">{title}</span>
      <span className="env-kind__text">{text}</span>
    </button>
  )
}

function SizeField({ label, value, options, unit, onChange }: { label: string; value: string; options: string[]; unit: string; onChange: (value: string) => void }): JSX.Element {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <Select value={value} label={label} options={[{ value: DEFAULT, label: 'Default' }, ...options.map((o) => ({ value: o, label: `${o}${unit}` }))]} onChange={onChange} />
    </div>
  )
}

/** Whether this computer can use exe.dev, and what to do when it can't. */
export function ExeAccountLine({ account, onRefresh }: { account: ExeAccount | null; onRefresh: () => void }): JSX.Element {
  if (!account) {
    return (
      <div className="env-account" data-state="checking">
        <Loader2 size={14} strokeWidth={2} className="spinner" />
        <span>Checking exe.dev…</span>
      </div>
    )
  }
  if (account.ok) {
    return (
      <div className="env-account" data-state="ok">
        <span className="env-account__dot" aria-hidden />
        <span className="env-account__text">
          Signed in to exe.dev{account.email ? ` as ${account.email}` : ''}
          <span className="env-account__more"> · {account.vms.length === 1 ? '1 VM' : `${account.vms.length} VMs`}</span>
        </span>
      </div>
    )
  }
  return (
    <div className="env-account" data-state="problem" role="alert">
      <span className="env-account__dot" aria-hidden />
      <span className="env-account__text">
        {account.message}
        {account.reason === 'not-registered' && (
          <>
            {' '}
            exe.dev uses your SSH key as your login: in Terminal, run <code>ssh exe.dev</code> and follow its steps.
          </>
        )}
      </span>
      <button type="button" className="btn btn--sm" onClick={onRefresh}>
        <RefreshCw size={13} strokeWidth={2} />
        Check again
      </button>
    </div>
  )
}

