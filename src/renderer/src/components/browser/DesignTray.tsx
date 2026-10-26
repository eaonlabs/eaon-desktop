import { useEffect, useRef, useState, type JSX } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ChevronDown, ClipboardCopy, MessageSquare, Pencil, SendHorizontal, SquareDashedMousePointer, X } from 'lucide-react'
import type { DesignNote } from '@shared/browser'
import { useApp } from '../../state/store'
import { MenuItem, MenuSeparator, Popover, useDisclosure } from '../ui'
import { useCode } from '../code/codeStore'
import { terminals } from '../code/terminal/registry'
import { useTerminals } from '../code/terminal/terminalStore'
import { AgentMark } from '../code/terminal/TerminalWorkspace'
import { useBrowser } from './browserStore'
import { formatNotes, sourceText } from './designPrompt'
import type { TerminalPaneSpec } from '@shared/terminals'

/**
 * Design Mode's annotation tray, under the page: every element picked so far
 * with what should change about it. Notes gather here until they are sent —
 * pasted into an agent's terminal in the ADE (Claude Code, Codex…), added to
 * the chat composer, or copied — as one block of context. A note still being
 * written stays behind when the rest go.
 */

const EMPTY: DesignNote[] = []
const NO_PANES: TerminalPaneSpec[] = []

type Target = { kind: 'pane'; paneId: string } | { kind: 'chat' } | { kind: 'copy' }

export function DesignTray({
  scopeKey,
  onHover,
  onSent
}: {
  scopeKey: string
  onHover: (note: DesignNote | null) => void
  onSent: (message: string) => void
}): JSX.Element | null {
  const notes = useBrowser((s) => s.notes[scopeKey] ?? EMPTY)
  const editing = useBrowser((s) => s.editing)
  const [collapsed, setCollapsed] = useState(false)
  const list = useRef<HTMLOListElement>(null)
  const count = notes.length

  // A new pick scrolls into view, open for its note.
  useEffect(() => {
    if (count === 0) return
    setCollapsed(false)
    requestAnimationFrame(() => list.current?.lastElementChild?.scrollIntoView({ block: 'nearest' }))
  }, [count])

  if (count === 0) return null
  const ready = notes.filter((n) => !editing[n.id]).length

  return (
    <section className="design-tray" aria-label="Page notes">
      <header className="design-tray__head">
        <button className="design-tray__title" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed}>
          <SquareDashedMousePointer size={14} strokeWidth={1.9} />
          <span>Page notes</span>
          <span className="design-tray__count">{count}</span>
          <ChevronDown size={13} strokeWidth={2} className="design-tray__chevron" data-collapsed={collapsed || undefined} />
        </button>
        <div style={{ flex: 1 }} />
        <button className="btn btn--ghost btn--sm" onClick={() => useBrowser.getState().clearNotes(scopeKey)}>
          Clear
        </button>
        <SendButton scopeKey={scopeKey} ready={ready} onSent={onSent} />
      </header>
      {!collapsed && (
        <ol ref={list} className="design-tray__list scroll">
          {notes.map((note, index) => (
            <NoteCard key={note.id} scopeKey={scopeKey} note={note} index={index} editing={Boolean(editing[note.id])} onHover={onHover} />
          ))}
        </ol>
      )}
    </section>
  )
}

function NoteCard({
  scopeKey,
  note,
  index,
  editing,
  onHover
}: {
  scopeKey: string
  note: DesignNote
  index: number
  editing: boolean
  onHover: (note: DesignNote | null) => void
}): JSX.Element {
  const [draft, setDraft] = useState(note.note)
  const field = useRef<HTMLTextAreaElement>(null)
  const cwd = useCode((s) => s.cwd)
  const browser = useBrowser.getState
  const source = sourceText(note.element.source, cwd)

  useEffect(() => {
    if (!editing) return
    setDraft(note.note)
    requestAnimationFrame(() => {
      const node = field.current
      if (!node) return
      node.focus()
      node.setSelectionRange(node.value.length, node.value.length)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing])

  const save = (): void => {
    browser().setNote(scopeKey, note.id, draft.trim())
    browser().setEditing(note.id, false)
  }
  const cancel = (): void => {
    setDraft(note.note)
    browser().setEditing(note.id, false)
  }

  return (
    <li className="design-note" data-editing={editing || undefined} onMouseEnter={() => onHover(note)} onMouseLeave={() => onHover(null)}>
      <span className="design-note__index">{index + 1}</span>
      {note.thumbnail ? (
        <button
          className="design-note__thumb"
          title={note.screenshot ? 'Show the screenshot in its folder' : undefined}
          onClick={() => note.screenshot && void window.api.app.showItem(note.screenshot)}
        >
          <img src={note.thumbnail} alt={`Screenshot of ${note.element.label}`} />
        </button>
      ) : (
        <span className="design-note__thumb design-note__thumb--none" aria-hidden="true">
          <SquareDashedMousePointer size={16} strokeWidth={1.6} />
        </span>
      )}
      <div className="design-note__body">
        <div className="design-note__meta">
          <code className="design-note__label" title={note.element.selector}>
            {note.element.label}
          </code>
          {(source || note.element.components[0]) && (
            <span className="design-note__source" title={source ?? undefined}>
              {source ? shortSource(source) : note.element.components[0]}
            </span>
          )}
        </div>
        {editing ? (
          <>
            <textarea aria-label="What should change"
              ref={field}
              className="design-note__field"
              value={draft}
              rows={2}
              placeholder="What should change? (optional)"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation()
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  save()
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  cancel()
                }
              }}
            />
            <div className="design-note__edit-actions">
              <button className="btn btn--ghost btn--sm" onClick={cancel}>
                Cancel
              </button>
              <button className="btn btn--sm btn--primary" onClick={save}>
                Save
              </button>
            </div>
          </>
        ) : (
          <p className="design-note__text" data-empty={!note.note || undefined} onDoubleClick={() => browser().setEditing(note.id, true)}>
            {note.note || 'No note: sent as context'}
          </p>
        )}
      </div>
      {!editing && (
        <div className="design-note__actions">
          <button className="icon-btn" aria-label="Edit note" title="Edit" onClick={() => browser().setEditing(note.id, true)}>
            <Pencil size={13} strokeWidth={1.9} />
          </button>
          <button className="icon-btn" aria-label="Remove note" title="Remove" onClick={() => browser().removeNote(scopeKey, note.id)}>
            <X size={14} strokeWidth={2} />
          </button>
        </div>
      )}
    </li>
  )
}

/** "src/components/Hero.tsx:42" → "Hero.tsx:42", for the card; the full path is its tooltip. */
function shortSource(source: string): string {
  return source.replace(/ \(approximate\)$/, '').split(/[\\/]/).pop() ?? source
}

/** Sends the tray's notes: to an ADE terminal (where focus was last), the chat composer, or the clipboard. */
function SendButton({ scopeKey, ready, onSent }: { scopeKey: string; ready: number; onSent: (message: string) => void }): JSX.Element {
  const inAde = scopeKey.startsWith('code:')
  const cwd = useCode((s) => s.cwd)
  const panes = useTerminals(useShallow((s) => (inAde && cwd ? (s.layout[cwd] ?? NO_PANES) : NO_PANES)))
  const agents = useTerminals((s) => s.agents)
  const programs = useTerminals((s) => s.programs)
  const anchor = useRef<HTMLDivElement>(null)
  const menu = useDisclosure()
  const [chosen, setChosen] = useState<Target | null>(null)

  const pasteable = (paneId: string): boolean => terminals.takesBlockPaste(paneId)
  const label = (pane: TerminalPaneSpec): string => {
    const agent = agents.find((a) => a.id === pane.agent)
    const program = pane.agent === 'shell' ? programs[pane.id] : undefined
    if (program) return `${pane.name} · ${program}`
    return agent && pane.agent !== 'shell' ? `${pane.name} · ${agent.label}` : pane.name
  }

  /** Where Send goes without asking: what was picked, else the pane last typed in, else the first that takes a paste. */
  const target = (): Target => {
    if (chosen && (chosen.kind !== 'pane' || panes.some((p) => p.id === chosen.paneId))) return chosen
    if (!inAde) return { kind: 'chat' }
    const last = terminals.lastFocused()
    const pane = panes.find((p) => p.id === last && pasteable(p.id)) ?? panes.find((p) => p.agent !== 'shell' && pasteable(p.id)) ?? panes.find((p) => pasteable(p.id))
    return pane ? { kind: 'pane', paneId: pane.id } : { kind: 'copy' }
  }

  const current = target()
  const currentLabel =
    current.kind === 'pane' ? (panes.find((p) => p.id === current.paneId)?.name ?? 'terminal') : current.kind === 'chat' ? 'chat' : 'clipboard'

  const send = (to: Target): void => {
    const browser = useBrowser.getState()
    const editing = browser.editing
    const sendable = (browser.notes[scopeKey] ?? []).filter((n) => !editing[n.id])
    if (sendable.length === 0) return
    if (to.kind === 'pane') {
      const text = formatNotes(sendable, { cwd, screenshots: 'paths' })
      if (!terminals.paste(to.paneId, text)) {
        onSent('That terminal isn’t running. Pick another one.')
        return
      }
      browser.takeNotes(scopeKey)
      terminals.focus(to.paneId)
      onSent(`Sent ${plural(sendable.length)} to ${panes.find((p) => p.id === to.paneId)?.name ?? 'the terminal'}. Add your request and press Enter.`)
      return
    }
    if (to.kind === 'chat') {
      const text = formatNotes(sendable, { screenshots: 'attached' })
      useApp.getState().appendToComposer({ text, attachments: sendable.map((n) => n.screenshot).filter((p): p is string => Boolean(p)) })
      browser.takeNotes(scopeKey)
      onSent(`Added ${plural(sendable.length)} to the composer.`)
      return
    }
    void navigator.clipboard.writeText(formatNotes(sendable, { cwd, screenshots: 'paths' })).then(() => {
      browser.takeNotes(scopeKey)
      onSent(`Copied ${plural(sendable.length)}.`)
    })
  }

  const pick = (to: Target): void => {
    menu.close()
    setChosen(to)
    send(to)
  }

  return (
    <div ref={anchor} className="design-send">
      <button
        className="btn btn--sm btn--primary design-send__main"
        disabled={ready === 0}
        title={ready === 0 ? 'Save the note you’re writing first' : undefined}
        onClick={() => send(current)}
      >
        {current.kind === 'copy' ? <ClipboardCopy size={13} strokeWidth={2} /> : <SendHorizontal size={13} strokeWidth={2} />}
        <span>{current.kind === 'copy' ? 'Copy' : `Send to ${currentLabel}`}</span>
      </button>
      <button className="btn btn--sm btn--primary design-send__more" aria-label="Send to…" onClick={menu.toggle}>
        <ChevronDown size={13} strokeWidth={2} />
      </button>
      <Popover anchor={anchor} open={menu.open} onClose={menu.close} placement="top-end" width={260}>
        {inAde && (
          <>
            <div className="menu__label">Paste into a terminal</div>
            {panes.length === 0 && <MenuItem title="No terminals open" description="Open Claude Code, Codex or another agent first" disabled />}
            {panes.map((pane) => {
              const ok = pasteable(pane.id)
              return (
                <MenuItem
                  key={pane.id}
                  icon={<AgentMark agent={pane.agent} program={programs[pane.id]} size={16} />}
                  title={label(pane)}
                  description={ok ? undefined : 'Not ready for a multi-line paste'}
                  checked={current.kind === 'pane' && current.paneId === pane.id}
                  disabled={!ok || ready === 0}
                  onClick={() => pick({ kind: 'pane', paneId: pane.id })}
                />
              )
            })}
            <MenuSeparator />
          </>
        )}
        {!inAde && (
          <MenuItem
            icon={<MessageSquare size={15} strokeWidth={1.8} />}
            title="Add to the composer"
            description="Screenshots go as attachments"
            checked={current.kind === 'chat'}
            disabled={ready === 0}
            onClick={() => pick({ kind: 'chat' })}
          />
        )}
        <MenuItem
          icon={<ClipboardCopy size={15} strokeWidth={1.8} />}
          title="Copy as text"
          description="Paste it into any agent"
          checked={current.kind === 'copy'}
          disabled={ready === 0}
          onClick={() => pick({ kind: 'copy' })}
        />
      </Popover>
    </div>
  )
}

const plural = (n: number): string => (n === 1 ? '1 note' : `${n} notes`)

