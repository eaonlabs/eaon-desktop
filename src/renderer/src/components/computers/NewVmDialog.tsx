import { useEffect, useMemo, useState } from 'react'
import { Laptop, Monitor, SquareTerminal } from 'lucide-react'
import { imagesFor, linuxImage, vmLimits, type VmDevice, type VmDeviceInfo, type VmOs } from '@shared/vms'
import { Modal, Segmented, Slider, Switch } from '../ui'
import { cleanVmError } from './useVmDevices'

/**
 * Making a VM: which OS (only what this device can run is offered, and the
 * rest say why not), which version, desktop or terminal, how big (sized for
 * this device to start with), and whether agents may use it.
 */

const OSES: { os: VmOs; name: string; blurb: string; icon: JSX.Element }[] = [
  { os: 'linux', name: 'Linux', blurb: 'Ubuntu or Debian', icon: <SquareTerminal size={20} strokeWidth={1.7} /> },
  { os: 'macos', name: 'macOS', blurb: 'On a Mac with Apple silicon', icon: <Laptop size={20} strokeWidth={1.7} /> },
  { os: 'windows', name: 'Windows', blurb: 'Coming later', icon: <Monitor size={20} strokeWidth={1.7} /> }
]

export function NewVmDialog({
  open,
  device,
  deviceName,
  info,
  onClose,
  onCreated
}: {
  open: boolean
  device: VmDevice
  deviceName: string
  info: VmDeviceInfo
  onClose: () => void
  onCreated: () => void
}): JSX.Element | null {
  const firstAvailable = OSES.find((o) => info.os[o.os].available)?.os ?? 'linux'
  const [os, setOs] = useState<VmOs>(firstAvailable)
  const [image, setImage] = useState<string>('')
  const [desktop, setDesktop] = useState(true)
  const [name, setName] = useState('')
  const [cpus, setCpus] = useState(2)
  const [memoryGB, setMemoryGB] = useState(4)
  const [diskGB, setDiskGB] = useState(32)
  const [agents, setAgents] = useState(true)
  const [ipsw, setIpsw] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const images = imagesFor(os)
  const limits = useMemo(() => vmLimits(info, os, os === 'macos' || desktop), [info, os, desktop])

  // A fresh start each time it opens.
  useEffect(() => {
    if (!open) return
    setOs(firstAvailable)
    setError(null)
    setCreating(false)
    setIpsw('')
    setAgents(true)
    setDesktop(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    const pick = imagesFor(os).find((i) => i.recommended) ?? imagesFor(os)[0]
    setImage(pick?.id ?? '')
  }, [os])

  useEffect(() => {
    setCpus(limits.cpus.value)
    setMemoryGB(Math.round(limits.memoryMB.value / 1024))
    setDiskGB(limits.diskGB.value)
  }, [limits])

  useEffect(() => {
    const chosen = os === 'linux' ? linuxImage(image) : null
    setName(chosen ? chosen.name.split(' ')[0] : os === 'macos' ? 'macOS' : '')
  }, [os, image])

  const support = info.os[os]
  const needsFile = os === 'macos' && image === 'macos-file'
  const canCreate = support.available && Boolean(image) && name.trim().length > 0 && (!needsFile || ipsw.trim().length > 0) && !creating

  const create = async (): Promise<void> => {
    setCreating(true)
    setError(null)
    try {
      await window.api.vms.create(device, {
        name: name.trim(),
        os,
        image,
        desktop: os === 'macos' ? true : desktop,
        cpus,
        memoryMB: memoryGB * 1024,
        diskGB,
        agents,
        ipsw: needsFile ? ipsw.trim() : undefined
      })
      onCreated()
    } catch (e) {
      setError(cleanVmError(e))
      setCreating(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`New VM on ${deviceName}`}
      width={560}
      actions={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" disabled={!canCreate} onClick={() => void create()}>
            {creating ? 'Starting…' : 'Make VM'}
          </button>
        </>
      }
    >
      <div className="vm-new">
        <div className="vm-new__label">System</div>
        <div className="vm-os" role="radiogroup" aria-label="System">
          {OSES.map((option) => {
            const available = info.os[option.os].available
            return (
              <button
                key={option.os}
                type="button"
                role="radio"
                aria-checked={os === option.os}
                className="vm-os__tile"
                data-selected={os === option.os || undefined}
                disabled={!available}
                title={available ? undefined : info.os[option.os].reason}
                onClick={() => setOs(option.os)}
              >
                <span className="vm-os__icon">{option.icon}</span>
                <span className="vm-os__name">{option.name}</span>
                <span className="vm-os__blurb">{option.blurb}</span>
              </button>
            )
          })}
        </div>
        {(() => {
          const unavailable = OSES.filter((o) => !info.os[o.os].available && o.os !== 'windows')
          return unavailable.length > 0 ? <p className="vm-new__note">{unavailable.map((o) => info.os[o.os].reason).join(' ')}</p> : null
        })()}
        {support.available && support.reason && <p className="vm-new__note vm-new__note--warn">{support.reason}</p>}

        {support.available && (
          <>
            <div className="vm-new__label">Version</div>
            <div className="vm-versions" role="radiogroup" aria-label="Version">
              {images.map((option) => (
                <label key={option.id} className="vm-version" data-selected={image === option.id || undefined}>
                  <input type="radio" name="vm-version" checked={image === option.id} onChange={() => setImage(option.id)} />
                  <span className="vm-version__body">
                    <span className="vm-version__name">{option.name}</span>
                    <span className="vm-version__detail">{option.detail}</span>
                  </span>
                </label>
              ))}
            </div>
            {needsFile && (
              <div className="vm-new__file">
                <input className="input" value={ipsw} placeholder={device === 'local' ? 'Choose a .ipsw file' : 'The .ipsw file’s path on the worker computer'} onChange={(e) => setIpsw(e.target.value)} />
                {device === 'local' && (
                  <button type="button" className="btn" onClick={() => void window.api.vms.pickIpsw().then((path) => path && setIpsw(path))}>
                    Choose…
                  </button>
                )}
              </div>
            )}

            {os === 'linux' && (
              <>
                <div className="vm-new__label">Screen</div>
                <Segmented
                  value={desktop ? 'desktop' : 'terminal'}
                  options={[
                    { value: 'desktop', label: 'Desktop and browser' },
                    { value: 'terminal', label: 'Terminal only' }
                  ]}
                  onChange={(value) => setDesktop(value === 'desktop')}
                />
                <p className="vm-new__hint">
                  {desktop ? 'Xfce with a web browser, for agents that need to see and click. Takes a few minutes more to set up.' : 'Lighter and faster to start. Agents work in it with commands.'}
                </p>
              </>
            )}

            <div className="vm-new__label">Name</div>
            <input className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} aria-label="Name" />

            <div className="vm-new__label">Size</div>
            <div className="vm-sizes">
              <div className="vm-size">
                <span className="vm-size__name">Processors</span>
                <Slider label="Processors" value={cpus} min={limits.cpus.min} max={limits.cpus.max} onChange={setCpus} />
              </div>
              <div className="vm-size">
                <span className="vm-size__name">Memory (GB)</span>
                <Slider label="Memory in GB" value={memoryGB} min={Math.ceil(limits.memoryMB.min / 1024)} max={Math.max(Math.ceil(limits.memoryMB.min / 1024), Math.floor(limits.memoryMB.max / 1024))} onChange={setMemoryGB} />
              </div>
              <div className="vm-size">
                <span className="vm-size__name">Disk (GB)</span>
                <Slider label="Disk in GB" value={diskGB} min={limits.diskGB.min} max={limits.diskGB.max} onChange={setDiskGB} />
              </div>
            </div>
            <p className="vm-new__hint">
              {info.cpus} processors and {Math.round(info.memoryMB / 1024)} GB on {deviceName}
              {info.diskFreeMB !== null ? `, ${Math.round(info.diskFreeMB / 1024)} GB free` : ''}. The disk only takes the space the VM uses.
            </p>

            <label className="vm-new__agents">
              <span>
                <span className="vm-new__agents-title">Agents can use it</span>
                <span className="vm-new__hint">Agents in Chat and Workers can run commands in it and see and use its screen.</span>
              </span>
              <Switch checked={agents} onChange={setAgents} label="Agents can use it" />
            </label>
          </>
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
