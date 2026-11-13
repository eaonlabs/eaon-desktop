import { useEffect, useRef, useState } from 'react'
import RFB from '@novnc/novnc'
import { ArrowLeft, Copy, Eye, EyeOff, KeyRound, Loader2, Play, Power } from 'lucide-react'
import { vmPhaseLabel, type VmLogin, type VmStatus } from '@shared/vms'
import { cleanVmError } from './useVmDevices'
import { vmIcon } from './VmCard'
import { VmTerminal } from './VmTerminal'
import { Segmented } from '../ui'
import { notify } from '../Notice'
import { CLIPBOARD_FAILED, copyText } from '../../lib/clipboard'

/**
 * A VM's screen, live, to watch and use: noVNC draws it, over Eaon's own
 * channel to the main process rather than a WebSocket (the main process
 * carries the bytes from the VM here, or over the link from the worker
 * computer). The viewer takes the keyboard while it's focused. A Linux VM
 * also has a terminal (VmTerminal.tsx): the one a terminal-only VM opens on.
 */

/** A WebSocket-shaped channel over IPC: what noVNC calls a raw channel. */
class ScreenChannel {
  binaryType = 'arraybuffer'
  protocol = ''
  readyState: 'connecting' | 'open' | 'closing' | 'closed' = 'connecting'
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null

  constructor(private readonly session: string) {}

  send(data: ArrayBuffer | Uint8Array): void {
    if (this.readyState === 'open') window.api.vms.sendScreen(this.session, data instanceof Uint8Array ? data : new Uint8Array(data))
  }

  close(): void {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    void window.api.vms.closeScreen(this.session)
    this.onclose?.({ code: 1000, reason: '', wasClean: true })
  }

  receive(data: Uint8Array): void {
    this.onmessage?.({ data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer })
  }

  ended(): void {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'
    this.onclose?.({ code: 1000, reason: '', wasClean: true })
  }

  opened(): void {
    this.readyState = 'open'
    this.onopen?.(new Event('open'))
  }
}

export function VmScreen({ vm, onBack, onStart, onStop }: { vm: VmStatus; onBack: () => void; onStart: () => void; onStop: () => void }): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const rfb = useRef<RFB | null>(null)
  const [state, setState] = useState<'connecting' | 'connected' | 'closed'>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [login, setLogin] = useState<VmLogin | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [view, setView] = useState<'screen' | 'terminal'>(vm.os === 'linux' && !vm.desktop ? 'terminal' : 'screen')
  const [command, setCommand] = useState<string | null>(null)

  useEffect(() => {
    if (!vm.screen || !host.current) {
      setState('closed')
      return
    }
    let channel: ScreenChannel | null = null
    let session: string | null = null
    let cancelled = false
    let removeAltSwap: (() => void) | null = null
    setState('connecting')
    setError(null)
    const offData = window.api.vms.onScreenData((id, data) => {
      if (id === session) channel?.receive(data)
    })
    const offClosed = window.api.vms.onScreenClosed((id) => {
      if (id === session) channel?.ended()
    })
    void window.api.vms
      .openScreen(vm.device, vm.id)
      .then((opened) => {
        if (cancelled || !host.current) {
          void window.api.vms.closeScreen(opened.session)
          return
        }
        session = opened.session
        channel = new ScreenChannel(opened.session)
        const view = new RFB(host.current, channel as unknown as WebSocket, { credentials: { password: opened.password ?? '' }, shared: true })
        view.scaleViewport = true
        view.resizeSession = false
        view.focusOnClick = true
        view.background = 'transparent'
        view.addEventListener('connect', () => setState('connected'))
        view.addEventListener('disconnect', () => setState('closed'))
        view.addEventListener('securityfailure', () => setError('The VM’s screen didn’t accept Eaon’s login. Restart the VM.'))
        rfb.current = view
        // Apple's VNC server (a Mac's VMs) reads Meta as Alt and ignores Alt itself: send Alt as Meta.
        if (vm.backend === 'vz' && host.current) {
          const element = host.current
          const swap = (event: KeyboardEvent): void => {
            if (event.key !== 'Alt' || !rfb.current) return
            event.preventDefault()
            event.stopImmediatePropagation()
            rfb.current.sendKey(event.code === 'AltRight' ? 0xffe8 : 0xffe7, event.code, event.type === 'keydown')
          }
          element.addEventListener('keydown', swap, true)
          element.addEventListener('keyup', swap, true)
          removeAltSwap = () => {
            element.removeEventListener('keydown', swap, true)
            element.removeEventListener('keyup', swap, true)
          }
        }
        // noVNC has its handlers on the channel now; it can open.
        queueMicrotask(() => channel?.opened())
      })
      .catch((e) => {
        if (!cancelled) {
          setError(cleanVmError(e))
          setState('closed')
        }
      })
    return () => {
      cancelled = true
      removeAltSwap?.()
      offData()
      offClosed()
      try {
        rfb.current?.disconnect()
      } catch {
        /* already gone */
      }
      rfb.current = null
      channel?.close()
    }
  }, [vm.device, vm.id, vm.screen, vm.backend, attempt])

  // When the VM comes back (a restart), reconnect.
  useEffect(() => {
    if (vm.screen && state === 'closed' && !error) {
      const timer = setTimeout(() => setAttempt((n) => n + 1), 1500)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [vm.screen, state, error])

  const toggleLogin = async (): Promise<void> => {
    if (login) return setLogin(null)
    try {
      setLogin(await window.api.vms.login(vm.device, vm.id))
    } catch (e) {
      setError(cleanVmError(e))
    }
  }

  const on = vm.phase === 'running' || vm.phase === 'setting-up' || vm.phase === 'starting'
  return (
    <div className="vm-screen">
      <div className="vm-screen__bar">
        <button className="btn btn--ghost btn--sm" onClick={onBack}>
          <ArrowLeft size={14} strokeWidth={2} />
          Computers
        </button>
        <div className="vm-screen__title">
          {vmIcon(vm, 15)}
          <span className="vm-screen__name">{vm.name}</span>
          <span className="vm-screen__phase">{vmPhaseLabel(vm)}</span>
        </div>
        {vm.os === 'linux' && (
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { value: 'screen', label: 'Screen' },
              { value: 'terminal', label: 'Terminal' }
            ]}
          />
        )}
        <div className="vm-screen__tools">
          {view === 'terminal' && command && (
            <button
              className="btn btn--ghost btn--sm"
              title="The same connection from your own terminal app, while Eaon is open"
              onClick={() => void copyText(command).then((ok) => notify(ok ? 'SSH command copied. It works while Eaon is open.' : CLIPBOARD_FAILED, ok ? 'done' : 'error'))}
            >
              <Copy size={14} strokeWidth={1.9} />
              Copy SSH command
            </button>
          )}
          {vm.os === 'linux' && (
            <button className="btn btn--ghost btn--sm" onClick={() => void toggleLogin()} aria-expanded={Boolean(login)}>
              <KeyRound size={14} strokeWidth={1.9} />
              Login
            </button>
          )}
          {state === 'connected' && view === 'screen' && (
            <button className="btn btn--ghost btn--sm" onClick={() => rfb.current?.sendCtrlAltDel()}>
              Ctrl+Alt+Del
            </button>
          )}
          {on ? (
            <button className="btn btn--sm" onClick={onStop}>
              <Power size={14} strokeWidth={1.9} />
              Shut down
            </button>
          ) : vm.phase === 'stopped' || vm.phase === 'error' ? (
            <button className="btn btn--sm btn--primary" onClick={onStart}>
              <Play size={14} strokeWidth={2} />
              Start
            </button>
          ) : null}
        </div>
      </div>

      {login && (
        <div className="vm-screen__login">
          <span>
            User <code>{login.user}</code>
          </span>
          <span>
            Password <code>{showPassword ? login.password : '•'.repeat(10)}</code>
          </span>
          <button className="icon-btn" aria-label={showPassword ? 'Hide the password' : 'Show the password'} onClick={() => setShowPassword(!showPassword)}>
            {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
          <button className="btn btn--ghost btn--sm" onClick={() => void navigator.clipboard.writeText(login.password)}>
            Copy password
          </button>
        </div>
      )}
      {vm.agentActive && <div className="vm-screen__agent">An agent is using this VM. You can watch, or take over by clicking in it.</div>}
      {vm.os === 'macos' && vm.phase === 'running' && <div className="vm-screen__hint">The first time it starts, finish setting up macOS here: pick a language, make an account, and you’re in.</div>}

      <div className="vm-screen__stage">
        <div ref={host} className="vm-screen__canvas" data-state={state} hidden={view !== 'screen'} />
        {vm.os === 'linux' && <VmTerminal vm={vm} shown={view === 'terminal'} onCommand={setCommand} />}
        {state !== 'connected' && view === 'screen' && (
          <div className="vm-screen__overlay">
            {error ? (
              <p className="vm-screen__error">{error}</p>
            ) : vm.screen ? (
              <p>
                <Loader2 size={16} className="spinner" /> Connecting to the screen…
              </p>
            ) : on ? (
              <p>
                <Loader2 size={16} className="spinner" /> {vmPhaseLabel(vm)}…
              </p>
            ) : (
              <p>{vm.name} is off.</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
