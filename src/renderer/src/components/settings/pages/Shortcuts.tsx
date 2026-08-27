import { useEffect, useMemo, useState } from 'react'
import { Pencil, Trash2, Zap } from 'lucide-react'
import { useApp } from '../../../state/store'
import { Card, Modal, SearchField } from '../../ui'

interface ShortcutDef {
  id: string
  label: string
  description: string
  /** Optional second binding shown beneath the first, as on "New chat". */
  altId?: string
}

const SHORTCUTS: ShortcutDef[] = [
  { id: 'new-chat', label: 'New chat', description: 'Start a new chat', altId: 'new-chat-alt' },
  { id: 'new-temporary-chat', label: 'New Temporary Chat', description: "Start a chat that won't appear in history" },
  { id: 'quick-chat', label: 'Quick chat', description: 'Start a lightweight chat in the quick composer' },
  { id: 'archive-chat', label: 'Archive chat', description: 'Archive the current chat' },
  { id: 'new-standalone-chat', label: 'New standalone chat', description: 'Start a new chat outside of any project' },
  { id: 'open-side-chat', label: 'Open side chat', description: 'Open the current chat in a side chat' },
  { id: 'mark-unread', label: 'Mark as unread', description: 'Mark the current chat as unread' },
  { id: 'open-new-window', label: 'Open in new window', description: 'Open the current chat in a new window' },
  { id: 'toggle-pin', label: 'Toggle pin', description: 'Pin or unpin the current chat' },
  { id: 'focus-browser-address-bar', label: 'Focus browser address bar', description: 'Focus the in-app browser address bar' },
  { id: 'focus-main-chat', label: 'Focus main chat', description: 'Move keyboard focus to the main chat composer' },
  { id: 'focus-side-chat', label: 'Focus side chat', description: 'Move keyboard focus to the side chat composer' },
  { id: 'toggle-sidebar', label: 'Toggle sidebar', description: 'Show or hide the chat sidebar' },
  { id: 'open-settings', label: 'Open settings', description: 'Open the settings window' },
  { id: 'search', label: 'Search', description: 'Search across chats and projects' }
]

export function ShortcutsPage(): JSX.Element {
  const { settings, patchSettings } = useApp()
  const [query, setQuery] = useState('')
  const [recording, setRecording] = useState<string | null>(null)
  const [captured, setCaptured] = useState<string | null>(null)

  useEffect(() => {
    if (!recording) return
    const onKey = (event: KeyboardEvent): void => {
      event.preventDefault()
      if (event.key === 'Escape') {
        setRecording(null)
        return
      }
      const combo = formatCombo(event)
      if (combo) setCaptured(combo)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return SHORTCUTS
    return SHORTCUTS.filter((s) => s.label.toLowerCase().includes(q) || s.description.toLowerCase().includes(q))
  }, [query])

  if (!settings) return <></>
  const bindings = settings.shortcuts

  const setBinding = (id: string, value: string | null): void =>
    void patchSettings({ shortcuts: { ...bindings, [id]: value } })

  return (
    <>
      <h1 className="settings__h1">Keyboard shortcuts</h1>

      <div style={{ margin: '30px 0 22px' }}>
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search shortcuts"
          trailing={
            <span style={{ position: 'absolute', right: 14, color: 'var(--text-3)', display: 'grid' }}>
              <Zap size={15} strokeWidth={1.9} />
            </span>
          }
        />
      </div>

      <Card>
        {results.map((shortcut) => (
          <div className="shortcut-row" key={shortcut.id}>
            <div className="shortcut-row__body">
              <div className="row__title">{shortcut.label}</div>
              <div className="row__desc">{shortcut.description}</div>
            </div>
            <div className="shortcut-row__keys">
              {[shortcut.id, ...(shortcut.altId ? [shortcut.altId] : [])].map((id) => (
                <div className="shortcut-row__key" key={id}>
                  {bindings[id] ? (
                    <span className="keycap">{bindings[id]}</span>
                  ) : (
                    <span className="keycap keycap--empty">Unassigned</span>
                  )}
                  <button
                    className="icon-btn"
                    aria-label={`Edit ${shortcut.label}`}
                    onClick={() => {
                      setCaptured(null)
                      setRecording(id)
                    }}
                  >
                    <Pencil size={14} strokeWidth={1.9} />
                  </button>
                  {bindings[id] && (
                    <button
                      className="icon-btn"
                      aria-label={`Clear ${shortcut.label}`}
                      onClick={() => setBinding(id, null)}
                    >
                      <Trash2 size={14} strokeWidth={1.9} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </Card>

      <Modal
        open={recording !== null}
        onClose={() => setRecording(null)}
        title="Record shortcut"
        actions={
          <>
            <button className="btn btn--ghost" onClick={() => setRecording(null)}>
              Cancel
            </button>
            <button
              className="btn btn--primary"
              disabled={!captured}
              onClick={() => {
                if (recording && captured) setBinding(recording, captured)
                setRecording(null)
              }}
            >
              Save
            </button>
          </>
        }
      >
        <div style={{ textAlign: 'center', padding: '10px 0 4px' }}>
          {captured ? (
            <span className="keycap" style={{ fontSize: 15, height: 34, minWidth: 60 }}>
              {captured}
            </span>
          ) : (
            <span>Press the key combination you want to use…</span>
          )}
        </div>
      </Modal>
    </>
  )
}

/** Render a keyboard event as the macOS glyph string used in the UI. */
function formatCombo(event: KeyboardEvent): string | null {
  const key = event.key
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(key)) return null
  const parts: string[] = []
  if (event.ctrlKey) parts.push('⌃')
  if (event.altKey) parts.push('⌥')
  if (event.shiftKey) parts.push('⇧')
  if (event.metaKey) parts.push('⌘')
  const named: Record<string, string> = {
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Enter: '↩',
    Backspace: '⌫',
    ' ': 'Space',
    Tab: '⇥',
    ',': ','
  }
  parts.push(named[key] ?? key.toUpperCase())
  return parts.join('')
}
