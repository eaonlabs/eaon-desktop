import { useEffect, useMemo, useState } from 'react'
import { Monitor, Plus, X } from 'lucide-react'
import { vmLimits, type VmDevice, type VmDeviceState, type VmStatus } from '@shared/vms'
import { TopBar } from '../TopBar'
import { Card, ConfirmDialog, Modal, Row, Section, Segmented, Slider, Switch } from '../ui'
import { notify } from '../Notice'
import { NewVmDialog } from './NewVmDialog'
import { VmCard } from './VmCard'
import { VmScreen } from './VmScreen'
import { cleanVmError, useVmDevices } from './useVmDevices'

/**
 * Computers: virtual machines on this computer and on the worker computer,
 * for the user and for agents. A list of them per device, a way to make one,
 * and each one's screen, live, in place of the list.
 */

const deviceLabel = (state: VmDeviceState): string => (state.device === 'local' ? (state.info?.platform === 'darwin' ? 'This Mac' : 'This computer') : state.name)

function deviceLine(state: VmDeviceState): string | null {
  const info = state.info
  if (!info) return null
  const can = (['linux', 'macos'] as const).filter((os) => info.os[os].available).map((os) => (os === 'linux' ? 'Linux' : 'macOS'))
  return [
    `${info.cpus} processors`,
    `${Math.round(info.memoryMB / 1024)} GB memory`,
    info.diskFreeMB !== null ? `${Math.round(info.diskFreeMB / 1024)} GB free` : null,
    can.length ? `runs ${can.join(' and ')}` : null
  ]
    .filter(Boolean)
    .join(' · ')
}

export function ComputersPage(): JSX.Element {
  const { devices, refresh } = useVmDevices()
  // Until picked: the worker computer when it has VMs, or when this computer can't run any.
  const [picked, setDeviceId] = useState<VmDevice | null>(null)
  const linked = devices?.find((d) => d.device === 'host')
  const here = devices?.find((d) => d.device === 'local')
  const runsVms = (d?: VmDeviceState): boolean => Boolean(d?.info && (d.info.os.linux.available || d.info.os.macos.available))
  const deviceId: VmDevice = picked ?? (linked && (linked.vms.length > 0 || !runsVms(here)) ? 'host' : 'local')
  const [creating, setCreating] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<VmStatus | null>(null)
  const [settings, setSettings] = useState<VmStatus | null>(null)
  const [snapshots, setSnapshots] = useState<VmStatus | null>(null)
  const [installing, setInstalling] = useState(false)

  const device = devices?.find((d) => d.device === deviceId) ?? devices?.[0] ?? null
  useEffect(() => {
    if (devices && picked && !devices.some((d) => d.device === picked)) setDeviceId(null)
  }, [devices, picked])
  const open = device?.vms.find((vm) => vm.id === openId) ?? null

  const act = async (vm: VmStatus, action: () => Promise<unknown>): Promise<void> => {
    setBusy(vm.id)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(cleanVmError(e))
    } finally {
      setBusy(null)
    }
  }

  const installTools = async (): Promise<void> => {
    if (!device) return
    setInstalling(true)
    setError(null)
    try {
      const result = await window.api.vms.installTools(device.device)
      if (result.needsPassword) setError(`Installing needs your password on ${device.name}. Run this there, then come back: ${result.command}`)
      else if (!result.ok) setError(`That didn’t work: ${result.output.split('\n').slice(-3).join(' ')}`)
      else {
        notify(
          result.restarting
            ? `Installed. Eaon on ${device.name} is restarting so it can use KVM; it’s back in a few seconds.`
            : result.restartNeeded
              ? `Done. Restart Eaon on ${device.name} (or the computer) so it can use KVM.`
              : 'Installed. You can make VMs now.'
        )
        await refresh()
      }
    } catch (e) {
      setError(cleanVmError(e))
    } finally {
      setInstalling(false)
    }
  }

  if (open && device) {
    return (
      <div className="page">
        <VmScreen
          vm={open}
          onBack={() => setOpenId(null)}
          onStart={() => void act(open, () => window.api.vms.start(device.device, open.id))}
          onStop={() => void act(open, () => window.api.vms.stop(device.device, open.id))}
        />
      </div>
    )
  }

  const fix = device?.info ? (device.info.os.linux.fix ?? null) : null
  const canMake = Boolean(device?.info && (device.info.os.linux.available || device.info.os.macos.available) && device.connected)

  return (
    <div className="page">
      <TopBar
        variant="page__bar"
        right={
          <button className="btn btn--primary" disabled={!canMake} onClick={() => setCreating(true)}>
            <Plus size={14} strokeWidth={2} />
            New VM
          </button>
        }
      />
      <div className="page__scroll scroll">
        <div className="page__inner page__inner--vms">
          <h1 className="page__title">Computers</h1>
          <p className="page__subtitle">Whole computers to work in, apart from this one: Linux or macOS, for you and for agents. They run here or on your worker computer.</p>

          {devices && devices.length > 1 && (
            <div className="vm-devices">
              <Segmented value={device?.device ?? 'local'} options={devices.map((d) => ({ value: d.device, label: deviceLabel(d) }))} onChange={(value) => setDeviceId(value)} />
            </div>
          )}
          {device && (
            <div className="vm-device">
              <span>{deviceLine(device) ?? (device.connected ? 'Checking…' : '')}</span>
              {device.error && <span className="vm-device__error">{device.error}</span>}
            </div>
          )}
          {device?.info && !device.info.os.linux.available && !device.info.os.macos.available && (
            <Section>
              <Card>
                <Row title="Can’t run VMs yet" description={device.info.os.linux.reason}>
                  {fix && (
                    <button className="btn" disabled={installing} onClick={() => void installTools()}>
                      {installing ? 'Installing…' : fix.label}
                    </button>
                  )}
                </Row>
                {fix && <div className="vm-fix">It runs: <code>{fix.command}</code></div>}
              </Card>
            </Section>
          )}
          {device?.info?.os.linux.available && fix && (
            <div className="vm-warn">
              <span>{device.info.os.linux.reason}</span>
              <button className="btn btn--sm" disabled={installing} onClick={() => void installTools()}>
                {installing ? 'Working…' : fix.label}
              </button>
            </div>
          )}

          {error && (
            <div className="sched-alert" role="alert">
              <span>{error}</span>
              <button className="icon-btn" aria-label="Dismiss" onClick={() => setError(null)}>
                <X size={14} strokeWidth={2} />
              </button>
            </div>
          )}

          {device && device.vms.length === 0 && canMake && (
            <Section>
              <Card>
                <Row title="No VMs yet" description={`Make one to give agents a computer of their own on ${deviceLabel(device).replace(/^This/, 'this')}: they install, build, browse and click there, never on yours.`}>
                  <button className="btn" onClick={() => setCreating(true)}>
                    <Monitor size={14} strokeWidth={1.9} />
                    Make a VM
                  </button>
                </Row>
              </Card>
            </Section>
          )}

          <div className="vm-list">
            {device?.vms.map((vm) => (
              <VmCard
                key={vm.id}
                vm={vm}
                busy={busy === vm.id}
                onOpen={() => setOpenId(vm.id)}
                onStart={() => void act(vm, () => window.api.vms.start(vm.device, vm.id))}
                onStop={(force) => void act(vm, () => window.api.vms.stop(vm.device, vm.id, force))}
                onAgents={(on) => void act(vm, () => window.api.vms.update(vm.device, vm.id, { agents: on }))}
                onSettings={() => setSettings(vm)}
                onSnapshots={() => setSnapshots(vm)}
                onCancel={() => void act(vm, () => window.api.vms.cancel(vm.device, vm.id))}
                onDelete={() => setDeleting(vm)}
              />
            ))}
          </div>
        </div>
      </div>

      {device?.info && (
        <NewVmDialog
          open={creating}
          device={device.device}
          deviceName={deviceLabel(device).replace(/^This/, 'this')}
          info={device.info}
          onClose={() => setCreating(false)}
          onCreated={() => setCreating(false)}
        />
      )}
      <ConfirmDialog
        open={Boolean(deleting)}
        title={`Delete ${deleting?.name ?? 'this VM'}?`}
        confirmLabel="Delete"
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          const vm = deleting
          setDeleting(null)
          if (vm) void act(vm, () => window.api.vms.remove(vm.device, vm.id))
        }}
      >
        Its disk, its snapshots and everything in it go. This can’t be undone.
      </ConfirmDialog>
      {settings && device?.info && <VmSettingsDialog vm={settings} info={device.info} onClose={() => setSettings(null)} onError={setError} />}
      {snapshots && <SnapshotsDialog vm={device?.vms.find((v) => v.id === snapshots.id) ?? snapshots} onClose={() => setSnapshots(null)} />}
    </div>
  )
}

function VmSettingsDialog({ vm, info, onClose, onError }: { vm: VmStatus; info: NonNullable<VmDeviceState['info']>; onClose: () => void; onError: (message: string) => void }): JSX.Element {
  const limits = useMemo(() => vmLimits(info, vm.os, vm.desktop), [info, vm.os, vm.desktop])
  const [name, setName] = useState(vm.name)
  const [cpus, setCpus] = useState(vm.cpus)
  const [memoryGB, setMemoryGB] = useState(Math.round(vm.memoryMB / 1024))
  const [keepRunning, setKeepRunning] = useState(vm.keepRunning)
  const off = vm.phase === 'stopped' || vm.phase === 'error'
  const save = async (): Promise<void> => {
    try {
      const sizeChanged = cpus !== vm.cpus || memoryGB * 1024 !== vm.memoryMB
      await window.api.vms.update(vm.device, vm.id, { name, keepRunning, ...(sizeChanged ? { cpus, memoryMB: memoryGB * 1024 } : {}) })
      onClose()
    } catch (e) {
      onError(cleanVmError(e))
      onClose()
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={`${vm.name} settings`}
      width={480}
      actions={
        <>
          <button className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" disabled={!name.trim()} onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <div className="vm-new">
        <div className="vm-new__label">Name</div>
        <input className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} aria-label="Name" />
        <div className="vm-new__label">Size</div>
        {!off && <p className="vm-new__hint">Turn it off to change its size.</p>}
        <div className="vm-sizes" data-disabled={!off || undefined}>
          <div className="vm-size">
            <span className="vm-size__name">Processors</span>
            <Slider label="Processors" value={cpus} min={limits.cpus.min} max={limits.cpus.max} onChange={(v) => off && setCpus(v)} />
          </div>
          <div className="vm-size">
            <span className="vm-size__name">Memory (GB)</span>
            <Slider label="Memory in GB" value={memoryGB} min={Math.ceil(limits.memoryMB.min / 1024)} max={Math.floor(limits.memoryMB.max / 1024)} onChange={(v) => off && setMemoryGB(v)} />
          </div>
        </div>
        {vm.device === 'host' && (
          <label className="vm-new__agents">
            <span>
              <span className="vm-new__agents-title">Keep it running</span>
              <span className="vm-new__hint">Starts again when the worker computer restarts.</span>
            </span>
            <Switch checked={keepRunning} onChange={setKeepRunning} label="Keep it running" />
          </label>
        )}
      </div>
    </Modal>
  )
}

function SnapshotsDialog({ vm, onClose }: { vm: VmStatus; onClose: () => void }): JSX.Element {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const off = vm.phase === 'stopped' || vm.phase === 'error'
  const run = async (action: () => Promise<unknown>, done?: string): Promise<void> => {
    setWorking(true)
    setError(null)
    try {
      await action()
      if (done) notify(done)
    } catch (e) {
      setError(cleanVmError(e))
    } finally {
      setWorking(false)
    }
  }
  return (
    <Modal open onClose={onClose} title={`${vm.name} snapshots`} width={480} actions={<button className="btn btn--primary" onClick={onClose}>Done</button>}>
      <div className="vm-new">
        <p className="vm-new__hint">A snapshot keeps the VM exactly as it is, to come back to after an agent’s experiment goes wrong. {off ? '' : 'Turn the VM off to take or use one.'}</p>
        <div className="vm-new__file">
          <input className="input" value={name} placeholder="Name, e.g. Clean install" onChange={(e) => setName(e.target.value)} disabled={!off} />
          <button
            className="btn"
            disabled={!off || working}
            onClick={() =>
              void run(async () => {
                await window.api.vms.snapshot(vm.device, vm.id, name)
                setName('')
              }, 'Snapshot taken.')
            }
          >
            Take snapshot
          </button>
        </div>
        {vm.snapshots.length === 0 ? (
          <p className="vm-new__hint">None yet.</p>
        ) : (
          <div className="vm-snapshots">
            {[...vm.snapshots].reverse().map((snapshot) => (
              <div key={snapshot.id} className="vm-snapshot">
                <span className="vm-snapshot__name">{snapshot.name}</span>
                <span className="vm-snapshot__at">{new Date(snapshot.at).toLocaleString()}</span>
                <button className="btn btn--sm" disabled={!off || working} onClick={() => void run(() => window.api.vms.restore(vm.device, vm.id, snapshot.id), `Back to “${snapshot.name}”.`)}>
                  Go back to it
                </button>
                <button className="icon-btn" aria-label={`Delete ${snapshot.name}`} disabled={!off || working} onClick={() => void run(() => window.api.vms.deleteSnapshot(vm.device, vm.id, snapshot.id))}>
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        {error && (
          <p className="vm-new__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}
