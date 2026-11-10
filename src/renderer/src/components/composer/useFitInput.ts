import { useLayoutEffect, useState, type RefObject } from 'react'

/** How many lines the box's text takes up as it is laid out now. */
function lines(node: HTMLTextAreaElement): number {
  const style = getComputedStyle(node)
  const inner = node.scrollHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
  return Math.round(inner / parseFloat(style.lineHeight))
}

/**
 * Sizes a message box to its text, up to `max`, and says when the text has
 * outgrown the one line it has between + and send. Then it takes the box's
 * whole width, with the buttons on a row under it (`data-stacked` on
 * `.composer`). Whether it wraps is always measured on that one line, so a
 * word at the edge doesn't flip the box back and forth.
 */
export function useFitInput(input: RefObject<HTMLTextAreaElement>, text: string, max: number, enabled = true): boolean {
  const [stacked, setStacked] = useState(false)

  useLayoutEffect(() => {
    const node = input.current
    const box = node?.closest<HTMLElement>('.composer')
    if (!node || !box) return
    let width = 0
    const fit = (): void => {
      node.style.height = 'auto'
      let wraps = false
      if (enabled && text) {
        const was = box.dataset.stacked
        delete box.dataset.stacked
        wraps = lines(node) > 1
        if (was !== undefined) box.dataset.stacked = was
      }
      setStacked(wraps)
      node.style.height = `${Math.min(node.scrollHeight, max)}px`
    }
    fit()
    // A narrower window can wrap what fitted, and a wider one unwrap it.
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width === width) return
      const first = width === 0
      width = entry.contentRect.width
      if (!first) fit()
    })
    observer.observe(box)
    return () => observer.disconnect()
  }, [input, text, max, enabled, stacked])

  return stacked
}
