import { create } from 'zustand'
import type { TradingSnapshot } from '@shared/trading'

/**
 * The trading desk's mirror of main's trading engine: the latest snapshot,
 * replaced whole whenever main pushes one. Commands go straight through
 * `window.api.trading`; their results arrive here as the next snapshot.
 */
interface TradingState {
  snapshot: TradingSnapshot | null
  /** A command failed; shown at the top of the desk until the next one. */
  error: string | null
  init: () => Promise<void>
  set: (snapshot: TradingSnapshot) => void
  /** Runs a command, keeping any snapshot it returns and any error it throws. */
  run: <T>(work: () => Promise<T>) => Promise<T | null>
}

let bound = false

export const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const isSnapshot = (value: unknown): value is TradingSnapshot =>
  Boolean(value && typeof value === 'object' && 'config' in value && 'stats' in value && 'equity' in value)

export const useTrading = create<TradingState>((set) => ({
  snapshot: null,
  error: null,

  async init() {
    if (bound) return
    bound = true
    window.api.trading.onChanged((snapshot) => set({ snapshot }))
    try {
      set({ snapshot: await window.api.trading.snapshot() })
      // The desk wants fresh numbers, not the last saved ones.
      void window.api.trading.refresh().then((snapshot) => set({ snapshot }), () => {})
    } catch (error) {
      set({ error: errorText(error) })
    }
  },

  set(snapshot) {
    set({ snapshot })
  },

  async run(work) {
    set({ error: null })
    try {
      const result = await work()
      if (isSnapshot(result)) set({ snapshot: result })
      return result
    } catch (error) {
      set({ error: errorText(error) })
      return null
    }
  }
}))

/* --------------------------------------------------------------- formatting */

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const moneyRound = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const compact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 })

export function usd(value: number, round = false): string {
  return (round ? moneyRound : money).format(value)
}

/** "$12.9K", for axis ticks. */
export function usdCompact(value: number): string {
  return Math.abs(value) >= 10_000 ? compact.format(value) : moneyRound.format(value)
}

/** "+$1,284.10" / "−$12.00": a change always carries its sign — unless it rounds to nothing. */
export function signedUsd(value: number): string {
  if (Math.abs(value) < 0.005) return money.format(0)
  const sign = value > 0 ? '+' : '−'
  return `${sign}${money.format(Math.abs(value))}`
}

/** "+2.41%" / "−0.30%". */
export function signedPct(value: number, digits = 2): string {
  // A move too small to show isn't a gain or a loss: "0.00%", not "−0.00%".
  if (Math.abs(value) < 0.5 / 10 ** digits) return `${(0).toFixed(digits)}%`
  const sign = value > 0 ? '+' : '−'
  return `${sign}${Math.abs(value).toFixed(digits)}%`
}

export function qty(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
}

/** "up" / "down" / "flat", for a gain or loss cue (always shown with its sign and an arrow, never colour alone). */
export function direction(value: number): 'up' | 'down' | 'flat' {
  return value > 0.000_5 ? 'up' : value < -0.000_5 ? 'down' : 'flat'
}

export function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function dayAndTime(at: number): string {
  const date = new Date(at)
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  return sameDay ? clock(at) : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
