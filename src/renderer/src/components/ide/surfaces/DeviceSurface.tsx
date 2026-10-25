import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import { RefreshCw, RotateCcwSquare, Smartphone, Tablet } from 'lucide-react'
import { useBrowser, hostOf } from '../../browser/browserStore'

/**
 * The browser's page as a phone or a tablet sees it: the same address at the
 * device's size and with its browser's name, scaled to fit the dock. It
 * shares the in-app browser's session, so a page signed in there is signed in
 * here.
 */

interface Device {
  id: string
  label: string
  width: number
  height: number
  agent: string
}

const PHONE_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const TABLET_AGENT = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

const DEVICES: Device[] = [
  { id: 'phone', label: 'Phone', width: 390, height: 844, agent: PHONE_AGENT },
  { id: 'tablet', label: 'Tablet', width: 820, height: 1180, agent: TABLET_AGENT }
]

/** The page the in-app browser shows in Chat, when it shows one. */
export function useBrowserPage(): string | null {
  return useBrowser((s) => {
    const scope = s.scopes.chat
    const tab = scope?.tabs.find((t) => t.id === scope.activeId)
    return tab?.url || null
  })
}

export function DeviceSurface(): JSX.Element {
  const url = useBrowserPage()
  const [device, setDevice] = useState(DEVICES[0])
  const [turned, setTurned] = useState(false)
  const [scale, setScale] = useState(1)
  const stage = useRef<HTMLDivElement>(null)
  const page = useRef<Electron.WebviewTag | null>(null)
  const width = turned ? device.height : device.width
  const height = turned ? device.width : device.height

  // Scaled down to the room there is, never up.
  useLayoutEffect(() => {
    const box = stage.current
    if (!box) return
    const fit = (): void => setScale(Math.min(1, (box.clientWidth - 32) / width, (box.clientHeight - 32) / height))
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(box)
    return () => observer.disconnect()
  }, [width, height])

  // Another page in the browser: this one follows.
  const [src, setSrc] = useState(url)
  useEffect(() => {
    if (url) setSrc(url)
  }, [url])

  if (!src) {
    return (
      <div className="dock-note">
        <Smartphone size={22} strokeWidth={1.5} />
        <p className="dock-note__title">No page to show</p>
        <p className="dock-note__hint">Open a page in the browser to see it on a phone or a tablet.</p>
      </div>
    )
  }

  return (
    <div className="device">
      <div className="device__bar">
        <div className="device__choice" role="radiogroup" aria-label="Device">
          {DEVICES.map((d) => (
            <button key={d.id} type="button" role="radio" aria-checked={d.id === device.id} className="device__pick" onClick={() => setDevice(d)}>
              {d.id === 'phone' ? <Smartphone size={13} strokeWidth={1.9} /> : <Tablet size={13} strokeWidth={1.9} />}
              {d.label}
            </button>
          ))}
        </div>
        <span className="device__size">
          {width} × {height}
        </span>
        <span className="device__host" title={src}>
          {hostOf(src)}
        </span>
        <div style={{ flex: 1 }} />
        <button type="button" className="dock-tool" title="Turn it sideways" aria-label="Turn it sideways" aria-pressed={turned} onClick={() => setTurned(!turned)}>
          <RotateCcwSquare size={15} strokeWidth={1.9} />
        </button>
        <button type="button" className="dock-tool" title="Reload" aria-label="Reload" onClick={() => page.current?.reload()}>
          <RefreshCw size={14} strokeWidth={1.9} />
        </button>
      </div>
      <div ref={stage} className="device__stage">
        <div className="device__frame" style={{ width: width * scale, height: height * scale }}>
          <webview
            // A new device starts a fresh page, with its own browser's name.
            key={`${device.id}-${turned}`}
            ref={(element) => {
              page.current = element as Electron.WebviewTag | null
            }}
            className="device__page"
            src={src}
            useragent={device.agent}
            partition="persist:in-app-browser"
            style={{ width, height, transform: `scale(${scale})` }}
          />
        </div>
      </div>
    </div>
  )
}
