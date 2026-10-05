import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useApp, useIsWork } from '../../../state/store'
import { Card, ErrorDetails, Row, Section, Select, Switch } from '../../ui'
import { LinkAccounts } from '../../LinkAccounts'
import { ExternalLink, Github } from 'lucide-react'
import type { LaunchMode } from '@shared/types'
import { DOCS_URL, ISSUES_URL, RELEASES_URL, REPO_URL } from '@shared/links'
import { errorText, explainUpdateError } from '../../../lib/errors'

export function GeneralPage(): JSX.Element {
  const { settings, patchSettings } = useApp(useShallow((s) => ({ settings: s.settings, patchSettings: s.patchSettings })))
  const isWork = useIsWork()
  const update = useApp((s) => s.updateStatus)
  const [version, setVersion] = useState('')
  // The same switch as Scheduled → Keep running in the background: one setting, two places.
  const [background, setBackground] = useState<{ supported: boolean; enabled: boolean } | null>(null)
  const [backgroundError, setBackgroundError] = useState<string | null>(null)
  const [linking, setLinking] = useState(false)

  useEffect(() => {
    void window.api.app.version().then(setVersion)
    void window.api.app.background().then(setBackground)
  }, [])

  const setLaunchAtLogin = (on: boolean): void => {
    setBackgroundError(null)
    window.api.app.setBackground(on).then(setBackground, (error: unknown) =>
      setBackgroundError(`Couldn't ${on ? 'turn on' : 'turn off'} launch at login: ${errorText(error)}`)
    )
  }

  if (!settings) return <></>
  const g = settings.general

  return (
    <>
      <h1 className="settings__h1">General</h1>

      {/* Describes exactly the local file/command permission model that only
          exists for Eaon Work's tools — meaningless copy in chat mode. */}
      {isWork && (
      <Section label="Permissions">
        <Card>
          {/* What fullAccess really gates (localTools.ts riskyPath): the
              "outside the work folder" check. It used to promise commands with
              network and no approvals at all, which it never did. A disabled
              "Default permissions" switch beside it only mirrored this one. */}
          <Row
            title="Full access"
            description="Off: changing anything outside the assistant's work folder always asks you first. On: it can change files anywhere on your computer, following your usual approval setting. Risky commands always ask."
          >
            <Switch
              label="Full access"
              checked={g.fullAccess}
              onChange={(on) => void patchSettings({ general: { fullAccess: on } })}
            />
          </Row>
        </Card>
      </Section>
      )}

      <Section label="General">
        <Card>
          <Row title="Open on launch" description="The mode Eaon opens in when it starts">
            <Select
              value={g.launchMode ?? 'chat'}
              onChange={(value) => void patchSettings({ general: { launchMode: value as LaunchMode } })}
              options={[
                { value: 'chat', label: 'Chat' },
                { value: 'workers', label: 'Workers' },
                { value: 'ade', label: 'ADE' },
                { value: 'last', label: 'Where I left off' }
              ]}
            />
          </Row>
          <Row title="Prevent sleep while running" description="Keep your computer awake while the assistant is running a task">
            <Switch
              label="Prevent sleep while running"
              checked={g.preventSleep}
              onChange={(on) => void patchSettings({ general: { preventSleep: on } })}
            />
          </Row>
          <Row title="Suggested prompts" description="Show starter prompts under the message box on the home screen">
            <Switch
              label="Suggested prompts"
              checked={g.suggestedPrompts}
              onChange={(on) => void patchSettings({ general: { suggestedPrompts: on } })}
            />
          </Row>
          {/* Accounts only: chats and projects stay in the other apps. Reading
              another app's stored sign-in to "import" it can get the account
              banned, so Link accounts uses each provider's own sign-in. */}
          <Row
            title="Use your accounts from other AI apps"
            description="Finds the AI apps on this computer and signs in to their providers the official way. Chats and projects stay in those apps."
          >
            <button type="button" className="btn" onClick={() => setLinking(true)}>
              Link accounts
            </button>
          </Row>
          <Row title="License" description="Eaon's license and copyright notice, in its GitHub repository">
            <button type="button" className="btn" onClick={() => void window.api.app.openExternal(`${REPO_URL}/blob/main/NOTICE`)}>
              View
            </button>
          </Row>
          {background?.supported && (
            <Row
              title="Launch at login"
              description="Start Eaon in the background when you log in, without opening a window, so scheduled tasks run"
            >
              <Switch label="Launch at login" checked={background.enabled} onChange={setLaunchAtLogin} />
            </Row>
          )}
          {backgroundError && (
            <Row title={<span className="ch-error">{backgroundError}</span>} />
          )}
        </Card>
      </Section>
      <LinkAccounts open={linking} onClose={() => setLinking(false)} />

      <Section label="Software update">
        <Card>
          <Row title="Version" description={version ? `You're on version ${version}` : undefined}>
            <button
              className="btn"
              disabled={update.state === 'checking' || update.state === 'downloading'}
              onClick={() => void window.api.updater.check()}
            >
              {update.state === 'checking'
                ? 'Checking…'
                : update.state === 'downloading'
                  ? `Downloading… ${update.percent}%`
                  : 'Check for updates'}
            </button>
          </Row>
          {update.state === 'not-available' && (
            <Row title="Up to date" description="You have the latest version installed" />
          )}
          {update.state === 'available' && (
            <Row title="Update available" description={`Version ${update.version} is downloading in the background`} />
          )}
          {update.state === 'downloaded' && (
            <Row title="Update ready" description={`Version ${update.version} will install the next time the app restarts`}>
              <button className="btn" onClick={() => void window.api.updater.install()}>
                Restart & install
              </button>
            </Row>
          )}
          {update.state === 'error' && <UpdateError message={update.message} />}
        </Card>
      </Section>

      <Section label="Resources">
        <Card>
          <Row title="Documentation" description="How to install Eaon, pick models, and use Chat, Workers and the ADE">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => void window.api.app.openExternal(DOCS_URL)}>
              View docs
              <ExternalLink size={13} strokeWidth={1.9} aria-hidden />
            </button>
          </Row>
          <Row title="Release notes" description={version ? `What changed in Eaon ${version}` : "What's new in Eaon"}>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => void window.api.app.openReleaseNotes()}>
              View release notes
              <ExternalLink size={13} strokeWidth={1.9} aria-hidden />
            </button>
          </Row>
        </Card>
      </Section>

      <Section label="Community">
        <Card>
          <Row title="GitHub" description="Eaon's source code. Contributions are welcome.">
            <button
              type="button"
              className="icon-btn"
              aria-label="Open Eaon on GitHub"
              title="Open Eaon on GitHub"
              onClick={() => void window.api.app.openExternal(REPO_URL)}
            >
              <Github size={16} strokeWidth={1.9} />
            </button>
          </Row>
        </Card>
      </Section>

      <Section label="Support">
        <Card>
          <Row title="Report an issue" description="Found a bug? File an issue on GitHub. Include your Eaon version and what you were doing.">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => void window.api.app.openExternal(ISSUES_URL)}>
              Report issue
              <ExternalLink size={13} strokeWidth={1.9} aria-hidden />
            </button>
          </Row>
        </Card>
      </Section>

      <Section label="Credits">
        <p className="settings__lede">Built with Electron and React, connected to whichever AI provider you bring your own key for.</p>
      </Section>
    </>
  )
}

/** A failed update check or download, in plain words, with the raw error kept for bug reports. */
function UpdateError({ message }: { message: string }): JSX.Element {
  const explained = explainUpdateError(message)
  return (
    <div className="row row--stack">
      <div className="row__body">
        <div className="row__title">Update didn't finish</div>
        <div className="row__desc">{explained.message}</div>
        <ErrorDetails detail={message} />
      </div>
      {explained.offerDownload && (
        <button type="button" className="btn btn--sm" onClick={() => void window.api.app.openExternal(RELEASES_URL)}>
          Open releases page
          <ExternalLink size={13} strokeWidth={1.9} aria-hidden />
        </button>
      )}
    </div>
  )
}
