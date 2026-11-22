import { useState, type JSX } from 'react'
import { Check, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { environmentsOf, environmentSummary, LOCAL_ENVIRONMENT, type CloudEnvironment, type ExeVm } from '@shared/environments'
import { useApp } from '../../../state/store'
import { notify } from '../../Notice'
import { Card, ConfirmDialog, Row, Section, Select } from '../../ui'
import { EnvironmentDialog, ExeAccountLine, useExeAccount } from '../../environments/EnvironmentDialog'
import { EnvironmentIcon } from '../../environments/EnvironmentPicker'
import { ProvidersPanel, type Picked } from '../../environments/Providers'
import '../../environments/environments.css'

/**
 * Settings → Environments: where sessions can run besides this computer.
 * exe.dev VMs and any machine over SSH (shared/environments.ts). Each one
 * set up here is offered under the message box when a session starts and in
 * the ADE's New session; "New sessions run on" is the one picked there.
 */
export function EnvironmentsPage(): JSX.Element {
  const { saved, chosen, chats, patchSettings } = useApp(useShallow((s) => ({ saved: s.settings?.environments, chosen: s.settings?.environment, chats: s.chats, patchSettings: s.patchSettings })))
  const list = environmentsOf(saved)
  const [editing, setEditing] = useState<CloudEnvironment | 'new' | null>(null)
  const [removing, setRemoving] = useState<CloudEnvironment | null>(null)
  const [grabbing, setGrabbing] = useState<Picked | null>(null)
  const [checks, setChecks] = useState<Record<string, { busy: boolean; ok?: boolean; message?: string }>>({})
  const usesExe = list.some((env) => env.kind === 'exe')
  const exe = useExeAccount(usesExe)

  const check = async (env: CloudEnvironment): Promise<void> => {
    setChecks((all) => ({ ...all, [env.id]: { busy: true } }))
    const result = await window.api.environments.check(env).catch((error: unknown) => ({ ok: false, message: String(error) }))
    setChecks((all) => ({ ...all, [env.id]: { busy: false, ...result } }))
  }

  const sessionsIn = (env: CloudEnvironment): number => chats.filter((c) => c.place?.envId === env.id && !c.archived).length

  return (
    <>
      <h1 className="settings__h1">Environments</h1>
      <p className="settings__lede">
        Run sessions on another machine instead of this computer: a VM on exe.dev, or any server you reach over SSH. A session gets a copy of its project there, and its agent (Codex or Claude Code) runs
        there too, so it keeps working when you close this computer. Bring the changes back here as a branch when it’s done.
      </p>

      {list.length > 0 && (
        <Section label="New sessions">
          <Card>
            <Row title="Run new sessions on" description="Picked under the message box when a session starts, and in the ADE’s New session.">
              <Select
                value={chosen && list.some((e) => e.id === chosen) ? chosen : LOCAL_ENVIRONMENT}
                width={220}
                options={[{ value: LOCAL_ENVIRONMENT, label: 'This computer' }, ...list.map((env) => ({ value: env.id, label: env.name }))]}
                onChange={(value) => void patchSettings({ environment: value })}
              />
            </Row>
          </Card>
        </Section>
      )}

      <Section label="Cloud environments">
        <Card>
          {list.length === 0 ? (
            <div className="env-empty">
              <span className="env-empty__title">No environments yet</span>
              <span className="env-empty__text">Add exe.dev, or a machine you reach over SSH, to run sessions there.</span>
              <button type="button" className="btn btn--primary btn--sm" onClick={() => setEditing('new')}>
                <Plus size={14} strokeWidth={2} />
                New environment
              </button>
            </div>
          ) : (
            <>
              {list.map((env) => {
                const state = checks[env.id]
                const count = sessionsIn(env)
                return (
                  <div key={env.id} className="row env-row">
                    <span className="env-row__icon">
                      <EnvironmentIcon env={env} size={17} />
                    </span>
                    <div className="row__body">
                      <div className="row__title">
                        {env.name}
                        {chosen === env.id && <span className="env-row__tag">New sessions</span>}
                      </div>
                      <div className="row__desc">
                        {environmentSummary(env)}
                        {count > 0 ? ` · ${count} ${count === 1 ? 'chat' : 'chats'}` : ''}
                      </div>
                      {state && !state.busy && (
                        <div className="env-row__check" data-ok={state.ok || undefined}>
                          {state.ok && <Check size={13} strokeWidth={2.2} />}
                          {state.message}
                        </div>
                      )}
                    </div>
                    <div className="row__trail env-row__actions">
                      <button type="button" className="btn btn--sm" onClick={() => void check(env)} disabled={state?.busy}>
                        {state?.busy ? <Loader2 size={13} strokeWidth={2} className="spinner" /> : null}
                        {state?.busy ? 'Checking…' : 'Check'}
                      </button>
                      <button type="button" className="icon-btn" title={`Edit ${env.name}`} aria-label={`Edit ${env.name}`} onClick={() => setEditing(env)}>
                        <Pencil size={14} strokeWidth={1.9} />
                      </button>
                      <button type="button" className="icon-btn" title={`Remove ${env.name}`} aria-label={`Remove ${env.name}`} onClick={() => setRemoving(env)}>
                        <Trash2 size={14} strokeWidth={1.9} />
                      </button>
                    </div>
                  </div>
                )
              })}
              <div className="env-add">
                <button type="button" className="btn btn--sm" onClick={() => setEditing('new')}>
                  <Plus size={14} strokeWidth={2} />
                  New environment
                </button>
              </div>
            </>
          )}
        </Card>
      </Section>

      <Section label="Providers">
        <Card>
          <div className="env-providers">
            <p className="env-providers__lede">
              The VM providers whose command-line tools are on this computer, and the machines they can see. Pick one to run sessions on it. Eaon only reads what they list; it never starts, makes or changes anything there.
            </p>
            <ProvidersPanel picked={grabbing} onPick={setGrabbing} />
          </div>
        </Card>
      </Section>

      {usesExe && (
        <Section label="exe.dev">
          <Card>
            <div className="env-exe">
              <ExeAccountLine account={exe.account} onRefresh={exe.refresh} />
            </div>
            {exe.account?.ok && <EaonVms vms={exe.account.vms} onChange={exe.refresh} />}
          </Card>
        </Section>
      )}

      {editing && <EnvironmentDialog editing={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {grabbing && <EnvironmentDialog key={`${grabbing.provider.id}:${grabbing.machine.id}`} initialPick={grabbing} onClose={() => setGrabbing(null)} />}
      {removing && (
        <ConfirmDialog
          open
          title={`Remove ${removing.name}?`}
          confirmLabel="Remove"
          onClose={() => setRemoving(null)}
          onConfirm={() => {
            const gone = removing
            setRemoving(null)
            void patchSettings({ environments: list.filter((e) => e.id !== gone.id), ...(chosen === gone.id ? { environment: LOCAL_ENVIRONMENT } : {}) }).then(() => notify(`${gone.name} is removed.`))
          }}
        >
          New sessions can’t run there any more. Chats already on it keep their machine{removing.kind === 'exe' ? ', and their VMs stay until you delete them' : ''}.
        </ConfirmDialog>
      )}
    </>
  )
}

/** The VMs Eaon made on exe.dev (tagged `eaon`), each with its state and a way to delete it. */
function EaonVms({ vms, onChange }: { vms: ExeVm[]; onChange: () => void }): JSX.Element {
  const chats = useApp((s) => s.chats)
  const [deleting, setDeleting] = useState<ExeVm | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const made = vms.filter((vm) => vm.tags.includes('eaon') || vm.name.startsWith('eaon-'))
  const chatOf = (vm: ExeVm): string | null => chats.find((c) => c.place?.vm === vm.name)?.title ?? null
  return (
    <>
      <Row title="VMs Eaon made" description={made.length === 0 ? 'None yet. Each session on exe.dev gets one, named after it.' : 'Each is a session’s. Deleting one removes everything on it.'} />
      {made.map((vm) => (
        <div key={vm.name} className="row env-vm">
          <span className="env-vm__state" data-running={/running/i.test(vm.status) || undefined} aria-hidden />
          <div className="row__body">
            <div className="row__title env-vm__name">{vm.name}</div>
            <div className="row__desc">
              {[vm.status, vm.cpus ? `${vm.cpus} CPU` : null, vm.memoryGb ? `${vm.memoryGb} GB` : null, chatOf(vm) ? `“${chatOf(vm)}”` : 'no chat'].filter(Boolean).join(' · ')}
            </div>
          </div>
          <div className="row__trail">
            <button type="button" className="btn btn--sm" disabled={busy === vm.name} onClick={() => setDeleting(vm)}>
              {busy === vm.name ? <Loader2 size={13} strokeWidth={2} className="spinner" /> : <Trash2 size={13} strokeWidth={1.9} />}
              Delete
            </button>
          </div>
        </div>
      ))}
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
    </>
  )
}
