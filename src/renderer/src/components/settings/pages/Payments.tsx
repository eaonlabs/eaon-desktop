import { useCallback, useEffect, useState } from 'react'
import { CreditCard, ShieldAlert, Trash2 } from 'lucide-react'
import {
  formatMoney,
  PAYMENTS_WAIVER,
  PAYMENTS_WAIVER_VERSION,
  type PaymentLimits,
  type PaymentsMode,
  type PaymentsStatus,
  type PurchaseRecord
} from '@shared/payments'
import { Card, Modal, Row, Section, Segmented } from '../../ui'
import '../../../styles/payments.css'

/**
 * Settings → Payments: the card the agent pays with, how purchases are
 * allowed, the automatic limits and every purchase so far.
 *
 * "Automatic" never turns on from here directly: picking it opens the
 * waiver, and only accepting that (every box ticked) switches it on — the
 * main process refuses `auto` otherwise, so this page can't get around it.
 */

const errorText = (error: unknown): string => String((error as Error)?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function CardForm({ onSaved, onCancel }: { onSaved: (status: PaymentsStatus) => void; onCancel?: () => void }): JSX.Element {
  const [number, setNumber] = useState('')
  const [expiry, setExpiry] = useState('')
  const [cvc, setCvc] = useState('')
  const [name, setName] = useState('')
  const [zip, setZip] = useState('')
  const [label, setLabel] = useState('Agent card')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    const [mm, yy] = expiry.split('/').map((part) => part.trim())
    setSaving(true)
    setError(null)
    try {
      const status = await window.api.payments.setCard({
        number,
        expMonth: Number(mm),
        expYear: Number(yy),
        cvc,
        nameOnCard: name,
        billingZip: zip,
        label
      })
      setNumber('')
      setCvc('')
      onSaved(status)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  // "1234567812345678" → "1234 5678 1234 5678" as it is typed; "0829" → "08/29".
  const spaced = (value: string): string =>
    value
      .replace(/\D/g, '')
      .slice(0, 19)
      .replace(/(\d{4})(?=\d)/g, '$1 ')
  const slashed = (value: string): string => {
    const digits = value.replace(/\D/g, '').slice(0, 4)
    return digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits
  }

  return (
    <form
      className="row row--stack pay-form"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <label className="pay-field pay-field--wide">
        <span>Card number</span>
        <input className="input pay-mono" inputMode="numeric" autoComplete="off" value={number} placeholder="1234 5678 9012 3456" onChange={(e) => setNumber(spaced(e.target.value))} />
      </label>
      <div className="pay-grid">
        <label className="pay-field">
          <span>Expiry</span>
          <input className="input pay-mono" inputMode="numeric" autoComplete="off" value={expiry} placeholder="MM/YY" onChange={(e) => setExpiry(slashed(e.target.value))} />
        </label>
        <label className="pay-field">
          <span>Security code</span>
          <input className="input pay-mono" type="password" inputMode="numeric" autoComplete="off" value={cvc} placeholder="CVC" maxLength={4} onChange={(e) => setCvc(e.target.value.replace(/\D/g, ''))} />
        </label>
        <label className="pay-field">
          <span>Billing ZIP or postcode</span>
          <input className="input" autoComplete="off" value={zip} onChange={(e) => setZip(e.target.value)} />
        </label>
      </div>
      <div className="pay-grid pay-grid--two">
        <label className="pay-field">
          <span>Name on card</span>
          <input className="input" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="pay-field">
          <span>Call it</span>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
      </div>
      <p className="pay-hint">
        Use a virtual card with its own spending limit from your bank or card issuer, so the issuer caps what can be spent as well. The number and code are
        stored encrypted on this computer and are never shown again.
      </p>
      {error && <p className="pay-error">{error}</p>}
      <div className="pay-actions">
        <button className="btn btn--primary" type="submit" disabled={saving || !number || !expiry || !cvc || !name.trim()}>
          {saving ? 'Saving…' : 'Save card'}
        </button>
        {onCancel && (
          <button className="btn" type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  )
}

function WaiverModal({ open, onClose, onAccepted }: { open: boolean; onClose: () => void; onAccepted: (status: PaymentsStatus) => void }): JSX.Element | null {
  const [checks, setChecks] = useState<boolean[]>(() => PAYMENTS_WAIVER.checks.map(() => false))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setChecks(PAYMENTS_WAIVER.checks.map(() => false))
      setError(null)
    }
  }, [open])

  const all = checks.every(Boolean)
  const accept = async (): Promise<void> => {
    if (!all) return
    setBusy(true)
    setError(null)
    try {
      onAccepted(await window.api.payments.acceptWaiver(PAYMENTS_WAIVER_VERSION, checks))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={PAYMENTS_WAIVER.title}
      width={560}
      actions={
        <>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--primary" type="button" disabled={!all || busy} onClick={() => void accept()}>
            {busy ? 'Turning on…' : 'Continue'}
          </button>
        </>
      }
    >
      <div className="pay-waiver">
        <div className="pay-waiver__lead">
          <ShieldAlert size={16} strokeWidth={1.9} />
          <span>Read this before letting the agent spend money without asking you.</span>
        </div>
        <div className="pay-waiver__terms" tabIndex={0} aria-label="Terms">
          {PAYMENTS_WAIVER.paragraphs.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
        <div className="pay-waiver__checks">
          {PAYMENTS_WAIVER.checks.map((text, i) => (
            <label key={text} className="pay-check">
              <input type="checkbox" checked={checks[i]} onChange={(e) => setChecks((prev) => prev.map((c, j) => (j === i ? e.target.checked : c)))} />
              <span>{text}</span>
            </label>
          ))}
        </div>
        {error && <p className="pay-error">{error}</p>}
      </div>
    </Modal>
  )
}

function LimitInput({ value, currency, onCommit, label }: { value: number; currency: string; onCommit: (value: number) => void; label: string }): JSX.Element {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = (): void => {
    const next = Number(draft)
    if (Number.isFinite(next) && next >= 0 && next !== value) onCommit(next)
    else setDraft(String(value))
  }
  return (
    <span className="pay-limit">
      <span className="pay-limit__unit">{currency === 'USD' ? '$' : currency}</span>
      <input
        className="input pay-mono"
        inputMode="decimal"
        aria-label={label}
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9.]/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </span>
  )
}

const STATUS_LABEL: Record<PurchaseRecord['status'], string> = {
  authorized: 'Pending',
  paid: 'Paid',
  failed: 'Failed',
  cancelled: 'Cancelled'
}

function PurchaseRow({ purchase }: { purchase: PurchaseRecord }): JSX.Element {
  const when = new Date(purchase.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  return (
    <div className="row pay-purchase">
      <div className="row__body">
        <div className="row__title">
          {purchase.merchant}
          {purchase.description ? <span className="pay-purchase__what"> · {purchase.description}</span> : null}
        </div>
        <div className="row__desc">
          {when} · {purchase.how === 'approved' ? 'You approved it' : 'Automatic'}
          {purchase.site ? ` · ${purchase.site}` : ''}
          {purchase.note ? ` · ${purchase.note}` : ''}
        </div>
      </div>
      <div className="row__trail">
        <span className="pay-mono pay-purchase__amount">{formatMoney(purchase.charged ?? purchase.amount, purchase.currency)}</span>
        <span className={`badge${purchase.status === 'paid' ? ' badge--ok' : purchase.status === 'failed' ? ' badge--warn' : ''}`}>{STATUS_LABEL[purchase.status]}</span>
      </div>
    </div>
  )
}

export function PaymentsPage(): JSX.Element {
  const [status, setStatus] = useState<PaymentsStatus | null>(null)
  const [replacing, setReplacing] = useState(false)
  const [waiverOpen, setWaiverOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.api.payments.status().then(setStatus)
    return window.api.payments.onChanged(setStatus)
  }, [])

  const act = useCallback(async (fn: () => Promise<PaymentsStatus>): Promise<void> => {
    setError(null)
    try {
      setStatus(await fn())
    } catch (e) {
      setError(errorText(e))
    }
  }, [])

  if (!status) return <></>
  const { card, currency, limits, spent } = status

  const pickMode = (mode: PaymentsMode): void => {
    // Automatic goes through the waiver unless the current one is already accepted.
    if (mode === 'auto' && !status.waiverCurrent) {
      setWaiverOpen(true)
      return
    }
    void act(() => window.api.payments.setMode(mode))
  }

  const setLimit = (key: keyof PaymentLimits, value: number): void => void act(() => window.api.payments.setLimits({ [key]: value }))

  const modeDescription =
    status.effectiveMode === 'auto'
      ? `The agent buys on its own when a purchase fits your limits. Anything over them asks you first.`
      : status.effectiveMode === 'approve'
        ? 'Before every purchase you see who, what and how much, and nothing is paid until you approve.'
        : 'The agent can’t pay for anything.'

  return (
    <>
      <h1 className="settings__h1">Payments</h1>
      <p className="settings__lede">
        Let the agent pay for things with a card you save here, like a coffee order, tickets or a subscription. Approve each purchase, or let it buy on its own within
        limits you set.
      </p>

      <Section label="Card">
        <Card>
          {card && !replacing ? (
            <Row
              title={
                <span className="pay-card">
                  <CreditCard size={15} strokeWidth={1.9} />
                  {card.brand} •••• {card.last4}
                </span>
              }
              description={`${card.label} · ${card.nameOnCard} · expires ${String(card.expMonth).padStart(2, '0')}/${String(card.expYear).slice(-2)}`}
            >
              <button className="btn btn--sm" onClick={() => setReplacing(true)}>
                Replace
              </button>
              <button className="btn btn--sm btn--ghost" aria-label="Remove card" onClick={() => void act(() => window.api.payments.removeCard())}>
                <Trash2 size={13} strokeWidth={1.9} />
                Remove
              </button>
            </Row>
          ) : (
            <CardForm
              onSaved={(next) => {
                setStatus(next)
                setReplacing(false)
              }}
              onCancel={card ? () => setReplacing(false) : undefined}
            />
          )}
        </Card>
      </Section>

      <Section label="Purchases">
        <Card>
          <Row title="When the agent wants to buy something" description={modeDescription}>
            <Segmented<PaymentsMode>
              value={status.effectiveMode}
              onChange={pickMode}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'approve', label: 'Ask me' },
                { value: 'auto', label: 'Automatic' }
              ]}
            />
          </Row>
          {status.waiver && status.waiverCurrent && (
            <Row
              title="Automatic purchases terms"
              description={`Accepted ${new Date(status.waiver.acceptedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}. Withdrawing turns automatic purchases off.`}
            >
              <button className="btn btn--sm" onClick={() => void act(() => window.api.payments.revokeWaiver())}>
                Withdraw
              </button>
            </Row>
          )}
          {!card && <Row title="Add a card first" description="Payments stay off until there is a card to pay with." />}
        </Card>
        {error && <p className="pay-error pay-error--page">{error}</p>}
      </Section>

      <Section label="Automatic limits">
        <Card>
          <Row title="Each purchase" description="Largest single purchase the agent may make without asking">
            <LimitInput label="Each purchase" value={limits.perPurchase} currency={currency} onCommit={(v) => setLimit('perPurchase', v)} />
          </Row>
          <Row title="Each day" description={`Spent today: ${formatMoney(spent.today, currency)}`}>
            <LimitInput label="Each day" value={limits.perDay} currency={currency} onCommit={(v) => setLimit('perDay', v)} />
          </Row>
          <Row title="Each month" description={`Spent this month: ${formatMoney(spent.month, currency)}`}>
            <LimitInput label="Each month" value={limits.perMonth} currency={currency} onCommit={(v) => setLimit('perMonth', v)} />
          </Row>
        </Card>
      </Section>

      <Section label="History">
        <Card>
          {status.purchases.length === 0 ? (
            <Row title="No purchases yet" description="Everything the agent pays for is listed here, approved or automatic." />
          ) : (
            status.purchases.map((p) => <PurchaseRow key={p.id} purchase={p} />)
          )}
        </Card>
      </Section>

      <WaiverModal
        open={waiverOpen}
        onClose={() => setWaiverOpen(false)}
        onAccepted={(next) => {
          setStatus(next)
          setWaiverOpen(false)
        }}
      />
    </>
  )
}
