import { useState } from 'react'
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react'
import { MEMORY_COUNT_LIMIT, MEMORY_TEXT_LIMIT, type MemoryChange, type MemoryItem } from '@shared/personalize'
import { Card, ConfirmDialog, Row, Section, Switch } from '../../ui'
import { usePersonalize } from './usePersonalize'
import './personalize.css'

/** Settings → Memory: what Eaon remembers across chats, to read, change, delete or switch off. */
export function MemoryPage(): JSX.Element {
  const value = usePersonalize()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [clearing, setClearing] = useState(false)

  if (!value) return <h1 className="settings__h1">Memory</h1>
  const { enabled, items } = value.memory

  const report = (result: MemoryChange): boolean => {
    setError(result.ok ? null : result.message)
    return result.ok
  }
  const add = (): void => {
    if (!draft.trim()) return
    void window.api.personalize.addMemory(draft).then((result) => report(result) && setDraft(''))
  }
  const saveEdit = (): void => {
    if (!editing) return
    void window.api.personalize.editMemory(editing.id, editing.text).then((result) => report(result) && setEditing(null))
  }

  return (
    <>
      <h1 className="settings__h1">Memory</h1>
      <p className="settings__lede">Short facts Eaon keeps between chats, such as your name or how you like answers. They are stored on this computer only.</p>

      <Section>
        <Card>
          <Row
            title="Remember things across chats"
            description={
              enabled
                ? 'On. Everything listed below is sent with every message you send in Chat, and Eaon can save a fact when you ask it to remember something. It asks first, following your approval setting.'
                : 'Off. Nothing below is sent, and Eaon can’t save anything. When you turn it on, the list is sent with every message you send in Chat.'
            }
          >
            <Switch label="Remember things across chats" checked={enabled} onChange={(on) => void window.api.personalize.setMemoryEnabled(on)} />
          </Row>
        </Card>
      </Section>

      <Section label={items.length === 0 ? 'Memories' : `Memories (${items.length} of ${MEMORY_COUNT_LIMIT})`}>
        <Card>
          <div className="memory-add">
            <input
              aria-label="Add a memory"
              className="input"
              value={draft}
              maxLength={MEMORY_TEXT_LIMIT}
              placeholder="Something for Eaon to remember, such as “I prefer metric units.”"
              onChange={(e) => {
                setDraft(e.target.value)
                setError(null)
              }}
              onKeyDown={(e) => e.key === 'Enter' && add()}
            />
            <button type="button" className="btn" disabled={!draft.trim()} onClick={add}>
              <Plus size={14} strokeWidth={1.9} />
              Add
            </button>
          </div>
          {error && <div className="memory-error">{error}</div>}
          {items.length === 0 && <Row title="Nothing remembered yet" description="Add a fact here, or turn memory on and ask Eaon in a chat to remember something." />}
          {items.map((item) =>
            editing?.id === item.id ? (
              <Row key={item.id} title={
                <div className="memory-edit">
                  <input
                    autoFocus
                    aria-label="Memory"
                    className="input"
                    value={editing.text}
                    maxLength={MEMORY_TEXT_LIMIT}
                    onChange={(e) => setEditing({ id: item.id, text: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveEdit()
                      if (e.key === 'Escape') setEditing(null)
                    }}
                  />
                  <button type="button" className="icon-btn" aria-label="Save" disabled={!editing.text.trim()} onClick={saveEdit}>
                    <Check size={15} strokeWidth={1.9} />
                  </button>
                  <button type="button" className="icon-btn" aria-label="Cancel" onClick={() => setEditing(null)}>
                    <X size={15} strokeWidth={1.9} />
                  </button>
                </div>
              } />
            ) : (
              <Row key={item.id} title={<span className="memory-text">{item.text}</span>} description={describe(item)}>
                <button type="button" className="icon-btn" aria-label="Edit memory" onClick={() => setEditing({ id: item.id, text: item.text })}>
                  <Pencil size={15} strokeWidth={1.9} />
                </button>
                <button type="button" className="icon-btn" aria-label="Delete memory" onClick={() => void window.api.personalize.deleteMemory(item.id)}>
                  <Trash2 size={15} strokeWidth={1.9} />
                </button>
              </Row>
            )
          )}
        </Card>
        {items.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <button type="button" className="btn btn--danger" onClick={() => setClearing(true)}>
              Delete all memories
            </button>
          </div>
        )}
      </Section>
      <ConfirmDialog
        open={clearing}
        onClose={() => setClearing(false)}
        title={`Delete all ${items.length} ${items.length === 1 ? 'memory' : 'memories'}?`}
        confirmLabel="Delete all"
        onConfirm={() => void window.api.personalize.clearMemory()}
      >
        Eaon forgets everything listed here. This can’t be undone.
      </ConfirmDialog>
    </>
  )
}

const describe = (item: MemoryItem): string =>
  `${item.source === 'model' ? 'Saved by Eaon' : 'Added by you'} · ${new Date(item.updatedAt || item.createdAt).toLocaleDateString()}`
