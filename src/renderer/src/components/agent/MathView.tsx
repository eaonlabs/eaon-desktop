import { useEffect, useReducer, type JSX } from 'react'
import { drawMath, katexReady, loadKatex } from './mathRender'

/**
 * A formula in a reply, drawn by KaTeX (mathRender.ts). While KaTeX loads, and
 * if the LaTeX is not valid, it shows the source as written: a bad formula
 * reads as text, never as an error or a blank.
 *
 * Spans throughout, so a `$$` formula inside a sentence is still valid markup;
 * the display kind is set on its own line by CSS.
 */
export function MathView({ src, display, raw }: { src: string; display: boolean; raw: string }): JSX.Element {
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const ready = katexReady()
  useEffect(() => {
    if (ready) return
    let live = true
    void loadKatex().then((ok) => {
      if (live && ok) redraw()
    })
    return () => {
      live = false
    }
  }, [ready])

  const html = ready ? drawMath(src, display) : null
  if (html === null) {
    return (
      <span className="md__math-src" data-display={display || undefined}>
        <code>{raw}</code>
      </span>
    )
  }
  // KaTeX's markup (trust off, text escaped), the one place a reply's text
  // becomes HTML; a formula's text duplicated for screen readers is not searchable text.
  return <span className="md__math" data-display={display || undefined} data-find-skip dangerouslySetInnerHTML={{ __html: html }} />
}
