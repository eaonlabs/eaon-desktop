import { useMemo, useState } from 'react'
import { Card, SearchField, Section } from '../../ui'
import { CHAT_SHORTCUTS, COMPOSER_SHORTCUTS, SHORTCUTS, formatShortcut, isMacPlatform, type Shortcut } from '../../../lib/keys'
import { holdKeyLabel } from '@shared/holdKey'
import { useHoldSetting } from '../../composer/useHoldToTalk'
import { useApp } from '../../../state/store'

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
  const chat = match(CHAT_SHORTCUTS)
  const composer = match(COMPOSER_SHORTCUTS)
  // Hold to talk is the one key that can be changed, in Settings → General.
  const hold = useHoldSetting()
  const holdKey = holdKeyLabel(hold.key, mac)
  const holdShown = hold.enabled && (!query.trim() || `hold to talk dictate speech ${holdKey}`.toLowerCase().includes(query.trim().toLowerCase()))

  return (
    <>
      <h1 className="settings__h1">Keyboard shortcuts</h1>
      <p className="settings__lede">Shortcuts can't be changed yet, apart from the hold-to-talk key.</p>

      <div style={{ margin: '22px 0 22px' }}>
        <SearchField value={query} onChange={setQuery} placeholder="Search shortcuts" />
      </div>

      {app.length > 0 && (
        <Section label="App">
          <ShortcutList shortcuts={app} mac={mac} />
        </Section>
      )}
      {chat.length > 0 && (
        <Section label="Chat">
          <ShortcutList shortcuts={chat} mac={mac} />
        </Section>
      )}
      {composer.length > 0 && (
        <Section label="Message box">
          <ShortcutList shortcuts={composer} mac={mac} />
        </Section>
      )}
      {holdShown && (
        <Section label="Speech to text">
          <Card>
            <div className="shortcut-row">
              <div className="shortcut-row__body">
                <div className="row__title">Hold to talk, in Chat, Workers and the ADE</div>
                <div className="row__desc">
                  Hold it and speak; let go to put the words in.{' '}
                  <button type="button" className="link-btn" onClick={() => useApp.getState().setSettingsPage('general')}>
                    Change the key in General
                  </button>
                </div>
              </div>
              <kbd className="keycap">Hold {holdKey}</kbd>
            </div>
          </Card>
        </Section>
      )}
      {app.length === 0 && chat.length === 0 && composer.length === 0 && !holdShown && <p className="settings__lede">No shortcut matches “{query.trim()}”.</p>}
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
