import { EventEmitter } from 'node:events'
import type { Bar, BarRange, Quote } from '@shared/trading'
import { RANGE_INTERVAL, YahooMarketData, YAHOO_CHART_URL, type Headline, type ScreenKind, type ScreenRow } from '@main/features/trading/marketData'
import { store } from '@main/store'

/**
 * Market data for the desk's screens: quotes, intraday lines, bars,
 * movers and headlines, cached and refreshed only for what is on screen.
 *
 * The trading engine's price feed accepts only stock tickers, which is
 * right for orders. The desk also shows indices (^VIX), futures (GC=F),
 * currencies (EURUSD=X) and crypto (BTC-USD), so quotes and bars here come
 * straight from the same Yahoo chart endpoint, with the same browser-like
 * User-Agent fallback. A symbol is polled while a screen keeps asking for
 * it and dropped a little after it stops.
 */

const USER_AGENTS = ['Mozilla/5.0', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)']
const TIMEOUT_MS = 10_000
/** How long a quote stays fresh: shorter while the market is open. */
const QUOTE_FRESH_MS = 20_000
const BARS_FRESH_MS: Record<BarRange, number> = { '1d': 60_000, '5d': 5 * 60_000, '1mo': 30 * 60_000, '6mo': 60 * 60_000, '1y': 60 * 60_000 }
const SCREEN_FRESH_MS = 2 * 60_000
const NEWS_FRESH_MS = 10 * 60_000
/** A symbol nobody has asked about for this long stops being polled. */
const WANTED_FOR_MS = 30_000
const CONCURRENCY = 4

interface ChartMeta {
  symbol?: string
  currency?: string
  regularMarketPrice?: number
  previousClose?: number
  chartPreviousClose?: number
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

const round = (v: number, places = 4): number => Math.round(v * 10 ** places) / 10 ** places

async function fetchChart(symbol: string, range: string, interval: string): Promise<ChartResult> {
  const url = `${YAHOO_CHART_URL}/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`
  let response: Response | null = null
  for (const agent of USER_AGENTS) {
    response = await fetch(url, { headers: { 'User-Agent': agent, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (response.status !== 429 || agent === USER_AGENTS[USER_AGENTS.length - 1]) break
    await response.body?.cancel().catch(() => undefined)
  }
  if (!response) throw new Error('No answer from Yahoo Finance')
  if (response.status === 429) throw new Error('Yahoo Finance is limiting requests; trying again shortly')
  const body = (await response.json().catch(() => null)) as { chart?: { result?: ChartResult[] | null; error?: { description?: string } | null } } | null
  const result = body?.chart?.result?.[0]
  if (!response.ok || !result) throw new Error(body?.chart?.error?.description ?? `No data for ${symbol}`)
  return result
}

function toBars(result: ChartResult): Bar[] {
  const t = result.timestamp ?? []
  const q = result.indicators?.quote?.[0] ?? {}
  const out: Bar[] = []
  for (let i = 0; i < t.length; i++) {
    const c = q.close?.[i]
    if (typeof c !== 'number' || !Number.isFinite(c)) continue
    const o = q.open?.[i] ?? c
    out.push({ t: t[i] * 1000, o: round(o ?? c), h: round(q.high?.[i] ?? c), l: round(q.low?.[i] ?? c), c: round(c), v: q.volume?.[i] ?? 0 })
  }
  return out
}

function toQuote(symbol: string, meta: ChartMeta, bars: Bar[]): Quote {
  const price = meta.regularMarketPrice ?? bars[bars.length - 1]?.c ?? 0
  const prev = meta.previousClose ?? meta.chartPreviousClose ?? bars[0]?.o ?? price
  const change = price - prev
  return {
    symbol,
    name: meta.longName ?? meta.shortName ?? null,
    price: round(price),
    change: round(change),
    changePct: prev ? round((change / prev) * 100, 3) : 0,
    prevClose: round(prev),
    dayHigh: meta.regularMarketDayHigh ?? null,
    dayLow: meta.regularMarketDayLow ?? null,
    volume: meta.regularMarketVolume ?? null,
    currency: meta.currency ?? 'USD',
    at: (meta.regularMarketTime ?? Date.now() / 1000) * 1000
  }
}

interface QuoteEntry {
  quote: Quote | null
  /** Today's closes, oldest first, for a sparkline. */
  line: number[]
  at: number
  error: string | null
}

export class Market extends EventEmitter {
  private quotes = new Map<string, QuoteEntry>()
  private bars = new Map<string, { bars: Bar[]; at: number; error: string | null }>()
  private screens = new Map<ScreenKind, { rows: ScreenRow[]; at: number }>()
  private headlines = new Map<string, { items: Headline[]; at: number }>()
  private wanted = new Map<string, number>()
  private inflight = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly yahoo = new YahooMarketData()

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.pump(), 1000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /* ----------------------------------------------------------- asking */

  /** The latest quote, or undefined until the first one arrives. Marks the symbol as on screen. */
  quote(symbol: string): Quote | undefined {
    const s = symbol.toUpperCase()
    this.wanted.set(`q:${s}`, Date.now())
    const entry = this.quotes.get(s)
    if (!entry) this.pumpSoon()
    return entry?.quote ?? undefined
  }

  /** Today's price line for a sparkline. */
  line(symbol: string): number[] {
    return this.quotes.get(symbol.toUpperCase())?.line ?? []
  }

  errorOf(symbol: string): string | null {
    return this.quotes.get(symbol.toUpperCase())?.error ?? null
  }

  barsFor(symbol: string, range: BarRange): Bar[] | undefined {
    const key = `${symbol.toUpperCase()}|${range}`
    this.wanted.set(`b:${key}`, Date.now())
    const entry = this.bars.get(key)
    if (!entry) this.pumpSoon()
    return entry?.bars
  }

  barsError(symbol: string, range: BarRange): string | null {
    return this.bars.get(`${symbol.toUpperCase()}|${range}`)?.error ?? null
  }

  movers(kind: ScreenKind): ScreenRow[] | undefined {
    this.wanted.set(`s:${kind}`, Date.now())
    const entry = this.screens.get(kind)
    if (!entry) this.pumpSoon()
    return entry?.rows
  }

  news(symbol: string): Headline[] | undefined {
    const s = symbol.toUpperCase()
    this.wanted.set(`n:${s}`, Date.now())
    const entry = this.headlines.get(s)
    if (!entry) this.pumpSoon()
    return entry?.items
  }

  /** Forgets cached data so the next pump fetches it all again (the R key). */
  refreshAll(): void {
    for (const entry of this.quotes.values()) entry.at = 0
    for (const entry of this.bars.values()) entry.at = 0
    for (const entry of this.screens.values()) entry.at = 0
    this.pumpSoon()
  }

  /* ---------------------------------------------------------- fetching */

  private soon: ReturnType<typeof setTimeout> | null = null
  private pumpSoon(): void {
    if (this.soon) return
    this.soon = setTimeout(() => {
      this.soon = null
      this.pump()
    }, 30)
  }

  private pump(): void {
    const now = Date.now()
    const due: string[] = []
    for (const [key, lastAsked] of this.wanted) {
      if (now - lastAsked > WANTED_FOR_MS) {
        this.wanted.delete(key)
        continue
      }
      if (this.inflight.has(key)) continue
      const [kind, id] = [key.slice(0, 1), key.slice(2)]
      const age =
        kind === 'q'
          ? now - (this.quotes.get(id)?.at ?? 0)
          : kind === 'b'
            ? now - (this.bars.get(id)?.at ?? 0)
            : kind === 's'
              ? now - (this.screens.get(id as ScreenKind)?.at ?? 0)
              : now - (this.headlines.get(id)?.at ?? 0)
      const fresh =
        kind === 'q' ? QUOTE_FRESH_MS : kind === 'b' ? BARS_FRESH_MS[id.split('|')[1] as BarRange] ?? 60_000 : kind === 's' ? SCREEN_FRESH_MS : NEWS_FRESH_MS
      if (age >= fresh) due.push(key)
    }
    const room = CONCURRENCY - this.inflight.size
    for (const key of due.slice(0, Math.max(0, room))) void this.fetch(key)
  }

  private async fetch(key: string): Promise<void> {
    this.inflight.add(key)
    const kind = key.slice(0, 1)
    const id = key.slice(2)
    try {
      if (kind === 'q') {
        const result = await fetchChart(id, '1d', '5m')
        const bars = toBars(result)
        this.quotes.set(id, { quote: toQuote(id, result.meta ?? {}, bars), line: bars.map((b) => b.c), at: Date.now(), error: null })
      } else if (kind === 'b') {
        const [symbol, range] = id.split('|') as [string, BarRange]
        const result = await fetchChart(symbol, range, RANGE_INTERVAL[range])
        const bars = toBars(result)
        this.bars.set(id, { bars, at: Date.now(), error: null })
        if (range === '1d') this.quotes.set(symbol, { quote: toQuote(symbol, result.meta ?? {}, bars), line: bars.map((b) => b.c), at: Date.now(), error: null })
      } else if (kind === 's') {
        this.screens.set(id as ScreenKind, { rows: await this.yahoo.screen(id as ScreenKind, 25), at: Date.now() })
      } else {
        this.headlines.set(id, { items: await this.yahoo.news(id, 8), at: Date.now() })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Keep what we had; try again after the usual wait.
      if (kind === 'q') {
        const old = this.quotes.get(id)
        this.quotes.set(id, { quote: old?.quote ?? null, line: old?.line ?? [], at: Date.now(), error: message })
      } else if (kind === 'b') {
        const old = this.bars.get(id)
        this.bars.set(id, { bars: old?.bars ?? [], at: Date.now(), error: message })
      } else if (kind === 's') this.screens.set(id as ScreenKind, { rows: this.screens.get(id as ScreenKind)?.rows ?? [], at: Date.now() })
      else this.headlines.set(id, { items: this.headlines.get(id)?.items ?? [], at: Date.now() })
    } finally {
      this.inflight.delete(key)
      this.emit('change')
    }
  }
}

/* -------------------------------------------------------------- watchlist */

const WATCHLIST_FILE = 'cli-watchlist.json'
const DEFAULT_WATCHLIST = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AMD', 'AVGO', 'JPM']

export const watchlist = {
  get(): string[] {
    const saved = store.getJson<unknown>(WATCHLIST_FILE, null)
    return Array.isArray(saved) ? saved.filter((s): s is string => typeof s === 'string') : DEFAULT_WATCHLIST.slice()
  },
  set(symbols: string[]): void {
    store.setJson(WATCHLIST_FILE, [...new Set(symbols.map((s) => s.toUpperCase()))])
  },
  add(symbol: string): void {
    const list = this.get()
    if (!list.includes(symbol.toUpperCase())) this.set([...list, symbol])
  },
  remove(symbol: string): void {
    this.set(this.get().filter((s) => s !== symbol.toUpperCase()))
  },
  move(symbol: string, by: number): void {
    const list = this.get()
    const at = list.indexOf(symbol.toUpperCase())
    if (at === -1) return
    const to = Math.max(0, Math.min(list.length - 1, at + by))
    list.splice(to, 0, ...list.splice(at, 1))
    this.set(list)
  }
}

export const INDEXES: { symbol: string; label: string }[] = [
  { symbol: 'SPY', label: 'S&P 500' },
  { symbol: 'QQQ', label: 'NASDAQ 100' },
  { symbol: 'DIA', label: 'DOW 30' },
  { symbol: 'IWM', label: 'RUSSELL 2K' },
  { symbol: '^VIX', label: 'VIX' }
]

export const RATES: { group: string; symbol: string; label: string; unit?: string }[] = [
  { group: 'RATES', symbol: '^IRX', label: 'US 13-week bill', unit: '%' },
  { group: 'RATES', symbol: '^FVX', label: 'US 5-year', unit: '%' },
  { group: 'RATES', symbol: '^TNX', label: 'US 10-year', unit: '%' },
  { group: 'RATES', symbol: '^TYX', label: 'US 30-year', unit: '%' },
  { group: 'METALS', symbol: 'GC=F', label: 'Gold' },
  { group: 'METALS', symbol: 'SI=F', label: 'Silver' },
  { group: 'METALS', symbol: 'HG=F', label: 'Copper' },
  { group: 'ENERGY', symbol: 'CL=F', label: 'Crude oil (WTI)' },
  { group: 'ENERGY', symbol: 'BZ=F', label: 'Brent' },
  { group: 'ENERGY', symbol: 'NG=F', label: 'Natural gas' },
  { group: 'FX', symbol: 'DX-Y.NYB', label: 'US dollar index' },
  { group: 'FX', symbol: 'EURUSD=X', label: 'EUR/USD' },
  { group: 'FX', symbol: 'JPY=X', label: 'USD/JPY' },
  { group: 'FX', symbol: 'GBPUSD=X', label: 'GBP/USD' },
  { group: 'CRYPTO', symbol: 'BTC-USD', label: 'Bitcoin' },
  { group: 'CRYPTO', symbol: 'ETH-USD', label: 'Ether' }
]
