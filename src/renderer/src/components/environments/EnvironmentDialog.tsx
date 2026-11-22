import { useEffect, useState, type JSX } from 'react'
import { Check, CircleAlert, KeyRound, Loader2, Plug, Plus, RefreshCw, Server, Sparkles } from 'lucide-react'
import type { SshHost } from '@shared/adeRemote'
import { useShallow } from 'zustand/react/shallow'
import { shortId, type CloudEnvironment, type ExeAccount } from '@shared/environments'
import { useApp } from '../../state/store'
import { Details, Modal, Select, Switch } from '../ui'
import { ProviderMark, ProvidersPanel, type Picked } from './Providers'
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
export type DialogTab = 'exe' | 'provider' | 'ssh'

export function EnvironmentDialog({
  editing,
  initialPick,
  initialTab,
  onClose,
  onSaved
}: {
  editing?: CloudEnvironment | null
  /** A provider's machine picked already (Settings → Environments' list): the dialog opens on it. */
  initialPick?: Picked | null
  /** The kind it opens on. */
  initialTab?: DialogTab
  onClose: () => void
  onSaved?: (env: CloudEnvironment) => void
}): JSX.Element {
  const { saved, patchSettings } = useApp(useShallow((s) => ({ saved: s.settings?.environments, patchSettings: s.patchSettings })))
  const environments = saved ?? []
  // What is being set up: exe.dev, a machine a provider's CLI found, or any machine over SSH.
  const [kind, setKind] = useState<DialogTab>(initialPick ? 'provider' : (editing?.kind ?? initialTab ?? 'exe'))
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


  const tabs: { id: DialogTab; label: string; icon: JSX.Element }[] = [
    { id: 'exe', label: 'exe.dev', icon: <ProviderMark id="exe" size={18} /> },
    { id: 'provider', label: 'Your providers', icon: <Plug size={15} strokeWidth={1.9} /> },
    { id: 'ssh', label: 'SSH machine', icon: <Server size={15} strokeWidth={1.9} /> }
  ]

  return (
    <Modal
      open
      onClose={() => busy === null && onClose()}
      title={editing ? `Edit ${editing.name}` : 'Add environment'}
      width={560}
      actions={
        <>
          <button type="button" className="btn btn--ghost envd-check" onClick={() => void check()} disabled={!ready || busy !== null}>
            {busy === 'check' ? <Loader2 size={14} strokeWidth={2} className="spinner" /> : <Plug size={14} strokeWidth={1.9} />}
            {busy === 'check' ? 'Checking…' : 'Check connection'}
          </button>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy !== null}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={!ready || busy !== null}>
            {busy === 'save' ? (kind === 'provider' && picked?.provider.id === 'freestyle' ? 'Making its token…' : 'Saving…') : editing ? 'Save' : 'Add environment'}
          </button>
        </>
      }
    >
      <form
        className="envd"
        onSubmit={(e) => {
          e.preventDefault()
          if (ready && busy === null) void save()
        }}
      >
        {!editing && (
          <div className="envd-tabs" role="tablist" aria-label="Kind of environment">
            {tabs.map((tab, i) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={kind === tab.id}
                // One stop for Tab, the arrows move along: the tab focused is always the one shown.
                tabIndex={kind === tab.id ? 0 : -1}
                className="envd-tab"
                data-on={kind === tab.id || undefined}
                onClick={() => setKind(tab.id)}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
                  e.preventDefault()
                  const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
                  setKind(next.id)
                  ;(e.currentTarget.parentElement?.children[tabs.indexOf(next)] as HTMLElement | undefined)?.focus()
                }}
              >
                <span className="envd-tab__icon">{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </div>
        )}
        <p className="envd-lede">{LEDE[kind]}</p>

        {kind === 'provider' ? (
          <>
            <ProvidersPanel
              picked={picked}
              focus={initialPick?.provider.id ?? null}
              onPick={(pick) => {
                setPicked(pick)
                setPickedUser(pick.machine.user ?? '')
              }}
            />
            {picked && (
              <div className="envd-picked">
                {picked.machine.why && (
                  <p className="envd-note" data-tone="warn">
                    <CircleAlert size={14} strokeWidth={2} />
                    {picked.machine.why}
                  </p>
                )}
                {picked.provider.id === 'freestyle' && (
                  <p className="envd-note">
                    <KeyRound size={14} strokeWidth={1.9} />
                    Adding it makes an SSH token on your Freestyle account that only works for {picked.machine.name}. It stays in a file only you can read, and goes when you remove this.
                  </p>
                )}
                {picked.provider.id !== 'exe' && (
                  <div className="envd-row">
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
              </div>
            )}
          </>
        ) : kind === 'exe' ? (
          <>
            <ExeAccountLine account={account} onRefresh={refresh} />
            {account?.ok && (
              <>
                <div className="envd-choices" role="radiogroup" aria-label="Where sessions run">
                  <Choice on={vm === NEW_VM} onPick={() => setVm(NEW_VM)} icon={<Sparkles size={16} strokeWidth={1.8} />} title="New VM per session" text="Fresh each time, gone with its chat" />
                  <Choice
                    on={vm !== NEW_VM}
                    disabled={vms.length === 0}
                    onPick={() => setVm(vms[0]?.name ?? NEW_VM)}
                    icon={<Server size={16} strokeWidth={1.8} />}
                    title="One of my VMs"
                    text={vms.length === 0 ? 'None on exe.dev yet' : 'A folder per session'}
                  />
                </div>
                {vm === NEW_VM ? (
                  <>
                    <div className="envd-size">
                      <span className="envd-size__label">Size</span>
                      <SizeSelect label="CPUs" value={cpu} options={CPUS} unit=" CPU" onChange={setCpu} />
                      <SizeSelect label="Memory" value={memory} options={MEMORY} unit=" GB memory" onChange={setMemory} />
                      <SizeSelect label="Disk" value={disk} options={DISK} unit=" GB disk" onChange={setDisk} />
                    </div>
                    <div className="envd-switch">
                      <span className="envd-switch__text">
                        <span className="envd-switch__title">Delete the VM with its chat</span>
                        <span className="envd-switch__sub">Sessions in the ADE keep theirs until you delete it here</span>
                      </span>
                      <Switch checked={removeWithChat} onChange={setRemoveWithChat} label="Delete the VM with its chat" />
                    </div>
                    <Details label={image.trim() || setup.trim() ? 'Image and setup (set)' : 'Image and setup'}>
                      <div className="envd-more">
                        <label className="field">
                          <span className="field-label">Image</span>
                          <input className="input" spellCheck={false} placeholder="exeuntu, exe.dev’s own" value={image} onChange={(e) => setImage(e.target.value)} />
                        </label>
                        <label className="field">
                          <span className="field-label">Setup script</span>
                          <textarea
                            className="input envd-script"
                            rows={3}
                            spellCheck={false}
                            placeholder={'Runs once when a VM first starts, e.g.\nsudo apt-get install -y nodejs npm'}
                            value={setup}
                            onChange={(e) => setSetup(e.target.value)}
                          />
                        </label>
                      </div>
                    </Details>
                  </>
                ) : (
                  <div className="envd-vms" role="radiogroup" aria-label="Your VMs">
                    {vms.map((v) => (
                      <button key={v.name} type="button" role="radio" aria-checked={vm === v.name} className="machine" data-on={vm === v.name || undefined} onClick={() => setVm(v.name)}>
                        <span className="machine__dot" data-running={/running/i.test(v.status) || undefined} aria-hidden />
                        <span className="machine__body">
                          <span className="machine__name">{v.name}</span>
                          <span className="machine__detail">{[v.status, v.cpus ? `${v.cpus} CPU` : null, v.memoryGb ? `${v.memoryGb} GB` : null, v.host].filter(Boolean).join(' · ')}</span>
                        </span>
                        {vm === v.name && <Check size={14} strokeWidth={2.2} className="machine__check" />}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        ) : (
          <>
            {!addingHost ? (
              <div className="envd-row envd-row--host">
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
                        ...hosts.map((h) => ({ value: h.id, label: h.label, icon: <Server size={14} strokeWidth={1.8} /> })),
                        { value: ADD_HOST, label: 'Add a host…', icon: <Plus size={14} strokeWidth={1.8} /> }
                      ]}
                      onChange={(value) => (value === ADD_HOST ? setAddingHost(true) : setHostId(value))}
                    />
                  )}
                </div>
                <label className="field">
                  <span className="field-label">Folder for sessions</span>
                  <input className="input" spellCheck={false} placeholder="~/eaon" value={folder} onChange={(e) => setFolder(e.target.value)} />
                </label>
              </div>
            ) : (
              <div className="envd-host">
                <label className="field">
                  <span className="field-label">Host name or address</span>
                  <input autoFocus className="input" spellCheck={false} placeholder="build-box.example.com" value={hostForm.hostname} onChange={(e) => setHostForm({ ...hostForm, hostname: e.target.value })} />
                </label>
                <div className="envd-row envd-row--three">
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
                <label className="field">
                  <span className="field-label">Folder for sessions</span>
                  <input className="input" spellCheck={false} placeholder="~/eaon" value={folder} onChange={(e) => setFolder(e.target.value)} />
                </label>
                {(hosts?.length ?? 0) > 0 && (
                  <button type="button" className="env-dialog__link" onClick={() => setAddingHost(false)}>
                    Pick a saved host instead
                  </button>
                )}
              </div>
            )}
            <p className="envd-note">
              <KeyRound size={14} strokeWidth={1.9} />
              Eaon signs in with your SSH keys and agent, as Terminal does. A key with a passphrase needs to be in the agent (ssh-add).
            </p>
          </>
        )}

        {(kind !== 'provider' || picked) && (
          <label className="field envd-name">
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
          <p className="envd-result" data-ok={result.ok || undefined} role="status">
            {result.ok ? <Check size={14} strokeWidth={2.4} /> : <CircleAlert size={14} strokeWidth={2.2} />}
            <span>{result.message}</span>
          </p>
        )}
        {error && (
          <p className="envd-result" role="alert">
            <CircleAlert size={14} strokeWidth={2.2} />
            <span>{error}</span>
          </p>
        )}
      </form>
    </Modal>
  )
}

/** A short line under the tabs, for each kind. */
const LEDE: Record<DialogTab, string> = {
  exe: 'Linux VMs with git, Claude Code and Codex ready to go.',
  provider: 'Machines your providers’ command-line tools can see on this computer.',
  ssh: 'Any server or computer you can reach over SSH.'
}

function Choice({ on, onPick, icon, title, text, disabled }: { on: boolean; onPick: () => void; icon: JSX.Element; title: string; text: string; disabled?: boolean }): JSX.Element {
  return (
    <button type="button" role="radio" aria-checked={on} className="envd-choice" data-on={on || undefined} disabled={disabled} onClick={onPick}>
      <span className="envd-choice__icon">{icon}</span>
      <span className="envd-choice__body">
        <span className="envd-choice__title">{title}</span>
        <span className="envd-choice__text">{text}</span>
      </span>
      <span className="envd-choice__radio" aria-hidden />
    </button>
  )
}

function SizeSelect({ label, value, options, unit, onChange }: { label: string; value: string; options: string[]; unit: string; onChange: (value: string) => void }): JSX.Element {
  return <Select value={value} label={label} options={[{ value: DEFAULT, label: `Default ${unit.trim().split(' ').pop()}` }, ...options.map((o) => ({ value: o, label: `${o}${unit}` }))]} onChange={onChange} />
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

