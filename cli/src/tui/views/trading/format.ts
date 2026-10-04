/**
 * Number formatting for the desk: money with separators, compact money for
 * tight columns, signed changes with arrows. A value that rounds to zero is
 * shown unsigned ("0.00%"), never "-0.00%".
 */

const group = (value: number, digits: number): string =>
  Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })

const isZero = (value: number, digits: number): boolean => Math.abs(value) < 0.5 * 10 ** -digits

export function usd(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${value < 0 && !isZero(value, digits) ? '-' : ''}$${group(value, digits)}`
}

/** "$494.3K", "$1.25M", "$980". */
export function usdShort(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const sign = value < 0 ? '-' : ''
  const a = Math.abs(value)
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`
  if (a >= 1e4) return `${sign}$${(a / 1e3).toFixed(1)}K`
  return `${sign}$${group(a, a >= 1000 ? 0 : 2)}`
}

export function signedUsd(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (isZero(value, digits)) return usd(0, digits)
  return `${value > 0 ? '+' : '-'}$${group(value, digits)}`
}

export function signedPct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (isZero(value, digits)) return `${(0).toFixed(digits)}%`
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`
}

export function pct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${value.toFixed(digits)}%`
}

/** A price: two decimals, four under a dollar, none of the grouping lost. */
export function price(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const digits = Math.abs(value) < 1 ? 4 : Math.abs(value) >= 10_000 ? 0 : 2
  return group(value, digits).replace(/^/, value < 0 ? '-' : '')
}

export function arrow(value: number | null | undefined): string {
  if (!value || Math.abs(value) < 1e-9) return '•'
  return value > 0 ? '▲' : '▼'
}

export function shares(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(value < 1 ? 4 : 2).replace(/0+$/, '').replace(/\.$/, '')
}

export function volume(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(0)}K`
  return String(Math.round(value))
}

export function time(at: number | null | undefined): string {
  if (!at) return '—'
  const d = new Date(at)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

export function span(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h${String(m % 60).padStart(2, '0')}m`
  return `${Math.round(h / 24)}d`
}
