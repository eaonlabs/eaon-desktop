import { useEffect, useRef, useState, type CSSProperties, type JSX, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * A step's line, with a card that rises over it after a moment's hover:
 * what the step was in a sentence, and the call exactly as the agent made it.
 * The line is a summary — a command cut to the width of the column, a path
 * cut to its file name — and this is where the whole of it can be read
 * without opening the step.
 */

/** Long enough that running the pointer down a list doesn't flash a card per row. */
const DELAY = 450

export function PeekLine({
  summary,
  raw,
  className,
  children
}: {
  summary: string
  /** The call itself: a command line, or its arguments. Mono. */
  raw?: string
  className?: string
  children: ReactNode
}): JSX.Element {
  // Where the card goes, measured when it shows: it is drawn over the page
  // rather than inside the line, so a folding list or a scrolling thread
  // around it can't clip it.
  const [at, setAt] = useState<CSSProperties | null>(null)
  const line = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => clearTimeout(timer.current), [])
  const hide = (): void => {
    clearTimeout(timer.current)
    setAt(null)
  }
  // Pinned to where the line was: the thread scrolling under it takes it away.
  useEffect(() => {
    if (!at) return
    window.addEventListener('scroll', hide, true)
    return () => window.removeEventListener('scroll', hide, true)
  }, [at])
  const show = (): void => {
    const rect = line.current?.getBoundingClientRect()
    if (!rect) return
    // Above the line when there is room for it, else below.
    const above = rect.top > 180
    setAt({
      left: rect.left,
      maxWidth: Math.min(560, window.innerWidth - rect.left - 16),
      ...(above ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 })
    })
  }
  return (
    <div
      ref={line}
      className={`peek-line${className ? ` ${className}` : ''}`}
      onMouseEnter={() => {
        clearTimeout(timer.current)
        timer.current = setTimeout(show, DELAY)
      }}
      onMouseLeave={hide}
      onMouseDown={hide}
    >
      {children}
      {at &&
        createPortal(
          <div className="peek" role="tooltip" style={at}>
            <div className="peek__label">Summary</div>
            <div className="peek__summary">{summary}</div>
            {raw && (
              <>
                <div className="peek__label">Raw call</div>
                <pre className="peek__raw">{raw}</pre>
              </>
            )}
          </div>,
          document.body
        )}
    </div>
  )
}

/** A call's arguments as readable JSON, each long value cut short so the card stays a card. */
export function rawCall(input: Record<string, unknown>): string {
  const text = JSON.stringify(input, (_key, value: unknown) => (typeof value === 'string' && value.length > 240 ? `${value.slice(0, 240)}…` : value), 2)
  return text.length > 900 ? `${text.slice(0, 900)}…` : text
}
