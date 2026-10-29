import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { Eye, PanelRight } from 'lucide-react'
import type { GuestTerminalView } from '@shared/rc'
import { useApp } from '../../state/store'
import { findTheme } from '../code/terminal/themes'
import { xtermTheme } from '../code/terminal/registry'
import { useGuestWatch } from './guestWatchStore'
import './guestWatch.css'

/**
 * A friend's terminal beside your own work, live: the locked terminal you
 * shared with them, or one they opened in one of your sessions. It opens on
 * its own when they start one (guestWatchStore.ts). Watching only: nothing
 * typed here reaches it, and its size is theirs, so it's drawn at their
 * terminal's size and scaled down to fit.
 */
export function GuestWatchPanel(): JSX.Element | null {
  const views = useGuestWatch((s) => s.views)
  const open = useGuestWatch((s) => s.open)
  const active = useGuestWatch((s) => s.active)
  const labels = useAgentLabels()
  const [stopping, setStopping] = useState(false)
  const current = views.find((v) => v.paneId === active) ?? views[0]
  if (!open || !current) return null

  const stop = (): void => {
    setStopping(true)
    void window.api.rc.guestStop(current.paneId).finally(() => setStopping(false))
  }

  return (
    <aside className="browser guest-watch" aria-label="A friend’s terminal">
      <div className="browser__tabs">
        <span className="agent-browser__title">
          <Eye size={14} strokeWidth={1.9} />
          Shared
        </span>
        {views.length > 1 && (
          <div className="guest-watch__tabs" role="tablist">
            {views.map((v) => (
              <button
                key={v.paneId}
                type="button"
                role="tab"
                className="browser__tab"
                data-active={v.paneId === current.paneId}
                aria-selected={v.paneId === current.paneId}
                onClick={() => useGuestWatch.getState().show(v.paneId)}
              >
                <span className="browser__tab-select">
                  <span className="guest-watch__dot" data-live={v.running || undefined} aria-hidden />
                  <span className="browser__tab-label">@{v.login}</span>
                </span>
              </button>
            ))}
          </div>
        )}
        <div style={{ flex: 1 }} />
        <button type="button" className="icon-btn" data-active onClick={() => useGuestWatch.getState().hide()} aria-label="Close" title="Close">
          <PanelRight size={16} strokeWidth={1.9} />
        </button>
      </div>
      <div className="guest-watch__who">
        <div className="guest-watch__names">
          <span className="guest-watch__login">@{current.login}</span>
          <span className="guest-watch__where">
            {current.agent ? (labels[current.agent] ?? current.agent) : 'Shell'} in {current.label}
          </span>
        </div>
        {current.running ? (
          <span className="agent-browser__live">
            <span className="agent-browser__live-dot" />
            Live
          </span>
        ) : (
          <span className="guest-watch__ended">Ended</span>
        )}
      </div>
      <GuestScreen key={current.paneId} view={current} />
      <div className="guest-watch__foot">
        <span>You’re watching. Nothing you type reaches their terminal.</span>
        <button type="button" className="btn btn--sm" disabled={!current.running || stopping} onClick={stop} title="Ends their terminal now. The share stays, so they can start it again.">
          Stop their terminal
        </button>
      </div>
    </aside>
  )
}

/** The pill that brings the panel back while a friend's terminal runs. */
export function GuestWatchPill(): JSX.Element | null {
  const views = useGuestWatch((s) => s.views)
  const open = useGuestWatch((s) => s.open)
  const view = useApp((s) => s.view)
  const live = views.filter((v) => v.running)
  // In Settings the panel isn't there to open beside anything: the pill still says who's in.
  if ((open && view !== 'settings') || live.length === 0) return null
  const first = live[0]
  const watch = (): void => {
    if (useApp.getState().view === 'settings') useApp.getState().setView('chat')
    useGuestWatch.getState().show(first.paneId)
  }
  return (
    <div className="guest-watch-pill" role="status" aria-live="polite">
      <span className="guest-watch-pill__icon" aria-hidden="true">
        <Eye size={14} strokeWidth={1.9} />
      </span>
      <div className="guest-watch-pill__title">{live.length === 1 ? `@${first.login} is in ${first.label}` : `${live.length} friends are in your shared terminals`}</div>
      <button type="button" className="btn btn--sm" onClick={watch}>
        Watch
      </button>
    </div>
  )
}

/** The CLIs' names, for "Claude Code in my-app". */
function useAgentLabels(): Record<string, string> {
  const [labels, setLabels] = useState<Record<string, string>>({})
  useEffect(() => {
    void window.api.terminals
      .agents()
      .then((agents) => setLabels(Object.fromEntries(agents.map((a) => [a.id, a.label]))))
      .catch(() => undefined)
  }, [])
  return labels
}

/**
 * The terminal itself: what it showed when the panel opened, then its output
 * as it comes. Output that arrives before the snapshot is already in it (both
 * come down the same channel, in order), so it's dropped rather than drawn twice.
 */
function GuestScreen({ view }: { view: GuestTerminalView }): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const themeId = useApp((s) => s.settings?.ade?.theme ?? 'eaon')
  const appearance = useApp((s) => s.settings?.appearance)
  const { paneId } = view

  useEffect(() => {
    const el = host.current
    if (!el) return
    const stage = document.createElement('div')
    stage.className = 'guest-watch__stage'
    el.appendChild(stage)
    const t = new Terminal({
      cols: 120,
      rows: 32,
      disableStdin: true,
      cursorBlink: false,
      fontFamily: "ui-monospace, 'SF Mono', Menlo, Monaco, Consolas, monospace",
      fontSize: 12.5,
      lineHeight: 1.15,
      scrollback: 5000,
      minimumContrastRatio: 1,
      theme: xtermTheme({ theme: findTheme(useApp.getState().settings?.ade?.theme ?? 'eaon'), scenes: false })
    })
    term.current = t
    t.open(stage)

    // Their terminal at its own size, scaled to the panel's width.
    const fit = (): void => {
      const screen = stage.querySelector<HTMLElement>('.xterm-screen')
      if (!screen?.offsetWidth) return
      const scale = Math.min(1, el.clientWidth / screen.offsetWidth)
      stage.style.width = `${screen.offsetWidth}px`
      stage.style.transform = `scale(${scale})`
      el.style.height = `${Math.ceil(screen.offsetHeight * scale)}px`
    }
    const observer = new ResizeObserver(fit)
    observer.observe(el)

    let ready = false
    let gone = false
    const offData = window.api.terminals.onData((e) => {
      if (ready && e.paneId === paneId) t.write(e.data)
    })
    const offExit = window.api.terminals.onExit((e) => {
      if (ready && e.paneId === paneId) t.write('\r\n\x1b[2m[their terminal ended]\x1b[0m\r\n')
    })
    void window.api.rc
      .guestSnapshot(paneId)
      .then((snap) => {
        if (gone) return
        if (!snap) return t.write('\x1b[2mThis terminal isn’t shared any more.\x1b[0m\r\n')
        t.resize(snap.cols, snap.rows)
        ready = true
        t.write(snap.data, fit)
        if (!snap.running) t.write('\r\n\x1b[2m[their terminal ended]\x1b[0m\r\n')
      })
      .catch(() => undefined)
    requestAnimationFrame(fit)

    return () => {
      gone = true
      offData()
      offExit()
      observer.disconnect()
      t.dispose()
      stage.remove()
      term.current = null
    }
  }, [paneId])

  // The ADE's terminal theme (by default the app's own colours), kept in step.
  useEffect(() => {
    if (term.current) term.current.options.theme = xtermTheme({ theme: findTheme(themeId), scenes: false })
  }, [themeId, appearance])

  return (
    <div className="guest-watch__body">
      <div className="guest-watch__screen" ref={host} />
    </div>
  )
}
