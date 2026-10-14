/**
 * Cron expressions for scheduled tasks: parsing, the next and previous time
 * one fires, and a plain-English description.
 *
 * Five fields: minute (0-59), hour (0-23), day of the month (1-31), month
 * (1-12 or JAN-DEC) and day of the week (0-7 or SUN-SAT, where 0 and 7 are
 * both Sunday). Each takes `*`, a number, a range (`1-5`), a list (`1,15`)
 * and a step (`*\/15`, `9-17/2`). `@hourly`, `@daily` (`@midnight`),
 * `@weekly`, `@monthly` and `@yearly` (`@annually`) stand for the usual
 * expressions. As in Vixie cron, when both day fields are restricted a day
 * matching either one fires.
 *
 * Times are a wall clock: this computer's, or an IANA zone's when one is
 * given. The walk goes day by day over calendar dates (never by adding 24
 * hours), so daylight-saving changes behave like daily schedules do: a time
 * in the skipped spring hour runs just after it, and a repeated autumn time
 * runs once.
 */

export interface Cron {
  minutes: number[]
  hours: number[]
  days: Set<number>
  months: Set<number>
  weekdays: Set<number>
  /** The day-of-month field starts with `*`. */
  anyDay: boolean
  /** The day-of-week field starts with `*`. */
  anyWeekday: boolean
}

const SHORTHANDS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *'
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

interface FieldSpec {
  name: string
  min: number
  max: number
  names?: string[]
  /** Where the first name sits: months are 1-based. */
  nameBase?: number
}

const FIELDS: FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of the month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS, nameBase: 1 },
  { name: 'day of the week', min: 0, max: 7, names: WEEKDAYS, nameBase: 0 }
]

function value(text: string, spec: FieldSpec): number | null {
  const upper = text.toUpperCase()
  const named = spec.names?.indexOf(upper) ?? -1
  if (named >= 0) return named + (spec.nameBase ?? 0)
  if (!/^\d+$/.test(text)) return null
  const n = Number(text)
  return n >= spec.min && n <= spec.max ? n : null
}

function field(text: string, spec: FieldSpec): number[] | string {
  const out = new Set<number>()
  for (const part of text.split(',')) {
    const match = /^([^/]+)(?:\/(\d+))?$/.exec(part)
    if (!match) return `The ${spec.name} field has "${part}", which isn't a value, range or step.`
    const step = match[2] === undefined ? 1 : Number(match[2])
    if (step < 1) return `The ${spec.name} step must be at least 1.`
    let from: number
    let to: number
    if (match[1] === '*') {
      from = spec.min
      to = spec.max
    } else {
      const range = match[1].split('-')
      if (range.length > 2) return `The ${spec.name} field has "${part}", which isn't a value, range or step.`
      const a = value(range[0], spec)
      const b = range.length === 2 ? value(range[1], spec) : a
      if (a === null || b === null) return `The ${spec.name} must be between ${spec.min} and ${spec.max}${spec.names ? ` (or ${spec.names[0]}-${spec.names[spec.names.length - 1]})` : ''}.`
      if (b < a) return `The ${spec.name} range ${match[1]} runs backwards.`
      from = a
      // "5/15" means from 5 to the end, every 15.
      to = range.length === 1 && match[2] !== undefined ? spec.max : b
    }
    for (let n = from; n <= to; n += step) out.add(n)
  }
  return [...out].sort((x, y) => x - y)
}

/** The parsed expression, or what is wrong with it. */
export function parseCron(expr: string): Cron | string {
  const trimmed = expr.trim().replace(/\s+/g, ' ')
  const text = SHORTHANDS[trimmed.toLowerCase()] ?? trimmed
  if (text.startsWith('@')) return `"${trimmed}" isn't a shorthand Eaon knows. Use @hourly, @daily, @weekly, @monthly or @yearly.`
  const parts = text.split(' ')
  if (parts.length !== 5) return 'A cron expression has five fields: minute, hour, day of the month, month and day of the week.'
  const parsed: number[][] = []
  for (let i = 0; i < 5; i++) {
    const result = field(parts[i], FIELDS[i])
    if (typeof result === 'string') return result
    parsed.push(result)
  }
  return {
    minutes: parsed[0],
    hours: parsed[1],
    days: new Set(parsed[2]),
    months: new Set(parsed[3]),
    weekdays: new Set(parsed[4].map((d) => d % 7)),
    // As in Vixie cron, a field that starts with `*` (`*`, `*/2`) leaves that day rule open.
    anyDay: parts[2].startsWith('*'),
    anyWeekday: parts[4].startsWith('*')
  }
}

/** Whether `tz` is a time zone this computer knows. */
export function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

interface Wall {
  year: number
  month: number // 0-11
  day: number
  hour: number
  minute: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric'
    })
    formatters.set(tz, f)
  }
  return f
}

function wallAt(at: number, tz?: string): Wall {
  if (!tz) {
    const d = new Date(at)
    return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate(), hour: d.getHours(), minute: d.getMinutes() }
  }
  const parts: Record<string, number> = {}
  for (const part of formatter(tz).formatToParts(at)) if (part.type !== 'literal') parts[part.type] = Number(part.value)
  return { year: parts.year, month: parts.month - 1, day: parts.day, hour: parts.hour % 24, minute: parts.minute }
}

/** The zone's offset from UTC at `at`, in ms. */
function offsetAt(at: number, tz: string): number {
  const w = wallAt(at, tz)
  const asUtc = Date.UTC(w.year, w.month, w.day, w.hour, w.minute)
  return asUtc - (at - (((at % 60_000) + 60_000) % 60_000))
}

/**
 * The moment a wall-clock time happens. A time the clocks skip lands as far
 * after the gap as it was into it (02:30 → 03:30), like `new Date(...)`; a
 * repeated time gives its first occurrence.
 */
function epochOf(year: number, month: number, day: number, hour: number, minute: number, tz?: string): number {
  if (!tz) return new Date(year, month, day, hour, minute, 0, 0).getTime()
  const utc = Date.UTC(year, month, day, hour, minute)
  // The offset before the wall time, then after: they differ only near a change.
  const before = offsetAt(utc - 86_400_000 / 2, tz)
  const after = offsetAt(utc + 86_400_000 / 2, tz)
  const first = utc - before
  if (before === after) return first
  // Near a change: the earliest candidate that reads back as this wall time.
  const second = utc - after
  for (const candidate of [Math.min(first, second), Math.max(first, second)]) {
    const w = wallAt(candidate, tz)
    if (w.hour === hour && w.minute === minute && w.day === day) return candidate
  }
  // In the gap: read with the offset from before it, which lands as far
  // past the gap as the time was into it.
  return utc - before
}

function dayMatches(cron: Cron, year: number, month: number, day: number): boolean {
  if (!cron.months.has(month + 1)) return false
  const date = new Date(Date.UTC(year, month, day))
  if (date.getUTCMonth() !== month) return false
  const weekday = date.getUTCDay()
  const dayOk = cron.days.has(day)
  const weekdayOk = cron.weekdays.has(weekday)
  if (cron.anyDay && cron.anyWeekday) return true
  if (cron.anyDay) return weekdayOk
  if (cron.anyWeekday) return dayOk
  return dayOk || weekdayOk
}

/** Far enough to reach Feb 29 from anywhere, with room. */
const MAX_DAYS = 366 * 9

/** The first time strictly after `after` the expression fires, or null if it never does. */
export function cronNext(cron: Cron, after: number, tz?: string): number | null {
  const start = wallAt(after, tz)
  for (let offset = 0; offset <= MAX_DAYS; offset++) {
    const date = new Date(Date.UTC(start.year, start.month, start.day + offset))
    const year = date.getUTCFullYear()
    const month = date.getUTCMonth()
    const day = date.getUTCDate()
    if (!dayMatches(cron, year, month, day)) continue
    for (const hour of cron.hours) {
      if (offset === 0 && hour < start.hour) continue
      for (const minute of cron.minutes) {
        if (offset === 0 && hour === start.hour && minute <= start.minute) continue
        const at = epochOf(year, month, day, hour, minute, tz)
        if (at > after) return at
      }
    }
  }
  return null
}

/** The last time at or before `at` the expression fired, or null if none in nine years. */
export function cronPrev(cron: Cron, at: number, tz?: string): number | null {
  const start = wallAt(at, tz)
  const hours = [...cron.hours].reverse()
  const minutes = [...cron.minutes].reverse()
  for (let offset = 0; offset <= MAX_DAYS; offset++) {
    const date = new Date(Date.UTC(start.year, start.month, start.day - offset))
    const year = date.getUTCFullYear()
    const month = date.getUTCMonth()
    const day = date.getUTCDate()
    if (!dayMatches(cron, year, month, day)) continue
    for (const hour of hours) {
      if (offset === 0 && hour > start.hour) continue
      for (const minute of minutes) {
        if (offset === 0 && hour === start.hour && minute > start.minute) continue
        const when = epochOf(year, month, day, hour, minute, tz)
        if (when <= at) return when
      }
    }
  }
  return null
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

const clock = (hour: number, minute: number): string =>
  new Date(2000, 0, 1, hour, minute).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

const ordinal = (n: number): string => {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}

function stepOf(values: number[], min: number, max: number): number | null {
  if (values.length < 2 || values[0] !== min) return null
  const step = values[1] - values[0]
  for (let i = 1; i < values.length; i++) if (values[i] - values[i - 1] !== step) return null
  return values[values.length - 1] + step > max ? step : null
}

function sameSet(set: Set<number>, list: number[]): boolean {
  return set.size === list.length && list.every((n) => set.has(n))
}

/**
 * "Every 15 minutes", "Weekdays at 9:00 AM", "On the 1st of every month at
 * 12:00 AM"; the expression itself when it doesn't read as a sentence.
 */
export function describeCron(expr: string, tz?: string): string {
  const cron = parseCron(expr)
  const zone = tz ? ` (${tz})` : ''
  if (typeof cron === 'string') return `Cron ${expr.trim()}${zone}`
  const allMonths = cron.months.size === 12
  const anyDays = cron.anyDay && cron.anyWeekday
  const allHours = cron.hours.length === 24
  const allMinutes = cron.minutes.length === 60

  let when: string | null = null
  if (anyDays && allMonths) {
    if (allHours && allMinutes) when = 'Every minute'
    else if (allHours) {
      const step = stepOf(cron.minutes, 0, 59)
      if (step) when = `Every ${step} minutes`
      else if (cron.minutes.length === 1) when = cron.minutes[0] === 0 ? 'Every hour' : `Every hour at :${String(cron.minutes[0]).padStart(2, '0')}`
    } else if (cron.minutes.length === 1) {
      const step = stepOf(cron.hours, 0, 23)
      if (step) when = `Every ${step} hours${cron.minutes[0] ? ` at :${String(cron.minutes[0]).padStart(2, '0')}` : ''}`
    }
  }
  if (!when && cron.minutes.length === 1 && cron.hours.length <= 3) {
    const at = cron.hours.map((h) => clock(h, cron.minutes[0])).join(', ')
    if (allMonths && anyDays) when = `Every day at ${at}`
    else if (allMonths && cron.anyDay) {
      const days = [...cron.weekdays].sort()
      if (sameSet(cron.weekdays, [1, 2, 3, 4, 5])) when = `Weekdays at ${at}`
      else if (sameSet(cron.weekdays, [0, 6])) when = `Weekends at ${at}`
      else if (days.length === 1) when = `Every ${DAY_NAMES[days[0]]} at ${at}`
      else {
        const ordered = [...days.filter((d) => d !== 0), ...days.filter((d) => d === 0)]
        when = `${ordered.map((d) => DAY_NAMES[d].slice(0, 3)).join(', ')} at ${at}`
      }
    } else if (cron.anyWeekday && !cron.anyDay && cron.days.size === 1) {
      const day = ordinal([...cron.days][0])
      if (allMonths) when = `On the ${day} of every month at ${at}`
      else if (cron.months.size === 1) when = `Every ${MONTH_NAMES[[...cron.months][0] - 1]} ${[...cron.days][0]} at ${at}`
    }
  }
  return `${when ?? `Cron ${expr.trim()}`}${zone}`
}
