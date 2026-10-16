import { useEffect, useState, type JSX } from 'react'
import { ExternalLink, Globe, Loader2 } from 'lucide-react'
import { Card, Row, Section, Switch } from '../../ui'
import type { RcInfo, RcShare } from '@shared/rc'

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
      {info?.linked && <SharedWith site={site} connected={info.connection === 'connected'} />}
    </Section>
  )
}

/**
 * Who else can reach this computer through Eaon Remote: the people it, or
 * one of its terminals, was shared with on the website. Shown here too so
 * whoever sits at this computer knows, and can take it back without the
 * website.
 */
function SharedWith({ site, connected }: { site: string; connected: boolean }): JSX.Element | null {
  const [shares, setShares] = useState<RcShare[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = (): void =>
      void window.api.rc.shares().then(
        (list) => alive && (setShares(list), setError(null)),
        (e) => alive && setError(errorText(e))
      )
    load()
    // Who is connected changes while the page is open.
    const timer = setInterval(load, 10_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [connected])

  const revoke = async (share: RcShare): Promise<void> => {
    setRevoking(share.id)
    try {
      await window.api.rc.revokeShare(share.id)
      setShares((list) => list?.filter((s) => s.id !== share.id) ?? null)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setRevoking(null)
    }
  }

  if (!shares?.length && !error) return null
  return (
    <Card>
      {shares?.map((share) => (
        <Row
          key={share.id}
          title={`@${share.login}${share.online ? ' · connected now' : ''}`}
          description={[
            share.paneLabel ? `Terminal “${share.paneLabel}”` : share.pane ? 'One terminal' : 'This whole computer',
            share.access === 'control' ? 'can watch and type' : 'can watch',
            share.pending ? (share.expired ? 'invite expired' : 'invite not accepted yet') : null
          ]
            .filter(Boolean)
            .join(' · ')}
        >
          <button type="button" className="btn btn--sm btn--danger" disabled={revoking === share.id} onClick={() => void revoke(share)}>
            Revoke
          </button>
        </Row>
      ))}
      {error && (
        <div className="row">
          <p className="ch-error">{error}</p>
        </div>
      )}
      <div className="row">
        <p className="row__desc">Share a terminal or this computer from {site}. Revoking ends their connection right away.</p>
      </div>
    </Card>
  )
}
