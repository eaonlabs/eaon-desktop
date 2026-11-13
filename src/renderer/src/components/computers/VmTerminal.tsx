import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Loader2, RotateCw } from 'lucide-react'
import type { VmStatus } from '@shared/vms'
import { appTheme } from '../code/terminal/registry'
import { cleanVmError } from './useVmDevices'

/**
 * A terminal in a Linux VM: this computer's own `ssh`, signed in as the VM's
 * account with the key Eaon made for it, through Eaon's tunnel to the VM
 * (relayed over the link when the worker computer runs it). It opens once the
 * VM is up; when the connection ends it says so and offers to connect again.
 */
export function VmTerminal({ vm, shown, onCommand }: { vm: VmStatus; shown: boolean; onCommand: (command: string | null) => void }): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const fit = useRef<FitAddon | null>(null)
  const [state, setState] = useState<'connecting' | 'open' | 'ended'>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  // Its SSH answers from early in the first boot; before the VM is running there's nothing to reach.
  const up = vm.phase === 'running' || vm.phase === 'setting-up'

  useEffect(() => {
    if (!up || !host.current) return
    const term = new Terminal({
      fontFamily: "ui-monospace, 'SF Mono', Menlo, Monaco, Consolas, monospace",
      fontSize: 12.5,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 10_000,
      macOptionIsMeta: true,
      minimumContrastRatio: 1,
      theme: appTheme()
    })
    const fitter = new FitAddon()
    term.loadAddon(fitter)
    term.open(host.current)
    fit.current = fitter
    try {
      fitter.fit()
    } catch {
      /* not laid out yet: the observer below fits it */
    }
    let session: string | null = null
    let cancelled = false
    setState('connecting')
    setError(null)
    const offData = window.api.vms.onTerminalData((id, data) => {
      if (id === session) term.write(data)
    })
    const offExit = window.api.vms.onTerminalExit((id) => {
      if (id !== session) return
      session = null
      setState('ended')
    })
    const input = term.onData((data) => {
      if (session) window.api.vms.writeTerminal(session, data)
    })
    const size = term.onResize(({ cols, rows }) => {
      if (session) window.api.vms.resizeTerminal(session, cols, rows)
    })
    const observer = new ResizeObserver(() => {
      if (host.current?.offsetParent === null) return
      try {
        fitter.fit()
      } catch {
        /* hidden */
      }
    })
    observer.observe(host.current)
    void window.api.vms
      .openTerminal(vm.device, vm.id, term.cols, term.rows)
      .then((opened) => {
        if (cancelled) return void window.api.vms.closeTerminal(opened.session)
        session = opened.session
        onCommand(opened.command)
        setState('open')
        term.focus()
      })
      .catch((e) => {
        if (cancelled) return
        setError(cleanVmError(e))
        setState('ended')
      })
    return () => {
      cancelled = true
      observer.disconnect()
      offData()
      offExit()
      input.dispose()
      size.dispose()
      if (session) void window.api.vms.closeTerminal(session)
      fit.current = null
      term.dispose()
    }
    // onCommand is the page's setter: the same function every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vm.device, vm.id, up, attempt])

  // Shown again after the screen was: it was laid out at no size while hidden.
  useEffect(() => {
    if (!shown) return
    const frame = requestAnimationFrame(() => {
      try {
        fit.current?.fit()
      } catch {
        /* not laid out */
      }
      host.current?.querySelector('textarea')?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [shown])

  return (
    <div className="vm-term" hidden={!shown}>
      <div ref={host} className="vm-term__host" data-state={state} />
      {(!up || state !== 'open') && (
        <div className="vm-screen__overlay vm-term__overlay" data-dim={state === 'ended' || undefined}>
          {!up ? (
            <p>{vm.name} is off.</p>
          ) : state === 'connecting' ? (
            <p>
              <Loader2 size={16} className="spinner" /> Connecting to {vm.name}…
            </p>
          ) : (
            <div className="vm-term__ended">
              <p className={error ? 'vm-screen__error' : undefined}>{error ?? 'The terminal’s connection ended.'}</p>
              <button className="btn btn--sm" onClick={() => setAttempt((n) => n + 1)}>
                <RotateCw size={13} strokeWidth={2} />
                Connect again
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
