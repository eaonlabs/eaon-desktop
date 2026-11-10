import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { Check, Search } from 'lucide-react'
import { withRecentsFirst } from '@shared/palette'
import { paletteActions, recentActionIds, rememberAction, searchPalette, type PaletteAction } from '../../lib/commands'
import { registerBuiltinPaletteSources } from '../../lib/paletteSources'
import { useBindingLabel } from '../../lib/bindings'
import { closePalette, usePalette } from './paletteStore'
import './palette.css'

// Before anything else registers, so the built-in actions list first.
registerBuiltinPaletteSources()

/**
 * The command palette: one key (Settings → Keyboard shortcuts shows it, and
 * can change it) opens a box that finds an action by a few words and runs it.
 * ↑ ↓ move, Enter runs, Esc closes. What it can run is in lib/commands.ts;
 * lib/paletteSources.ts lists the built-in actions.
 */
export function CommandPalette(): JSX.Element | null {
  const open = usePalette((s) => s.open)
  if (!open) return null
  return createPortal(<PaletteDialog />, document.body)
}

function Keycap({ id }: { id: string }): JSX.Element | null {
  const label = useBindingLabel(id)
  return label ? <kbd className="palette__kbd">{label}</kbd> : null
}

function PaletteDialog(): JSX.Element {
  const [query, setQuery] = useState('')
  const [current, setCurrent] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  // Listed again when the query changes, so what a source offers for a query (chats by title) follows it.
  const results: PaletteAction[] = useMemo(
    () => (query.trim() ? searchPalette(query) : withRecentsFirst(paletteActions(''), recentActionIds())),
    [query]
  )

  useEffect(() => {
    requestAnimationFrame(() => input.current?.focus())
  }, [])
  useEffect(() => setCurrent(0), [query])
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${current}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [current])

  const run = (action: PaletteAction | undefined): void => {
    if (!action) return
    closePalette()
    rememberAction(action.id)
    // After the palette is gone, so an action that opens a dialog or a field keeps the focus it asks for.
    setTimeout(action.run, 0)
  }

  return (
    <div className="code-search__scrim" onMouseDown={(e) => e.target === e.currentTarget && closePalette()}>
      <div
        className="code-search palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            closePalette()
          } else if (e.key === 'ArrowDown') {
            e.preventDefault()
            setCurrent((i) => Math.min(i + 1, results.length - 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setCurrent((i) => Math.max(i - 1, 0))
          } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            run(results[current])
          }
        }}
      >
        <div className="code-search__bar">
          <Search size={15} strokeWidth={2} className="code-search__glyph" />
          <input
            ref={input}
            className="code-search__input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command, a Settings page or a chat"
            spellCheck={false}
            role="combobox"
            aria-expanded
            aria-controls="palette-list"
            aria-activedescendant={results[current] ? `palette-row-${current}` : undefined}
            aria-label="Command"
          />
        </div>
        <div id="palette-list" ref={list} className="code-search__results palette__results scroll" role="listbox" aria-label="Commands">
          {results.length === 0 ? (
            <div className="palette__empty">{query.trim() ? `Nothing matches “${query.trim()}”.` : 'Nothing to run yet.'}</div>
          ) : (
            results.map((action, index) => (
              <button
                key={action.id}
                id={`palette-row-${index}`}
                type="button"
                role="option"
                aria-selected={index === current}
                data-index={index}
                className="palette__row"
                data-current={index === current || undefined}
                onMouseMove={() => current !== index && setCurrent(index)}
                onClick={() => run(action)}
              >
                <span className="palette__main">
                  <span className="palette__title">{action.title}</span>
                  {action.detail && <span className="palette__detail">{action.detail}</span>}
                </span>
                {action.current && <Check size={14} strokeWidth={2.2} className="palette__check" aria-label="In use" />}
                {action.state && <span className="palette__state">{action.state}</span>}
                <span className="palette__group">{action.group}</span>
                {action.shortcut && <Keycap id={action.shortcut} />}
              </button>
            ))
          )}
        </div>
        <div className="code-search__foot palette__foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>↩</kbd> to run
          </span>
          <span>
            <kbd>esc</kbd> to close
          </span>
        </div>
      </div>
    </div>
  )
}
