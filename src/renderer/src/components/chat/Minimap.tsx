import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX, type RefObject } from 'react'

/**
 * A strip down the conversation's right edge with a mark for each of the
 * user's messages, placed where it falls in the chat. Pointing at a mark
 * shows the message; clicking goes to it. The mark for the part being read
 * is the strong one. Shown once a chat is long enough to get lost in.
 *
 * Messages are found by `data-user-message` on their rows (ChatView), so
 * nothing here depends on how they are drawn.
 */

interface Mark {
  id: string
  /** Where the message starts, as a share of the thread's full height. */
  at: number
  text: string
}

const MIN_MARKS = 3
/** How far below the top of the view a message counts as the one being read: just under the top bar. */
const READ_LINE = 120

export function Minimap({ thread, version }: { thread: RefObject<HTMLDivElement>; version: unknown }): JSX.Element | null {
  const strip = useRef<HTMLDivElement>(null)
  const [marks, setMarks] = useState<Mark[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [hover, setHover] = useState<Mark | null>(null)

  const measure = useCallback((): void => {
    const node = thread.current
    if (!node) return
    // Long enough to need it: over twice the height of the view.
    if (node.scrollHeight < node.clientHeight * 2) {
      setMarks((current) => (current.length ? [] : current))
      return
    }
    const top = node.getBoundingClientRect().top - node.scrollTop
    const rows = [...node.querySelectorAll<HTMLElement>('[data-user-message]')]
    const next = rows.map((row) => ({
      id: row.dataset.userMessage!,
      at: Math.min(1, Math.max(0, (row.getBoundingClientRect().top - top) / node.scrollHeight)),
      text: row.querySelector('.msg--user')?.textContent?.trim() || 'Files'
    }))
    setMarks(next.length >= MIN_MARKS ? next : [])
    // The strip runs the thread's own height, wherever the thread sits.
    if (strip.current) {
      strip.current.style.top = `${node.offsetTop + 12}px`
      strip.current.style.height = `${node.clientHeight - 24}px`
    }
  }, [thread])

  useLayoutEffect(measure, [measure, version])

  // A streaming reply grows the thread on every batch of tokens: measured at
  // most every quarter second then, not on each.
  const pending = useRef<number | null>(null)
  const later = useCallback((): void => {
    if (pending.current !== null) return
    pending.current = window.setTimeout(() => {
      pending.current = null
      measure()
    }, 250)
  }, [measure])
  useEffect(() => () => {
    if (pending.current !== null) clearTimeout(pending.current)
  }, [])

  useEffect(() => {
    const node = thread.current
    if (!node) return
    const observer = new ResizeObserver(later)
    observer.observe(node)
    if (node.firstElementChild) observer.observe(node.firstElementChild)
    return () => observer.disconnect()
  }, [thread, later])

  // The mark for what's being read: the last message that starts near the top of the view.
  useEffect(() => {
    const node = thread.current
    if (!node || marks.length === 0) return
    const onScroll = (): void => {
      const line = (node.scrollTop + READ_LINE) / node.scrollHeight
      let current: string | null = marks[0].id
      for (const mark of marks) if (mark.at <= line) current = mark.id
      setActive(current)
    }
    onScroll()
    node.addEventListener('scroll', onScroll, { passive: true })
    return () => node.removeEventListener('scroll', onScroll)
  }, [thread, marks])

  if (marks.length === 0) return null

  const go = (mark: Mark): void => {
    const node = thread.current
    const row = node?.querySelector<HTMLElement>(`[data-user-message="${CSS.escape(mark.id)}"]`)
    if (!node || !row) return
    const offset = row.getBoundingClientRect().top - node.getBoundingClientRect().top
    node.scrollBy({ top: offset - 56, behavior: document.body.dataset.reduceMotion === 'on' ? 'auto' : 'smooth' })
  }

  return (
    <div ref={strip} className="minimap" aria-label="Your messages in this chat" role="navigation" onMouseLeave={() => setHover(null)}>
      {marks.map((mark) => (
        <button
          key={mark.id}
          type="button"
          className="minimap__mark"
          data-active={mark.id === active || undefined}
          style={{ top: `${mark.at * 100}%` }}
          onMouseEnter={() => setHover(mark)}
          onFocus={() => setHover(mark)}
          onBlur={() => setHover(null)}
          onClick={() => go(mark)}
          aria-label={`Go to your message: ${mark.text.slice(0, 80)}`}
        />
      ))}
      {hover && (
        <div className="minimap__peek" style={{ top: `${hover.at * 100}%` }} aria-hidden="true">
          {hover.text.length > 140 ? `${hover.text.slice(0, 140).trimEnd()}…` : hover.text}
        </div>
      )}
    </div>
  )
}
