import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useApp, useIsWork } from '../../../state/store'
import { Card, ErrorDetails, Modal, Row, Section, Select, Switch } from '../../ui'
import { LinkAccounts } from '../../LinkAccounts'
import { ExternalLink, Github, Star } from 'lucide-react'
import type { LaunchMode } from '@shared/types'
import { DOCS_URL, ISSUES_URL, RELEASES_URL, REPO_URL } from '@shared/links'
import { errorText, explainUpdateError } from '../../../lib/errors'
import { CreditsSection } from './Credits'

export function GeneralPage(): JSX.Element {
  const { settings, patchSettings } = useApp(useShallow((s) => ({ settings: s.settings, patchSettings: s.patchSettings })))
  const isWork = useIsWork()
  const update = useApp((s) => s.updateStatus)
  const [version, setVersion] = useState('')
  const [confirmStable, setConfirmStable] = useState(false)
  // A beta, release candidate or other prerelease: `2026.6.2-beta.3`.
  const isBeta = /^\d+\.\d+\.\d+-[0-9A-Za-z]/.test(version)
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
          {isBeta && (
            <Row
              title="Go back to the stable version"
              description="You’re on a beta, which can be unstable. This downloads the latest stable release and installs it when Eaon restarts."
            >
              <button className="btn" onClick={() => setConfirmStable(true)}>
                Switch to stable
              </button>
            </Row>
          )}
        </Card>
      </Section>
      <Modal
        open={confirmStable}
        onClose={() => setConfirmStable(false)}
        title="Go back to the stable version?"
        width={460}
        actions={
          <>
            <button className="btn btn--ghost" onClick={() => setConfirmStable(false)}>
              Stay on the beta
            </button>
            <button
              className="btn btn--primary"
              onClick={() => {
                setConfirmStable(false)
                window.api.updater.switchToStable().catch(() => undefined)
              }}
            >
              Download the stable version
            </button>
          </>
        }
      >
        <p style={{ margin: 0, lineHeight: 1.45 }}>
          Eaon downloads the latest stable release and installs it when you restart. Your chats stay, but things the beta added (such as new worker threads and
          ADE sessions) may not show in the older version, so copy <code>~/Library/Application Support/Eaon</code> first if it holds anything you care about.
        </p>
      </Modal>

      <BetaUpdates version={version} />

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
          <Row title="Star Eaon" description="Opens the repository, and stars it for you if the GitHub CLI is signed in on this computer.">
            <button className="btn btn--ghost btn--sm" onClick={() => void window.api.star.answer('star')}>
              <Star size={13} strokeWidth={1.9} />
              Star on GitHub
            </button>
          </Row>
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

      <CreditsSection />
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

/**
 * Beta updates, apart from the stable ones above: switched on here, and then
 * a newer beta is offered with its own Download button. Nothing is downloaded
 * until it is pressed, and what is installed stays what you chose.
 */
function BetaUpdates({ version }: { version: string }): JSX.Element {
  const { settings, patchSettings } = useApp(useShallow((s) => ({ settings: s.settings, patchSettings: s.patchSettings })))
  const beta = useApp((s) => s.betaStatus)
  // A beta build already follows betas and stable releases by itself.
  const onBeta = /^\d+\.\d+\.\d+-/.test(version)
  const enabled = settings?.updates.beta ?? false

  const turn = (on: boolean): void => {
    void patchSettings({ updates: { beta: on } }).then(() => window.api.updater.betaChanged())
  }

  return (
    <Section label="Beta updates">
      <Card>
        {onBeta ? (
          <Row
            title="You're on a beta build"
            description="Its updates follow betas and stable releases, so a newer beta arrives with the usual update above."
          />
        ) : (
          <>
            <Row
              title="Install beta updates"
              description="Be told when a beta is out. It's an early build for testing and can have bugs. It's never downloaded unless you press Download, and your chats and settings carry over."
            >
              <Switch label="Install beta updates" checked={enabled} onChange={turn} />
            </Row>
            {enabled && beta.state === 'checking' && <Row title="Looking for a beta…" />}
            {enabled && beta.state === 'available' && (
              <Row title={`Beta ${beta.version} is out`} description="Download it now, then restart Eaon to switch to it.">
                <button className="btn btn--accent" onClick={() => void window.api.updater.downloadBeta()}>
                  Download beta
                </button>
              </Row>
            )}
            {enabled && beta.state === 'downloading' && (
              <Row title="Downloading the beta…" description={`${beta.percent}% — keep using Eaon, this runs in the background`} />
            )}
            {enabled && beta.state === 'downloaded' && (
              <Row title="Beta ready" description={`Version ${beta.version} installs when you restart`}>
                <button className="btn btn--accent" onClick={() => void window.api.updater.install()}>
                  Restart & install
                </button>
              </Row>
            )}
            {enabled && (beta.state === 'idle' || beta.state === 'not-available') && (
              <Row
                title={beta.state === 'idle' ? 'No beta checked yet' : 'No newer beta'}
                description={beta.state === 'idle' ? undefined : 'You have the newest build, or there is no newer beta out right now.'}
              >
                <button className="btn btn--ghost btn--sm" onClick={() => void window.api.updater.checkBeta()}>
                  Check for betas
                </button>
              </Row>
            )}
            {enabled && beta.state === 'error' && (
              <Row title="Couldn't get the beta" description={beta.message}>
                <button className="btn btn--ghost btn--sm" onClick={() => void window.api.updater.checkBeta()}>
                  Try again
                </button>
              </Row>
            )}
          </>
        )}
      </Card>
    </Section>
  )
}
