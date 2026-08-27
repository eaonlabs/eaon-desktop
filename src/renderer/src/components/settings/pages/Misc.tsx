import { useCallback, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { useApp } from '../../../state/store'
import { Card, Row, Section, Segmented, Select, Switch } from '../../ui'

/** Renderer-local preferences for the secondary settings pages. */
function useLocal<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(`pref:${key}`)
      return raw === null ? initial : (JSON.parse(raw) as T)
    } catch {
      return initial
    }
  })
  const update = useCallback(
    (next: T) => {
      setValue(next)
      try {
        localStorage.setItem(`pref:${key}`, JSON.stringify(next))
      } catch {
        /* storage can be unavailable; the in-memory value still applies */
      }
    },
    [key]
  )
  return [value, update]
}

/* ------------------------------------------------------------ Computer use */

export function ComputerUsePage(): JSX.Element {
  const [enabled, setEnabled] = useLocal('cu.enabled', false)
  const [confirmClicks, setConfirmClicks] = useLocal('cu.confirm', true)
  const [quality, setQuality] = useLocal<'balanced' | 'sharp'>('cu.quality', 'balanced')

  return (
    <>
      <h1 className="settings__h1">Computer use</h1>
      <p className="settings__lede">Let the assistant see your screen and drive the pointer and keyboard.</p>
      <Section label="Access">
        <Card>
          <Row title="Enable computer use" description="Requires Screen Recording and Accessibility permission in System Settings">
            <Switch label="Enable computer use" checked={enabled} onChange={setEnabled} />
          </Row>
          <Row title="Confirm before each click" description="Ask before the assistant clicks or types on your behalf">
            <Switch label="Confirm before each click" checked={confirmClicks} dimmed={!enabled} onChange={setConfirmClicks} />
          </Row>
          <Row title="Screenshot quality" description="Sharper screenshots cost more tokens per step">
            <Segmented
              value={quality}
              onChange={setQuality}
              options={[
                { value: 'balanced', label: 'Balanced' },
                { value: 'sharp', label: 'Sharp' }
              ]}
            />
          </Row>
          <Row title="System permissions" description="Open the macOS privacy panel to grant access">
            <button
              className="btn"
              onClick={() =>
                void window.api.app.openExternal(
                  'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
                )
              }
            >
              Open
              <ExternalLink size={13} strokeWidth={1.9} />
            </button>
          </Row>
        </Card>
      </Section>
    </>
  )
}

/* ---------------------------------------------------------------- Appshots */

export function AppshotsPage(): JSX.Element {
  const [capture, setCapture] = useLocal('appshots.capture', true)
  const [retain, setRetain] = useLocal('appshots.retain', '30 days')

  return (
    <>
      <h1 className="settings__h1">Appshots</h1>
      <p className="settings__lede">Snapshots of app windows the assistant captured while working.</p>
      <Section>
        <Card>
          <Row title="Capture app windows" description="Save a snapshot whenever a window is attached to a chat">
            <Switch label="Capture app windows" checked={capture} onChange={setCapture} />
          </Row>
          <Row title="Keep snapshots for" description="Older snapshots are deleted automatically">
            <Select
              value={retain}
              onChange={setRetain}
              options={[
                { value: '7 days', label: '7 days' },
                { value: '30 days', label: '30 days' },
                { value: 'Forever', label: 'Forever' }
              ]}
            />
          </Row>
          <Row title="Delete all snapshots" description="Remove every stored appshot from this computer">
            <button className="btn btn--danger">Delete</button>
          </Row>
        </Card>
      </Section>
    </>
  )
}

/* -------------------------------------------------------- Plugins settings */

export function PluginsSettingsPage(): JSX.Element {
  const { settings, patchSettings, setView } = useApp()
  const [autoUpdate, setAutoUpdate] = useLocal('plugins.autoUpdate', true)

  return (
    <>
      <h1 className="settings__h1">Plugins</h1>
      <p className="settings__lede">Manage which plugins, MCP servers, and skills the assistant can reach.</p>
      <Section>
        <Card>
          <Row title="Manage plugins" description="Turn individual plugins, MCP servers, and skills on or off">
            <button className="btn" onClick={() => setView('integrations')}>
              Open
            </button>
          </Row>
          <Row title="Auto-update plugins" description="Keep installed plugins on their latest version">
            <Switch label="Auto-update plugins" checked={autoUpdate} onChange={setAutoUpdate} />
          </Row>
          <Row
            title="Installed"
            description={`${settings?.installedPlugins.length ?? 0} plugins installed, ${
              settings?.disabledPlugins.length ?? 0
            } disabled`}
          >
            <button className="btn btn--ghost" onClick={() => void patchSettings({ disabledPlugins: [] })}>
              Enable all
            </button>
          </Row>
        </Card>
      </Section>
    </>
  )
}

/* -------------------------------------------------------- Browser settings */

export function BrowserSettingsPage(): JSX.Element {
  const { settings, patchSettings } = useApp()
  const [engine, setEngine] = useLocal('browser.engine', 'DuckDuckGo')
  const [blockTrackers, setBlockTrackers] = useLocal('browser.blockTrackers', true)

  return (
    <>
      <h1 className="settings__h1">Browser</h1>
      <p className="settings__lede">The built-in browser the assistant uses to read and act on the web.</p>
      <Section>
        <Card>
          <Row title="Search engine" description="Used when you type something that isn't a URL">
            <Select
              value={engine}
              onChange={setEngine}
              options={[
                { value: 'DuckDuckGo', label: 'DuckDuckGo' },
                { value: 'Google', label: 'Google' },
                { value: 'Bing', label: 'Bing' }
              ]}
            />
          </Row>
          <Row title="Homepage" description="Opened when a new tab starts">
            <input
              className="input"
              style={{ width: 260 }}
              value={settings?.browser.homepage ?? ''}
              placeholder="https://"
              spellCheck={false}
              onChange={(e) => void patchSettings({ browser: { homepage: e.target.value } })}
            />
          </Row>
          <Row title="Block trackers" description="Strip known tracking requests in the built-in browser">
            <Switch label="Block trackers" checked={blockTrackers} onChange={setBlockTrackers} />
          </Row>
          <Row title="Show Chrome import banner" description="Offer to bring over passwords and cookies">
            <Switch
              label="Show Chrome import banner"
              checked={!settings?.browser.dismissedImportBanner}
              onChange={(on) => void patchSettings({ browser: { dismissedImportBanner: !on } })}
            />
          </Row>
        </Card>
      </Section>
    </>
  )
}
