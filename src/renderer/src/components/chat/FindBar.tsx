import { useEffect, useLayoutEffect, useRef, useState, type JSX, type RefObject } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'

/**
 * Find in the conversation (⌘F): every match marked where it is, the
 * current one stronger, with ⏎ and ⇧⏎ (or the arrows) to go between them.
 * Matches are marked with the CSS Custom Highlight API, so nothing in the
 * messages is rewrapped or re-rendered to show them. Folded messages open
 * while the bar is up (`data-finding` on the thread), so what's found can be
 * seen.
 */

const ALL = 'chat-find'
const CURRENT = 'chat-find-current'

/** Text inside these isn't the conversation: buttons, labels, the bar itself. */
const SKIP = 'button, [data-find-skip], svg, input, textarea'

function supported(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined'
}

function clearMarks(): void {
  if (!supported()) return
  CSS.highlights.delete(ALL)
  CSS.highlights.delete(CURRENT)
}

/** Every case-insensitive occurrence of `query` in the text under `root`. */
export function findRanges(root: Element, query: string): Range[] {
  const needle = query.toLocaleLowerCase()
  if (!needle) return []
  const ranges: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.nodeValue ?? '').toLocaleLowerCase()
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + needle.length)
      ranges.push(range)
    }
  }
  return ranges
}

export function FindBar({
  open,
  onClose,
  thread,
  version
}: {
  open: boolean
  onClose: () => void
  /** The scrolling thread; matches are looked for in it. */
  thread: RefObject<HTMLDivElement>
  /** Changes when the messages do, so matches are looked for again. */
  version: unknown
}): JSX.Element | null {
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [ranges, setRanges] = useState<Range[]>([])
  const [current, setCurrent] = useState(0)

  useEffect(() => {
    if (!open) return
    input.current?.focus()
    input.current?.select()
  }, [open])

  // Look again as the query or the conversation changes; the current match
  // stays the nth one, or the last when there are fewer now.
  useLayoutEffect(() => {
    const root = thread.current?.firstElementChild
    if (!open || !root) {
      setRanges([])
      return
    }
    const found = findRanges(root, query.trim())
    setRanges(found)
    setCurrent((at) => Math.min(at, Math.max(0, found.length - 1)))
  }, [open, query, version, thread])

  useEffect(() => {
    if (!open || !supported()) return clearMarks
    CSS.highlights.set(ALL, new Highlight(...ranges))
    const range = ranges[current]
    if (range) {
      CSS.highlights.set(CURRENT, new Highlight(range))
      scrollToRange(thread.current, range)
    } else CSS.highlights.delete(CURRENT)
    return clearMarks
  }, [open, ranges, current, thread])

  useEffect(() => {
    if (open) thread.current?.setAttribute('data-finding', '')
    else thread.current?.removeAttribute('data-finding')
  }, [open, thread])

  if (!open) return null
  const step = (by: number): void => {
    if (ranges.length === 0) return
    setCurrent((at) => (at + by + ranges.length) % ranges.length)
  }

  return (
    <div className="find-bar" role="search" data-find-skip>
      <Search size={14} strokeWidth={2} className="find-bar__icon" aria-hidden="true" />
      <input
        ref={input}
        className="find-bar__input"
        value={query}
        placeholder="Find in chat"
        aria-label="Find in chat"
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value)
          setCurrent(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            step(e.shiftKey ? -1 : 1)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            step(e.key === 'ArrowDown' ? 1 : -1)
          }
        }}
      />
      <span className="find-bar__count" aria-live="polite">
        {query.trim() ? (ranges.length ? `${current + 1} of ${ranges.length}` : 'No matches') : ''}
      </span>
      <button type="button" className="find-bar__btn" onClick={() => step(-1)} disabled={ranges.length === 0} aria-label="Previous match" title="Previous (⇧⏎)">
        <ChevronUp size={15} strokeWidth={2} />
      </button>
      <button type="button" className="find-bar__btn" onClick={() => step(1)} disabled={ranges.length === 0} aria-label="Next match" title="Next (⏎)">
        <ChevronDown size={15} strokeWidth={2} />
      </button>
      <button type="button" className="find-bar__btn" onClick={onClose} aria-label="Close find" title="Close (Esc)">
        <X size={15} strokeWidth={2} />
      </button>
    </div>
  )
}

/** The match in the middle of the thread, unless it is already in view. */
function scrollToRange(scroller: HTMLElement | null, range: Range): void {
  if (!scroller) return
  const box = range.getBoundingClientRect()
  const view = scroller.getBoundingClientRect()
  if (box.top >= view.top + 60 && box.bottom <= view.bottom - 40) return
  scroller.scrollBy({ top: box.top - view.top - view.height / 2, behavior: 'auto' })
}
