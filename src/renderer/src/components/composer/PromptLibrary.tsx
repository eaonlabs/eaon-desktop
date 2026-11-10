import { useEffect, useMemo, useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { nameFor, PROMPT_NAME_LIMIT, PROMPT_TEXT_LIMIT, previewOf, searchPrompts, type SavedPrompt } from '@shared/savedPrompts'
import { usePrompts } from '../../state/prompts'
import { ConfirmDialog, Modal, SearchField } from '../ui'
import './prompts.css'

interface Draft {
  id?: string
  name: string
  text: string
}

/**
 * The prompt library: every saved prompt by name, searchable, with Use,
 * Edit and Delete. Reached from the composer's + menu and its "/" menu.
 * `typed` is what is in the box now, which can be saved as a prompt; Use
 * hands a prompt's text back to the composer to put in the box.
 */
export function PromptLibrary({ open, onClose, typed, onUse }: { open: boolean; onClose: () => void; typed: string; onUse: (text: string) => void }): JSX.Element | null {
  const list = usePrompts((s) => s.list)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [deleting, setDeleting] = useState<SavedPrompt | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => usePrompts.getState().ensure(), [])
  // Closed and opened again: the list, not the last search or half an edit.
  useEffect(() => {
    if (open) return
    setQuery('')
    setDraft(null)
    setError(null)
  }, [open])
  const shown = useMemo(() => searchPrompts(list, query), [list, query])

  if (!open) return null

  const save = (): void => {
    if (!draft) return
    void window.api.prompts.save({ id: draft.id, name: draft.name, text: draft.text }).then((result) => {
      if (result.ok) {
        setDraft(null)
        setError(null)
      } else setError(result.message)
    })
  }

  if (draft) {
    return (
      <Modal
        open
        onClose={() => setDraft(null)}
        title={draft.id ? 'Edit saved prompt' : 'Save a prompt'}
        width={520}
        actions={
          <>
            <button type="button" className="btn btn--ghost" onClick={() => setDraft(null)}>
              Cancel
            </button>
            <button type="button" className="btn btn--primary" disabled={!draft.text.trim()} onClick={save}>
              Save
            </button>
          </>
        }
      >
        <div className="prompts__form">
          <label className="field">
            <span className="field-label">Name</span>
            <input
              className="input"
              value={draft.name}
              maxLength={PROMPT_NAME_LIMIT}
              placeholder={draft.text.trim() ? nameFor(draft.text) : 'What you will call it'}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">Prompt</span>
            <textarea
              autoFocus={!draft.text}
              className="input"
              rows={8}
              value={draft.text}
              maxLength={PROMPT_TEXT_LIMIT}
              placeholder="The text that goes in the message box"
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            />
          </label>
          {error && <span className="prompts__error">{error}</span>}
        </div>
      </Modal>
    )
  }

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title="Saved prompts"
        width={560}
        actions={
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Close
          </button>
        }
      >
        <div className="prompts__bar">
          <SearchField value={query} onChange={setQuery} placeholder="Search saved prompts" autoFocus />
          <button type="button" className="btn btn--sm" onClick={() => setDraft({ name: '', text: '' })}>
            <Plus size={14} strokeWidth={1.9} />
            New
          </button>
          {typed.trim() && (
            <button type="button" className="btn btn--sm" title="Saves the text in the message box" onClick={() => setDraft({ name: '', text: typed.trim() })}>
              Save what I typed
            </button>
          )}
        </div>
        {shown.length === 0 ? (
          <div className="prompts__empty">
            {list.length === 0 ? 'No saved prompts yet. Write one here, or type in the message box and choose Save what I typed.' : 'No saved prompt matches that.'}
          </div>
        ) : (
          <div className="prompts__list">
            {shown.map((prompt) => (
              <div key={prompt.id} className="prompt-row">
                <button type="button" className="prompt-row__main" title="Put this in the message box" onClick={() => onUse(prompt.text)}>
                  <span className="prompt-row__name">{prompt.name}</span>
                  <span className="prompt-row__text">{previewOf(prompt.text)}</span>
                </button>
                <div className="prompt-row__tools">
                  <button type="button" className="icon-btn" aria-label={`Edit ${prompt.name}`} title="Edit" onClick={() => setDraft({ id: prompt.id, name: prompt.name, text: prompt.text })}>
                    <Pencil size={14} strokeWidth={1.9} />
                  </button>
                  <button type="button" className="icon-btn" aria-label={`Delete ${prompt.name}`} title="Delete" onClick={() => setDeleting(prompt)}>
                    <Trash2 size={14} strokeWidth={1.9} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Modal>
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete this saved prompt?"
        confirmLabel="Delete"
        onConfirm={() => deleting && void window.api.prompts.delete(deleting.id)}
      >
        “{deleting?.name}” is removed from your saved prompts. This can’t be undone.
      </ConfirmDialog>
    </>
  )
}
