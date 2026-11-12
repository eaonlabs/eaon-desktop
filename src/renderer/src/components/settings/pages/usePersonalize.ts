import { useEffect, useState } from 'react'
import type { Personalize } from '@shared/personalize'

/** Custom instructions and memory as main has them, kept current when another window or the model changes them. */
export function usePersonalize(): Personalize | null {
  const [value, setValue] = useState<Personalize | null>(null)
  useEffect(() => {
    let live = true
    void window.api.personalize.get().then((v) => live && setValue(v))
    const off = window.api.personalize.onChanged(setValue)
    return () => {
      live = false
      off()
    }
  }, [])
  return value
}
