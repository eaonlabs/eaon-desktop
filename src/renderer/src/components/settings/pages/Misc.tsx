import { useCallback, useState } from 'react'
import { useApp } from '../../../state/store'
import { Card, Row, Section, Select, Switch } from '../../ui'

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
