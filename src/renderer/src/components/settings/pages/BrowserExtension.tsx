import { useEffect, useRef, useState, type JSX } from 'react'
import { Check, Copy, ExternalLink, FolderOpen, RefreshCw } from 'lucide-react'
import { CHROME_WEB_STORE_URL, type BrowserBridgeStatus } from '@shared/browserBridge'
import { useApp } from '../../../state/store'
import { Card, Row, Section, Switch } from '../../ui'

type CopyTarget = 'code' | 'path' | 'url'

/** Newer-than check on dotted versions ("1.0.10" > "1.0.9"). */
function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  return false
}

function statusLine(status: BrowserBridgeStatus): { state: string; label: string; detail: string } {
  if (!status.enabled) return { state: 'off', label: 'Off', detail: 'The agent cannot use your browser.' }
  if (status.error) return { state: 'error', label: 'Not listening', detail: status.error }
  if (status.connected) {
    const who = status.client ? `${status.client.browser} · extension ${status.client.extensionVersion}` : 'the extension'
    if (status.paused) return { state: 'paused', label: 'Stopped', detail: `Connected to ${who}, but agent control was stopped from the extension.` }
    return { state: 'on', label: 'Connected', detail: status.agentTab ? `${who}. Working in “${status.agentTab.title}”.` : `Connected to ${who}.` }
  }
  if (status.paired) return { state: 'waiting', label: 'Not connected', detail: `Paired with ${status.client?.browser ?? 'a browser'}. Open it and the extension reconnects on its own.` }
  return { state: 'waiting', label: 'Waiting', detail: 'Install the extension and pair it with the code below.' }
}

export function BrowserExtensionPage(): JSX.Element {
  const { settings, patchSettings } = useApp()
  const [status, setStatus] = useState<BrowserBridgeStatus | null>(null)
  const [extensionPath, setExtensionPath] = useState('')
  const [copied, setCopied] = useState<CopyTarget | null>(null)
  const [pairAnother, setPairAnother] = useState(false)
  const [portDraft, setPortDraft] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const copyTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    void window.api.browserBridge.status().then(setStatus)
    void window.api.browserBridge.extensionPath().then(setExtensionPath)
    const off = window.api.browserBridge.onStatus(setStatus)
    // Keeps the "expires in" countdown honest without a per-second re-render.
    const tick = window.setInterval(() => setNow(Date.now()), 15_000)
    return () => {
      off()
      window.clearInterval(tick)
      window.clearTimeout(copyTimer.current)
    }
  }, [])

  const wantsCode = Boolean(status?.listening && (!status.paired || pairAnother))
  const codeExpired = !status?.pairing || status.pairing.expiresAt <= now

  // Ask for a code whenever one should be on screen and none is live — first
  // visit, expiry, or the bridge discarding it after too many wrong guesses.
  useEffect(() => {
    if (wantsCode && codeExpired) void window.api.browserBridge.pairingCode(false)
  }, [wantsCode, codeExpired])

  // A successful pairing ends "pair another browser" mode.
  useEffect(() => {
    if (status?.connected) setPairAnother(false)
  }, [status?.connected, status?.client?.pairedAt])

  if (!settings || !status) return <h1 className="settings__h1">Browser extension</h1>

  const line = statusLine(status)

  const copy = (target: CopyTarget, text: string): void => {
    void navigator.clipboard.writeText(text)
    setCopied(target)
    window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(null), 1600)
  }

  const setEnabled = async (enabled: boolean): Promise<void> => {
    await patchSettings({ browserExtension: { enabled } })
    setStatus(await window.api.browserBridge.apply())
  }

  const commitPort = async (): Promise<void> => {
    if (portDraft === null) return
    const port = Number(portDraft)
    setPortDraft(null)
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === settings.browserExtension.port) return
    await patchSettings({ browserExtension: { port } })
    setStatus(await window.api.browserBridge.apply())
  }

  // Date.now(), not `now`: `now` can predate the code by up to a tick, which
  // made a fresh 10-minute code read "11 minutes".
  const minutesLeft = status.pairing ? Math.max(1, Math.ceil((status.pairing.expiresAt - Date.now()) / 60_000)) : 0
  const updateWaiting =
    status.client && status.bundledExtensionVersion && isNewer(status.bundledExtensionVersion, status.client.extensionVersion)

  return (
    <>
      <h1 className="settings__h1">Browser extension</h1>
      <p className="settings__lede">
        Let the agent use Chrome in Work mode: open pages, read them, click, type and take screenshots. It works in its
        own “Eaon” tab group and can only touch your other tabs if you share them from the extension.
      </p>

      <Section>
        <Card>
          <Row title="Browser control" description="Listen for the Eaon extension on this computer.">
            <Switch label="Browser control" checked={settings.browserExtension.enabled} onChange={(on) => void setEnabled(on)} />
          </Row>
          <Row title="Status" description={line.detail}>
            <span className="bx-status" data-state={line.state}>
              <span className="bx-status__dot" aria-hidden="true" />
              {line.label}
            </span>
          </Row>
          <Row
            title="Port"
            description={`Only change this if another app already uses ${settings.browserExtension.port}. Enter the same port in the extension popup.`}
          >
            <input
              className="input bx-port"
              type="number"
              min={1024}
              max={65535}
              aria-label="Port"
              value={portDraft ?? String(settings.browserExtension.port)}
              onChange={(e) => setPortDraft(e.target.value)}
              onBlur={() => void commitPort()}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          </Row>
        </Card>
      </Section>

      {status.enabled && status.listening && (
        <Section label="Pairing">
          <Card>
            {status.paired && status.client && (
              <Row
                title={status.client.browser}
                description={`Extension ${status.client.extensionVersion} · paired ${new Date(status.client.pairedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`}
              >
                <button className="btn btn--danger" onClick={() => void window.api.browserBridge.unpair().then(setStatus)}>
                  Unpair
                </button>
              </Row>
            )}
            {updateWaiting && (
              <Row
                title="Extension update available"
                description={`Eaon ships extension ${status.bundledExtensionVersion}. If you loaded it unpacked, click the reload button on its card in chrome://extensions.`}
              />
            )}
            {wantsCode ? (
              <div className="row bx-pair">
                <div className="row__body">
                  <div className="row__title">{status.paired ? 'Pair a different browser' : 'Pairing code'}</div>
                  <div className="row__desc">
                    Click the Eaon icon in Chrome’s toolbar and enter this code.
                    {status.pairing && ` It works once and expires in ${minutesLeft} minute${minutesLeft === 1 ? '' : 's'}.`}
                    {status.paired && ' Pairing a new browser unpairs the current one.'}
                  </div>
                </div>
                <div className="row__trail">
                  <span className="bx-code" aria-label="Pairing code">
                    {status.pairing?.code ?? '···-···'}
                  </span>
                  <button
                    className="icon-btn"
                    aria-label="Copy pairing code"
                    disabled={!status.pairing}
                    onClick={() => status.pairing && copy('code', status.pairing.code)}
                  >
                    {copied === 'code' ? <Check size={15} strokeWidth={2} /> : <Copy size={15} strokeWidth={1.9} />}
                  </button>
                  <button
                    className="icon-btn"
                    aria-label="New pairing code"
                    title="New code"
                    onClick={() => void window.api.browserBridge.pairingCode(true)}
                  >
                    <RefreshCw size={15} strokeWidth={1.9} />
                  </button>
                </div>
              </div>
            ) : (
              <Row title="Pair a different browser" description="Replaces the pairing above.">
                <button className="btn" onClick={() => setPairAnother(true)}>
                  Show code
                </button>
              </Row>
            )}
          </Card>
        </Section>
      )}

      <Section label="Get the extension">
        <Card>
          <Row
            title="Chrome Web Store"
            description={
              CHROME_WEB_STORE_URL
                ? 'Install Eaon Browser Control from the Chrome Web Store. It updates itself from there.'
                : 'Not on the Chrome Web Store yet. Load it unpacked for now, as below.'
            }
          >
            {CHROME_WEB_STORE_URL && (
              <button className="btn" onClick={() => void window.api.app.openExternal(CHROME_WEB_STORE_URL)}>
                <ExternalLink size={14} strokeWidth={1.9} />
                Open
              </button>
            )}
          </Row>
          <div className="row row--stack">
            <div className="row__body">
              <div className="row__title">Load unpacked</div>
              <div className="row__desc">Works in Chrome, Edge, Brave and other Chromium browsers.</div>
            </div>
            <ol className="bx-steps">
              <li>
                <span>
                  Open <code>chrome://extensions</code>. Browsers only open this page from their own address bar, so paste it
                  there.
                </span>
                <button className="btn btn--sm" onClick={() => copy('url', 'chrome://extensions')}>
                  {copied === 'url' ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={1.9} />}
                  {copied === 'url' ? 'Copied' : 'Copy address'}
                </button>
              </li>
              <li>
                <span>Turn on Developer mode, in the top-right corner.</span>
              </li>
              <li>
                <span>Click Load unpacked and choose this folder:</span>
              </li>
            </ol>
            <div className="bx-path">
              <code className="bx-path__text" title={extensionPath}>
                <bdi>{extensionPath || '…'}</bdi>
              </code>
              <button className="btn btn--sm" disabled={!extensionPath} onClick={() => copy('path', extensionPath)}>
                {copied === 'path' ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={1.9} />}
                {copied === 'path' ? 'Copied' : 'Copy'}
              </button>
              <button className="btn btn--sm" onClick={() => void window.api.browserBridge.revealExtension()}>
                <FolderOpen size={13} strokeWidth={1.9} />
                Show folder
              </button>
            </div>
          </div>
        </Card>
      </Section>
    </>
  )
}
