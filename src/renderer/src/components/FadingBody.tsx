import { useEffect, useRef, type ReactNode } from 'react'

/**
 * A side panel's list, fading and softly blurring out at an edge with more
 * of it past that edge, instead of being sliced off under what sits above it
 * and at the bottom of the panel. Each edge eases in over the first few
 * pixels of scroll, so a list that fits shows no fade at all. The sidebars
 * and Settings' list both use it.
 */
export function FadingBody({ className = 'sidebar__body', children }: { className?: string; children: ReactNode }): JSX.Element {
  const wrap = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = wrap.current
    const node = body.current
    if (!host || !node) return
    const ease = (px: number): string => {
      const t = Math.min(1, Math.max(0, px / 32))
      return (t * t * (3 - 2 * t)).toFixed(3)
    }
    let last = ''
    const update = (): void => {
      const top = ease(node.scrollTop)
      const bottom = ease(node.scrollHeight - node.clientHeight - node.scrollTop)
      if (`${top} ${bottom}` === last) return
      last = `${top} ${bottom}`
      host.style.setProperty('--fade-top', top)
      host.style.setProperty('--fade-bottom', bottom)
    }
    update()
    node.addEventListener('scroll', update, { passive: true })
    // The list also grows and shrinks without a scroll: a chat added, a project opened or folded.
    const sizes = new ResizeObserver(update)
    const watch = (): void => {
      sizes.disconnect()
      sizes.observe(node)
      for (const child of Array.from(node.children)) sizes.observe(child)
    }
    watch()
    const rows = new MutationObserver(watch)
    rows.observe(node, { childList: true })
    return () => {
      node.removeEventListener('scroll', update)
      sizes.disconnect()
      rows.disconnect()
    }
  }, [])
  return (
    <div ref={wrap} className="sidebar__fade">
      <div ref={body} className={`${className} scroll`}>
        {children}
      </div>
      {(['top', 'bottom'] as const).map((edge) => (
        <div key={edge} className="edge-veil" data-edge={edge} aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} style={{ ['--i' as string]: i }} />
          ))}
        </div>
      ))}
    </div>
  )
}
