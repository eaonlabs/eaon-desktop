import { useEffect, useRef, useState, type JSX } from 'react'
import { Check, Copy, ExternalLink, FolderOpen, RefreshCw, TriangleAlert } from 'lucide-react'
import { CHROME_WEB_STORE_URL, isNewerVersion, type BrowserBridgeStatus } from '@shared/browserBridge'
import { useApp } from '../../../state/store'
import { Card, Row, Section, Switch } from '../../ui'

type CopyTarget = 'code' | 'path' | 'url'

/**
 * One button per Chromium browser installed here that opens its extensions
 * page — which browsers only open from their own address bar or from the
 * system, never from a link. Copying the address is the fallback.
 */
function ExtensionsPageButtons({
  browsers,
  copied,
  onCopy
}: {
  browsers: { id: string; name: string }[]
  copied: boolean
  onCopy: () => void
}): JSX.Element {
  return (
    <span className="bx-browsers">
      {browsers.slice(0, 4).map((browser) => (
        <button key={browser.id} className="btn btn--sm" onClick={() => void window.api.browserBridge.openExtensionsPage(browser.id)}>
          <ExternalLink size={13} strokeWidth={1.9} />
          {browser.name}
        </button>
      ))}
      <button className="btn btn--sm" onClick={onCopy}>
        {copied ? <Check size={13} strokeWidth={2} /> : <Copy size={13} strokeWidth={1.9} />}
        {copied ? 'Copied' : browsers.length ? 'Copy address' : 'Copy chrome://extensions'}
      </button>
    </span>
  )
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
  const [browsers, setBrowsers] = useState<{ id: string; name: string }[]>([])
  const copyTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    void window.api.browserBridge.status().then(setStatus)
    void window.api.browserBridge.extensionPath().then(setExtensionPath)
    void window.api.browserBridge.browsers().then(setBrowsers)
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
  const updateWaiting = Boolean(
    status.client && status.bundledExtensionVersion && isNewerVersion(status.bundledExtensionVersion, status.client.extensionVersion)
  )
  const extensionsButtons = <ExtensionsPageButtons browsers={browsers} copied={copied === 'url'} onCopy={() => copy('url', 'chrome://extensions')} />

  return (
    <>
      <h1 className="settings__h1">Browser extension</h1>
      <p className="settings__lede">
        Let Eaon use Chrome from Chat and Workers: open pages, read them, click, type and take screenshots. It works in its
        own “Eaon” tab group and can only touch your other tabs if you share them from the extension.
      </p>

      {status.legacyExtensionSeenAt && (
        <Section>
          <div className="bx-legacy" role="alert">
            <div className="bx-legacy__head">
              <TriangleAlert size={16} strokeWidth={2} aria-hidden="true" />
              <span>An old Eaon extension is still installed</span>
            </div>
            <p className="bx-legacy__text">
              Your browser has the Eaon Browser Control extension from the previous Eaon app. It can’t talk to this version
              of Eaon — that’s why it shows as out of date and never connects. Replace it:
            </p>
            <ol className="bx-steps">
              <li>
                <span>Open your browser’s extensions page.</span>
                {extensionsButtons}
              </li>
              <li>
                <span>
                  Remove the <strong>Eaon Browser Control</strong> that has no Eaon logo and an Options page (version 1.0.0).
                </span>
              </li>
              <li>
                <span>Load the new one from the folder under “Get the extension” below, then pair it.</span>
              </li>
            </ol>
            <p className="bx-legacy__foot">This notice goes away within a minute of the old extension being removed.</p>
          </div>
        </Section>
      )}

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
            {updateWaiting && status.update === 'reloading' && (
              <Row title="Updating the extension…" description={`Moving it to ${status.bundledExtensionVersion}. It reconnects in a few seconds.`} />
            )}
            {updateWaiting && status.update === 'stuck' && (
              <Row
                title="The extension didn’t update"
                description={`It reloaded but is still ${status.client?.extensionVersion}, so it was loaded from a folder Eaon doesn’t keep up to date. Remove it from your browser and load it again from the folder below.`}
              />
            )}
            {updateWaiting && status.update !== 'reloading' && status.update !== 'stuck' && status.canSelfUpdate && (
              <Row
                title="Extension update available"
                description={`Eaon ships extension ${status.bundledExtensionVersion}; your browser has ${status.client?.extensionVersion}. Updating takes a second and keeps the pairing.`}
              >
                <button className="btn" onClick={() => void window.api.browserBridge.updateExtension().then(setStatus)}>
                  Update now
                </button>
              </Row>
            )}
            {updateWaiting && status.update !== 'reloading' && status.update !== 'stuck' && !status.canSelfUpdate && (
              <div className="row row--stack">
                <div className="row__body">
                  <div className="row__title">Extension update available</div>
                  <div className="row__desc">
                    Eaon ships extension {status.bundledExtensionVersion}; your browser has {status.client?.extensionVersion}, which
                    can’t update itself. Open the extensions page and click the reload icon on the Eaon Browser Control card —
                    once. From {status.bundledExtensionVersion} on, it updates itself.
                  </div>
                </div>
                {extensionsButtons}
              </div>
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
              <div className="row__desc">
                Works in Chrome, Edge, Brave, Arc, Comet, Vivaldi, Opera and other Chromium browsers. Once loaded, it updates
                itself whenever Eaon does.
              </div>
            </div>
            <ol className="bx-steps">
              <li>
                <span>
                  Open your browser’s extensions page{browsers.length ? '' : <> — paste <code>chrome://extensions</code> in its address bar</>}.
                </span>
                {extensionsButtons}
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
