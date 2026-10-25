import { useEffect, useState, type JSX, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Quote } from 'lucide-react'
import { useApp } from '../../state/store'

/** Longer than this, a quote stops being a pointer to a passage and becomes a paste. */
const MAX_QUOTE = 2000

/**
 * Selecting part of a reply puts a Quote button just above the selection;
 * it drops the passage into the message box as a quote, after anything
 * already typed, ready for a question about it. The reply's own Reply
 * action quotes the whole reply; this is for one sentence of it.
 */
export function QuoteSelection({ thread }: { thread: RefObject<HTMLDivElement> }): JSX.Element | null {
  const appendToComposer = useApp((s) => s.appendToComposer)
  const [spot, setSpot] = useState<{ x: number; y: number; text: string } | null>(null)

  useEffect(() => {
    const read = (): void => {
      const selection = window.getSelection()
      const node = thread.current
      if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !node) return setSpot(null)
      const range = selection.getRangeAt(0)
      const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
      const end = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement
      // Inside one reply only: across messages it would quote the user's words back as the reply's.
      const reply = start?.closest('.msg--assistant')
      if (!reply || !node.contains(reply) || end?.closest('.msg--assistant') !== reply) return setSpot(null)
      const text = selection.toString().trim()
      if (!text) return setSpot(null)
      const box = range.getBoundingClientRect()
      setSpot({ x: box.left + box.width / 2, y: box.top, text })
    }
    // After the pointer lets go, not during the drag, so the button doesn't chase the cursor.
    const onUp = (): void => void requestAnimationFrame(read)
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.shiftKey || event.key === 'Shift') read()
    }
    const onChange = (): void => {
      if (window.getSelection()?.isCollapsed) setSpot(null)
    }
    const hide = (): void => setSpot(null)
    document.addEventListener('mouseup', onUp)
    document.addEventListener('keyup', onKeyUp)
    document.addEventListener('selectionchange', onChange)
    const scroller = thread.current
    scroller?.addEventListener('scroll', hide, { passive: true })
    return () => {
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('keyup', onKeyUp)
      document.removeEventListener('selectionchange', onChange)
      scroller?.removeEventListener('scroll', hide)
    }
  }, [thread])

  if (!spot) return null
  const tooLong = spot.text.length > MAX_QUOTE
  return createPortal(
    <button
      type="button"
      className="quote-pop"
      style={{ left: spot.x, top: spot.y }}
      disabled={tooLong}
      title={tooLong ? 'Too long to quote — select less' : 'Quote in your message'}
      // Pressing a button would clear the selection before the click lands.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        const quoted = spot.text
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')
        appendToComposer({ text: `${quoted}\n\n`, attachments: [] })
        window.getSelection()?.removeAllRanges()
        setSpot(null)
      }}
    >
      <Quote size={13} strokeWidth={2} />
      Quote
    </button>,
    document.body
  )
}
