import { useCallback, useEffect, useState, type JSX } from 'react'
import { Check, Loader2 } from 'lucide-react'
import type { UsageAccountState } from '@shared/usage'

/**
 * Eaon's account is a Tokn account (toknhq.com): the one sign-in Eaon has.
 * It puts Eaon's usage and agents on the user's Tokn profile. Model providers'
 * sign-ins (ChatGPT, Copilot) are credentials for those models, not this.
 *
 * Signed out, Settings offers the sign-in at the top of its navigation;
 * signed in, the account is in Settings → Usage. First run offers the same
 * sign-in (onboarding). Sign-in itself runs in main
 * (features/usage).
 */

/** Tokn's mark, as on toknhq.com. */
export function ToknMark({ size = 18 }: { size?: number }): JSX.Element {
  return (
    <svg className="tokn-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#ccff33" />
      <path d="M13 7H9a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4" stroke="#121214" strokeWidth="3.5" strokeLinecap="round" fill="none" />
      <path d="M19 7h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" stroke="#121214" strokeWidth="3.5" strokeLinecap="round" fill="none" />
      <rect x="13.5" y="13.5" width="5" height="5" rx="1.5" fill="#121214" />
    </svg>
  )
}

/** The last state read, so an entry mounted later (opening Settings) shows at once rather than popping in. */
let known: UsageAccountState | null = null

/** The account, kept current: sign-in, sign-out and syncs all send `usage:changed`. */
export function useToknAccount(): UsageAccountState | null {
  const [state, setState] = useState<UsageAccountState | null>(known)
  const load = useCallback(() => {
    void window.api.usage.account().then((next) => {
      known = next
      setState(next)
    })
  }, [])
  useEffect(() => {
    load()
    return window.api.usage.onChanged(load)
  }, [load])
  return state
}

/** How long "Signed in" shows in Settings before the prompt folds away. */
const SIGNED_IN_NOTE_MS = 1600

/**
 * Settings' sign-in prompt: "Sign in with Tokn" at the top of the navigation
 * while signed out. Signed in, the account lives in Settings → Usage
 * (profiles, Sync now, Sign out), so nothing shows here. Signing in from the
 * prompt says so for a moment, then the prompt folds away.
 */
export function SignInPrompt(): JSX.Element | null {
  const state = useToknAccount()
  const account = state?.account ?? null
  // Seen signed out while open: only then is a sign-in worth a "Signed in" before folding away.
  const [sawSignedOut, setSawSignedOut] = useState(false)
  const [folded, setFolded] = useState(false)
  useEffect(() => {
    if (state && !state.account) {
      setSawSignedOut(true)
      setFolded(false)
    }
  }, [state])
  useEffect(() => {
    if (!account) return
    const timer = window.setTimeout(() => setFolded(true), SIGNED_IN_NOTE_MS)
    return () => window.clearTimeout(timer)
  }, [account])

  if (!state) return null
  if (account && (!sawSignedOut || folded)) return null

  if (account) {
    return (
      <div className="settings__account" data-folding="" role="status">
        <div className="settings__account-inner">
          <div className="account-entry account-entry--done">
            <span className="account-entry__avatar account-entry__avatar--done">
              <Check size={15} strokeWidth={2.4} />
            </span>
            <span className="account-entry__text">
              <span className="account-entry__name">Signed in as @{account.handle}</span>
              <span className="account-entry__sub">Your account is in Usage</span>
            </span>
          </div>
        </div>
      </div>
    )
  }

  const { signIn } = state
  const pending = signIn.state === 'pending'
  return (
    <div className="settings__account">
      <div className="settings__account-inner">
        <button
          className="account-entry"
          data-testid="account-entry"
          title={pending ? 'Waiting for you to approve Eaon on toknhq.com. Click to cancel.' : (signIn.error ?? 'Your Eaon account is your Tokn account, on toknhq.com.')}
          onClick={() => void (pending ? window.api.usage.cancelSignIn() : window.api.usage.signIn())}
        >
          <span className="account-entry__avatar account-entry__avatar--mark">
            {pending ? <Loader2 size={14} className="spinner" /> : <ToknMark size={22} />}
          </span>
          <span className="account-entry__text">
            <span className="account-entry__name">{pending ? 'Waiting for Tokn…' : 'Sign in with Tokn'}</span>
            <span className="account-entry__sub">
              {pending ? 'Approve Eaon in your browser' : signIn.state === 'error' ? 'Couldn’t sign in. Try again.' : 'Account on toknhq.com'}
            </span>
          </span>
        </button>
      </div>
    </div>
  )
}
