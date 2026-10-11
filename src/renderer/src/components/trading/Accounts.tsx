import { useState, type JSX } from 'react'
import { Check, ExternalLink, ShieldAlert } from 'lucide-react'
import { BROKERS, LIVE_CONFIRMATION, type BrokerInfo, type BrokerKind, type TradingSnapshot } from '@shared/trading'
import { Modal } from '../ui'
import { errorText, useTrading } from './tradingStore'

/**
 * Picking the account the agent trades, and linking it: the simulator needs
 * nothing, Alpaca a key pair, Tradier an access token, Robinhood a browser
 * sign-in to its own MCP server. A real-money account also takes the typed
 * confirmation before it can be used. Everything is in one list, in the order
 * someone new should try them: practice first.
 */

type KeyKind = 'paper' | 'live' | 'tradier-paper' | 'tradier-live'

const keyKindOf = (kind: BrokerKind): KeyKind | null =>
  kind === 'alpaca-paper' ? 'paper' : kind === 'alpaca-live' ? 'live' : kind === 'tradier-paper' || kind === 'tradier-live' ? kind : null

export function AccountsModal({ snapshot, open, onClose }: { snapshot: TradingSnapshot; open: boolean; onClose: () => void }): JSX.Element {
  const [confirming, setConfirming] = useState<BrokerKind | null>(null)
  return (
    <Modal open={open} onClose={onClose} title={confirming ? 'Trade real money?' : 'Accounts'} width={560} actions={null}>
      {confirming ? (
        <LiveConfirm
          broker={BROKERS.find((b) => b.id === confirming)!}
          onDone={(used) => {
            setConfirming(null)
            if (used) onClose()
          }}
        />
      ) : (
        <div className="tr-accounts">
          <p className="tr-muted tr-hint">The agent trades one account at a time. Your limits and the kill switch apply to every order, whichever it is.</p>
          <ul className="tr-accounts__list">
            {BROKERS.map((broker) => (
              <AccountRow
                key={broker.id}
                broker={broker}
                snapshot={snapshot}
                onUse={() => {
                  if (broker.real && !snapshot.config.liveConfirmedAt) setConfirming(broker.id)
                  else void useTrading.getState().run(() => window.api.trading.setConfig({ broker: broker.id })).then((done) => done && onClose())
                }}
              />
            ))}
          </ul>
        </div>
      )}
    </Modal>
  )
}

function AccountRow({ broker, snapshot, onUse }: { broker: BrokerInfo; snapshot: TradingSnapshot; onUse: () => void }): JSX.Element {
  const run = useTrading((s) => s.run)
  const linked = snapshot.linked?.[broker.id] ?? (broker.id === 'simulator' || (broker.id === 'alpaca-paper' && snapshot.keys.paper) || (broker.id === 'alpaca-live' && snapshot.keys.live))
  const current = snapshot.config.broker === broker.id
  const [linking, setLinking] = useState(false)
  const unlink = (): void => {
    const keyKind = keyKindOf(broker.id)
    if (keyKind) void run(() => window.api.trading.clearKeys(keyKind))
    else if (broker.link === 'sign-in') void run(async () => {
      await window.api.pluginAuth.disconnect('robinhood')
      return window.api.trading.refresh()
    })
  }
  return (
    <li className="tr-account" data-current={current || undefined} data-real={broker.real || undefined}>
      <div className="tr-account__main">
        <div className="tr-account__title">
          {broker.real && <ShieldAlert size={13} strokeWidth={2} aria-label="Real money" />}
          {broker.label}
          {current ? (
            <span className="tr-account__state" data-tone="on">
              <Check size={12} strokeWidth={2.4} /> Trading
            </span>
          ) : linked ? (
            <span className="tr-account__state">Linked</span>
          ) : null}
        </div>
        <div className="tr-account__desc">{broker.description}</div>
      </div>
      <div className="tr-account__actions">
        {linked && !current && (
          <button className="btn btn--sm" onClick={onUse}>
            Use
          </button>
        )}
        {!linked && !linking && (
          <button className="btn btn--sm btn--primary" onClick={() => setLinking(true)}>
            Link
          </button>
        )}
        {linked && broker.link !== 'none' && (
          <button className="btn btn--sm btn--ghost" onClick={unlink} title={`Forget ${broker.label}`}>
            Unlink
          </button>
        )}
      </div>
      {linking && !linked && <LinkForm broker={broker} onDone={() => setLinking(false)} />}
    </li>
  )
}

/** The credentials one account needs, checked with the broker before they are saved. */
function LinkForm({ broker, onDone }: { broker: BrokerInfo; onDone: () => void }): JSX.Element {
  const [first, setFirst] = useState('')
  const [second, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const keyKind = keyKindOf(broker.id)

  const work = async (step: () => Promise<TradingSnapshot>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      useTrading.getState().set(await step())
      onDone()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const signIn = (): Promise<void> =>
    work(async () => {
      const result = await window.api.pluginAuth.signIn({ pluginId: 'robinhood' })
      if (!result.ok) throw new Error(result.error ?? 'The Robinhood sign-in didn’t finish.')
      // The MCP connection settles a moment after the browser comes back.
      for (let i = 0; i < 20; i++) {
        const snap = await window.api.trading.refresh()
        if (snap.linked?.robinhood) return snap
        await new Promise((r) => setTimeout(r, 500))
      }
      throw new Error('Signed in, but Robinhood’s server hasn’t answered yet. Try Use again in a moment.')
    })

  return (
    <div className="tr-account__link">
      {broker.linkHelp && <p className="tr-hint tr-muted">{broker.linkHelp}</p>}
      {broker.link === 'sign-in' ? (
        <div className="tr-account__row">
          <button className="btn btn--sm btn--primary" disabled={busy} onClick={() => void signIn()}>
            {busy ? 'Waiting for the browser…' : `Sign in to ${broker.provider}`}
          </button>
          {busy && (
            <button className="btn btn--sm btn--ghost" onClick={() => void window.api.pluginAuth.cancelSignIn({ pluginId: 'robinhood' })}>
              Cancel
            </button>
          )}
        </div>
      ) : (
        <form
          className="tr-account__form"
          onSubmit={(e) => {
            e.preventDefault()
            if (keyKind) void work(() => window.api.trading.setKeys(keyKind, first.trim(), second.trim()))
          }}
        >
          {broker.link === 'keys' ? (
            <input className="input" placeholder="API key ID" value={first} onChange={(e) => setFirst(e.target.value)} spellCheck={false} autoComplete="off" autoFocus />
          ) : (
            <input className="input" placeholder="Account number (optional)" value={first} onChange={(e) => setFirst(e.target.value)} spellCheck={false} autoComplete="off" />
          )}
          <input
            className="input"
            type="password"
            placeholder={broker.link === 'keys' ? 'Secret key' : 'Access token'}
            value={second}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="off"
            autoFocus={broker.link === 'token'}
          />
          <button className="btn btn--sm btn--primary" type="submit" disabled={busy || !second.trim() || (broker.link === 'keys' && !first.trim())}>
            {busy ? 'Checking…' : 'Link'}
          </button>
        </form>
      )}
      <div className="tr-account__row">
        {broker.linkUrl && (
          <button className="btn btn--sm btn--ghost" onClick={() => void window.api.app.openExternal(broker.linkUrl!)}>
            <ExternalLink size={12} strokeWidth={1.9} />
            {broker.link === 'sign-in' ? 'About Robinhood Agentic trading' : `Get them from ${broker.provider}`}
          </button>
        )}
        <button className="btn btn--sm btn--ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
      {error && <p className="tr-error">{error}</p>}
      <p className="tr-hint tr-muted">
        {broker.link === 'sign-in'
          ? 'Eaon keeps the sign-in in your system keychain and uses it only to read the Agentic account and place the orders that pass your limits.'
          : `Checked with ${broker.provider}, then kept in your system keychain; they never leave this computer otherwise.`}
      </p>
    </div>
  )
}

/** Typing the sentence that switches real money on, then using the account. */
function LiveConfirm({ broker, onDone }: { broker: BrokerInfo; onDone: (used: boolean) => void }): JSX.Element {
  const run = useTrading((s) => s.run)
  const [typed, setTyped] = useState('')
  return (
    <div className="tr-live">
      <p>
        With {broker.label}, orders use real money, and you can lose it. Eaon only trades inside your limits, and asks you before every real-money order it places from
        a chat — but a session (Eaon’s agent or Claude Code) trades on its own within those limits.
      </p>
      <p>To go ahead, type:</p>
      <p className="tr-live__phrase">{LIVE_CONFIRMATION}</p>
      <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Confirmation" autoFocus />
      <div className="modal__actions">
        <button className="btn btn--ghost" onClick={() => onDone(false)}>
          Back
        </button>
        <button
          className="btn btn--danger"
          disabled={typed.trim() !== LIVE_CONFIRMATION}
          onClick={async () => {
            await run(() => window.api.trading.confirmLive(typed.trim()))
            const done = await run(() => window.api.trading.setConfig({ broker: broker.id }))
            onDone(Boolean(done))
          }}
        >
          Use real money
        </button>
      </div>
    </div>
  )
}
