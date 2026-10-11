import { useEffect, useState, type JSX } from 'react'
import { ExternalLink, Globe, Loader2 } from 'lucide-react'
import { Card, Row, Section, Switch } from '../../ui'
import type { RcInfo } from '@shared/rc'

const errorText = (error: unknown): string => (error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error))

/**
 * Settings → Remote devices → Control from anywhere: this computer linked to
 * a GitHub account at rc.eaon.dev (features/rc). No app to install: any
 * browser signed in to the same GitHub account sees its ADE sessions, live
 * terminals and Workers.
 */
export function RemoteWebSection(): JSX.Element {
  const [info, setInfo] = useState<RcInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.api.rc.info().then(setInfo)
    return window.api.rc.onStatus(setInfo)
  }, [])

  const run = async (job: () => Promise<RcInfo>): Promise<void> => {
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

  const site = info ? info.server.replace(/^https?:\/\//, '') : 'rc.eaon.dev'
  const state =
    !info?.enabled ? 'Off' : info.connection === 'connected' ? 'Connected' : info.connection === 'connecting' ? 'Connecting…' : info.connection === 'offline' ? 'Offline, retrying' : 'Off'

  return (
    <Section label="Control from anywhere">
      <Card>
        {!info ? null : info.linked ? (
          <>
            <Row
              title={`Linked to @${info.login ?? 'your GitHub account'}`}
              description={`Open ${site} and sign in with GitHub to see this computer’s ADE sessions, live terminals and Workers, from any browser.`}
            >
              <Switch label="Connected to Eaon Remote" checked={info.enabled} disabled={busy} onChange={(on) => void run(() => window.api.rc.setEnabled(on))} />
            </Row>
            <Row title="Status" description={info.problem ?? state}>
              <button type="button" className="btn btn--sm" onClick={() => void window.api.app.openExternal(info.server)}>
                <ExternalLink size={13} strokeWidth={2} />
                Open {site}
              </button>
            </Row>
            <Row title="Unlink this computer" description="It stops being reachable from the website right away, and its key stops working.">
              <button type="button" className="btn btn--sm btn--danger" disabled={busy} onClick={() => void run(() => window.api.rc.unlink())}>
                Unlink
              </button>
            </Row>
          </>
        ) : info.linking ? (
          <Row
            title="Approve it in your browser"
            description={`Sign in with GitHub at ${site} and check the code there matches this one. It expires in a few minutes.`}
          >
            <div className="rc-link">
              <span className="rc-link__code">{info.linking.code}</span>
              <Loader2 size={14} strokeWidth={2} className="spinner" aria-label="Waiting for approval" />
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => void window.api.app.openExternal(info.linking!.url)}>
                Open again
              </button>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => void run(() => window.api.rc.cancelLink())}>
                Cancel
              </button>
            </div>
          </Row>
        ) : (
          <Row
            title="Use this computer from the web"
            description={`Link it to your GitHub account, then open ${site} on any phone or computer to see and type into its ADE terminals and talk to its Workers. No app to install, and nothing on this computer is opened to the internet: it connects out.`}
          >
            <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={() => void run(() => window.api.rc.link())}>
              <Globe size={13} strokeWidth={2} />
              Link with GitHub
            </button>
          </Row>
        )}
        {(error || (info && !info.linked && info.problem)) && (
          <div className="row">
            <p className="ch-error">{error ?? info?.problem}</p>
          </div>
        )}
      </Card>
    </Section>
  )
}
