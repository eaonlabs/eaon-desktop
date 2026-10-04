import type { BarRange } from '@shared/trading'
import { indicators } from '@main/features/trading/marketData'
import { axisLabels, bucketCandles, candleChart, columnBars, lineChart, scaleOf } from '../../charts'
import type { Canvas } from '../../screen'
import { strWidth, truncate } from '../../term'
import { C, S, signStyle } from '../../theme'
import { ago, panel } from '../../widgets'
import { arrow, price, shares, signedPct, signedUsd, time, volume } from './format'
import type { TradingView } from './index'

/**
 * One symbol in full: the quote, the day's numbers and a few indicators,
 * a chart over a chosen range (a line, or candles with V) with volume under
 * it, and beside it the latest headlines and the user's own orders in it.
 */

const RANGES: { id: BarRange; label: string }[] = [
  { id: '1d', label: '1D' },
  { id: '5d', label: '5D' },
  { id: '1mo', label: '1M' },
  { id: '6mo', label: '6M' },
  { id: '1y', label: '1Y' }
]

export function drawDetail(c: Canvas, view: TradingView, symbol: string): void {
  const market = view.market
  const quote = market.quote(symbol)
  const position = view.positions().find((p) => p.symbol === symbol)
  const title = `${symbol}${quote?.name ? ` · ${quote.name}` : ''}`
  const inner = panel(c, title, {
    right: quote ? [{ text: `as of ${time(quote.at)}`, style: S.faint }] : [],
    focused: view.page === 'lookup'
  })
  if (!quote) {
    const error = market.errorOf(symbol)
    inner.text(0, 1, error ? `Couldn’t load ${symbol}: ${error}` : `Loading ${symbol}…`, error ? S.red : S.faint, inner.w)
    return
  }

  // The price, big enough to find at a glance.
  let x = inner.text(0, 0, price(quote.price), { fg: C.text, bold: true })
  x += inner.text(x + 2, 0, `${arrow(quote.change)} ${quote.change > 0 ? '+' : ''}${quote.change.toFixed(2)} (${signedPct(quote.changePct)})`, signStyle(quote.change, true)) + 2
  if (quote.currency && quote.currency !== 'USD') x += inner.text(x + 2, 0, quote.currency, S.muted) + 2
  if (position) {
    inner.segments(x + 4, 0, [
      { text: 'HELD ', style: S.amberBold },
      { text: `${shares(position.qty)} @ ${price(position.avgPrice)}  `, style: S.text },
      { text: `${signedUsd(position.unrealizedPl)} ${signedPct(position.unrealizedPlPct)}`, style: signStyle(position.unrealizedPl, true) }
    ])
  }

  // Numbers: the day, then indicators from six months of daily bars.
  const daily = market.barsFor(symbol, '6mo')
  const ind = daily && daily.length >= 20 ? indicators(daily) : null
  const cells: [string, string, string?][] = [
    ['Prev close', price(quote.prevClose)],
    ['Day high', price(quote.dayHigh)],
    ['Volume', volume(quote.volume)],
    ['Day low', price(quote.dayLow)],
    ['RSI 14', ind?.rsi14 != null ? ind.rsi14.toFixed(1) : '—', ind?.rsi14 != null ? (ind.rsi14 >= 70 ? 'red' : ind.rsi14 <= 30 ? 'green' : '') : ''],
    ['ATR 14', ind?.atr14 != null ? price(ind.atr14) : '—'],
    ['SMA 20', ind?.sma20 != null ? price(ind.sma20) : '—', ind?.sma20 != null ? (quote.price >= ind.sma20 ? 'green' : 'red') : ''],
    ['SMA 50', ind?.sma50 != null ? price(ind.sma50) : '—', ind?.sma50 != null ? (quote.price >= ind.sma50 ? 'green' : 'red') : ''],
    [
      'MACD hist',
      ind?.macdHist != null ? `${ind.macdHist.toFixed(2)} ${ind.macdHistPrev != null ? (ind.macdHist > ind.macdHistPrev ? '↑' : '↓') : ''}` : '—',
      ind?.macdHist != null ? (ind.macdHist > 0 ? 'green' : 'red') : ''
    ],
    ['20d range', ind ? `${price(ind.low20)}–${price(ind.high20)}` : '—'],
    ['Vol vs 20d', ind?.volumeRatio != null ? `${ind.volumeRatio.toFixed(2)}x` : '—'],
    ['6M change', ind ? signedPct(ind.changePct) : '—', ind ? (ind.changePct >= 0 ? 'green' : 'red') : '']
  ]
  const colW = Math.max(22, Math.floor(inner.w / 4))
  const statRows = 3
  cells.forEach(([label, value, tone], i) => {
    const col = Math.floor(i / statRows)
    const row = i % statRows
    const cx = col * colW
    if (cx + 10 > inner.w) return
    inner.text(cx, 2 + row, label, S.muted)
    inner.text(cx + 11, 2 + row, value, tone === 'green' ? S.green : tone === 'red' ? S.red : S.text, colW - 12)
  })

  // Range tabs and chart.
  const tabsY = 2 + statRows + 1
  let tx = 0
  for (const range of RANGES) {
    const active = range.id === view.range
    tx += inner.text(tx, tabsY, ` ${range.label} `, active ? { fg: C.ink, bg: '#D8D8D8', bold: true } : S.muted)
    tx += inner.text(tx, tabsY, '│', S.faint)
  }
  inner.text(tx + 2, tabsY, `${view.chartMode === 'line' ? 'LINE' : 'CANDLES'}  [ ] range · V candles`, S.faint)

  const sideW = inner.w >= 100 ? Math.max(34, Math.floor(inner.w * 0.32)) : 0
  const chartArea = inner.sub(0, tabsY + 1, inner.w - sideW - (sideW ? 2 : 0), inner.h - tabsY - 1)
  const bars = market.barsFor(symbol, view.range)
  if (!bars || bars.length < 2) {
    const error = market.barsError(symbol, view.range)
    chartArea.text(Math.max(0, Math.floor(chartArea.w / 2) - 5), Math.floor(chartArea.h / 2), error ? truncate(error, chartArea.w) : 'Loading…', error ? S.red : S.faint)
  } else {
    const axisW = 10
    const volH = chartArea.h >= 14 ? 3 : 0
    const plot = chartArea.sub(0, 0, chartArea.w - axisW, chartArea.h - volH - 1)
    let scale
    if (view.chartMode === 'candles') {
      const candles = bucketCandles(bars, plot.w)
      scale = candleChart(plot, candles, scaleOf(candles.flatMap((k) => [k.h, k.l])))
    } else {
      const base = view.range === '1d' ? quote.prevClose : bars[0].c
      scale = lineChart(plot, bars.map((b) => b.c), { baseline: base, splitColors: true })
    }
    for (const label of axisLabels(scale, plot.h, (v) => price(v))) chartArea.text(plot.w + 1, label.row, label.text, S.faint, axisW - 1)
    if (volH) {
      const vol = chartArea.sub(0, plot.h, plot.w, volH)
      const shown = view.chartMode === 'candles' ? bars.slice(-plot.w) : bars
      const step = Math.max(1, Math.ceil(shown.length / plot.w))
      const buckets: { v: number; up: boolean }[] = []
      for (let i = 0; i < shown.length; i += step) {
        const group = shown.slice(i, i + step)
        buckets.push({ v: group.reduce((s, b) => s + b.v, 0), up: group[group.length - 1].c >= group[0].o })
      }
      columnBars(
        vol,
        buckets.map((b) => b.v),
        (i) => ({ fg: buckets[Math.max(0, buckets.length - vol.w) + i]?.up ? '#2E7D4F' : '#8E2F2A' })
      )
    }
    const first = time(bars[0].t)
    const last = time(bars[bars.length - 1].t)
    chartArea.text(0, chartArea.h - 1, first, S.faint)
    chartArea.text(Math.max(strWidth(first) + 2, plot.w - strWidth(last)), chartArea.h - 1, last, S.faint)
  }

  if (!sideW) return
  const side = inner.sub(inner.w - sideW, tabsY + 1, sideW, inner.h - tabsY - 1)
  side.vline(-1, 0, side.h, S.border)
  side.text(1, 0, 'NEWS', S.header)
  const news = market.news(symbol)
  let y = 1
  if (!news) side.text(1, y++, 'Loading…', S.faint)
  else if (news.length === 0) side.text(1, y++, 'No recent headlines.', S.faint)
  else
    for (const item of news.slice(0, 6)) {
      if (y >= side.h - 6) break
      side.text(1, y++, truncate(item.title, side.w - 2), S.text)
      side.text(1, y++, `${item.publisher ?? ''}${item.at ? ` · ${ago(item.at)} ago` : ''}`, S.faint, side.w - 2)
    }
  const mine = (view.snapshot?.orders ?? []).filter((o) => o.symbol === symbol).slice(0, Math.max(0, side.h - y - 2))
  y++
  side.text(1, y++, 'YOUR ORDERS', S.header)
  if (mine.length === 0) side.text(1, y++, 'None. B buy · S sell', S.faint)
  for (const o of mine) {
    side.segments(1, y++, [
      { text: `${o.side === 'buy' ? 'BUY ' : 'SELL'} `, style: o.side === 'buy' ? S.green : S.red },
      { text: `${shares(o.filledQty || o.qty)} @ ${price(o.filledAvgPrice ?? o.limitPrice)} `, style: S.text },
      { text: o.status === 'rejected' ? 'refused' : o.status, style: S.muted },
      { text: ` ${time(o.submittedAt)}`, style: S.faint }
    ], side.w - 2)
  }
}
