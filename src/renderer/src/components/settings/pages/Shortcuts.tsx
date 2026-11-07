import { useEffect, useMemo, useState, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Card, ConfirmDialog, SearchField, Section } from '../../ui'
import { CHAT_SHORTCUTS, COMPOSER_SHORTCUTS, SHORTCUTS, formatShortcut, isMacPlatform, type Shortcut } from '../../../lib/keys'
import { keyOf } from '../../../lib/bindings'
import {
  BINDABLE,
  bindable,
  conflictsFor,
  effectiveBinding,
  formatBinding,
  isDefaultBinding,
  recordBinding,
  type BindableShortcut
} from '@shared/keybindings'
import { holdKeyLabel } from '@shared/holdKey'
import { useHoldSetting } from '../../composer/useHoldToTalk'
import { useApp } from '../../../state/store'

/**
 * The shortcuts Eaon has, written for this platform, and the keys of the ones
 * that can be changed: click a key, press the new one. A key already used by
 * another command is said so before it is taken (that command loses it).
 * What can be changed, and the rules, are shared/keybindings.ts; every place
 * that listens for a key reads it from there, so a change works at once.
 *
 * The keys that are fixed (the editing keys of every text field, the message
 * box's Enter) are listed so the page is complete.
 */
export function ShortcutsPage(): JSX.Element {
  const [query, setQuery] = useState('')
  const mac = isMacPlatform()
  const { saved, patchSettings } = useApp(useShallow((s) => ({ saved: s.settings?.shortcuts, patchSettings: s.patchSettings })))
  // The key being chosen for a command, and a choice waiting on the user's answer about a clash.
  const [listening, setListening] = useState<string | null>(null)
  const [message, setMessage] = useState<{ id: string; text: string } | null>(null)
  const [clash, setClash] = useState<{ id: string; binding: string; others: BindableShortcut[] } | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)

  const setKeys = (keys: Record<string, string | null>): void => void patchSettings({ shortcuts: keys })

  /** Gives `id` a key (null: none), after saying so if another command has it. */
  const choose = (id: string, binding: string | null): void => {
    setMessage(null)
    const others = binding ? conflictsFor(id, binding, saved, mac) : []
    if (others.length > 0 && binding) return setClash({ id, binding, others })
    setClash(null)
    setKeys({ [id]: binding })
  }

  // Choosing a key: the next chord pressed, if it can be a shortcut.
  useEffect(() => {
    if (!listening) return
    const onKey = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        setListening(null)
        setMessage(null)
        return
      }
      if ((event.key === 'Backspace' || event.key === 'Delete') && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        choose(listening, null)
        setListening(null)
        return
      }
      const recorded = recordBinding(keyOf(event), mac)
      if ('waiting' in recorded) return
      if (!recorded.ok) return setMessage({ id: listening, text: recorded.error })
      choose(listening, recorded.binding)
      setListening(null)
    }
    window.addEventListener('keydown', onKey, true)
    // The app menu takes the keys it has before the page sees them, so while one is being chosen it lets go of them.
    void window.api.app.shortcutsRecording(true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      void window.api.app.shortcutsRecording(false)
    }
    // `choose` reads the saved keys as they are when a key is pressed; only `listening` starts and stops this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listening, saved, mac])

  const q = query.trim().toLowerCase()
  const shown = (id: string, label: string, key: string): boolean => !q || label.toLowerCase().includes(q) || key.toLowerCase().includes(q) || id.includes(q)

  const sections = useMemo(() => {
    const row = (entry: BindableShortcut): Row => ({ id: entry.id, label: entry.label, entry })
    const fixed = (list: Shortcut[]): Row[] => list.filter((s) => !bindable(s.id)).map((s) => ({ id: s.id, label: s.label, fixed: formatShortcut(s, mac) }))
    return {
      app: [...BINDABLE.filter((e) => e.section === 'app').map(row), ...fixed(SHORTCUTS)],
      chat: [...BINDABLE.filter((e) => e.section === 'chat').map(row), ...fixed(CHAT_SHORTCUTS)],
      composer: COMPOSER_SHORTCUTS.map((s): Row => ({ id: s.id, label: s.label, fixed: formatShortcut(s, mac) }))
    }
  }, [mac])

  const keyText = (row: Row): string => (row.entry ? formatBinding(effectiveBinding(row.entry.id, saved, mac), mac) : (row.fixed ?? ''))
  const visible = (rows: Row[]): Row[] => rows.filter((row) => shown(row.id, row.label, keyText(row)))
  const app = visible(sections.app)
  const chat = visible(sections.chat)
  const composer = visible(sections.composer)

  // Hold to talk is a key held on its own, changed in Settings → General.
  const hold = useHoldSetting()
  const holdKey = holdKeyLabel(hold.key, mac)
  const holdShown = hold.enabled && (!q || `hold to talk dictate speech ${holdKey}`.toLowerCase().includes(q))
  const anyChanged = BINDABLE.some((entry) => !isDefaultBinding(entry.id, saved, mac))

  const list = (rows: Row[]): JSX.Element => (
    <Card>
      {rows.map((row) => {
        const entry = row.entry
        const binding = entry ? effectiveBinding(entry.id, saved, mac) : null
        const changed = entry ? !isDefaultBinding(entry.id, saved, mac) : false
        const asking = entry && clash?.id === entry.id ? clash : null
        const warning = entry && message?.id === entry.id ? message.text : null
        return (
          <div key={row.id}>
            <div className="shortcut-row">
              <div className="shortcut-row__body">
                <div className="row__title">{row.label}</div>
                {listening === row.id && (
                  <div className="row__desc" aria-live="polite">
                    Press the new key with {mac ? '⌘' : 'Ctrl'}. Esc cancels, Delete removes the key.
                  </div>
                )}
                {warning && (
                  <div className="row__desc shortcut-row__warn" role="alert">
                    {warning}
                  </div>
                )}
              </div>
              {entry ? (
                <div className="shortcut-row__edit">
                  {changed && listening !== row.id && (
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => {
                        setListening(null)
                        choose(entry.id, entry.default)
                      }}
                      aria-label={`Reset ${row.label} to ${formatBinding(entry.default, mac)}`}
                    >
                      Reset
                    </button>
                  )}
                  <button
                    type="button"
                    className={`keycap keycap--button${binding ? '' : ' keycap--empty'}`}
                    data-listening={listening === row.id || undefined}
                    aria-label={`${row.label}: ${binding ? formatBinding(binding, mac) : 'no key'}. Change`}
                    onClick={() => {
                      setClash(null)
                      setMessage(null)
                      setListening((now) => (now === row.id ? null : row.id))
                    }}
                  >
                    {listening === row.id ? 'Press a key…' : binding ? formatBinding(binding, mac) : 'None'}
                  </button>
                </div>
              ) : (
                <kbd className="keycap">{row.fixed}</kbd>
              )}
            </div>
            {asking && (
              <div className="shortcut-row__clash" role="alert">
                <span>
                  {formatBinding(asking.binding, mac)} is already used by {asking.others.map((o) => o.label).join(' and ')}. Use it here and remove it there?
                </span>
                <span className="shortcut-row__clash-actions">
                  <button type="button" className="btn btn--sm" onClick={() => setClash(null)}>
                    Keep it as it was
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm btn--primary"
                    onClick={() => {
                      setKeys({ [asking.id]: asking.binding, ...Object.fromEntries(asking.others.map((o) => [o.id, null])) })
                      setClash(null)
                    }}
                  >
                    Use it here
                  </button>
                </span>
              </div>
            )}
          </div>
        )
      })}
    </Card>
  )

  return (
    <>
      <h1 className="settings__h1">Keyboard shortcuts</h1>
      <p className="settings__lede">
        Click a key to change it, then press the new one. A key another command already has is flagged before it is taken.{' '}
        <button type="button" className="link-btn" disabled={!anyChanged} onClick={() => setConfirmAll(true)}>
          Reset all shortcuts
        </button>
      </p>

      <div style={{ margin: '22px 0 22px' }}>
        <SearchField value={query} onChange={setQuery} placeholder="Search shortcuts" />
      </div>

      {app.length > 0 && <Section label="App">{list(app)}</Section>}
      {chat.length > 0 && <Section label="Chat">{list(chat)}</Section>}
      {composer.length > 0 && <Section label="Message box">{list(composer)}</Section>}
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

      <ConfirmDialog
        open={confirmAll}
        title="Reset all shortcuts?"
        confirmLabel="Reset shortcuts"
        danger={false}
        onConfirm={() => setKeys(Object.fromEntries(BINDABLE.map((entry) => [entry.id, entry.default])))}
        onClose={() => setConfirmAll(false)}
      >
        Every shortcut goes back to the key it came with. Nothing else in Settings changes.
      </ConfirmDialog>
    </>
  )
}

interface Row {
  id: string
  label: string
  /** Set for a shortcut that can be changed. */
  entry?: BindableShortcut
  /** The written key of one that can't. */
  fixed?: string
}
