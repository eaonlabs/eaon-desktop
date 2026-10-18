import { useState, type JSX } from 'react'

/**
 * The box for an event code (a hackathon's), in Settings → Model providers →
 * Eaon Free and in first-run setup. A code gives each computer its own
 * allowance; without one, Eaon Free's gateway counts a whole venue on one
 * shared IP as a single user.
 */
export function RedeemCode({ onRedeemed }: { onRedeemed: () => void | Promise<void> }): JSX.Element {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const redeem = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.freeCredits.redeem(value)
      if (!result.ok) return setError(result.message)
      setValue('')
      await onRedeemed()
    } catch {
      setError('Couldn’t check the code. Try again.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="free-code">
      <div className="free-code__title">Have an event code?</div>
      <p className="free-code__desc">From a hackathon or another event Eaon sponsors. It gives Eaon Free the event’s allowance until the code ends.</p>
      <div className="fallback-row">
        <input
          className="input"
          value={value}
          placeholder="EAON-XXXX-XXXX-XXXX"
          aria-label="Event code"
          spellCheck={false}
          autoCapitalize="characters"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && value.trim() && !busy && void redeem()}
        />
        <button className="btn btn--provider" disabled={!value.trim() || busy} onClick={() => void redeem()}>
          {busy ? 'Checking…' : 'Redeem'}
        </button>
      </div>
      {error && (
        <div className="provider-status" data-tone="error">
          {error}
        </div>
      )}
    </div>
  )
}
