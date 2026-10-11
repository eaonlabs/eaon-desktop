import { useState, type JSX } from 'react'
import { type TradingLimits, type TradingSnapshot } from '@shared/trading'
import { Card, Modal, Row, Switch } from '../ui'
import { usd, useTrading } from './tradingStore'

/**
 * The limits every order moves within, and the simulator's own settings.
 * Which account the agent trades, and linking one, is the account picker's
 * (Accounts.tsx).
 */
export function TradingSetup({ snapshot }: { snapshot: TradingSnapshot }): JSX.Element {
  const { config } = snapshot
  const run = useTrading((s) => s.run)
  const [resetting, setResetting] = useState(false)

  return (
    <section className="tr-panel">
      <div className="tr-panel__head">
        <h2 className="tr-h2">Limits</h2>
      </div>

      {config.broker === 'simulator' && (
        <Card>
          <Row title="Starting cash" description="What the simulator begins with, and goes back to when you reset it.">
            <NumberField value={config.simulatorCash} min={1000} step={1000} prefix="$" onCommit={(simulatorCash) => void run(() => window.api.trading.setConfig({ simulatorCash }))} />
          </Row>
          <Row title="Practice outside market hours" description="Fill orders at the last price when the market is closed, so you can try things any time. Off, the simulator keeps real market hours.">
            <Switch label="Practice outside market hours" checked={config.simulatorAnytime} onChange={(simulatorAnytime) => void run(() => window.api.trading.setConfig({ simulatorAnytime }))} />
          </Row>
          <Row title="Start over" description={`Sell nothing, forget everything: back to ${usd(config.simulatorCash, true)} in cash and no trades.`}>
            <button className="btn" onClick={() => setResetting(true)}>
              Reset simulator
            </button>
          </Row>
        </Card>
      )}


      <Limits limits={config.limits} />

      <Modal
        open={resetting}
        onClose={() => setResetting(false)}
        title="Reset the simulator?"
        actions={
          <>
            <button className="btn btn--ghost" onClick={() => setResetting(false)}>
              Cancel
            </button>
            <button
              className="btn btn--danger"
              autoFocus
              onClick={() => {
                setResetting(false)
                void run(() => window.api.trading.resetSimulator())
              }}
            >
              Reset
            </button>
          </>
        }
      >
        The practice account goes back to {usd(config.simulatorCash, true)} in cash with no holdings, and its trades and chart start again.
      </Modal>
    </section>
  )
}

function Limits({ limits }: { limits: TradingLimits }): JSX.Element {
  const run = useTrading((s) => s.run)
  const save = (patch: Partial<TradingLimits>): void => void run(() => window.api.trading.setConfig({ limits: { ...limits, ...patch } }))
  const [symbols, setSymbols] = useState(limits.allowedSymbols.join(', '))
  return (
    <div className="settings__section ch-subsection">
      <div className="settings__section-label">Limits — every order must pass these, yours and Eaon’s</div>
      <Card>
        <Row title="Largest order" description="The most one order may spend or sell.">
          <NumberField value={limits.maxOrderUsd} min={1} step={100} prefix="$" onCommit={(maxOrderUsd) => save({ maxOrderUsd })} />
        </Row>
        <Row title="Largest holding" description="The most of the account one stock may be.">
          <NumberField value={limits.maxPositionPct} min={1} max={100} suffix="%" onCommit={(maxPositionPct) => save({ maxPositionPct })} />
        </Row>
        <Row title="Most invested at once" description="The rest always stays in cash.">
          <NumberField value={limits.maxInvestedPct} min={1} max={100} suffix="%" onCommit={(maxInvestedPct) => save({ maxInvestedPct })} />
        </Row>
        <Row title="Daily loss stop" description="Once the account is down this much on the day, no more buying until tomorrow. Selling stays allowed.">
          <NumberField value={limits.maxDailyLossPct} min={0.1} step={0.5} suffix="%" onCommit={(maxDailyLossPct) => save({ maxDailyLossPct })} />
        </Row>
        <Row title="Orders per day" description="Counted across Eaon, its sessions and you.">
          <NumberField value={limits.maxOrdersPerDay} min={1} step={1} onCommit={(maxOrdersPerDay) => save({ maxOrdersPerDay: Math.round(maxOrdersPerDay) })} />
        </Row>
        <div className="row row--stack">
          <div className="row__body">
            <div className="row__title">Only these stocks</div>
            <div className="row__desc">Symbols separated by commas. Leave empty to allow any US stock or ETF.</div>
          </div>
          <input
            className="input"
            value={symbols}
            placeholder="e.g. AAPL, MSFT, SPY"
            onChange={(e) => setSymbols(e.target.value.toUpperCase())}
            onBlur={() =>
              save({
                allowedSymbols: symbols
                  .split(/[\s,]+/)
                  .map((s) => s.trim())
                  .filter(Boolean)
              })
            }
          />
        </div>
      </Card>
    </div>
  )
}

/** A number that saves when the field loses focus or Enter is pressed. */
function NumberField({
  value,
  min,
  max,
  step = 1,
  prefix,
  suffix,
  onCommit
}: {
  value: number
  min?: number
  max?: number
  step?: number
  prefix?: string
  suffix?: string
  onCommit: (value: number) => void
}): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (): void => {
    if (draft === null) return
    const n = Number(draft)
    setDraft(null)
    if (!Number.isFinite(n) || n === value) return
    onCommit(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n)))
  }
  return (
    <span className="tr-number">
      {prefix && <span className="tr-number__affix">{prefix}</span>}
      <input
        className="input"
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft ?? String(value)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      {suffix && <span className="tr-number__affix">{suffix}</span>}
    </span>
  )
}
