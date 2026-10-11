import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { TradingSnapshot, TradingStep } from '@shared/trading'

/**
 * The trading desk's mirror of main's trading engine: the latest snapshot,
 * replaced whole whenever main pushes one. Commands go straight through
 * `window.api.trading`; their results arrive here as the next snapshot.
 */
interface TradingState {
  snapshot: TradingSnapshot | null
  /** The latest tools the session's agent used, newest last. */
  steps: TradingStep[]
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
  steps: [],
  error: null,

  async init() {
    if (bound) return
    bound = true
    window.api.trading.onChanged((snapshot) => set({ snapshot }))
    window.api.trading.onSteps((steps) => set({ steps }))
    void window.api.trading.steps().then((steps) => set({ steps }), () => {})
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

/** The time now, ticking every `everyMs` while the component is on screen: countdowns and "2 s ago". */
export function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), everyMs)
    return () => window.clearInterval(timer)
  }, [everyMs])
  return now
}

/** "12s", "4m 05s", "2h 10m": a countdown or an age. */
export function span(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}
