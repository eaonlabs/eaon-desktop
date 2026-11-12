import { useEffect, useState } from 'react'
import { useApp } from '../../state/store'

/**
 * Whether Trading is on: switched on in Settings → General and started this
 * launch. The switch alone isn't enough: Trading's engine, tools and broker
 * link only start with the app, so one switched on a moment ago shows up
 * after a restart (`started` is what separates the two).
 */
export function useTradingOn(): { on: boolean; wanted: boolean; started: boolean } {
  const wanted = useApp((s) => s.settings?.general.trading === true)
  const [started, setStarted] = useState(false)
  useEffect(() => {
    let live = true
    void window.api.trading.available().then((ok) => live && setStarted(ok)).catch(() => live && setStarted(false))
    return () => {
      live = false
    }
  }, [wanted])
  return { on: wanted && started, wanted, started }
}
