import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useApp } from '../../../state/store'
import { Card, Row, Section, Select } from '../../ui'
import { formatShortcut, isMacPlatform } from '../../../lib/keys'
import { SEARCH_ENGINES, isSearchEngine, toBrowserUrl, type SearchEngine } from '../../../lib/browserUrl'

/* -------------------------------------------------------- Browser settings */

/**
 * The built-in browser panel (BrowserPanel.tsx). Both settings here are read
 * by it. "Block trackers" and "Show Chrome import banner" were removed in
 * 2026.6.2: nothing blocked trackers, and the banner's Import button only hid
 * the banner. An unlinked "Appshots" page went with them.
 */
export function BrowserSettingsPage(): JSX.Element {
  const { settings, patchSettings } = useApp(useShallow((s) => ({ settings: s.settings, patchSettings: s.patchSettings })))
  const saved = settings?.browser.homepage ?? ''
  // Saved when the field is left or Enter is pressed, not on every keystroke,
  // so a half-typed address is never what a new tab opens.
  const [homepage, setHomepage] = useState(saved)
  useEffect(() => setHomepage(saved), [saved])

  const engine: SearchEngine = isSearchEngine(settings?.browser.searchEngine) ? settings.browser.searchEngine : 'DuckDuckGo'
  const typed = homepage.trim()
  const opens = typed ? toBrowserUrl(typed, engine) : null
  const save = (): void => {
    if (typed !== saved) void patchSettings({ browser: { homepage: typed } })
  }

  return (
    <>
      <h1 className="settings__h1">Browser</h1>
      <p className="settings__lede">
        The browser panel beside a chat. Open it from the message box's + menu, or with{' '}
        {formatShortcut({ modifiers: ['shift', 'mod'], key: 'B' }, isMacPlatform())}.
      </p>
      <Section>
        <Card>
          <Row title="Search engine" description="Used when you type something that isn't a web address">
            <Select
              value={engine}
              onChange={(searchEngine) => void patchSettings({ browser: { searchEngine } })}
              options={(Object.keys(SEARCH_ENGINES) as SearchEngine[]).map((name) => ({ value: name, label: name }))}
            />
          </Row>
          <Row
            title="Homepage"
            description={
              opens && opens !== typed ? `New tabs open ${opens}` : 'Opened in each new tab. Leave empty for a blank tab.'
            }
          >
            <input
              className="input"
              style={{ width: 260, maxWidth: '40vw' }}
              value={homepage}
              placeholder="example.com"
              aria-label="Homepage"
              spellCheck={false}
              onChange={(e) => setHomepage(e.target.value)}
              onBlur={save}
              onKeyDown={(e) => e.key === 'Enter' && save()}
            />
          </Row>
        </Card>
      </Section>
    </>
  )
}
