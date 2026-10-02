import { useState, type JSX } from 'react'
import { ExternalLink, ShieldAlert } from 'lucide-react'
import { BROKERS, LIVE_CONFIRMATION, type BrokerKind, type TradingLimits, type TradingSnapshot } from '@shared/trading'
import { Card, Modal, Row, Switch } from '../ui'
import { errorText, usd, useTrading } from './tradingStore'

/**
 * Where the money is and the limits it moves within. Practice is the
 * default; real money takes the user's Alpaca live keys *and* typing a
 * sentence, and even then every order has to pass the limits below.
 */
export function TradingSetup({ snapshot }: { snapshot: TradingSnapshot }): JSX.Element {
  const { config, keys } = snapshot
  const run = useTrading((s) => s.run)
  const [confirmLive, setConfirmLive] = useState(false)
  const [resetting, setResetting] = useState(false)

  const choose = (broker: BrokerKind): void => {
    if (broker === 'alpaca-live' && !config.liveConfirmedAt) {
      setConfirmLive(true)
      return
    }
    void run(() => window.api.trading.setConfig({ broker }))
  }

  return (
    <section className="tr-panel">
      <div className="tr-panel__head">
        <h2 className="tr-h2">Account and limits</h2>
      </div>

      <div className="tr-brokers" role="radiogroup" aria-label="Broker">
        {BROKERS.map((broker) => (
          <button
            key={broker.id}
            role="radio"
            aria-checked={config.broker === broker.id}
            className="tr-broker-card"
            data-real={broker.real || undefined}
            onClick={() => choose(broker.id)}
          >
            <span className="tr-broker-card__name">
              {broker.real && <ShieldAlert size={14} strokeWidth={2} />}
              {broker.label}
            </span>
            <span className="tr-broker-card__desc">{broker.description}</span>
          </button>
        ))}
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

      {config.broker !== 'simulator' && <AlpacaKeys kind={config.broker === 'alpaca-live' ? 'live' : 'paper'} saved={config.broker === 'alpaca-live' ? keys.live : keys.paper} />}

      <Limits limits={config.limits} />

      <Modal
        open={confirmLive}
        onClose={() => setConfirmLive(false)}
        title="Trade real money?"
        width={480}
        actions={null}
      >
        <LiveConfirm onDone={() => setConfirmLive(false)} />
      </Modal>
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

function LiveConfirm({ onDone }: { onDone: () => void }): JSX.Element {
  const run = useTrading((s) => s.run)
  const [typed, setTyped] = useState('')
  return (
    <div className="tr-live">
      <p>
        With Alpaca live, orders use the real money in your brokerage account, and you can lose it. Eaon only trades inside the limits below, and asks
        you before every real-money order it places from a chat — but a scheduled session trades on its own within those limits.
      </p>
      <p>To go ahead, type:</p>
      <p className="tr-live__phrase">{LIVE_CONFIRMATION}</p>
      <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Confirmation" autoFocus />
      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={onDone}>
          Cancel
        </button>
        <button
          className="btn btn--danger"
          disabled={typed.trim() !== LIVE_CONFIRMATION}
          onClick={async () => {
            await run(() => window.api.trading.confirmLive(typed.trim()))
            await run(() => window.api.trading.setConfig({ broker: 'alpaca-live' }))
            onDone()
          }}
        >
          Use real money
        </button>
      </div>
    </div>
  )
}

function AlpacaKeys({ kind, saved }: { kind: 'paper' | 'live'; saved: boolean }): JSX.Element {
  const run = useTrading((s) => s.run)
  const [keyId, setKeyId] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Card>
      {saved ? (
        <Row title={`Alpaca ${kind} keys`} description="Saved in your system keychain.">
          <button className="btn" onClick={() => void run(() => window.api.trading.clearKeys(kind))}>
            Remove keys
          </button>
        </Row>
      ) : (
        <div className="row row--stack">
          <div className="row__body">
            <div className="row__title">Connect Alpaca {kind}</div>
            <div className="row__desc">
              In Alpaca’s dashboard, switch to your {kind === 'paper' ? 'paper' : 'live'} account and generate API keys, then paste them here. They’re checked with
              Alpaca and stored in your system keychain.
            </div>
          </div>
          <button className="btn btn--sm" onClick={() => void window.api.app.openExternal('https://app.alpaca.markets/')}>
            <ExternalLink size={13} strokeWidth={1.9} />
            Open Alpaca
          </button>
          <form
            className="tr-keys"
            onSubmit={async (e) => {
              e.preventDefault()
              setBusy(true)
              setError(null)
              try {
                useTrading.getState().set(await window.api.trading.setKeys(kind, keyId.trim(), secret.trim()))
                setKeyId('')
                setSecret('')
              } catch (err) {
                setError(errorText(err))
              } finally {
                setBusy(false)
              }
            }}
          >
            <input className="input" placeholder="API key ID" value={keyId} onChange={(e) => setKeyId(e.target.value)} spellCheck={false} autoComplete="off" />
            <input className="input" type="password" placeholder="Secret key" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" />
            <button className="btn btn--primary" type="submit" disabled={busy || !keyId.trim() || !secret.trim()}>
              {busy ? 'Checking…' : 'Connect'}
            </button>
          </form>
          {error && <p className="tr-error">{error}</p>}
        </div>
      )}
    </Card>
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
