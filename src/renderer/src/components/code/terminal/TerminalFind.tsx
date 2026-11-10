import { useEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { terminals } from './registry'
import type { SearchOptions } from '@shared/terminalSearch'

/**
 * Find in a terminal's output: a bar over the pane's top right corner, opened
 * with ⌘F (Ctrl+Shift+F elsewhere) or Find in the pane's menu. The matches are
 * marked in the terminal itself (registry.ts `find`), the newest first: what
 * an agent printed last is what you are usually looking for. ⏎ goes to the
 * next older match, ⇧⏎ to the next newer.
 */
export function TerminalFind({ paneId, open, asked, onClose }: { paneId: string; open: boolean; /** Changes each time find is asked for, so an open bar takes the keyboard again. */ asked: number; onClose: () => void }): JSX.Element | null {
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<SearchOptions>({})
  // The count follows output that arrives while the bar is open.
  useSyncExternalStore(terminals.subscribe, terminals.getVersion)
  const result = terminals.findResult(paneId)

  // Opened (or asked for again): the field takes the keyboard, with what it holds selected to type over.
  useEffect(() => {
    if (!open) return
    input.current?.focus()
    input.current?.select()
  }, [open, asked])
  // The search follows what is typed and the options; a closed bar searches nothing.
  useEffect(() => {
    terminals.find(paneId, open ? query : '', options)
  }, [open, query, options, paneId])
  // A pane closed under an open bar leaves no marks behind.
  useEffect(() => () => void terminals.find(paneId, '', {}), [paneId])

  if (!open) return null
  const toggle = (key: keyof SearchOptions): void => setOptions((now) => ({ ...now, [key]: !now[key] }))
  const close = (): void => {
    onClose()
    terminals.closeFind(paneId)
  }
  const none = query.length > 0 && result.count === 0
  const status = result.error
    ? 'Not a pattern'
    : !query
      ? ''
      : none
        ? 'No matches'
        : `${result.current} of ${result.count}${result.truncated ? '+' : ''}`

  return (
    <div className="find-bar find-bar--term" role="search" onMouseDown={(e) => e.stopPropagation()}>
      <Search size={14} strokeWidth={2} className="find-bar__icon" aria-hidden="true" />
      <input
        ref={input}
        className="find-bar__input"
        value={query}
        placeholder="Find in this terminal"
        aria-label="Find in this terminal"
        aria-invalid={Boolean(result.error) || undefined}
        title={result.error ?? undefined}
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            terminals.findStep(paneId, e.shiftKey ? -1 : 1)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            close()
          }
        }}
      />
      <span className="find-bar__count" aria-live="polite" data-bad={none || Boolean(result.error) || undefined}>
        {status}
      </span>
      <button type="button" className="find-bar__btn find-bar__btn--opt" aria-pressed={Boolean(options.caseSensitive)} aria-label="Match case" title="Match case" onClick={() => toggle('caseSensitive')}>
        Aa
      </button>
      <button type="button" className="find-bar__btn find-bar__btn--opt" aria-pressed={Boolean(options.word)} aria-label="Whole word" title="Whole word" onClick={() => toggle('word')}>
        ab
      </button>
      <button type="button" className="find-bar__btn find-bar__btn--opt" aria-pressed={Boolean(options.regex)} aria-label="Regular expression" title="Regular expression" onClick={() => toggle('regex')}>
        .*
      </button>
      <button type="button" className="find-bar__btn" onClick={() => terminals.findStep(paneId, 1)} disabled={result.count === 0} aria-label="Older match" title="Older match (⏎)">
        <ChevronUp size={15} strokeWidth={2} />
      </button>
      <button type="button" className="find-bar__btn" onClick={() => terminals.findStep(paneId, -1)} disabled={result.count === 0} aria-label="Newer match" title="Newer match (⇧⏎)">
        <ChevronDown size={15} strokeWidth={2} />
      </button>
      <button type="button" className="find-bar__btn" onClick={close} aria-label="Close find" title="Close (Esc)">
        <X size={15} strokeWidth={2} />
      </button>
    </div>
  )
}
