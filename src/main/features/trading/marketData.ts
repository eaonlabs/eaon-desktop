import type { Bar, BarRange, Quote } from '@shared/trading'

/**
 * Prices, from Yahoo Finance's chart API — free, no key, and it covers every
 * US stock and ETF. Quotes are cached for 15 seconds: the desk, the agent's
 * tools and the simulator all ask for the same few symbols, often within the
 * same second, and Yahoo rate-limits clients that hammer it.
 *
 * `indicators()` boils a range of bars down to the handful of numbers a model
 * can reason with (moving averages, RSI, ATR, MACD, volume against its
 * average, the range), so the history tool hands the agent a paragraph rather
 * than 300 raw bars.
 *
 * Two more free, keyless Yahoo feeds help the agent find trades: the
 * predefined screeners (today's gainers, losers, most active) and per-ticker
 * RSS headlines. The search API's `news` looks similar but is not about the
 * ticker searched for, so it is not used.
 */

export const YAHOO_CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart'
export const YAHOO_SCREENER_URL = 'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved'
/** Per-ticker headlines. The search API's news is not about the ticker searched for; this feed is. */
export const YAHOO_NEWS_URL = 'https://feeds.finance.yahoo.com/rss/2.0/headline'
export const DATA_SOURCE = 'Prices from Yahoo Finance; they can lag the market by a few seconds or, for some exchanges, up to 15 minutes.'

/**
 * Yahoo refuses requests without a browser-like User-Agent, and has at times
 * answered 429 to one particular browser string while serving another; on a
 * 429 the next one is tried before giving up.
 */
const USER_AGENTS = ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'Mozilla/5.0']

const QUOTE_TTL_MS = 15_000
const BARS_TTL_MS = 60_000
const SCREEN_TTL_MS = 60_000
const NEWS_TTL_MS = 5 * 60_000
const TIMEOUT_MS = 10_000

/** What a bar range is sampled at: intraday for a day or a week, daily beyond. */
export const RANGE_INTERVAL: Record<BarRange, string> = { '1d': '5m', '5d': '15m', '1mo': '1d', '6mo': '1d', '1y': '1d' }
export const BAR_RANGES = Object.keys(RANGE_INTERVAL) as BarRange[]

/** US tickers: a letter, then letters, digits, dots or dashes (BRK.B, BF-B). */
const SYMBOL = /^[A-Z][A-Z0-9.\-]{0,9}$/

/** Where prices come from. The engine and the simulator only need this much, so tests can fake it. */
export interface PriceFeed {
  quote(symbol: string): Promise<Quote>
  bars(symbol: string, range: BarRange): Promise<Bar[]>
  /** Today's movers, for finding what to trade. Optional: a test feed may not have it. */
  screen?(kind: ScreenKind, count: number): Promise<ScreenRow[]>
  /** Recent headlines about one stock, newest first. Optional, like `screen`. */
  news?(symbol: string, count: number): Promise<Headline[]>
  /** A line for the desk's footnote. */
  readonly source: string
}

export type ScreenKind = 'gainers' | 'losers' | 'active'
export const SCREEN_KINDS: ScreenKind[] = ['gainers', 'losers', 'active']
const SCREEN_IDS: Record<ScreenKind, string> = { gainers: 'day_gainers', losers: 'day_losers', active: 'most_actives' }

export interface ScreenRow {
  symbol: string
  name: string | null
  price: number
  changePct: number
  volume: number | null
  /** Today's volume over the 3-month daily average: 2 means twice the usual trading. */
  relativeVolume: number | null
  marketCap: number | null
}

export interface Headline {
  title: string
  publisher: string | null
  at: number
  url: string | null
}

/** "aapl", " $AAPL " → "AAPL". Throws a sentence for anything that isn't a ticker. */
export function normalizeSymbol(raw: unknown): string {
  const symbol = String(raw ?? '')
    .trim()
    .replace(/^\$/, '')
    .toUpperCase()
  if (!SYMBOL.test(symbol)) {
    throw new Error(`"${String(raw ?? '').slice(0, 20)}" isn't a stock symbol. Use the ticker, like AAPL for Apple or SPY for the S&P 500 ETF.`)
  }
  return symbol
}

interface ChartMeta {
  symbol?: string
  currency?: string
  regularMarketPrice?: number
  chartPreviousClose?: number
  previousClose?: number
  regularMarketDayHigh?: number
  regularMarketDayLow?: number
  regularMarketVolume?: number
  regularMarketTime?: number
  longName?: string
  shortName?: string
}

interface ChartResult {
  meta?: ChartMeta
  timestamp?: number[]
  indicators?: { quote?: { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }[] }
}

interface ChartResponse {
  chart?: { result?: ChartResult[] | null; error?: { code?: string; description?: string } | null }
}

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const round = (value: number, places = 4): number => Math.round(value * 10 ** places) / 10 ** places

export interface YahooOptions {
  /** The chart endpoint; tests point it at a local server. */
  baseUrl?: string
  screenerUrl?: string
  newsUrl?: string
  fetch?: typeof fetch
  now?: () => number
}

export class YahooMarketData implements PriceFeed {
  readonly source = DATA_SOURCE
  private readonly baseUrl: string
  private readonly screenerUrl: string
  private readonly newsUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly quotes = new Map<string, { quote: Quote; at: number }>()
  private readonly barCache = new Map<string, { bars: Bar[]; at: number }>()
  private readonly screens = new Map<ScreenKind, { rows: ScreenRow[]; at: number }>()
  private readonly headlines = new Map<string, { items: Headline[]; at: number }>()
  /** Requests in flight, so ten callers asking for AAPL at once make one request. */
  private readonly inflight = new Map<string, Promise<ChartResult>>()

  constructor(options: YahooOptions = {}) {
    this.baseUrl = (options.baseUrl ?? YAHOO_CHART_URL).replace(/\/+$/, '')
    this.screenerUrl = options.screenerUrl ?? YAHOO_SCREENER_URL
    this.newsUrl = options.newsUrl ?? YAHOO_NEWS_URL
    this.fetchImpl = options.fetch ?? fetch
    this.now = options.now ?? Date.now
  }

  async quote(raw: string): Promise<Quote> {
    const symbol = normalizeSymbol(raw)
    const cached = this.quotes.get(symbol)
    if (cached && this.now() - cached.at < QUOTE_TTL_MS) return { ...cached.quote }
    // range=1d makes `previousClose` yesterday's close; over longer ranges
    // `chartPreviousClose` is the close before the whole range instead.
    const result = await this.chart(symbol, '1d', '5m')
    const quote = toQuote(symbol, result.meta ?? {}, this.now())
    this.quotes.set(symbol, { quote, at: this.now() })
    return { ...quote }
  }

  async bars(raw: string, range: BarRange): Promise<Bar[]> {
    const symbol = normalizeSymbol(raw)
    if (!(range in RANGE_INTERVAL)) throw new Error(`Pick a range of ${BAR_RANGES.join(', ')}.`)
    const key = `${symbol}|${range}`
    const cached = this.barCache.get(key)
    if (cached && this.now() - cached.at < BARS_TTL_MS) return cached.bars.map((b) => ({ ...b }))
    const result = await this.chart(symbol, range, RANGE_INTERVAL[range])
    const bars = toBars(result)
    this.barCache.set(key, { bars, at: this.now() })
    // A fresh chart carries a fresh quote too; no need to ask again.
    if (result.meta) this.quotes.set(symbol, { quote: toQuote(symbol, result.meta, this.now()), at: this.now() })
    return bars.map((b) => ({ ...b }))
  }

  /** Today's biggest gainers, losers or most traded US stocks, from Yahoo's predefined screeners. */
  async screen(kind: ScreenKind, count = 25): Promise<ScreenRow[]> {
    if (!SCREEN_IDS[kind]) throw new Error(`Pick a list: ${SCREEN_KINDS.join(', ')}.`)
    const cached = this.screens.get(kind)
    if (cached && this.now() - cached.at < SCREEN_TTL_MS) return cached.rows.map((r) => ({ ...r }))
    const response = await this.get(`${this.screenerUrl}?scrIds=${SCREEN_IDS[kind]}&count=100`, 'the market screener')
    const body = (await response.json().catch(() => null)) as ScreenerResponse | null
    const quotes = body?.finance?.result?.[0]?.quotes
    if (!response.ok || !Array.isArray(quotes)) throw new Error(`Yahoo Finance couldn’t list today’s ${kind} (HTTP ${response.status}). Try again shortly.`)
    const rows = quotes.flatMap((q): ScreenRow[] => {
      const price = finite(q.regularMarketPrice)
      if (!q.symbol || price === null) return []
      const volume = finite(q.regularMarketVolume)
      const average = finite(q.averageDailyVolume3Month)
      return [
        {
          symbol: q.symbol,
          name: q.shortName || q.longName || null,
          price,
          changePct: round(finite(q.regularMarketChangePercent) ?? 0, 2),
          volume,
          relativeVolume: volume !== null && average ? round(volume / average, 2) : null,
          marketCap: finite(q.marketCap)
        }
      ]
    })
    this.screens.set(kind, { rows, at: this.now() })
    return rows.slice(0, Math.max(1, count)).map((r) => ({ ...r }))
  }

  /** The latest headlines about one stock. */
  async news(raw: string, count = 6): Promise<Headline[]> {
    const symbol = normalizeSymbol(raw)
    const cached = this.headlines.get(symbol)
    if (cached && this.now() - cached.at < NEWS_TTL_MS) return cached.items.slice(0, count).map((h) => ({ ...h }))
    const response = await this.get(`${this.newsUrl}?s=${encodeURIComponent(symbol.replace(/\./g, '-'))}&region=US&lang=en-US`, 'news')
    if (!response.ok) throw new Error(`Yahoo Finance couldn’t give news for ${symbol} (HTTP ${response.status}).`)
    const items = parseRss(await response.text())
    this.headlines.set(symbol, { items, at: this.now() })
    return items.slice(0, count).map((h) => ({ ...h }))
  }

  /** A GET with the browser-like User-Agent fallback the chart API needs. */
  private async get(url: string, what: string): Promise<Response> {
    let response: Response | null = null
    for (const agent of USER_AGENTS) {
      try {
        response = await this.fetchImpl(url, { headers: { 'User-Agent': agent, Accept: 'application/json, application/rss+xml, */*' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
      } catch (error) {
        throw new Error(`Couldn’t reach Yahoo Finance for ${what} (${error instanceof Error ? error.message : String(error)}). Check your internet connection.`)
      }
      if (response.status !== 429 || agent === USER_AGENTS[USER_AGENTS.length - 1]) break
      await response.body?.cancel().catch(() => undefined)
    }
    if (!response) throw new Error(`Couldn’t reach Yahoo Finance for ${what}.`)
    if (response.status === 429) throw new Error('Yahoo Finance is limiting requests right now. Try again in a minute.')
    return response
  }

  private chart(symbol: string, range: string, interval: string): Promise<ChartResult> {
    const key = `${symbol}|${range}|${interval}`
    const pending = this.inflight.get(key)
    if (pending) return pending
    const request = this.fetchChart(symbol, range, interval).finally(() => this.inflight.delete(key))
    this.inflight.set(key, request)
    return request
  }

  private async fetchChart(symbol: string, range: string, interval: string): Promise<ChartResult> {
    // Yahoo writes share classes with a dash (BRK-B) where brokers use a dot (BRK.B).
    const url = `${this.baseUrl}/${encodeURIComponent(symbol.replace(/\./g, '-'))}?interval=${interval}&range=${range}`
    let response: Response | null = null
    for (const agent of USER_AGENTS) {
      try {
        response = await this.fetchImpl(url, { headers: { 'User-Agent': agent, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
      } catch (error) {
        const name = error instanceof Error ? error.name : ''
        if (name === 'TimeoutError' || name === 'AbortError') throw new Error('Yahoo Finance took too long to answer for prices. Check your internet connection and try again.')
        throw new Error(`Couldn’t reach Yahoo Finance for prices (${error instanceof Error ? error.message : String(error)}). Check your internet connection.`)
      }
      if (response.status !== 429 || agent === USER_AGENTS[USER_AGENTS.length - 1]) break
      // Drained, or the connection stays tied up until it times out.
      await response.body?.cancel().catch(() => undefined)
    }
    if (!response) throw new Error('Couldn’t reach Yahoo Finance for prices.')
    const body = (await response.json().catch(() => null)) as ChartResponse | null
    const result = body?.chart?.result?.[0]
    if (response.status === 404 || (response.ok && !result) || body?.chart?.error?.code === 'Not Found') {
      throw new Error(`Couldn’t find a stock called ${symbol}. Check the ticker symbol — for example AAPL for Apple.`)
    }
    if (response.status === 429) throw new Error('Yahoo Finance is limiting price requests right now. Try again in a minute.')
    if (!response.ok || !result) {
      const why = body?.chart?.error?.description
      throw new Error(`Yahoo Finance couldn’t give prices for ${symbol} (HTTP ${response.status}${why ? `: ${why}` : ''}). Try again shortly.`)
    }
    return result
  }
}

interface ScreenerResponse {
  finance?: {
    result?: {
      quotes?: {
        symbol?: string
        shortName?: string
        longName?: string
        regularMarketPrice?: number
        regularMarketChangePercent?: number
        regularMarketVolume?: number
        averageDailyVolume3Month?: number
        marketCap?: number
      }[]
    }[]
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" }
const decode = (text: string): string =>
  text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
      if (ENTITIES[code]) return ENTITIES[code]
      if (code.startsWith('#x')) return String.fromCodePoint(parseInt(code.slice(2), 16))
      if (code.startsWith('#')) return String.fromCodePoint(Number(code.slice(1)))
      return whole
    })
    .replace(/\s+/g, ' ')
    .trim()

/** Headlines out of an RSS 2.0 feed, newest first. A regex is enough for this one flat format. */
export function parseRss(xml: string): Headline[] {
  const items: Headline[] = []
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const field = (name: string): string | null => {
      const found = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(match[1])
      return found ? decode(found[1]) : null
    }
    const title = field('title')
    if (!title) continue
    const date = Date.parse(field('pubDate') ?? '')
    items.push({ title, publisher: field('source'), at: Number.isFinite(date) ? date : 0, url: field('link') })
  }
  return items.sort((a, b) => b.at - a.at)
}

function toQuote(symbol: string, meta: ChartMeta, now: number): Quote {
  const price = finite(meta.regularMarketPrice)
  if (price === null || price <= 0) throw new Error(`Yahoo Finance has no current price for ${symbol}. It may not trade any more.`)
  const prevClose = finite(meta.previousClose) ?? finite(meta.chartPreviousClose) ?? price
  const change = price - prevClose
  const time = finite(meta.regularMarketTime)
  return {
    symbol,
    name: meta.longName || meta.shortName || null,
    price,
    change: round(change),
    changePct: prevClose > 0 ? round((change / prevClose) * 100, 3) : 0,
    prevClose,
    dayHigh: finite(meta.regularMarketDayHigh),
    dayLow: finite(meta.regularMarketDayLow),
    volume: finite(meta.regularMarketVolume),
    currency: meta.currency || 'USD',
    at: time !== null ? time * 1000 : now
  }
}

/** Bars oldest first; a slot with no trade (null close) is skipped rather than drawn as zero. */
function toBars(result: ChartResult): Bar[] {
  const times = result.timestamp ?? []
  const q = result.indicators?.quote?.[0] ?? {}
  const bars: Bar[] = []
  for (let i = 0; i < times.length; i++) {
    const c = finite(q.close?.[i])
    if (c === null) continue
    // Yahoo's numbers are float32 noise past the cent (330.79998779296875).
    bars.push({
      t: times[i] * 1000,
      o: round(finite(q.open?.[i]) ?? c),
      h: round(finite(q.high?.[i]) ?? c),
      l: round(finite(q.low?.[i]) ?? c),
      c: round(c),
      v: finite(q.volume?.[i]) ?? 0
    })
  }
  return bars
}

/* --------------------------------------------------------------- indicators */

export interface Indicators {
  /** How many bars these were computed from. */
  bars: number
  last: number
  /** From the first close of the range to the last, in percent. */
  changePct: number
  sma20: number | null
  sma50: number | null
  /** Wilder's 14-period RSI, 0–100. */
  rsi14: number | null
  /** The highest high and lowest low of the last 20 bars. */
  high20: number
  low20: number
  /** The range's highest high and lowest low. */
  high: number
  low: number
  /** Wilder's 14-period average true range: how far the price typically moves in one bar. */
  atr14: number | null
  /** The last bar's volume over the average of the 20 before it. */
  volumeRatio: number | null
  /** MACD (12, 26) minus its 9-period signal: positive and rising is upward momentum. */
  macdHist: number | null
  /** The histogram one bar earlier, to tell rising from falling. */
  macdHistPrev: number | null
}

function sma(closes: number[], period: number): number | null {
  if (closes.length < period) return null
  let sum = 0
  for (let i = closes.length - period; i < closes.length; i++) sum += closes[i]
  return sum / period
}

/**
 * Wilder's RSI: the first average gain and loss are plain means over the
 * first `period` changes, then each later change is folded in with weight
 * 1/period. All gains and no losses is 100.
 */
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length <= period) return null
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1]
    if (change > 0) gain += change
    else loss -= change
  }
  gain /= period
  loss /= period
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1]
    gain = (gain * (period - 1) + Math.max(change, 0)) / period
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period
  }
  if (loss === 0) return gain === 0 ? 50 : 100
  return 100 - 100 / (1 + gain / loss)
}

/**
 * Wilder's ATR: true range is the largest of high−low and the gaps from the
 * previous close; the first average is a plain mean, later ones smoothed by
 * 1/period. It is what stop distances and position sizes are measured in.
 */
export function atr(bars: Bar[], period = 14): number | null {
  if (bars.length <= period) return null
  const tr = (i: number): number => Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c))
  let value = 0
  for (let i = 1; i <= period; i++) value += tr(i)
  value /= period
  for (let i = period + 1; i < bars.length; i++) value = (value * (period - 1) + tr(i)) / period
  return value
}

/** Exponential moving averages of a series, seeded with the first value. */
function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1)
  const out: number[] = []
  values.forEach((value, i) => out.push(i === 0 ? value : value * k + out[i - 1] * (1 - k)))
  return out
}

/** The MACD histogram (12/26 EMAs, 9-period signal) for the last two bars; null with too little history. */
export function macdHistogram(closes: number[]): [number, number] | null {
  if (closes.length < 35) return null
  const fast = ema(closes, 12)
  const slow = ema(closes, 26)
  const line = closes.map((_, i) => fast[i] - slow[i])
  const signal = ema(line, 9)
  const n = closes.length - 1
  return [line[n] - signal[n], line[n - 1] - signal[n - 1]]
}

export function indicators(bars: Bar[]): Indicators | null {
  if (bars.length === 0) return null
  const closes = bars.map((b) => b.c)
  const recent = bars.slice(-20)
  const first = closes[0]
  const last = closes[closes.length - 1]
  const r = rsi(closes)
  const s20 = sma(closes, 20)
  const s50 = sma(closes, 50)
  const a = atr(bars)
  const before = bars.slice(-21, -1).map((b) => b.v).filter((v) => v > 0)
  const avgVolume = before.length >= 10 ? before.reduce((sum, v) => sum + v, 0) / before.length : 0
  const m = macdHistogram(closes)
  return {
    bars: bars.length,
    last,
    changePct: first > 0 ? round(((last - first) / first) * 100, 2) : 0,
    sma20: s20 === null ? null : round(s20),
    sma50: s50 === null ? null : round(s50),
    rsi14: r === null ? null : round(r, 1),
    high20: Math.max(...recent.map((b) => b.h)),
    low20: Math.min(...recent.map((b) => b.l)),
    high: Math.max(...bars.map((b) => b.h)),
    low: Math.min(...bars.map((b) => b.l)),
    atr14: a === null ? null : round(a),
    volumeRatio: avgVolume > 0 ? round(bars[bars.length - 1].v / avgVolume, 2) : null,
    macdHist: m ? round(m[0]) : null,
    macdHistPrev: m ? round(m[1]) : null
  }
}
