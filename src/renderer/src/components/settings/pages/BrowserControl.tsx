import { useCallback, useEffect, useState, type JSX } from 'react'
import { Check, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import type { BrowserControlStatus } from '@shared/browserUse'
import { useApp } from '../../../state/store'
import { notify } from '../../Notice'
import { Card, Row, Section, Select, Switch } from '../../ui'

/**
 * Settings → Browser control: the agent in the user's own browser, through
 * Browser Use. Set up once (Browser Use and a Python of its own, in Eaon's
 * folder), then one switch in the browser — "Allow remote debugging" — and
 * the browser's own Allow prompt when Eaon connects. No extension.
 */
export function BrowserControlPage(): JSX.Element {
  const settings = useApp((s) => s.settings)
  const patchSettings = useApp((s) => s.patchSettings)
  const [status, setStatus] = useState<BrowserControlStatus | null>(null)
  const [step, setStep] = useState<string | null>(null)

  const refresh = useCallback(async () => setStatus(await window.api.browserControl.status()), [])
  useEffect(() => {
    void refresh()
    const off = window.api.browserControl.onProgress(setStep)
    // The switch in the browser is flipped over there: look again every few seconds.
    const timer = window.setInterval(() => void refresh(), 3000)
    return () => {
      off()
      window.clearInterval(timer)
    }
  }, [refresh])

  if (!settings) return <></>
  const setting = settings.browserUse
  const installing = step !== null || Boolean(status?.setupStep)

  const setup = async (): Promise<void> => {
    setStep('Starting…')
    const next = await window.api.browserControl.setup()
    setStep(null)
    setStatus(next)
    if (next.setupError) notify(`Setup didn't finish: ${next.setupError}`, 'error')
    else notify('Browser control is ready.', 'done')
  }

  const chosen = status?.browsers.find((b) => b.id === setting.browser) ?? status?.browsers.find((b) => b.debugging) ?? status?.browsers[0] ?? null
  const ready = Boolean(status?.installed && setting.enabled)

  return (
    <>
      <h1 className="settings__h1">Browser control</h1>
      <p className="settings__lede">
        Lets the agent work in your own browser, with your logins, when you ask it to. Eaon uses{' '}
        <button type="button" className="link-btn" onClick={() => void window.api.app.openExternal('https://github.com/browser-use/browser-use')}>
          Browser Use
        </button>{' '}
        for this. There's no extension to install: your browser lets Eaon in through its own remote debugging switch, and asks you to Allow each time Eaon connects.
      </p>

      <Section label="Setup">
        <Card>
          <Row
            title="Browser Use"
            description={
              installing
                ? (step ?? status?.setupStep ?? 'Setting up…')
                : status?.installed
                  ? `Set up (version ${status.version}). It and its own Python live in Eaon's folder.`
                  : 'Downloads Browser Use and a Python of its own into Eaon’s folder, about 330 MB. Takes a minute; nothing else on your computer changes.'
            }
          >
            {installing ? (
              <Loader2 size={16} strokeWidth={2} className="spinner" />
            ) : status?.installed ? (
              <Switch label="Browser control" checked={setting.enabled} onChange={(on) => void patchSettings({ browserUse: { ...setting, enabled: on } })} />
            ) : (
              <button type="button" className="btn btn--accent" onClick={() => void setup()}>
                Set up
              </button>
            )}
          </Row>
          {status?.setupError && !installing && (
            <Row title="Setup didn't finish" description={status.setupError}>
              <button type="button" className="btn" onClick={() => void setup()}>
                <RefreshCw size={14} strokeWidth={1.9} />
                Try again
              </button>
            </Row>
          )}
        </Card>
      </Section>

      {ready && (
        <Section label="Your browser">
          <Card>
            {status!.browsers.length === 0 ? (
              <Row title="No browser found" description="Browser control works with Chrome and browsers built on it: Edge, Brave, Arc, Comet, Vivaldi, Chromium." />
            ) : (
              <>
                <Row title="Browser" description="The one the agent uses. Automatic picks whichever allows remote debugging.">
                  <Select
                    value={setting.browser ?? 'auto'}
                    width={180}
                    options={[{ value: 'auto', label: 'Automatic' }, ...status!.browsers.map((b) => ({ value: b.id, label: b.name }))]}
                    onChange={(value) => void patchSettings({ browserUse: { ...setting, browser: value === 'auto' ? null : value } }).then(refresh)}
                  />
                </Row>
                {chosen && (
                  <Row
                    title="Remote debugging"
                    description={
                      chosen.debugging
                        ? `${chosen.name} allows it. When the agent first uses your browser, ${chosen.name} asks you to Allow the connection.`
                        : `Open ${chosen.name}, then turn on “Allow remote debugging” on the page this opens. You do this once; ${chosen.name} remembers it.`
                    }
                  >
                    {chosen.debugging ? (
                      <span className="badge badge--ok">
                        <Check size={12} strokeWidth={2.4} /> Allowed
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn"
                        onClick={() =>
                          void window.api.browserControl.openInspect(chosen.id).then((r) => {
                            if (!r.ok) notify(r.error ?? `Couldn't open ${chosen.name}.`, 'error')
                          })
                        }
                      >
                        <ExternalLink size={14} strokeWidth={1.9} />
                        Open the switch in {chosen.name}
                      </button>
                    )}
                  </Row>
                )}
                {status!.connected && (
                  <Row title="Connected" description="The agent is attached to your browser now. Disconnect, and the next use asks you to Allow again.">
                    <button type="button" className="btn" onClick={() => void window.api.browserControl.disconnect().then(setStatus)}>
                      Disconnect
                    </button>
                  </Row>
                )}
              </>
            )}
          </Card>
        </Section>
      )}

      {status?.installed && (
        <Section label="Remove">
          <Card>
            <Row title="Remove Browser Use" description="Deletes Browser Use and its Python from Eaon’s folder and turns browser control off. You can set it up again any time.">
              <button type="button" className="btn btn--danger" onClick={() => void window.api.browserControl.remove().then(setStatus)}>
                Remove
              </button>
            </Row>
          </Card>
        </Section>
      )}

      <p className="settings__fine">
        Had the Eaon extension installed? It isn't used any more; you can remove it from your browser's Extensions page.
      </p>
    </>
  )
}
