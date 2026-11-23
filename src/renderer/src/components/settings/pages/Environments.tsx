import { useRef, useState, type JSX } from 'react'
import { Check, ChevronDown, CircleAlert, Laptop, Loader2, MoreHorizontal, Pencil, Plug, Plus, RefreshCw, Server, Star, Trash2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { environmentsOf, environmentSummary, LOCAL_ENVIRONMENT, type CloudEnvironment, type ExeVm, type ProviderStatus } from '@shared/environments'
import { useApp } from '../../../state/store'
import { notify } from '../../Notice'
import { ConfirmDialog, MenuItem, MenuSeparator, Popover, useDisclosure } from '../../ui'
import { EnvironmentDialog, useExeAccount, type DialogTab } from '../../environments/EnvironmentDialog'
import { EnvironmentIcon } from '../../environments/EnvironmentPicker'
import { FixCommand, ProviderMark, useProviders, type Picked } from '../../environments/Providers'
import '../../environments/environments.css'

type Checked = { busy: boolean; ok?: boolean; message?: string }

/**
 * Settings → Environments: where sessions can run besides this computer
 * (shared/environments.ts). One list, this computer first, each with its
 * provider's logo and a menu, the default (where new sessions run) marked.
 * Under it, the providers found on this computer as tiles to add a machine
 * from, and the VMs Eaon made on exe.dev.
 */
export function EnvironmentsPage(): JSX.Element {
  const { saved, chosen, chats, patchSettings } = useApp(useShallow((s) => ({ saved: s.settings?.environments, chosen: s.settings?.environment, chats: s.chats, patchSettings: s.patchSettings })))
  const list = environmentsOf(saved)
  const current = chosen && list.some((e) => e.id === chosen) ? chosen : LOCAL_ENVIRONMENT
  const [dialog, setDialog] = useState<{ editing?: CloudEnvironment; pick?: Picked; tab?: DialogTab } | null>(null)
  const [removing, setRemoving] = useState<CloudEnvironment | null>(null)
  const [checks, setChecks] = useState<Record<string, Checked>>({})
  const usesExe = list.some((env) => env.kind === 'exe')
  const exe = useExeAccount(usesExe)

  const check = async (env: CloudEnvironment): Promise<void> => {
    setChecks((all) => ({ ...all, [env.id]: { busy: true } }))
    const result = await window.api.environments.check(env).catch((error: unknown) => ({ ok: false, message: String(error) }))
    setChecks((all) => ({ ...all, [env.id]: { busy: false, ...result } }))
  }
  const sessionsIn = (env: CloudEnvironment): number => chats.filter((c) => c.place?.envId === env.id && !c.archived).length
  const makeDefault = (id: string): void => void patchSettings({ environment: id })

  return (
    <>
      <h1 className="settings__h1">Environments</h1>
      <p className="settings__lede">Run sessions on a VM or a server instead of this computer. They keep working while it’s closed, and their changes come back here as a branch.</p>

      <section className="settings__section">
        <div className="envs-head">
          <span className="settings__section-label">Where sessions run</span>
          <button type="button" className="btn btn--sm btn--primary" onClick={() => setDialog({})}>
            <Plus size={14} strokeWidth={2.2} />
            Add environment
          </button>
        </div>
        <div className="envs">
          <div className="env-item" data-default={current === LOCAL_ENVIRONMENT || undefined}>
            <span className="env-logo env-logo--plain">
              <Laptop size={17} strokeWidth={1.8} />
            </span>
            <span className="env-item__body">
              <span className="env-item__title">
                This computer
                {current === LOCAL_ENVIRONMENT && <span className="env-badge">Default</span>}
              </span>
              <span className="env-item__sub">Sessions work in the project folder itself</span>
            </span>
            {current !== LOCAL_ENVIRONMENT && (
              <button type="button" className="env-item__make" onClick={() => makeDefault(LOCAL_ENVIRONMENT)}>
                Make default
              </button>
            )}
          </div>
          {list.map((env) => (
            <EnvItem
              key={env.id}
              env={env}
              isDefault={current === env.id}
              sessions={sessionsIn(env)}
              checked={checks[env.id]}
              onCheck={() => void check(env)}
              onDefault={() => makeDefault(env.id)}
              onEdit={() => setDialog({ editing: env })}
              onRemove={() => setRemoving(env)}
            />
          ))}
          {list.length === 0 && (
            <div className="envs-empty">
              <span className="envs-empty__text">Add a place for sessions to run: an exe.dev VM, a machine from one of your providers, or any server you reach over SSH.</span>
              <div className="envs-empty__starts">
                <button type="button" className="envs-start" onClick={() => setDialog({ tab: 'exe' })}>
                  <ProviderMark id="exe" size={20} />
                  exe.dev
                </button>
                <button type="button" className="envs-start" onClick={() => setDialog({ tab: 'provider' })}>
                  <Plug size={15} strokeWidth={1.9} />
                  Your providers
                </button>
                <button type="button" className="envs-start" onClick={() => setDialog({ tab: 'ssh' })}>
                  <Server size={15} strokeWidth={1.9} />
                  SSH machine
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      <DetectedProviders onPick={(pick) => setDialog({ pick })} onOpen={() => setDialog({ tab: 'provider' })} />

      {usesExe && exe.account?.ok && <EaonVms vms={exe.account.vms} onChange={exe.refresh} />}

      {dialog && (
        <EnvironmentDialog
          key={dialog.editing?.id ?? (dialog.pick ? `${dialog.pick.provider.id}:${dialog.pick.machine.id}` : (dialog.tab ?? 'new'))}
          editing={dialog.editing ?? null}
          initialPick={dialog.pick ?? null}
          initialTab={dialog.tab}
          onClose={() => setDialog(null)}
        />
      )}
      {removing && (
        <ConfirmDialog
          open
          title={`Remove ${removing.name}?`}
          confirmLabel="Remove"
          onClose={() => setRemoving(null)}
          onConfirm={() => {
            const gone = removing
            setRemoving(null)
            // What Eaon made to reach its machine (a Freestyle token) is taken back first.
            void window.api.environments.forget(gone).then(async (result) => {
              if (!result.ok) return notify(result.error, 'error')
              await patchSettings({ environments: list.filter((e) => e.id !== gone.id), ...(current === gone.id ? { environment: LOCAL_ENVIRONMENT } : {}) })
              notify(`${gone.name} is removed.`)
            })
          }}
        >
          New sessions can’t run there any more. Chats already on it keep their machine{removing.kind === 'exe' ? ', and their VMs stay until you delete them' : ''}.
          {removing.provider?.id === 'freestyle' ? ' The SSH token Eaon made for it on Freestyle is deleted.' : ''}
        </ConfirmDialog>
      )}
    </>
  )
}

/** An environment in the list: its logo, name and where its sessions go, a check's result, and its menu. */
function EnvItem({
  env,
  isDefault,
  sessions,
  checked,
  onCheck,
  onDefault,
  onEdit,
  onRemove
}: {
  env: CloudEnvironment
  isDefault: boolean
  sessions: number
  checked: Checked | undefined
  onCheck: () => void
  onDefault: () => void
  onEdit: () => void
  onRemove: () => void
}): JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null)
  const menu = useDisclosure()
  const run = (fn: () => void) => () => {
    menu.close()
    fn()
  }
  return (
    <div className="env-item" data-default={isDefault || undefined} data-open={menu.open || undefined}>
      <span className="env-logo">
        <EnvironmentIcon env={env} size={17} tile={34} />
      </span>
      <span className="env-item__body">
        <span className="env-item__title">
          {env.name}
          {isDefault && <span className="env-badge">Default</span>}
        </span>
        <span className="env-item__sub">
          {environmentSummary(env)}
          {sessions > 0 ? ` · ${sessions} ${sessions === 1 ? 'chat' : 'chats'}` : ''}
        </span>
        {checked && (
          <span className="env-item__check" data-state={checked.busy ? 'busy' : checked.ok ? 'ok' : 'fail'} role="status">
            {checked.busy ? <Loader2 size={12} strokeWidth={2.2} className="spinner" /> : checked.ok ? <Check size={12} strokeWidth={2.4} /> : <CircleAlert size={12} strokeWidth={2.2} />}
            <span>{checked.busy ? 'Checking the connection…' : checked.message}</span>
          </span>
        )}
      </span>
      {!isDefault && (
        <button type="button" className="env-item__make" onClick={onDefault}>
          Make default
        </button>
      )}
      <button ref={anchor} type="button" className="icon-btn env-item__more" aria-label={`${env.name}: more`} title="More" data-open={menu.open || undefined} onClick={menu.toggle}>
        <MoreHorizontal size={16} strokeWidth={1.9} />
      </button>
      <Popover anchor={anchor} open={menu.open} onClose={menu.close} placement="bottom-end" width={220}>
        <MenuItem icon={<RefreshCw size={15} strokeWidth={1.8} />} title="Check connection" onClick={run(onCheck)} />
        {!isDefault && <MenuItem icon={<Star size={15} strokeWidth={1.8} />} title="Use for new sessions" onClick={run(onDefault)} />}
        <MenuItem icon={<Pencil size={15} strokeWidth={1.8} />} title="Edit…" onClick={run(onEdit)} />
        <MenuSeparator />
        <MenuItem icon={<Trash2 size={15} strokeWidth={1.8} />} title="Remove…" onClick={run(onRemove)} />
      </Popover>
    </div>
  )
}

/**
 * The providers whose tools are on this computer, as tiles: a ready one's
 * machines are a click away, a signed-out one says the command that fixes it.
 * The rest are a row of logos, unfolded to how to get each.
 */
function DetectedProviders({ onPick, onOpen }: { onPick: (pick: Picked) => void; onOpen: () => void }): JSX.Element {
  const { providers, refresh } = useProviders(true)
  const [more, setMore] = useState(false)
  const found = providers?.filter((p) => p.state !== 'missing') ?? []
  const missing = providers?.filter((p) => p.state === 'missing') ?? []
  const needing = found.filter((p) => p.state !== 'ready' && p.fix)
  return (
    <section className="settings__section">
      <div className="envs-head">
        <span className="settings__section-label">Found on this computer</span>
        <button type="button" className="btn btn--sm btn--ghost" onClick={refresh} disabled={providers === null}>
          {providers === null ? <Loader2 size={13} strokeWidth={2} className="spinner" /> : <RefreshCw size={13} strokeWidth={2} />}
          {providers === null ? 'Looking…' : 'Look again'}
        </button>
      </div>
      <div className="prov-grid" aria-busy={providers === null || undefined}>
        {providers === null
          ? [0, 1, 2, 3].map((i) => <span key={i} className="prov-tile prov-tile--ghost" />)
          : found.map((p) => <ProviderTile key={p.id} provider={p} onPick={onPick} onOpen={onOpen} />)}
        {providers !== null && found.length === 0 && <p className="prov-none">No provider’s command-line tool is on this computer yet.</p>}
      </div>
      {needing.length > 0 && (
        <div className="prov-fixes">
          {needing.map((p) => (
            <div key={p.id} className="prov-fix">
              <ProviderMark id={p.id} size={18} />
              <span className="prov-fix__text">{p.message ?? `${p.name} isn’t signed in.`}</span>
              <FixCommand command={p.fix!} />
            </div>
          ))}
        </div>
      )}
      {missing.length > 0 && (
        <div className="prov-also" data-open={more || undefined}>
          <button type="button" className="prov-also__toggle" aria-expanded={more} onClick={() => setMore(!more)}>
            <span>Also works with</span>
            <span className="prov-also__marks">
              {missing.map((p) => (
                <span key={p.id} title={p.name}>
                  <ProviderMark id={p.id} size={20} />
                </span>
              ))}
            </span>
            <ChevronDown size={14} strokeWidth={2} className="prov-also__chevron" />
          </button>
          {more && (
            <div className="prov-also__list">
              {missing.map((p) => (
                <div key={p.id} className="prov-also__row">
                  <ProviderMark id={p.id} size={20} />
                  <span className="prov-also__name">{p.name}</span>
                  {p.fix && <FixCommand command={p.fix} />}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/** A provider found: its machines in a menu, to add one; or, signed out, the add dialog's list, which says how to sign in. */
function ProviderTile({ provider: p, onPick, onOpen }: { provider: ProviderStatus; onPick: (pick: Picked) => void; onOpen: () => void }): JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null)
  const menu = useDisclosure()
  const ready = p.state === 'ready'
  const count = p.machines.length
  const running = p.machines.filter((m) => m.running).length
  const sub = ready ? (count === 0 ? 'No machines yet' : `${count} ${count === 1 ? 'machine' : 'machines'}${running < count ? ` · ${running} running` : ''}`) : p.state === 'signed-out' ? 'Needs signing in' : 'Didn’t answer'
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="prov-tile"
        data-state={p.state}
        data-open={menu.open || undefined}
        data-empty={ready && count === 0 ? true : undefined}
        onClick={() => (ready && count > 0 ? menu.toggle() : onOpen())}
        title={p.account ?? undefined}
      >
        <ProviderMark id={p.id} size={30} />
        <span className="prov-tile__body">
          <span className="prov-tile__name">{p.name}</span>
          <span className="prov-tile__sub">{sub}</span>
        </span>
        <span className="prov-tile__dot" data-state={p.state} aria-hidden />
      </button>
      <Popover anchor={anchor} open={menu.open} onClose={menu.close} placement="bottom-start" width={300} className="prov-menu">
        <div className="menu__label">Add a machine from {p.name}</div>
        {p.machines.map((m) => (
          <MenuItem
            key={m.id}
            icon={<span className="machine__dot" data-running={m.running || undefined} />}
            title={m.name}
            description={m.why ?? ([m.status, m.detail].filter(Boolean).join(' · ') || undefined)}
            onClick={() => {
              menu.close()
              onPick({ provider: p, machine: m })
            }}
          />
        ))}
      </Popover>
    </>
  )
}

/** The VMs Eaon made on exe.dev (tagged `eaon`), each with its state and a way to delete it. */
function EaonVms({ vms, onChange }: { vms: ExeVm[]; onChange: () => void }): JSX.Element | null {
  const chats = useApp((s) => s.chats)
  const [deleting, setDeleting] = useState<ExeVm | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const made = vms.filter((vm) => vm.tags.includes('eaon') || vm.name.startsWith('eaon-'))
  if (made.length === 0) return null
  const chatOf = (vm: ExeVm): string | null => chats.find((c) => c.place?.vm === vm.name)?.title ?? null
  return (
    <section className="settings__section">
      <div className="envs-head">
        <span className="settings__section-label">VMs Eaon made on exe.dev</span>
      </div>
      <div className="envs">
        {made.map((vm) => (
          <div key={vm.name} className="env-item">
            <span className="env-logo">
              <ProviderMark id="exe" size={34} />
            </span>
            <span className="env-item__body">
              <span className="env-item__title env-item__title--mono">{vm.name}</span>
              <span className="env-item__sub">
                <span className="machine__dot" data-running={/running/i.test(vm.status) || undefined} />
                {[vm.status, vm.cpus ? `${vm.cpus} CPU` : null, vm.memoryGb ? `${vm.memoryGb} GB` : null, chatOf(vm) ? `“${chatOf(vm)}”` : 'no chat'].filter(Boolean).join(' · ')}
              </span>
            </span>
            <button type="button" className="btn btn--sm btn--ghost" disabled={busy === vm.name} onClick={() => setDeleting(vm)}>
              {busy === vm.name ? <Loader2 size={13} strokeWidth={2} className="spinner" /> : <Trash2 size={13} strokeWidth={1.9} />}
              Delete
            </button>
          </div>
        ))}
      </div>
      {deleting && (
        <ConfirmDialog
          open
          title={`Delete ${deleting.name}?`}
          confirmLabel="Delete VM"
          onClose={() => setDeleting(null)}
          onConfirm={() => {
            const vm = deleting
            setDeleting(null)
            setBusy(vm.name)
            void window.api.environments.removeVm(vm.name).then((result) => {
              setBusy(null)
              if (!result.ok) return notify(result.error, 'error')
              notify(`${vm.name} is deleted.`)
              onChange()
            })
          }}
        >
          Everything on it goes, including work its session hasn’t brought back. This can’t be undone.
        </ConfirmDialog>
      )}
    </section>
  )
}
