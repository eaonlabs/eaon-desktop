/**
 * When the US stock market is open: the regular session, 9:30 to 16:00 New
 * York time on weekdays, minus NYSE holidays, with a 13:00 close on a few
 * half days.
 *
 * Everything is worked out in New York's own clock through
 * `Intl.DateTimeFormat`, never as "UTC − 5": New York is UTC−5 in winter and
 * UTC−4 in summer, and the switch falls on different dates from Europe's, so
 * a fixed offset is wrong for weeks every year. The session times themselves
 * (9:30, 13:00, 16:00) never fall inside a DST change (always 2 a.m.), which
 * keeps converting a New York wall-clock time back to an instant simple.
 *
 * The simulator uses this to decide when it may fill orders; Alpaca has its
 * own clock (`GET /v2/clock`), which wins when it is the broker.
 */

export const MARKET_ZONE = 'America/New_York'

/** NYSE full-day closures. Years not listed here only close on weekends. */
const HOLIDAYS = new Set([
  // 2026
  '2026-01-01',
  '2026-01-19',
  '2026-02-16',
  '2026-04-03',
  '2026-05-25',
  '2026-06-19',
  '2026-07-03',
  '2026-09-07',
  '2026-11-26',
  '2026-12-25',
  // 2027
  '2027-01-01',
  '2027-01-18',
  '2027-02-15',
  '2027-03-26',
  '2027-05-31',
  '2027-06-18',
  '2027-07-05',
  '2027-09-06',
  '2027-11-25',
  '2027-12-24'
])

/** Half days: the market closes at 13:00 New York time. */
const EARLY_CLOSES = new Set(['2026-11-27', '2026-12-24', '2027-11-26'])

const OPEN = { hour: 9, minute: 30 }
const CLOSE = { hour: 16, minute: 0 }
const EARLY_CLOSE = { hour: 13, minute: 0 }
/** Far enough to cross any run of weekends and holidays. */
const SEARCH_DAYS = 15

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

// `hourCycle: 'h23'` rather than `hour12: false`: the latter prints midnight as "24" in some engines.
const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: MARKET_ZONE,
  hourCycle: 'h23',
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
})

export interface MarketClockParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number
}

/** The wall clock in New York at an instant. */
export function marketClock(at: number): MarketClockParts {
  const parts: Record<string, string> = {}
  for (const part of formatter.formatToParts(new Date(at))) parts[part.type] = part.value
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday] ?? 0
  }
}

/** How far New York's clock is from UTC at an instant, in ms (negative: behind). */
function offsetAt(at: number): number {
  const c = marketClock(at)
  const wall = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second)
  // The formatter drops milliseconds; compare whole seconds.
  return wall - Math.floor(at / 1000) * 1000
}

/** The instant New York's clock reads this date and time. */
export function marketTimeToInstant(year: number, month: number, day: number, hour: number, minute: number): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute)
  // The second pass corrects a first guess that landed across a DST change
  // from the answer (only possible within a few hours of one).
  const first = guess - offsetAt(guess)
  return guess - offsetAt(first)
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** "YYYY-MM-DD" — the date in New York at an instant. */
export function marketDate(at: number): string {
  const c = marketClock(at)
  return `${c.year}-${pad(c.month)}-${pad(c.day)}`
}

function parseDate(key: string): { year: number; month: number; day: number } {
  const [year, month, day] = key.split('-').map(Number)
  return { year, month, day }
}

function addDays(key: string, days: number): string {
  const { year, month, day } = parseDate(key)
  const d = new Date(Date.UTC(year, month - 1, day + days))
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

function weekdayOf(key: string): number {
  const { year, month, day } = parseDate(key)
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

export function isTradingDay(key: string): boolean {
  const weekday = weekdayOf(key)
  return weekday !== 0 && weekday !== 6 && !HOLIDAYS.has(key)
}

export interface MarketSession {
  open: number
  close: number
  /** A half day, closing at 13:00. */
  early: boolean
}

/** The regular session on a New York date, or null when the market is closed all day. */
export function sessionOn(key: string): MarketSession | null {
  if (!isTradingDay(key)) return null
  const { year, month, day } = parseDate(key)
  const early = EARLY_CLOSES.has(key)
  const end = early ? EARLY_CLOSE : CLOSE
  return {
    open: marketTimeToInstant(year, month, day, OPEN.hour, OPEN.minute),
    close: marketTimeToInstant(year, month, day, end.hour, end.minute),
    early
  }
}

export function isOpen(at: number): boolean {
  const session = sessionOn(marketDate(at))
  return session !== null && at >= session.open && at < session.close
}

/** The next time the market opens, strictly after `at` (tomorrow's open while it is open now). */
export function nextOpen(at: number): number {
  let key = marketDate(at)
  for (let i = 0; i < SEARCH_DAYS; i++, key = addDays(key, 1)) {
    const session = sessionOn(key)
    if (session && session.open > at) return session.open
  }
  // Unreachable with SEARCH_DAYS covering any closure; keeps the type honest.
  return at + 24 * 3600_000
}

/** When the session in progress closes, or the next session's close when the market is closed now. */
export function nextClose(at: number): number {
  let key = marketDate(at)
  for (let i = 0; i < SEARCH_DAYS; i++, key = addDays(key, 1)) {
    const session = sessionOn(key)
    if (session && session.close > at) return session.close
  }
  return at + 24 * 3600_000
}

/** "10:35 AM ET", or "Mon 9:30 AM ET" when it is not today in New York. */
export function formatMarketTime(at: number, now = Date.now()): string {
  const sameDay = marketDate(at) === marketDate(now)
  const text = new Date(at).toLocaleString('en-US', {
    timeZone: MARKET_ZONE,
    ...(sameDay ? {} : { weekday: 'short' }),
    hour: 'numeric',
    minute: '2-digit'
  })
  return `${text} ET`
}
