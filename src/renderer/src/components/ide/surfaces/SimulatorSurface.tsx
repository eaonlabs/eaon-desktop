import { useEffect, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  Camera,
  ChevronDown,
  Copy,
  House,
  Loader2,
  Moon,
  Paperclip,
  Power,
  RotateCcw,
  RotateCw,
  Scan,
  Smartphone,
  Square,
  Sun,
  Tablet,
  Video,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import {
  deviceTurn,
  HOME_BAND,
  screenCorner,
  toNative,
  turned,
  type DeviceLook,
  type HardwareButton,
  type PaneDevice,
  type PaneProblem,
  type PaneSession
} from '@shared/simulatorPane'
import { useApp } from '../../../state/store'
import { MenuItem, MenuSeparator, Popover } from '../../ui'
import { useSimulator } from './simulatorStore'

/**
 * Eaon's Device pane: an iOS simulator inside the app. Its screen comes live
 * from main (simulatorPane.ts, through serve-sim), drawn in the device's
 * outline and turned as the device is. Touches go in as they happen — a
 * press, a drag, a long press — and with the screen focused the keyboard
 * types into it. Above it, the device and the Edit, Device and View menus;
 * under it, the buttons a phone has and the screenshot, recording and
 * add-to-chat ones.
 */

/** Without Xcode's frame for the device: the share of the screen's width its own border takes on each side. */
const BEZEL = 0.045
/** Room around the device, and under it for the toolbar. */
const PAD = 24
const TOOLBAR_ROOM = 76

/** A device's screen in pixels before its first frame: a recent iPhone or iPad. */
const guessPixels = (name: string): { width: number; height: number } => (/iPad/i.test(name) ? { width: 1640, height: 2360 } : { width: 1206, height: 2622 })

/** The shortest touch sent: iOS drops presses much shorter than a finger's. */
const MIN_TOUCH_MS = 60

/** The screen edge a touch near the bottom (as shown) starts from, in the native frame's terms (3 is its bottom). */
const BOTTOM_EDGE: Record<0 | 90 | -90 | 180, number> = { 0: 3, 90: 4, [-90]: 1, 180: 2 }

export function SimulatorSurface({ onWeb }: { onWeb: () => void }): JSX.Element {
  const { pane, udid, refresh } = useSimulator(useShallow((s) => ({ pane: s.pane, udid: s.udid, refresh: s.refresh })))

  // What runs changes from outside too (the agent, Xcode, a terminal): looked at every few seconds while showing.
  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 4000)
    return () => window.clearInterval(timer)
  }, [refresh])

  if (!pane) {
    return (
      <div className="dock-note">
        <Loader2 size={18} strokeWidth={2} className="spinner" />
        <p className="dock-note__title">Looking for simulators</p>
      </div>
    )
  }
  if (pane.problem) return <Problem problem={pane.problem} onWeb={onWeb} />
  const device = pane.devices.find((d) => d.udid === udid) ?? pane.devices[0]
  if (!device) {
    return (
      <div className="dock-note">
        <Smartphone size={22} strokeWidth={1.5} />
        <p className="dock-note__title">No simulators yet</p>
        <p className="dock-note__hint">Add an iPhone in Xcode, under Window → Devices and Simulators, and it shows up here.</p>
      </div>
    )
  }
  return <Simulator key={device.udid} device={device} devices={pane.devices} onWeb={onWeb} />
}

/** What stands in the way, and the way past it. */
function Problem({ problem, onWeb }: { problem: PaneProblem; onWeb: () => void }): JSX.Element {
  const refresh = useSimulator((s) => s.refresh)
  const title =
    problem.kind === 'platform'
      ? 'The iOS Simulator runs on a Mac'
      : problem.kind === 'xcode'
        ? 'The iOS Simulator comes with Xcode'
        : problem.kind === 'devices'
          ? 'No iOS simulator is installed'
          : 'The simulator couldn’t start'
  return (
    <div className="dock-note">
      <Smartphone size={22} strokeWidth={1.5} />
      <p className="dock-note__title">{title}</p>
      {problem.kind !== 'platform' && <p className="dock-note__hint">{problem.message}</p>}
      <div className="sim-note__actions">
        {problem.kind === 'xcode' && /install Xcode|not installed/i.test(problem.message) && (
          <button type="button" className="btn btn--primary btn--sm" onClick={() => void window.api.simulator.getXcode()}>
            Get Xcode
          </button>
        )}
        {problem.kind !== 'platform' && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void refresh()}>
            Check again
          </button>
        )}
        <button type="button" className="btn btn--ghost btn--sm" onClick={onWeb}>
          Show a web page on a phone
        </button>
      </div>
    </div>
  )
}

interface Notice {
  text: string
  file?: string
  error?: boolean
}

function Simulator({ device, devices, onWeb }: { device: PaneDevice; devices: PaneDevice[]; onWeb: () => void }): JSX.Element {
  const { view, zoom, setZoom, setView, busy, boot, shutdown, recording, setRecording } = useSimulator(
    useShallow((s) => ({
      view: s.view,
      zoom: s.zoom,
      setZoom: s.setZoom,
      setView: s.setView,
      busy: s.busy?.udid === device.udid ? s.busy.doing : null,
      boot: s.boot,
      shutdown: s.shutdown,
      recording: s.recording === device.udid,
      setRecording: s.setRecording
    }))
  )
  const booted = device.state === 'Booted' && busy !== 'shutdown'
  const starting = busy === 'boot' || device.state === 'Booting'
  const stopping = busy === 'shutdown' || device.state === 'Shutting Down'
  const [session, setSession] = useState<PaneSession | null>(null)
  const live = booted && session?.live === true
  const [pixels, setPixels] = useState<{ width: number; height: number } | null>(null)
  const [room, setRoom] = useState({ width: 0, height: 0 })
  const [notice, setNotice] = useState<Notice | null>(null)
  const [appearance, setAppearance] = useState<'light' | 'dark' | null>(null)
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number }[]>([])
  const stage = useRef<HTMLDivElement>(null)
  const screen = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)

  const say = (text: string, extra: Partial<Notice> = {}): void => setNotice({ text, ...extra })
  const fail = (error: unknown): void => say(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error), { error: true })
  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), notice.error ? 7000 : 5000)
    return () => window.clearTimeout(timer)
  }, [notice])

  // The screen, frame by frame, while it runs. Decoded off the main thread and drawn in order: a
  // frame that finishes decoding after a newer one is dropped.
  // The canvas keeps the screen's native portrait frame (the device, not the picture, is turned).
  // A stream that sends landscape-shaped frames already upright is turned back into it.
  const turnNow = useRef<0 | 90 | -90 | 180>(0)
  useEffect(() => {
    if (!booted) return
    let newest = 0
    let drawn = 0
    const offFrame = window.api.simulator.onFrame((frame) => {
      if (frame.udid !== device.udid) return
      const order = ++newest
      const sideways = frame.width > frame.height
      void createImageBitmap(new Blob([frame.data as BlobPart], { type: 'image/jpeg' })).then((bitmap) => {
        const node = canvas.current
        const context = node?.getContext('2d')
        if (node && context && order > drawn) {
          drawn = order
          const width = sideways ? bitmap.height : bitmap.width
          const height = sideways ? bitmap.width : bitmap.height
          if (node.width !== width || node.height !== height) {
            node.width = width
            node.height = height
          }
          if (!sideways) context.drawImage(bitmap, 0, 0)
          else {
            context.save()
            if (turnNow.current === -90) {
              context.translate(width, 0)
              context.rotate(Math.PI / 2)
            } else {
              context.translate(0, height)
              context.rotate(-Math.PI / 2)
            }
            context.drawImage(bitmap, 0, 0)
            context.restore()
          }
        }
        bitmap.close()
      })
      const width = sideways ? frame.height : frame.width
      const height = sideways ? frame.width : frame.height
      setPixels((now) => (now && now.width === width && now.height === height ? now : { width, height }))
    })
    const offSession = window.api.simulator.onSession((next) => {
      if (next.udid === device.udid) setSession(next)
    })
    void window.api.simulator.watch(device.udid)
    void window.api.simulator.appearance(device.udid).then(setAppearance, () => setAppearance(null))
    return () => {
      offFrame()
      offSession()
      setSession(null)
      void window.api.simulator.unwatch(device.udid)
    }
  }, [device.udid, booted])

  useLayoutEffect(() => {
    const node = stage.current
    if (!node) return
    const measure = (): void => setRoom({ width: node.clientWidth, height: node.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  // How the device looks, from the Mac's Xcode: its screen exactly, and the frame and buttons Simulator draws.
  const [look, setLook] = useState<DeviceLook | null>(null)
  useEffect(() => {
    let current = true
    setLook(null)
    window.api.simulator.look(device.udid).then(
      (found) => current && setLook(found),
      () => {}
    )
    return () => {
      current = false
    }
  }, [device.udid])

  // Everything in the device's points, then one scale (k, pixels per point) fits it to the pane.
  const shape = pixels ?? guessPixels(device.name)
  const scale = look?.screen.scale ?? (/iPad/i.test(device.name) ? 2 : 3)
  const screenPt = look ? { width: look.screen.width, height: look.screen.height } : { width: shape.width / scale, height: shape.height / scale }
  const art = view.frame ? (look?.frame ?? null) : null
  // No frame from Xcode: a plain one of the pane's own, a little past the screen.
  const plain = view.frame && !art ? screenPt.width * BEZEL : 0
  const border = art?.border ?? { top: plain, left: plain, bottom: plain, right: plain }
  const pad = art?.pad ?? (plain ? { top: 0, left: 4, bottom: 0, right: 4 } : { top: 0, left: 0, bottom: 0, right: 0 })
  const bodyW = screenPt.width + border.left + border.right
  const bodyH = screenPt.height + border.top + border.bottom
  const allW = bodyW + pad.left + pad.right
  const allH = bodyH + pad.top + pad.bottom
  const orientation = session?.orientation ?? 'portrait'
  const turn = deviceTurn(orientation)
  turnNow.current = turn
  const quarter = turn === 90 || turn === -90
  const boxW = quarter ? allH : allW
  const boxH = quarter ? allW : allH
  const k = Math.max(0.05, Math.min((room.width - PAD * 2) / boxW, (room.height - PAD - TOOLBAR_ROOM) / boxH)) * zoom
  const corners = look?.screen.corners ?? [0, 0, 0, 0].map(() => screenCorner(device.name) * screenPt.width)
  const outer = corners[0] + border.top

  const press = (name: HardwareButton): void => {
    void window.api.simulator.button(device.udid, name).catch(fail)
  }
  const rotate = (way: 'left' | 'right'): void => {
    void window.api.simulator.rotate(device.udid, turned(orientation, way)).catch(fail)
  }

  const onKey = (event: ReactKeyboardEvent): void => {
    if (!live) return
    const mod = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()
    let handled = true
    if (mod && event.shiftKey && key === 'h') press('home')
    else if (mod && !event.shiftKey && key === 'l') press('lock')
    else if (mod && event.key === 'ArrowLeft') rotate('left')
    else if (mod && event.key === 'ArrowRight') rotate('right')
    else if (mod && !event.shiftKey && key === 'v') void window.api.simulator.paste(device.udid, 'type').catch(fail)
    else if (mod || event.altKey) handled = false
    else if (event.key.length === 1 || /^(Enter|Escape|Backspace|Tab|Delete|Home|End|PageUp|PageDown|Arrow\w+)$/.test(event.key)) {
      window.api.simulator.key(device.udid, event.key, event.shiftKey)
    } else handled = false
    if (handled) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  // Touches as they happen: begin, a move a frame at most, end. Points on the picture as shown are
  // turned back into the screen's native frame. One that starts on the strip along the bottom waits
  // to see what it is: dragged, it's the swipe home (from the bottom edge); let go or held, a plain
  // touch — Safari's address bar and the like live there too.
  const touching = useRef<{ id: number; edge?: number; moved: boolean; x: number; y: number; begun: boolean; at: { x: number; y: number }; hold?: number; since?: number } | null>(null)
  const begin = (touch: NonNullable<typeof touching.current>, edge?: number): void => {
    if (touch.begun) return
    touch.begun = true
    touch.since = performance.now()
    touch.edge = edge
    if (touch.hold) window.clearTimeout(touch.hold)
    window.api.simulator.touch(device.udid, { type: 'begin', ...toNative(touch.at, turn), ...(edge ? { edge } : {}) })
  }
  const pendingMove = useRef<{ x: number; y: number } | null>(null)
  const moveFrame = useRef<number | null>(null)
  const shown = (event: React.PointerEvent): { x: number; y: number } | null => {
    const box = screen.current?.getBoundingClientRect()
    if (!box || !box.width || !box.height) return null
    return {
      x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height))
    }
  }
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!booted || event.button !== 0) return
    if (!live) {
      if (session?.problem) say(session.problem, { error: true })
      return
    }
    const at = shown(event)
    if (!at) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const touch: NonNullable<typeof touching.current> = { id: event.pointerId, moved: false, x: event.clientX, y: event.clientY, begun: false, at }
    touching.current = touch
    if (at.y < HOME_BAND) begin(touch)
    else touch.hold = window.setTimeout(() => begin(touch), 300)
  }
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const touch = touching.current
    if (!touch || touch.id !== event.pointerId) return
    const at = shown(event)
    if (!at) return
    if (Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > 4) touch.moved = true
    if (!touch.begun) {
      if (!touch.moved) return
      begin(touch, BOTTOM_EDGE[turn])
    }
    pendingMove.current = toNative(at, turn)
    if (moveFrame.current !== null) return
    moveFrame.current = requestAnimationFrame(() => {
      moveFrame.current = null
      const point = pendingMove.current
      pendingMove.current = null
      if (point && touching.current) window.api.simulator.touch(device.udid, { type: 'move', ...point, ...(touching.current.edge ? { edge: touching.current.edge } : {}) })
    })
  }
  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const touch = touching.current
    if (!touch || touch.id !== event.pointerId) return
    touching.current = null
    if (moveFrame.current !== null) cancelAnimationFrame(moveFrame.current)
    moveFrame.current = null
    const at = shown(event)
    const box = screen.current?.getBoundingClientRect()
    if (!at || !box) return
    // A tap on the bottom strip begins only now, as a plain touch. Every touch lasts long enough to
    // count: iOS ignores a press of a few milliseconds (a quick click) on an alert's buttons.
    begin(touch)
    const end = (): void => window.api.simulator.touch(device.udid, { type: 'end', ...toNative(at, turn), ...(touch.edge ? { edge: touch.edge } : {}) })
    const short = MIN_TOUCH_MS - (performance.now() - (touch.since ?? 0))
    if (short > 0) window.setTimeout(end, short)
    else end()
    if (!touch.moved) {
      const id = performance.now()
      const local = toNative(at, turn)
      setRipples((now) => [...now, { id, x: local.x * screenPt.width * k, y: local.y * screenPt.height * k }])
      window.setTimeout(() => setRipples((now) => now.filter((r) => r.id !== id)), 500)
    }
  }

  const screenshot = (to: 'desktop' | 'clipboard' | 'chat'): void => {
    void window.api.simulator
      .screenshot(device.udid, to)
      .then((file) => {
        if (to === 'clipboard') say('Copied the screen.')
        else if (to === 'chat' && file) {
          useApp.getState().appendToComposer({ text: '', attachments: [file] })
          say('Added a screenshot to your message.')
        } else if (file) say('Screenshot saved to the Desktop.', { file })
      })
      .catch(fail)
  }

  const [recordStart, setRecordStart] = useState(0)
  const toggleRecording = (): void => {
    const on = !recording
    setRecording(on ? device.udid : null)
    if (on) setRecordStart(Date.now())
    void window.api.simulator
      .record(device.udid, on)
      .then((file) => {
        if (!on && file) say('Recording saved to the Desktop.', { file })
      })
      .catch((error) => {
        setRecording(null)
        fail(error)
      })
  }

  const setMode = (mode: 'light' | 'dark'): void => {
    setAppearance(mode)
    void window.api.simulator.appearance(device.udid, mode).then(setAppearance, fail)
  }

  const start = (): void => void boot(device.udid).catch(fail)
  const stop = (): void => void shutdown(device.udid).catch(fail)

  return (
    <div className="sim">
      <div className="sim__bar">
        <DevicePicker device={device} devices={devices} />
        <div className="sim__menus">
          <BarMenu label="Edit">
            {(close) => (
              <>
                <MenuItem icon={<Copy size={15} strokeWidth={1.9} />} title="Copy screen" disabled={!booted} onClick={() => (close(), screenshot('clipboard'))} />
                <MenuItem title="Paste" hint="⌘V" disabled={!live} onClick={() => (close(), void window.api.simulator.paste(device.udid, 'type').catch(fail))} />
                <MenuItem
                  title="Send clipboard to the device"
                  description="Then paste it there"
                  disabled={!booted}
                  onClick={() => (close(), void window.api.simulator.paste(device.udid, 'pasteboard').then(() => say('The clipboard is on the device.'), fail))}
                />
              </>
            )}
          </BarMenu>
          <BarMenu label="Device">
            {(close) => (
              <>
                {booted ? (
                  <MenuItem icon={<Power size={15} strokeWidth={1.9} />} title="Shut down" disabled={stopping} onClick={() => (close(), stop())} />
                ) : (
                  <MenuItem icon={<Power size={15} strokeWidth={1.9} />} title="Start" disabled={starting || stopping} onClick={() => (close(), start())} />
                )}
                <MenuSeparator />
                <MenuItem title="Home" hint="⇧⌘H" disabled={!live} onClick={() => (close(), press('home'))} />
                <MenuItem title="Lock" hint="⌘L" disabled={!live} onClick={() => (close(), press('lock'))} />
                <MenuItem title="Rotate left" hint="⌘←" disabled={!live} onClick={() => (close(), rotate('left'))} />
                <MenuItem title="Rotate right" hint="⌘→" disabled={!live} onClick={() => (close(), rotate('right'))} />
                <MenuSeparator />
                <MenuItem title="Light appearance" checked={appearance === 'light'} disabled={!booted} onClick={() => (close(), setMode('light'))} />
                <MenuItem title="Dark appearance" checked={appearance === 'dark'} disabled={!booted} onClick={() => (close(), setMode('dark'))} />
                <MenuSeparator />
                <OpenLink disabled={!booted} onOpen={(url) => (close(), void window.api.simulator.openUrl(device.udid, url).catch(fail))} />
              </>
            )}
          </BarMenu>
          <BarMenu label="View">
            {(close) => (
              <>
                <MenuItem title="Device frame" checked={view.frame} onClick={() => (close(), setView({ frame: !view.frame }))} />
                <MenuSeparator />
                <MenuItem title="Fit to the pane" checked={zoom === 1} onClick={() => (close(), setZoom(1))} />
                <MenuItem title="Zoom in" onClick={() => (close(), setZoom(zoom * 1.25))} />
                <MenuItem title="Zoom out" onClick={() => (close(), setZoom(zoom / 1.25))} />
                <MenuSeparator />
                <MenuItem icon={<Smartphone size={15} strokeWidth={1.9} />} title="Web page on a phone" description="The browser’s page at a phone’s size" onClick={() => (close(), onWeb())} />
              </>
            )}
          </BarMenu>
        </div>
        <div className="sim__zoom" role="group" aria-label="Zoom">
          <button type="button" className="dock-tool" title="Zoom out" aria-label="Zoom out" onClick={() => setZoom(zoom / 1.25)}>
            <ZoomOut size={15} strokeWidth={1.8} />
          </button>
          <button type="button" className="dock-tool" title="Fit to the pane" aria-label="Fit to the pane" data-active={zoom === 1 || undefined} onClick={() => setZoom(1)}>
            <Scan size={15} strokeWidth={1.8} />
          </button>
          <button type="button" className="dock-tool" title="Zoom in" aria-label="Zoom in" onClick={() => setZoom(zoom * 1.25)}>
            <ZoomIn size={15} strokeWidth={1.8} />
          </button>
        </div>
      </div>

      <div ref={stage} className="sim__stage" data-zoomed={zoom > 1 || undefined}>
        <div className="sim__holder" style={{ width: boxW * k, height: boxH * k }}>
        <div className="sim__device" style={{ width: allW * k, height: allH * k, transform: `translate(-50%, -50%) rotate(${turn}deg)` }}>
        <div
          className="sim__body"
          data-frame={view.frame || undefined}
          data-art={art ? true : undefined}
          data-phone={/iPhone/i.test(device.name) || undefined}
          style={{ left: pad.left * k, top: pad.top * k, width: bodyW * k, height: bodyH * k, borderRadius: outer * k }}
        >
          {art && look && <FrameArt frame={art} buttons={look.buttons} k={k} width={bodyW} height={bodyH} live={live} onPress={press} />}
          <div
            ref={screen}
            className="sim__screen"
            data-on={booted || undefined}
            data-live={live || undefined}
            style={{
              left: border.left * k,
              top: border.top * k,
              width: screenPt.width * k,
              height: screenPt.height * k,
              borderRadius: corners.map((c) => `${c * k}px`).join(' ')
            }}
            tabIndex={booted ? 0 : -1}
            aria-label={`${device.name} screen`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={onKey}
          >
            <canvas ref={canvas} className="sim__canvas" hidden={!booted || !pixels} />
            {ripples.map((r) => (
              <span key={r.id} className="sim__ripple" style={{ left: r.x, top: r.y }} />
            ))}
            {!booted && (
              <div className="sim__off">
                {starting || stopping ? (
                  <span className="sim__off-state">
                    <Loader2 size={15} strokeWidth={2} className="spinner" />
                    {starting ? 'Starting…' : 'Shutting down…'}
                  </span>
                ) : (
                  <button type="button" className="sim__start" onClick={start}>
                    <Power size={14} strokeWidth={2} />
                    Start {device.name}
                  </button>
                )}
              </div>
            )}
            {booted && !pixels && (
              <div className="sim__off">
                <Loader2 size={15} strokeWidth={2} className="spinner" />
              </div>
            )}
          </div>
        </div>
        </div>
        </div>
      </div>

      <div className="sim__foot">
        {notice ? (
          <div className="sim__notice" data-error={notice.error || undefined} role="status">
            <span>{notice.text}</span>
            {notice.file && (
              <button type="button" onClick={() => void window.api.simulator.showFile(notice.file!)}>
                Show in Finder
              </button>
            )}
          </div>
        ) : (
          booted &&
          session?.problem && (
            <div className="sim__notice" role="note">
              <span>{session.problem}</span>
              {!/Device Hub/.test(session.problem) && (
                <button type="button" onClick={() => void window.api.simulator.reconnect(device.udid).catch(fail)}>
                  Reconnect
                </button>
              )}
            </div>
          )
        )}
        <div className="sim__toolbar" role="toolbar" aria-label="Device">
          <Tool label="Home" disabled={!live} onClick={() => press('home')}>
            <House size={16} strokeWidth={1.8} />
          </Tool>
          <Tool label="Lock" disabled={!live} onClick={() => press('lock')}>
            <Power size={16} strokeWidth={1.8} />
          </Tool>
          <Tool label="Rotate left" disabled={!live} onClick={() => rotate('left')}>
            <RotateCcw size={16} strokeWidth={1.8} />
          </Tool>
          <Tool label="Rotate right" disabled={!live} onClick={() => rotate('right')}>
            <RotateCw size={16} strokeWidth={1.8} />
          </Tool>
          <span className="sim__sep" />
          <Tool label={appearance === 'dark' ? 'Light appearance' : 'Dark appearance'} disabled={!booted || appearance === null} onClick={() => setMode(appearance === 'dark' ? 'light' : 'dark')}>
            {appearance === 'dark' ? <Sun size={16} strokeWidth={1.8} /> : <Moon size={16} strokeWidth={1.8} />}
          </Tool>
          <span className="sim__sep" />
          <Tool label="Save a screenshot to the Desktop" disabled={!booted} onClick={() => screenshot('desktop')}>
            <Camera size={16} strokeWidth={1.8} />
          </Tool>
          <Tool label={recording ? 'Stop recording' : 'Record the screen'} disabled={!booted} active={recording} onClick={toggleRecording}>
            {recording ? <Square size={13} strokeWidth={2.2} /> : <Video size={16} strokeWidth={1.8} />}
            {recording && <RecordingTime since={recordStart} />}
          </Tool>
          <span className="sim__sep" />
          <Tool label="Add a screenshot to your message" disabled={!booted} onClick={() => screenshot('chat')}>
            <Paperclip size={16} strokeWidth={1.8} />
          </Tool>
        </div>
      </div>
    </div>
  )
}

/**
 * Xcode's frame for the device, in its nine pieces around the screen (corners
 * as they are, edges stretched to the screen's size), with its buttons
 * tucked under the edge they stick out of; pressing one presses it on the
 * device. Sizes are in points, drawn at `k` pixels a point.
 */
function FrameArt({
  frame,
  buttons,
  k,
  width,
  height,
  live,
  onPress
}: {
  frame: NonNullable<DeviceLook['frame']>
  buttons: DeviceLook['buttons']
  k: number
  width: number
  height: number
  live: boolean
  onPress: (name: HardwareButton) => void
}): JSX.Element {
  const p = frame.pieces
  const at = (left: number, top: number, w: number, h: number): React.CSSProperties => ({ left: left * k, top: top * k, width: w * k, height: h * k })
  const pieces: [keyof typeof p, React.CSSProperties][] = [
    ['topLeft', at(0, 0, p.topLeft.width, p.topLeft.height)],
    ['top', at(p.topLeft.width, 0, width - p.topLeft.width - p.topRight.width, p.top.height)],
    ['topRight', at(width - p.topRight.width, 0, p.topRight.width, p.topRight.height)],
    ['right', at(width - p.right.width, p.topRight.height, p.right.width, height - p.topRight.height - p.bottomRight.height)],
    ['bottomRight', at(width - p.bottomRight.width, height - p.bottomRight.height, p.bottomRight.width, p.bottomRight.height)],
    ['bottom', at(p.bottomLeft.width, height - p.bottom.height, width - p.bottomLeft.width - p.bottomRight.width, p.bottom.height)],
    ['bottomLeft', at(0, height - p.bottomLeft.height, p.bottomLeft.width, p.bottomLeft.height)],
    ['left', at(0, p.topLeft.height, p.left.width, height - p.topLeft.height - p.bottomLeft.height)]
  ]
  const place = (b: DeviceLook['buttons'][number]): React.CSSProperties => {
    const w = b.image.width
    const h = b.image.height
    if (b.anchor === 'left') return at(b.x - w, b.y, w, h)
    if (b.anchor === 'right') return at(width + b.x, b.y, w, h)
    if (b.anchor === 'top') return at(b.x >= 0 ? b.x : width + b.x - w, b.y - h, w, h)
    return at((width - w) / 2 + b.x, height + b.y, w, h)
  }
  const button = (b: DeviceLook['buttons'][number]): JSX.Element => <FrameButton key={b.name} button={b} style={place(b)} live={live} onPress={onPress} />
  return (
    <>
      {buttons.filter((b) => !b.onTop).map(button)}
      {pieces.map(([name, style]) => (
        <img key={name} className="sim__piece" src={p[name].src} style={style} alt="" draggable={false} />
      ))}
      {buttons.filter((b) => b.onTop).map(button)}
    </>
  )
}

/** One of the device's buttons: its art, pressed while held, and the press sent when let go. */
function FrameButton({ button, style, live, onPress }: { button: DeviceLook['buttons'][number]; style: React.CSSProperties; live: boolean; onPress: (name: HardwareButton) => void }): JSX.Element {
  const [down, setDown] = useState(false)
  const press = button.press
  const label = { home: 'Home', lock: 'Side button', 'volume-up': 'Volume up', 'volume-down': 'Volume down', action: 'Action button' }
  return (
    <button
      type="button"
      className="sim__hw"
      style={style}
      disabled={!press || !live}
      title={press ? label[press] : undefined}
      aria-label={press ? label[press] : button.name}
      onPointerDown={() => setDown(true)}
      onPointerUp={() => setDown(false)}
      onPointerLeave={() => setDown(false)}
      onClick={() => press && onPress(press)}
    >
      <img src={(down && button.down ? button.down : button.image).src} alt="" draggable={false} />
    </button>
  )
}

function Tool({ label, children, disabled, active, onClick }: { label: string; children: ReactNode; disabled?: boolean; active?: boolean; onClick: () => void }): JSX.Element {
  return (
    <button type="button" className="sim__tool" title={label} aria-label={label} disabled={disabled} data-active={active || undefined} onClick={onClick}>
      {children}
    </button>
  )
}

function RecordingTime({ since }: { since: number }): JSX.Element {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  return <span className="sim__rec-time">{`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}</span>
}

/** A quiet text button in the bar that opens a menu; `children` gets the way to close it. */
function BarMenu({ label, children }: { label: string; children: (close: () => void) => ReactNode }): JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <>
      <button ref={anchor} type="button" className="sim__menu" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {label}
        <ChevronDown size={13} strokeWidth={2} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="bottom-start" width={240}>
        {children(() => setOpen(false))}
      </Popover>
    </>
  )
}

/** The Device menu's last row: a link to open on the device, typed in place. */
function OpenLink({ disabled, onOpen }: { disabled: boolean; onOpen: (url: string) => void }): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [url, setUrl] = useState('')
  if (!editing) return <MenuItem title="Open a link…" description="A website, or an app’s link" disabled={disabled} onClick={() => setEditing(true)} />
  const open = (): void => {
    const value = url.trim()
    if (!value) return
    onOpen(/^[a-z][\w+.-]*:/i.test(value) ? value : `https://${value}`)
  }
  return (
    <div className="sim__link">
      <input
        autoFocus
        className="input"
        placeholder="apple.com or myapp://screen"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') open()
        }}
      />
    </div>
  )
}

/** The device on show, and every other one to switch to, newest system first. */
function DevicePicker({ device, devices }: { device: PaneDevice; devices: PaneDevice[] }): JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const select = useSimulator((s) => s.select)
  const runtimes = [...new Set(devices.map((d) => d.runtime))]
  return (
    <>
      <button ref={anchor} type="button" className="sim__picker" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="sim__picker-text">
          <span className="sim__picker-name">{device.name}</span>
          <span className="sim__picker-os">{device.runtime}</span>
        </span>
        <ChevronDown size={14} strokeWidth={2} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="bottom-start" width={280} className="sim__devices">
        {runtimes.map((runtime) => (
          <div key={runtime}>
            <div className="menu__label">{runtime}</div>
            {devices
              .filter((d) => d.runtime === runtime)
              .map((d) => (
                <MenuItem
                  key={d.udid}
                  icon={/iPad/i.test(d.name) ? <Tablet size={15} strokeWidth={1.8} /> : <Smartphone size={15} strokeWidth={1.8} />}
                  title={d.name}
                  hint={d.state === 'Booted' ? <span className="sim__running">Running</span> : undefined}
                  checked={d.udid === device.udid}
                  onClick={() => {
                    setOpen(false)
                    select(d.udid)
                  }}
                />
              ))}
          </div>
        ))}
      </Popover>
    </>
  )
}
