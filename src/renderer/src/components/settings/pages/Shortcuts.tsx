import { useMemo, useState } from 'react'
import { Card, SearchField, Section } from '../../ui'
import { COMPOSER_SHORTCUTS, SHORTCUTS, formatShortcut, isMacPlatform, type Shortcut } from '../../../lib/keys'

/**
 * The shortcuts Eaon has, written for this platform. This page used to offer
 * sixteen editable bindings, saved to settings and applied by nothing, for
 * features that mostly don't exist (quick chat, side chats, mark as unread),
 * and one (⌥⌘N) that clashed with New Window. Until rebinding is real it
 * lists the keys that work, from the same list the app uses.
 */
export function ShortcutsPage(): JSX.Element {
  const [query, setQuery] = useState('')
  const mac = isMacPlatform()

  const match = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (list: Shortcut[]): Shortcut[] =>
      q ? list.filter((s) => s.label.toLowerCase().includes(q) || formatShortcut(s, mac).toLowerCase().includes(q)) : list
  }, [query, mac])

  const app = match(SHORTCUTS)
  const composer = match(COMPOSER_SHORTCUTS)

  return (
    <>
      <h1 className="settings__h1">Keyboard shortcuts</h1>
      <p className="settings__lede">Shortcuts can't be changed yet.</p>

      <div style={{ margin: '22px 0 22px' }}>
        <SearchField value={query} onChange={setQuery} placeholder="Search shortcuts" />
      </div>

      {app.length > 0 && (
        <Section label="App">
          <ShortcutList shortcuts={app} mac={mac} />
        </Section>
      )}
      {composer.length > 0 && (
        <Section label="Message box">
          <ShortcutList shortcuts={composer} mac={mac} />
        </Section>
      )}
      {app.length === 0 && composer.length === 0 && <p className="settings__lede">No shortcut matches “{query.trim()}”.</p>}
    </>
  )
}

function ShortcutList({ shortcuts, mac }: { shortcuts: Shortcut[]; mac: boolean }): JSX.Element {
  return (
    <Card>
      {shortcuts.map((shortcut) => (
        <div className="shortcut-row" key={shortcut.id}>
          <div className="shortcut-row__body">
            <div className="row__title">{shortcut.label}</div>
          </div>
          <kbd className="keycap">{formatShortcut(shortcut, mac)}</kbd>
        </div>
      ))}
    </Card>
  )
}
