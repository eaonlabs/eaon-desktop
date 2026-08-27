import { useEffect, useState } from 'react'
import { useApp, useIsWork } from '../../../state/store'
import { Card, Row, Section, Select, Switch } from '../../ui'
import { ExternalLink, Github } from 'lucide-react'

export function GeneralPage(): JSX.Element {
  const { settings, patchSettings } = useApp()
  const isWork = useIsWork()
  const update = useApp((s) => s.updateStatus)
  const [version, setVersion] = useState('')

  useEffect(() => {
    void window.api.app.version().then(setVersion)
  }, [])

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
          <Row
            title="Default permissions"
            description="By default, the assistant can read and edit files in its workspace. It can ask for additional access when needed"
          >
            <Switch
              label="Default permissions"
              checked={!g.fullAccess}
              dimmed
              disabled
              onChange={() => undefined}
            />
          </Row>
          <Row
            title="Full access"
            description="When the assistant runs with full access, it can edit any file on your computer and run commands with network, without your approval. This significantly increases the risk of data loss, leaks, or unexpected behavior."
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
          <Row title="Default file open destination" description="Where files and folders open by default">
            <Select
              value={g.fileOpenDestination}
              onChange={(value) => void patchSettings({ general: { fileOpenDestination: value } })}
              options={[
                { value: 'VS Code', label: 'VS Code' },
                { value: 'Cursor', label: 'Cursor' },
                { value: 'Zed', label: 'Zed' },
                { value: 'Xcode', label: 'Xcode' },
                { value: 'Finder', label: 'Finder' },
                { value: 'Terminal', label: 'Terminal' }
              ]}
            />
          </Row>
          <Row title="Language" description="Language for the app UI">
            <Select
              value={g.language}
              onChange={(value) => void patchSettings({ general: { language: value } })}
              options={[
                { value: 'Auto detect', label: 'Auto detect' },
                { value: 'English', label: 'English' },
                { value: 'Deutsch', label: 'Deutsch' },
                { value: 'Español', label: 'Español' },
                { value: 'Français', label: 'Français' },
                { value: '日本語', label: '日本語' }
              ]}
            />
          </Row>
          <Row title="Show in menu bar" description="Keep the app in the macOS menu bar when the main window is closed">
            <Switch
              label="Show in menu bar"
              checked={g.showInMenuBar}
              onChange={(on) => void patchSettings({ general: { showInMenuBar: on } })}
            />
          </Row>
          <Row title="Bottom panel" description="Show the bottom panel control in the app header">
            <Switch
              label="Bottom panel"
              checked={g.bottomPanel}
              onChange={(on) => void patchSettings({ general: { bottomPanel: on } })}
            />
          </Row>
          <Row title="Prevent sleep while running" description="Keep your computer awake while the assistant is running a task">
            <Switch
              label="Prevent sleep while running"
              checked={g.preventSleep}
              onChange={(on) => void patchSettings({ general: { preventSleep: on } })}
            />
          </Row>
          <Row title="Suggested prompts" description="Suggest what to do next by searching project files and connected apps">
            <Switch
              label="Suggested prompts"
              checked={g.suggestedPrompts}
              onChange={(on) => void patchSettings({ general: { suggestedPrompts: on } })}
            />
          </Row>
          <Row title="Import work from other AI apps" description="Bring over your setup, projects, and recent chats">
            <button className="btn">Import</button>
          </Row>
          <Row title="Open source licenses" description="Third-party notices for bundled dependencies">
            <button
              className="btn"
              onClick={() => void window.api.app.openExternal('https://opensource.org/licenses/MIT')}
            >
              View
            </button>
          </Row>
          <Row title="Launch at login" description="Start the app when you log in to your Mac">
            <Switch
              label="Launch at login"
              checked={g.launchAtLogin}
              onChange={(on) => void patchSettings({ general: { launchAtLogin: on } })}
            />
          </Row>
        </Card>
      </Section>

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
          {update.state === 'error' && <Row title="Update check failed" description={update.message} />}
        </Card>
      </Section>

      <Section label="Resources">
        <Card>
          <Row title="Documentation" description="Learn how to use Eaon and explore its features.">
            <button className="btn btn--ghost btn--sm" onClick={() => void window.api.app.openExternal('https://github.com/sanscreates/eaon-desktop#readme')}>
              View Docs
              <ExternalLink size={13} strokeWidth={1.9} />
            </button>
          </Row>
          <Row title="Release Notes" description="See what's new in the latest version of Eaon.">
            <button className="btn btn--ghost btn--sm" onClick={() => void window.api.app.openExternal('https://github.com/sanscreates/eaon-desktop/releases')}>
              View Releases
              <ExternalLink size={13} strokeWidth={1.9} />
            </button>
          </Row>
        </Card>
      </Section>

      <Section label="Community">
        <Card>
          <Row title="GitHub" description="Contribute to Eaon's development.">
            <button
              className="icon-btn"
              aria-label="Open GitHub repository"
              onClick={() => void window.api.app.openExternal('https://github.com/sanscreates/eaon-desktop')}
            >
              <Github size={16} strokeWidth={1.9} />
            </button>
          </Row>
        </Card>
      </Section>

      <Section label="Support">
        <Card>
          <Row title="Report an Issue" description="Found a bug? Help us out by filing an issue on GitHub.">
            <button className="btn btn--ghost btn--sm" onClick={() => void window.api.app.openExternal('https://github.com/sanscreates/eaon-desktop/issues')}>
              Report Issue
              <ExternalLink size={13} strokeWidth={1.9} />
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
