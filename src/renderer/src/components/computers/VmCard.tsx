import { useRef, useState } from 'react'
import { Camera, Laptop, Loader2, Monitor, MoreHorizontal, Play, Power, Settings2, SquareTerminal, Trash2 } from 'lucide-react'
import { vmPhaseLabel, type VmStatus } from '@shared/vms'
import { MenuItem, MenuSeparator, Popover, Switch } from '../ui'

/**
 * One VM in the list: what it is, how it is (with a bar while it's being
 * made), the one thing to do next (open its screen, start it), and the rest
 * in a menu.
 */

const tone = (vm: VmStatus): 'ok' | 'wait' | 'off' | 'error' =>
  vm.phase === 'running' ? 'ok' : vm.phase === 'stopped' ? 'off' : vm.phase === 'error' ? 'error' : 'wait'

export const vmIcon = (vm: Pick<VmStatus, 'os' | 'desktop'>, size = 18): JSX.Element =>
  vm.os === 'macos' ? <Laptop size={size} strokeWidth={1.8} /> : vm.desktop ? <Monitor size={size} strokeWidth={1.8} /> : <SquareTerminal size={size} strokeWidth={1.8} />

export function vmSummary(vm: VmStatus): string {
  const kind = vm.os === 'linux' ? (vm.desktop ? 'Desktop' : 'Terminal only') : null
  return [vm.version, kind, `${vm.cpus} CPU`, `${Math.round(vm.memoryMB / 1024)} GB memory`, `${vm.diskGB} GB disk`].filter(Boolean).join(' · ')
}

export function VmCard({
  vm,
  busy,
  onOpen,
  onStart,
  onStop,
  onAgents,
  onSettings,
  onSnapshots,
  onCancel,
  onDelete
}: {
  vm: VmStatus
  busy: boolean
  onOpen: () => void
  onStart: () => void
  onStop: (force: boolean) => void
  onAgents: (on: boolean) => void
  onSettings: () => void
  onSnapshots: () => void
  onCancel: () => void
  onDelete: () => void
}): JSX.Element {
  const [menu, setMenu] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const choose = (run: () => void) => () => {
    setMenu(false)
    run()
  }
  const making = vm.phase === 'preparing' || vm.phase === 'installing'
  const on = vm.phase === 'running' || vm.phase === 'setting-up' || vm.phase === 'starting'
  const fraction = vm.progress?.fraction ?? null
  return (
    <div className="vm-card card" data-phase={vm.phase}>
      <div className="vm-card__head">
        <div className="vm-card__icon" aria-hidden="true">
          {vmIcon(vm)}
        </div>
        <div className="vm-card__body">
          <div className="vm-card__name">{vm.name}</div>
          <div className="vm-card__meta">{vmSummary(vm)}</div>
        </div>
        <div className="vm-card__actions">
          {making ? (
            <button className="btn btn--sm btn--ghost" onClick={onCancel}>
              Cancel
            </button>
          ) : on ? (
            <button className="btn btn--sm btn--primary" disabled={!vm.screen} onClick={onOpen}>
              Open
            </button>
          ) : vm.phase !== 'stopping' ? (
            <button className="btn btn--sm" disabled={busy} onClick={onStart}>
              {busy ? <Loader2 size={13} className="spinner" /> : <Play size={13} strokeWidth={2} />}
              Start
            </button>
          ) : null}
          <button ref={anchor} className="icon-btn" aria-label={`More for ${vm.name}`} aria-expanded={menu} onClick={() => setMenu(!menu)}>
            <MoreHorizontal size={16} strokeWidth={1.9} />
          </button>
          <Popover anchor={anchor} open={menu} onClose={() => setMenu(false)} placement="bottom-end" width={200}>
            {on && <MenuItem icon={<Power size={15} strokeWidth={1.8} />} title="Shut down" onClick={choose(() => onStop(false))} />}
            {(on || vm.phase === 'stopping') && <MenuItem icon={<Power size={15} strokeWidth={1.8} />} title="Turn off now" onClick={choose(() => onStop(true))} />}
            {!making && <MenuItem icon={<Camera size={15} strokeWidth={1.8} />} title="Snapshots…" onClick={choose(onSnapshots)} />}
            {!making && <MenuItem icon={<Settings2 size={15} strokeWidth={1.8} />} title="Settings…" onClick={choose(onSettings)} />}
            <MenuSeparator />
            <MenuItem icon={<Trash2 size={15} strokeWidth={1.8} />} title="Delete…" onClick={choose(onDelete)} />
          </Popover>
        </div>
      </div>

      <div className="vm-card__status">
        <span className="vm-status" data-tone={tone(vm)}>
          <span className="vm-status__dot" aria-hidden="true" />
          {vmPhaseLabel(vm)}
        </span>
        {vm.agentActive && <span className="vm-card__agent">An agent is using it</span>}
        <span className="vm-card__spacer" />
        {!making && (
          <label className="vm-card__agents">
            Agents can use it
            <Switch checked={vm.agents} onChange={onAgents} label={`Agents can use ${vm.name}`} />
          </label>
        )}
      </div>
      {(making || vm.phase === 'setting-up') && (
        <div className="vm-progress" role="progressbar" aria-label={vm.progress?.step ?? 'Working'} aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}>
          <span style={fraction === null ? undefined : { width: `${Math.max(2, fraction * 100)}%` }} data-indeterminate={fraction === null || undefined} />
        </div>
      )}
    </div>
  )
}
