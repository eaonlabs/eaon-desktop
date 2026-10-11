import { useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'
import { TriangleAlert } from 'lucide-react'
import { Card, Modal, Row, Section, Switch } from '../../ui'
import type { RemoteInfo } from '@shared/remote'
import { RemoteWebSection } from './RemoteWeb'

/** The pairing link as a code to scan. Black on white in every theme, as phones read it. */
function QrCode({ text, size = 196 }: { text: string; size?: number }): JSX.Element {
  const path = useMemo(() => {
    const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' })
    let d = ''
    for (let y = 0; y < modules.size; y++) {
      for (let x = 0; x < modules.size; x++) if (modules.get(y, x)) d += `M${x} ${y}h1v1h-1z`
    }
    return { d, size: modules.size }
  }, [text])
  const box = path.size + 6
  return (
    <svg className="ch-qr" width={size} height={size} viewBox={`-3 -3 ${box} ${box}`} shapeRendering="crispEdges" role="img" aria-label="Pairing code for the Eaon app on your phone">
      <rect x={-3} y={-3} width={box} height={box} fill="#fff" />
      <path d={path.d} fill="#111" />
    </svg>
  )
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error))

export function RemoteDevicesPage(): JSX.Element {
  const [info, setInfo] = useState<RemoteInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<'key' | 'link' | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const [port, setPort] = useState('')

  useEffect(() => {
    const load = (): void => void window.api.remote.info().then(setInfo)
    load()
    // Starting or stopping changes the addresses and the link too, so read it all again.
    return window.api.remote.onStatus(load)
  }, [])
  useEffect(() => {
    if (info) setPort(String(info.status.port))
  }, [info?.status.port]) // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (job: () => Promise<RemoteInfo>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setInfo(await job())
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const copy = (what: 'key' | 'link', text: string | null): void => {
    if (!text) return
    void navigator.clipboard.writeText(text)
    setCopied(what)
    setTimeout(() => setCopied(null), 1500)
  }

  const applyPort = (): void => {
    if (!info || Number(port) === info.status.port) return
    void run(() => window.api.remote.setPort(Number(port)))
  }

  const enabled = info?.enabled ?? false
  const status = info?.status
  const statusText = !info
    ? '…'
    : status?.error
      ? `Could not start: ${status.error}`
      : status?.running
        ? `Listening on port ${status.port}.`
        : 'Starting…'

  return (
    <>
      <h1 className="settings__h1">Remote devices</h1>

      <RemoteWebSection />

      <Section>
        <Card>
          <Row title="Allow remote devices" description="Let the Eaon app on your iPhone see and control your workers, and use this Mac’s models.">
            <Switch label="Allow remote devices" checked={enabled} disabled={!info || busy} onChange={(on) => void run(() => window.api.remote.setEnabled(on))} />
          </Row>
          <div className="row row--stack">
            <div className="ch-warn" role="note">
              <TriangleAlert size={15} strokeWidth={2} aria-hidden="true" />
              <span>
                Phones talk to Eaon over plain HTTP, which anyone on the same network can read. Turn this on only on a network you trust, or a
                private network such as Tailscale. Anyone who has the key can control your workers.
              </span>
            </div>
          </div>
          {error && (
            <div className="row">
              <p className="ch-error">{error}</p>
            </div>
          )}
        </Card>
      </Section>

      {info && enabled && (
        <>
          <Section>
            <Card>
              <Row title="Status" description={statusText} />
              <Row
                title="Addresses"
                description={
                  info.addresses.length > 0
                    ? `${[...info.addresses, info.hostName].join(' · ')}`
                    : `${info.hostName}. No network address was found; connect to Wi-Fi or Tailscale.`
                }
              />
              <Row title="Port" description="The port the phone connects to. Phones that are already paired will need the new link.">
                <input
                  className="input"
                  style={{ width: 110 }}
                  type="number"
                  min={1024}
                  max={65535}
                  value={port}
                  disabled={busy}
                  onChange={(e) => setPort(e.target.value)}
                  onBlur={applyPort}
                  onKeyDown={(e) => e.key === 'Enter' && applyPort()}
                />
              </Row>
              <Row title="Key" description="Every request from a phone carries this key. Don’t share it.">
                <code className="code-settings__path" style={{ fontSize: 12 }}>
                  {info.token ? `${info.token.slice(0, 10)}…` : '…'}
                </code>
                <button className="btn btn--ghost" disabled={!info.token} onClick={() => copy('key', info.token)}>
                  {copied === 'key' ? 'Copied' : 'Copy'}
                </button>
                <button className="btn btn--ghost" disabled={busy} onClick={() => setConfirmReset(true)}>
                  Reset key
                </button>
              </Row>
            </Card>
          </Section>

          {info.link && (
            <Section label="Pair a phone">
              <Card>
                <div className="row row--stack">
                  <div className="ch-link">
                    <QrCode text={info.link} />
                    <ol className="bx-steps">
                      <li>
                        <span>Put the phone on the same network as this Mac, or on your Tailscale network.</span>
                      </li>
                      <li>
                        <span>Open the Eaon app on your iPhone and scan this code, or paste the link below.</span>
                      </li>
                      <li>
                        <span>If macOS asks whether Eaon may accept incoming connections, choose Allow. Without it the phone can't reach this Mac.</span>
                      </li>
                    </ol>
                  </div>
                </div>
                <Row title="Pairing link" description="It holds the key, so treat it like a password.">
                  <code className="code-settings__path" style={{ fontSize: 12 }}>
                    {`${info.link.split('&key=')[0]}&key=…`}
                  </code>
                  <button className="btn btn--ghost" onClick={() => copy('link', info.link)}>
                    {copied === 'link' ? 'Copied' : 'Copy link'}
                  </button>
                </Row>
              </Card>
            </Section>
          )}
        </>
      )}

      <Modal
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Reset the key?"
        actions={
          <>
            <button className="btn btn--ghost" onClick={() => setConfirmReset(false)}>
              Cancel
            </button>
            <button
              className="btn btn--danger"
              autoFocus
              onClick={() => {
                setConfirmReset(false)
                void run(() => window.api.remote.resetToken())
              }}
            >
              Reset key
            </button>
          </>
        }
      >
        Every phone you have paired is disconnected right away. Each one will have to pair again with the new key.
      </Modal>
    </>
  )
}
