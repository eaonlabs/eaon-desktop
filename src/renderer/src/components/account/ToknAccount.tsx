import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { BarChart3, Loader2, LogOut, RefreshCw, Trophy, UserRound } from 'lucide-react'
import type { UsageAccountState } from '@shared/usage'
import { useApp } from '../../state/store'
import { MenuItem, MenuSeparator, Popover, useDisclosure } from '../ui'

/**
 * Eaon's account is a Tokn account (toknhq.com): the one sign-in Eaon has.
 * It puts Eaon's usage and agents on the user's Tokn profile, their Eaon
 * profile and the Eaon leaderboard (tokns.eaon.dev). Model providers'
 * sign-ins (ChatGPT, Copilot) are credentials for those models, not this.
 *
 * The entry sits at the top of Settings (and in Settings → Usage); first
 * run offers the same sign-in (onboarding). Sign-in itself runs in main
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

/** The first letter of the name, or of the handle. */
const initial = (name: string): string => (name.trim()[0] ?? '?').toUpperCase()

/**
 * The account entry: who is signed in, with their profiles, Sync now and
 * Sign out a click away; signed out, "Sign in with Tokn".
 */
export function AccountButton({ placement = 'top-start' }: { placement?: 'top-start' | 'bottom-start' }): JSX.Element | null {
  const state = useToknAccount()
  const anchor = useRef<HTMLButtonElement>(null)
  const menu = useDisclosure()
  const setSettingsPage = useApp((s) => s.setSettingsPage)
  if (!state) return null

  const { account, signIn, sync } = state
  if (!account) {
    const pending = signIn.state === 'pending'
    return (
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
    )
  }

  const name = account.name || account.handle
  const syncing = sync.state === 'syncing'
  const open = (page: 'profile' | 'eaon-profile' | 'leaderboard') => () => {
    void window.api.usage.openProfile(page)
    menu.close()
  }
  return (
    <>
      <button
        ref={anchor}
        className="account-entry"
        data-testid="account-entry"
        data-open={menu.open || undefined}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        title={`${name} (@${account.handle})`}
        onClick={menu.toggle}
      >
        <span className="account-entry__avatar" aria-hidden="true">
          {initial(name)}
        </span>
        <span className="account-entry__text">
          <span className="account-entry__name">{name}</span>
          <span className="account-entry__sub">@{account.handle}</span>
        </span>
      </button>
      <Popover anchor={anchor} open={menu.open} onClose={menu.close} placement={placement} width={268}>
        <div className="menu__header account-menu__header">
          <span className="account-entry__avatar" aria-hidden="true">
            {initial(name)}
          </span>
          <span className="account-entry__text">
            <span className="account-entry__name">{name}</span>
            <span className="account-entry__sub">@{account.handle} on Tokn</span>
          </span>
        </div>
        <MenuSeparator />
        <MenuItem icon={<ToknMark size={15} />} title="Your profile on toknhq.com" onClick={open('profile')} />
        <MenuItem icon={<UserRound size={14} strokeWidth={2} />} title="Your Eaon profile on tokns.eaon.dev" onClick={open('eaon-profile')} />
        <MenuItem icon={<Trophy size={14} strokeWidth={2} />} title="Eaon leaderboard" onClick={open('leaderboard')} />
        <MenuSeparator />
        <MenuItem
          icon={<BarChart3 size={14} strokeWidth={2} />}
          title="Usage"
          onClick={() => {
            setSettingsPage('usage')
            menu.close()
          }}
        />
        <MenuItem
          icon={syncing ? <Loader2 size={14} className="spinner" /> : <RefreshCw size={14} strokeWidth={2} />}
          title={syncing ? 'Syncing…' : 'Sync now'}
          description={sync.state === 'error' ? 'The last sync didn’t go through.' : undefined}
          disabled={syncing}
          onClick={() => void window.api.usage.sync()}
        />
        <MenuItem
          icon={<LogOut size={14} strokeWidth={2} />}
          title="Sign out"
          onClick={() => {
            menu.close()
            void window.api.usage.signOut()
          }}
        />
      </Popover>
    </>
  )
}
