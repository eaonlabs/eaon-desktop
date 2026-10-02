import { useState, type JSX } from 'react'
import { Search } from 'lucide-react'
import type { OrderSide, Quote, TradingSnapshot } from '@shared/trading'
import { Segmented } from '../ui'
import { direction, errorText, signedPct, signedUsd, usd, useTrading } from './tradingStore'

/**
 * Trading by hand: look a stock up, then buy or sell by shares or by dollars.
 * The order goes through exactly the same limits as the agent's, and shows up
 * in the trades list marked as yours.
 */
export function TradeTicket({ snapshot }: { snapshot: TradingSnapshot }): JSX.Element {
  const run = useTrading((s) => s.run)
  const [symbol, setSymbol] = useState('')
  const [quote, setQuote] = useState<Quote | null>(null)
  const [looking, setLooking] = useState(false)
  const [side, setSide] = useState<OrderSide>('buy')
  const [by, setBy] = useState<'shares' | 'dollars'>('dollars')
  const [amount, setAmount] = useState('')
  const [stop, setStop] = useState('')
  const [target, setTarget] = useState('')
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const lookUp = async (): Promise<void> => {
    const wanted = symbol.trim().toUpperCase()
    if (!wanted) return
    setLooking(true)
    setNote(null)
    try {
      setQuote(await window.api.trading.quote(wanted))
    } catch (error) {
      setQuote(null)
      setNote({ ok: false, text: errorText(error) })
    } finally {
      setLooking(false)
    }
  }

  const place = async (): Promise<void> => {
    const value = Number(amount)
    if (!quote || !(value > 0)) return
    setBusy(true)
    setNote(null)
    const order = await run(() =>
      window.api.trading.placeOrder({
        symbol: quote.symbol,
        side,
        ...(by === 'shares' ? { qty: value } : { notional: value }),
        ...(side === 'buy' && stop.trim() ? { stopLoss: Number(stop) } : {}),
        ...(side === 'buy' && target.trim() ? { takeProfit: Number(target) } : {}),
        reason: 'Placed by hand from the trading desk'
      })
    )
    setBusy(false)
    if (!order) return
    if (order.status === 'rejected') setNote({ ok: false, text: order.error ?? 'The order was refused.' })
    else {
      setNote({ ok: true, text: `${order.status === 'filled' ? 'Done' : 'Sent'}: ${side === 'buy' ? 'bought' : 'sold'} ${quote.symbol}.` })
      setAmount('')
      setStop('')
      setTarget('')
    }
  }

  const held = quote ? snapshot.positions.find((p) => p.symbol === quote.symbol) : undefined
  const estimate = quote && Number(amount) > 0 ? (by === 'shares' ? Number(amount) * quote.price : Number(amount)) : null

  return (
    <section className="tr-panel tr-ticket" aria-label="Place an order">
      <div className="tr-panel__head">
        <h2 className="tr-h2">Trade</h2>
      </div>
      <form
        className="tr-ticket__lookup"
        onSubmit={(e) => {
          e.preventDefault()
          void lookUp()
        }}
      >
        <input
          className="input"
          value={symbol}
          placeholder="Symbol, e.g. AAPL"
          aria-label="Stock symbol"
          spellCheck={false}
          autoCapitalize="characters"
          onChange={(e) => setSymbol(e.target.value.toUpperCase())}
        />
        <button className="icon-btn" type="submit" aria-label="Look up" disabled={looking || !symbol.trim()}>
          <Search size={15} strokeWidth={1.9} />
        </button>
      </form>

      {quote && (
        <div className="tr-quote">
          <div className="tr-quote__name">
            <span className="tr-symbol">{quote.symbol}</span>
            <span className="tr-muted">{quote.name}</span>
          </div>
          <div className="tr-quote__price">
            {usd(quote.price)}{' '}
            <span className="tr-delta" data-dir={direction(quote.change)}>
              {signedUsd(quote.change)} ({signedPct(quote.changePct)})
            </span>
          </div>
          {held && <div className="tr-muted">You hold {held.qty} shares</div>}
        </div>
      )}

      {quote && (
        <div className="tr-ticket__form">
          <Segmented
            value={side}
            options={[
              { value: 'buy', label: 'Buy' },
              { value: 'sell', label: 'Sell' }
            ]}
            onChange={setSide}
          />
          <div className="tr-ticket__amount">
            <input
              className="input"
              type="number"
              min={0}
              step={by === 'shares' ? 'any' : 1}
              value={amount}
              placeholder={by === 'shares' ? 'Shares' : 'Dollars'}
              aria-label={by === 'shares' ? 'Number of shares' : 'Amount in dollars'}
              onChange={(e) => setAmount(e.target.value)}
            />
            <Segmented
              value={by}
              options={[
                { value: 'dollars', label: '$' },
                { value: 'shares', label: 'Shares' }
              ]}
              onChange={setBy}
            />
          </div>
          {estimate !== null && <div className="tr-muted">About {usd(estimate)} at the current price</div>}
          {side === 'buy' && (
            <div className="tr-ticket__exits">
              <input className="input" type="number" min={0} step="any" value={stop} placeholder="Stop-loss $ (optional)" aria-label="Stop-loss price" onChange={(e) => setStop(e.target.value)} />
              <input className="input" type="number" min={0} step="any" value={target} placeholder="Take-profit $ (optional)" aria-label="Take-profit price" onChange={(e) => setTarget(e.target.value)} />
            </div>
          )}
          <button className="btn btn--primary" disabled={busy || !(Number(amount) > 0) || snapshot.config.halted} onClick={() => void place()}>
            {busy ? 'Placing…' : `${side === 'buy' ? 'Buy' : 'Sell'} ${quote.symbol}`}
          </button>
        </div>
      )}

      {!quote && !note && <p className="tr-empty">Look up a stock to see its price and trade it. Orders pass the same limits as Eaon’s.</p>}
      {note && (
        <p className="tr-note" data-ok={note.ok || undefined} role="status">
          {note.text}
        </p>
      )}
    </section>
  )
}
