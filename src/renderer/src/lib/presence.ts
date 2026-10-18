import { useEffect, useState } from 'react'

/**
 * Keeps something mounted for `exitMs` after it is hidden, so it can animate
 * out rather than vanish. `closing` is true for that stretch; the element's
 * styles do the leaving. Shown again mid-exit, it simply stays.
 */
export function usePresence(shown: boolean, exitMs: number): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(shown)
  useEffect(() => {
    if (shown) {
      setMounted(true)
      return
    }
    const timer = setTimeout(() => setMounted(false), exitMs)
    return () => clearTimeout(timer)
  }, [shown, exitMs])
  return { mounted: shown || mounted, closing: !shown && mounted }
}
