import { useCallback, useEffect, useState, type JSX } from 'react'
import { Check, Cloud, Copy, ExternalLink, Globe, Inbox, Mail, RefreshCw, Trash2 } from 'lucide-react'
import {
  CLOUDFLARE_TOKEN_PERMISSIONS,
  CLOUDFLARE_TOKEN_URL,
  cleanCloudflareKey,
  cloudflareKeyKind,
  type CloudflareZoneChoice,
  type EmailDomain,
  type EmailMessage,
  type EmailState
} from '@shared/email'
import type { Worker } from '@shared/workers'
import { Card, Modal, Row, Section, Select, Switch } from '../../ui'

/**
 * Settings → Email: the agent's own address. Either on the user's own domain,
 * run on their Cloudflare account (Eaon sets up the DNS records, Email Routing
 * and a small Worker itself, from an API token), or through AgentMail, an email
 * service made for agents: Eaon creates the inbox, AgentMail sends the user a
 * six-digit code to confirm they own it, and from then on the agent can send
 * as well as receive. A custom domain gets its DNS records listed here to copy
 * into the domain's DNS settings, and is checked again on request.
 */

const errorText = (error: unknown): string => {
  // "Error invoking remote method 'email:x': AgentMailError: …" → just the sentence.
  const text = (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, '')
  // The page is newer than the main process it talks to: Eaon was updated (or rebuilt, in development) while running.
  if (/No handler registered for 'email:/.test(text)) return 'Eaon was updated while it was running, and Email needs a restart to finish. Quit Eaon and open it again.'
  return text
}

const CHECK_EVERY = [
  { value: '0', label: 'Only when asked' },
  { value: '1', label: 'Every minute' },
  { value: '5', label: 'Every 5 min' },
  { value: '15', label: 'Every 15 min' },
  { value: '60', label: 'Every hour' }
]

/** The email state, or why it could not be read (never a silently empty page). */
function useEmail(): { state: EmailState | null; setState: (state: EmailState) => void; loadError: string | null; load: () => void } {
  const [state, setState] = useState<EmailState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const load = useCallback(() => {
    setLoadError(null)
    window.api.email.state().then(setState, (error: unknown) => setLoadError(errorText(error)))
  }, [])
  useEffect(() => {
    load()
    return window.api.email.onChanged(setState)
  }, [load])
  return { state, setState, loadError, load }
}

export function EmailPage(): JSX.Element {
  const { state, setState, loadError, load } = useEmail()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (work: () => Promise<EmailState>): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      setState(await work())
      return true
    } catch (e) {
      setError(errorText(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h1 className="settings__h1">Email</h1>
      <p className="settings__lede">
        Give Eaon an email address of its own, so it can write to people and read their replies for you. It can use its own domain, too. Eaon asks you
        before it sends anything, unless you’ve given a chat full autonomy. Workers always ask.
      </p>
      {loadError && !state ? (
        <Section>
          <Card>
            <Row title="Email couldn’t load" description={loadError}>
              <button className="btn" onClick={load}>
                Try again
              </button>
            </Row>
          </Card>
        </Section>
      ) : !state ? null : state.status === 'off' ? (
        <SetUp run={run} busy={busy} apply={setState} />
      ) : (
        <>
          <Account state={state} run={run} busy={busy} />
          {state.status === 'verifying' && state.provider === 'agentmail' && <Verify state={state} run={run} busy={busy} />}
          {state.status !== 'verifying' && <InboxPreview state={state} run={run} />}
          <Domains state={state} run={run} busy={busy} apply={setState} />
          {state.status === 'ready' && <WorkerAddresses state={state} run={run} busy={busy} />}
          <Options state={state} run={run} />
        </>
      )}
      {error && <p className="em-error">{error}</p>}
    </>
  )
}

type Run = (work: () => Promise<EmailState>) => Promise<boolean>

const SETUP_CHOICES = [
  { value: 'cloudflare' as const, label: 'My own domain, on Cloudflare (Beta)' },
  { value: 'agentmail' as const, label: 'An AgentMail address' }
]

function SetUp({ run, busy, apply }: { run: Run; busy: boolean; apply: (state: EmailState) => void }): JSX.Element {
  const [choice, setChoice] = useState<'cloudflare' | 'agentmail'>('agentmail')
  return (
    <>
      <Section>
        <Card>
          <Row
            title="Where Eaon’s email lives"
            description={
              choice === 'cloudflare'
                ? 'An address on a domain you own, run on your own Cloudflare account. No AgentMail.'
                : 'A free address at agentmail.to, ready in a minute.'
            }
          >
            <Select value={choice} options={SETUP_CHOICES} onChange={setChoice} width={300} />
          </Row>
        </Card>
      </Section>
      {choice === 'cloudflare' ? <CloudflareSetUp apply={apply} /> : <AgentMailSetUp run={run} busy={busy} />}
    </>
  )
}

/** Email on your own domain through Cloudflare is new, and Cloudflare's sending service is itself in beta. */
function BetaBadge(): JSX.Element {
  return (
    <span className="badge em-beta" title="New, and still being proven on real Cloudflare accounts. If something doesn’t work, tell us.">
      Beta
    </span>
  )
}

/** "agents.example.com", or the domain itself. */
const fullDomain = (zone: string, sub: string): string => (sub.trim() ? `${sub.trim().toLowerCase().replace(/^\.+|\.+$/g, '')}.${zone}` : zone)

/**
 * The Cloudflare setup: a token, then the domain and the address. Eaon does
 * the rest on the user's account (see main/features/email/cloudflare.ts).
 * Shows its own progress and errors, since it also runs inside a dialog.
 */
/** What a pasted key is, as the user should hear it before anything is sent. */
const KEY_HINTS: Partial<Record<ReturnType<typeof cloudflareKeyKind>, string>> = {
  id: 'That’s an account or zone ID, not a token. Paste the API token’s value instead.',
  'cut-short': 'That looks cut short: a token is cfut_ (or cfat_) and 48 more letters and numbers. Copy it again.'
}

function CloudflareSetUp({ apply, onDone }: { apply: (state: EmailState) => void; onDone?: () => void }): JSX.Element {
  const [token, setToken] = useState('')
  const [login, setLogin] = useState('')
  const [working, setWorking] = useState(false)
  const [setupError, setSetupError] = useState<string | null>(null)
  const [zones, setZones] = useState<CloudflareZoneChoice[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [zoneId, setZoneId] = useState('')
  const [subdomain, setSubdomain] = useState('')
  const [username, setUsername] = useState('eaon')
  const [displayName, setDisplayName] = useState('Eaon')
  const zone = zones?.find((z) => z.id === zoneId) ?? null
  const domain = zone ? fullDomain(zone.name, subdomain) : ''
  const validUser = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(username.trim().toLowerCase())
  const validSub = !subdomain.trim() || /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(subdomain.trim().toLowerCase())
  const zonePermissions = CLOUDFLARE_TOKEN_PERMISSIONS.filter((p) => p.scope === 'Zone').map((p) => p.name)
  const accountPermissions = CLOUDFLARE_TOKEN_PERMISSIONS.filter((p) => p.scope === 'Account').map((p) => p.name)
  const byHand = CLOUDFLARE_TOKEN_PERMISSIONS.filter((p) => !p.prefilled).map((p) => p.name)
  const key = cleanCloudflareKey(token)
  const kind = cloudflareKeyKind(key)
  const globalKey = kind === 'global-key'
  const loginOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login.trim())
  const ready = globalKey ? loginOk : key.length >= 20 && !KEY_HINTS[kind]

  const setUp = async (): Promise<void> => {
    setWorking(true)
    setSetupError(null)
    try {
      apply(
        await window.api.email.setUpCloudflare({
          token: key,
          ...(globalKey ? { email: login.trim() } : {}),
          zoneId,
          subdomain: subdomain.trim().toLowerCase(),
          username: username.trim().toLowerCase(),
          displayName: displayName.trim() || undefined
        })
      )
      onDone?.()
    } catch (e) {
      setSetupError(errorText(e))
    } finally {
      setWorking(false)
    }
  }

  const check = async (): Promise<void> => {
    setChecking(true)
    setTokenError(null)
    try {
      const found = await window.api.email.cloudflareZones(key, globalKey ? login.trim() : undefined)
      setZones(found)
      setZoneId(found[0]?.id ?? '')
    } catch (e) {
      setTokenError(errorText(e))
    } finally {
      setChecking(false)
    }
  }

  return (
    <Section>
      <Card>
        {!zones ? (
          <form
            className="row row--stack"
            onSubmit={(e) => {
              e.preventDefault()
              void check()
            }}
          >
            <div className="row__body">
              <div className="row__title">
                Your domain, on your Cloudflare account
                <BetaBadge />
              </div>
              <div className="row__desc">
                Eaon sets up sending and receiving on a domain you have on Cloudflare: the DNS records, Email Routing and a small Worker that keeps incoming mail.
                Sending to people needs Cloudflare’s Workers Paid plan ($5 a month, 3,000 emails included); receiving is free.
              </div>
            </div>
            <label className="em-field">
              <span>Cloudflare API token, or your Global API Key</span>
              <input
                className="input em-mono"
                type="password"
                value={token}
                placeholder="cfut_…"
                onChange={(e) => {
                  setToken(e.target.value)
                  setTokenError(null)
                }}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            {KEY_HINTS[kind] && key ? <p className="em-error em-error--inline">{KEY_HINTS[kind]}</p> : null}
            {globalKey ? (
              <>
                <div className="em-key-note">
                  That’s your <b>Global API Key</b>. Eaon uses it once to make a token with only the permissions email needs, limited to the domain you pick,
                  and keeps just that token — not the key.
                </div>
                <label className="em-field">
                  <span>The email you sign in to Cloudflare with</span>
                  <input className="input" type="email" value={login} placeholder="you@example.com" onChange={(e) => setLogin(e.target.value)} autoComplete="email" />
                </label>
              </>
            ) : (
              <ul className="em-howto">
                <li>
                  <b>Easiest:</b> paste your Global API Key (Cloudflare → My Profile → API Tokens → Global API Key → View) and Eaon makes the token for you.
                </li>
                <li>
                  <b>Or make a token yourself:</b> Create Token → Create Custom Token, with {zonePermissions.join(', ')} for your domain and{' '}
                  {accountPermissions.join(', ')} for the account. “Create a token” below fills in {CLOUDFLARE_TOKEN_PERMISSIONS.length - byHand.length} of them; add{' '}
                  {byHand.join(', ')} yourself.
                </li>
              </ul>
            )}
            <div className="em-actions">
              <button className="btn btn--primary" type="submit" disabled={checking || !ready}>
                {checking ? 'Checking…' : 'Continue'}
              </button>
              <button type="button" className="btn btn--sm" onClick={() => void window.api.app.openExternal(CLOUDFLARE_TOKEN_URL)}>
                <ExternalLink size={13} strokeWidth={1.9} />
                Create a token
              </button>
            </div>
            {tokenError && <p className="em-error em-error--inline">{tokenError}</p>}
          </form>
        ) : (
          <form
            className="row row--stack"
            onSubmit={(e) => {
              e.preventDefault()
              void setUp()
            }}
          >
            <div className="row__body">
              <div className="row__title">
                <span className="em-address">
                  <Cloud size={15} strokeWidth={1.9} />
                  Pick the domain and the address
                </span>
              </div>
              <div className="row__desc">
                If the domain already gets email (Google Workspace, iCloud, Outlook…), use a subdomain such as agents — Eaon never takes over mail that already goes
                somewhere.
              </div>
            </div>
            <label className="em-field">
              <span>Domain</span>
              <Select value={zoneId} options={zones.map((z) => ({ value: z.id, label: z.name }))} onChange={setZoneId} width={320} />
            </label>
            <label className="em-field">
              <span>Subdomain (optional)</span>
              <span className="em-address-input">
                <input className="input" value={subdomain} placeholder="agents" onChange={(e) => setSubdomain(e.target.value)} spellCheck={false} />
                <span className="em-address-input__domain">.{zone?.name ?? ''}</span>
              </span>
            </label>
            <label className="em-field">
              <span>Eaon’s address</span>
              <span className="em-address-input">
                <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} spellCheck={false} aria-label="Address" />
                <span className="em-address-input__domain">@{domain}</span>
              </span>
            </label>
            <label className="em-field">
              <span>Name people see</span>
              <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </label>
            <div className="em-actions">
              <button className="btn btn--primary" type="submit" disabled={working || !zone || !validUser || !validSub}>
                {working ? 'Setting up on Cloudflare…' : 'Set up'}
              </button>
              <button type="button" className="btn btn--ghost" disabled={working} onClick={() => setZones(null)}>
                Back
              </button>
            </div>
            {setupError && <p className="em-error em-error--inline">{setupError}</p>}
          </form>
        )}
      </Card>
    </Section>
  )
}

function AgentMailSetUp({ run, busy }: { run: Run; busy: boolean }): JSX.Element {
  const [username, setUsername] = useState('')
  const [humanEmail, setHumanEmail] = useState('')
  const [displayName, setDisplayName] = useState('Eaon')
  const [haveKey, setHaveKey] = useState(false)
  const [key, setKey] = useState('')
  const cleanUser = username.trim().toLowerCase()
  const validUser = /^[a-z0-9][a-z0-9._-]{1,62}$/.test(cleanUser)
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(humanEmail.trim())

  return (
    <Section>
      <Card>
        {!haveKey ? (
          <form
            className="row row--stack"
            onSubmit={(e) => {
              e.preventDefault()
              void run(() => window.api.email.signUp({ username: cleanUser, humanEmail: humanEmail.trim(), displayName: displayName.trim() || undefined }))
            }}
          >
            <div className="row__body">
              <div className="row__title">Create Eaon’s inbox</div>
              <div className="row__desc">
                A free inbox at AgentMail. They email you a six-digit code to confirm it’s yours; until you enter it, the inbox can receive but not send.
              </div>
            </div>
            <label className="em-field">
              <span>Address</span>
              <span className="em-address-input">
                <input className="input" value={username} placeholder="your-assistant" onChange={(e) => setUsername(e.target.value)} spellCheck={false} />
                <span className="em-address-input__domain">@agentmail.to</span>
              </span>
            </label>
            <label className="em-field">
              <span>Name people see</span>
              <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </label>
            <label className="em-field">
              <span>Your own email, for the code</span>
              <input className="input" type="email" value={humanEmail} placeholder="you@example.com" onChange={(e) => setHumanEmail(e.target.value)} />
            </label>
            <div className="em-actions">
              <button className="btn btn--primary" type="submit" disabled={busy || !validUser || !validEmail}>
                {busy ? 'Creating…' : 'Create inbox'}
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => setHaveKey(true)}>
                I have an AgentMail API key
              </button>
            </div>
          </form>
        ) : (
          <form
            className="row row--stack"
            onSubmit={(e) => {
              e.preventDefault()
              void run(() => window.api.email.useApiKey(key.trim()))
            }}
          >
            <div className="row__body">
              <div className="row__title">Use your AgentMail account</div>
              <div className="row__desc">Paste an API key from the AgentMail console. Eaon uses your first inbox, or makes one.</div>
            </div>
            <input className="input em-mono" type="password" value={key} placeholder="am_…" onChange={(e) => setKey(e.target.value)} autoComplete="off" />
            <div className="em-actions">
              <button className="btn btn--primary" type="submit" disabled={busy || key.trim().length < 8}>
                {busy ? 'Checking…' : 'Connect'}
              </button>
              <button type="button" className="btn btn--sm" onClick={() => void window.api.app.openExternal('https://console.agentmail.to')}>
                <ExternalLink size={13} strokeWidth={1.9} />
                AgentMail console
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => setHaveKey(false)}>
                Create a new inbox instead
              </button>
            </div>
          </form>
        )}
      </Card>
    </Section>
  )
}

function CopyButton({ text, label }: { text: string; label: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      className="icon-btn"
      aria-label={label}
      title={label}
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1400)
      }}
    >
      {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.9} />}
    </button>
  )
}

function Account({ state, run, busy }: { state: EmailState; run: Run; busy: boolean }): JSX.Element {
  const [disconnecting, setDisconnecting] = useState(false)
  const cloudflare = state.provider === 'cloudflare' ? state.cloudflare : null
  const status =
    state.status === 'ready' && cloudflare?.sendsTo === 'nobody'
      ? { s: 'waiting', label: 'Receiving only' }
      : state.status === 'ready' && cloudflare?.sendsTo === 'verified'
      ? { s: 'on', label: 'Ready · verified addresses' }
      : state.status === 'ready'
      ? { s: 'on', label: 'Ready' }
      : state.status === 'verifying'
        ? { s: 'waiting', label: 'Waiting for your code' }
        : { s: 'error', label: 'Not working' }
  return (
    <Section label="Eaon’s address">
      <Card>
        <Row
          title={
            <span className="em-address">
              <Mail size={15} strokeWidth={1.9} />
              {state.inbox?.address ?? 'No inbox'}
              {state.inbox && <CopyButton text={state.inbox.address} label="Copy the address" />}
            </span>
          }
          description={state.error ?? `${state.sentToday} of ${state.maxPerDay} emails sent today.`}
        >
          <span className="bx-status" data-state={status.s}>
            <span className="bx-status__dot" aria-hidden="true" />
            {status.label}
          </span>
        </Row>
        {state.inboxes.length > 1 && (
          <Row title="Use this address" description={cloudflare ? `Eaon’s addresses on ${cloudflare.domain}.` : 'Every inbox on your AgentMail account.'}>
            <Select
              value={state.inbox?.id ?? ''}
              options={state.inboxes.map((i) => ({ value: i.id, label: i.address }))}
              onChange={(id) => void run(() => window.api.email.useInbox(id))}
              width={240}
            />
          </Row>
        )}
        {cloudflare && (
          <Row
            title={
              <span className="em-address">
                <Cloud size={15} strokeWidth={1.9} />
                On your Cloudflare account
                <BetaBadge />
              </span>
            }
            description={`Sent with Cloudflare Email Sending; replies reach Eaon through Email Routing and the eaon-mail Worker on ${cloudflare.zoneName}.`}
          />
        )}
        {cloudflare?.sendsTo === 'verified' && <VerifiedRecipients state={state} run={run} busy={busy} />}
        {cloudflare?.sendsTo === 'nobody' && (
          <Row
            title="Sending isn’t on yet"
            description="Mail to this address already reaches Eaon. To send, turn on Email Sending for your Cloudflare account (it needs the Workers Paid plan) — your domain below says how — then check again."
          >
            <button className="btn btn--sm" onClick={() => void window.api.app.openExternal('https://dash.cloudflare.com/')}>
              <ExternalLink size={13} strokeWidth={1.9} />
              Cloudflare
            </button>
            <button className="btn btn--sm" disabled={busy} onClick={() => void run(() => window.api.email.verifyDomain(cloudflare.domain))}>
              {busy ? 'Checking…' : 'Check again'}
            </button>
          </Row>
        )}
        <Row
          title="Disconnect"
          description={
            cloudflare
              ? `Eaon forgets the Cloudflare token.${cloudflare.returnsToAgentMail ? ' It goes back to its AgentMail address.' : ''}`
              : 'Eaon forgets the key. Nothing is deleted at AgentMail.'
          }
        >
          <button className="btn" disabled={busy} onClick={() => setDisconnecting(true)}>
            Disconnect
          </button>
        </Row>
      </Card>
      <Modal
        open={disconnecting}
        onClose={() => setDisconnecting(false)}
        title="Disconnect Eaon’s email?"
        actions={
          <>
            <button className="btn btn--ghost" onClick={() => setDisconnecting(false)}>
              Cancel
            </button>
            <button
              className="btn btn--danger"
              autoFocus
              onClick={() => {
                setDisconnecting(false)
                void run(() => window.api.email.disconnect())
              }}
            >
              Disconnect
            </button>
          </>
        }
      >
        {cloudflare ? (
          <>
            Eaon stops using {state.inbox?.address ?? 'this address'} and forgets the Cloudflare token. Your DNS records, the eaon-mail Worker and the mail it kept
            stay in your Cloudflare account, so mail to the address is still kept there.
            {cloudflare.returnsToAgentMail ? ' Eaon goes back to its AgentMail address.' : ''}
          </>
        ) : (
          <>
            Eaon stops using {state.inbox?.address ?? 'this inbox'} and forgets its key. The inbox and its mail stay at AgentMail; you can connect it again with an
            API key from their console.
          </>
        )}
      </Modal>
    </Section>
  )
}

/**
 * The free route (no Cloudflare Email Sending): Eaon can email only the
 * account's verified destination addresses. Lists them and asks for more.
 */
function VerifiedRecipients({ state, run, busy }: { state: EmailState; run: Run; busy: boolean }): JSX.Element {
  const [address, setAddress] = useState('')
  const [asked, setAsked] = useState<string | null>(null)
  const verified = state.cloudflare?.verified
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address.trim())
  return (
    <form
      className="row row--stack"
      onSubmit={(e) => {
        e.preventDefault()
        const target = address.trim().toLowerCase()
        void run(() => window.api.email.addVerifiedAddress(target)).then((ok) => {
          if (!ok) return
          setAsked(target)
          setAddress('')
        })
      }}
    >
      <div className="row__body">
        <div className="row__title">Sends to verified addresses</div>
        <div className="row__desc">
          Without Cloudflare’s paid Email Sending, Eaon emails for free — but only addresses verified in your Cloudflare account.{' '}
          {verified === null
            ? 'Eaon can’t list them with this token; they’re under Email Service → Email Routing → Destination addresses in Cloudflare.'
            : verified && verified.length
              ? `Verified: ${verified.join(', ')}.`
              : 'None are verified yet.'}{' '}
          To email anyone, turn on Email Sending in Cloudflare; Eaon switches by itself.
        </div>
      </div>
      <div className="em-actions">
        <input className="input" type="email" value={address} placeholder="you@example.com" onChange={(e) => setAddress(e.target.value)} aria-label="Address to verify" />
        <button className="btn" type="submit" disabled={busy || !valid}>
          Verify address
        </button>
      </div>
      {asked && <p className="em-footnote em-footnote--flush">Cloudflare emailed a link to {asked}. Once it’s clicked, Eaon can email that address.</p>}
    </form>
  )
}

function Verify({ state, run, busy }: { state: EmailState; run: Run; busy: boolean }): JSX.Element {
  const [code, setCode] = useState('')
  return (
    <Section label="Confirm it’s yours">
      <Card>
        <form
          className="row row--stack"
          onSubmit={(e) => {
            e.preventDefault()
            void run(() => window.api.email.verify(code.trim()))
          }}
        >
          <div className="row__body">
            <div className="row__title">Enter the code</div>
            <div className="row__desc">
              AgentMail sent a six-digit code to {state.humanEmail ?? 'your email'}. It lasts 24 hours. Until it’s entered, Eaon’s inbox can receive mail but not
              send it.
            </div>
          </div>
          <div className="em-actions">
            <input
              className="input em-code"
              inputMode="numeric"
              maxLength={6}
              value={code}
              placeholder="123456"
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              aria-label="Verification code"
            />
            <button className="btn btn--primary" type="submit" disabled={busy || code.length !== 6}>
              Verify
            </button>
            <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void run(() => window.api.email.resendCode())}>
              Send a new code
            </button>
          </div>
        </form>
      </Card>
    </Section>
  )
}

function InboxPreview({ state, run }: { state: EmailState; run: Run }): JSX.Element {
  const [open, setOpen] = useState<EmailMessage | null>(null)
  const [loading, setLoading] = useState<string | null>(null)
  return (
    <Section
      label={
        <span className="em-section-label">
          <span>
            Inbox{state.unread ? ` · ${state.unread} unread` : ''}
            {state.lastCheckedAt ? ` · checked ${new Date(state.lastCheckedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}
          </span>
          <button className="icon-btn" aria-label="Check for new mail" title="Check for new mail" onClick={() => void run(() => window.api.email.refresh())}>
            <RefreshCw size={13} strokeWidth={1.9} />
          </button>
        </span>
      }
    >
      <Card>
        {state.recent.length === 0 ? (
          <Row title={<span className="em-empty"><Inbox size={15} strokeWidth={1.8} /> Nothing here yet</span>} description="Mail to Eaon’s address shows up here, and Eaon can read it with its tools." />
        ) : (
          state.recent.slice(0, 12).map((message) => (
            <button
              key={message.id}
              className="row em-message"
              data-unread={message.unread || undefined}
              disabled={loading === message.id}
              onClick={async () => {
                setLoading(message.id)
                try {
                  setOpen(await window.api.email.read(message.id))
                } finally {
                  setLoading(null)
                }
              }}
            >
              <span className="em-message__dot" aria-hidden="true" />
              <span className="row__body">
                <span className="em-message__top">
                  <span className="em-message__from">{message.sent ? `To ${message.to.join(', ')}` : message.from}</span>
                  <span className="em-message__time">{new Date(message.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
                </span>
                <span className="em-message__subject">{message.subject || '(no subject)'}</span>
                <span className="em-message__preview">{message.preview}</span>
              </span>
            </button>
          ))
        )}
      </Card>
      <Modal open={open !== null} onClose={() => setOpen(null)} title={open?.subject || '(no subject)'} width={620} actions={null}>
        {open && (
          <div className="em-read">
            <div className="em-read__head">
              <div>
                <span className="tr-muted">From</span> {open.from}
              </div>
              <div>
                <span className="tr-muted">To</span> {open.to.join(', ')}
              </div>
              <div className="tr-muted">{new Date(open.at).toLocaleString()}</div>
            </div>
            <pre className="em-read__body">{open.text ?? open.preview}</pre>
          </div>
        )}
      </Modal>
    </Section>
  )
}

function Domains({ state, run, busy, apply }: { state: EmailState; run: Run; busy: boolean; apply: (state: EmailState) => void }): JSX.Element {
  const [domain, setDomain] = useState('')
  const [moving, setMoving] = useState(false)
  const clean = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  if (state.provider === 'cloudflare') {
    return (
      <Section label="Your domain">
        {state.domains.map((d) => (
          <DomainCard key={d.id} domain={d} run={run} busy={busy} cloudflare />
        ))}
      </Section>
    )
  }
  return (
    <Section label="Your own domain">
      <Card>
        <Row
          title={
            <span className="em-address">
              <Cloud size={15} strokeWidth={1.9} />
              Use your domain on Cloudflare
              <BetaBadge />
            </span>
          }
          description="No AgentMail for the domain: Eaon sets it up on your own Cloudflare account, DNS records included."
        >
          <button className="btn" disabled={busy} onClick={() => setMoving(true)}>
            Set up
          </button>
        </Row>
      </Card>
      <Modal open={moving} onClose={() => setMoving(false)} title="Your domain, on Cloudflare (Beta)" width={640} actions={null}>
        <p className="em-modal-lede">
          Eaon switches to the new address once it’s set up. Your AgentMail inbox stays; disconnecting Cloudflare later goes back to it.
        </p>
        <CloudflareSetUp apply={apply} onDone={() => setMoving(false)} />
      </Modal>
      <Card>
        <form
          className="row row--stack"
          onSubmit={(e) => {
            e.preventDefault()
            void run(() => window.api.email.addDomain(clean)).then((ok) => ok && setDomain(''))
          }}
        >
          <div className="row__body">
            <div className="row__title">Send from your domain</div>
            <div className="row__desc">
              Add a domain you own, put the records it shows into your domain’s DNS settings, then check it. Once it’s verified, Eaon can have an address like
              assistant@yourdomain.com. Use a subdomain (like mail.yourdomain.com) if the domain already has email.
            </div>
          </div>
          <div className="em-actions">
            <input className="input" value={domain} placeholder="yourdomain.com" onChange={(e) => setDomain(e.target.value)} spellCheck={false} />
            <button className="btn" type="submit" disabled={busy || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(clean)}>
              Add domain
            </button>
          </div>
        </form>
      </Card>
      {state.domains.map((d) => (
        <DomainCard key={d.id} domain={d} run={run} busy={busy} />
      ))}
    </Section>
  )
}

const DOMAIN_STATUS: Record<EmailDomain['status'], { s: string; label: string }> = {
  NOT_STARTED: { s: 'waiting', label: 'Add the records' },
  PENDING: { s: 'waiting', label: 'Checking' },
  VERIFYING: { s: 'waiting', label: 'Checking' },
  INVALID: { s: 'error', label: 'Records don’t match' },
  FAILED: { s: 'error', label: 'Failed' },
  VERIFIED: { s: 'on', label: 'Verified' }
}

function DomainCard({ domain, run, busy, cloudflare = false }: { domain: EmailDomain; run: Run; busy: boolean; cloudflare?: boolean }): JSX.Element {
  const [username, setUsername] = useState('assistant')
  const status = DOMAIN_STATUS[domain.status]
  return (
    <div className="em-domain">
      <Card>
        <Row
          title={
            <span className="em-address">
              <Globe size={15} strokeWidth={1.9} />
              {domain.domain}
            </span>
          }
          description={
            domain.reason ??
            (domain.status === 'VERIFIED'
              ? cloudflare
                ? 'Sending and receiving are set up on Cloudflare.'
                : 'Ready to send from.'
              : cloudflare
                ? 'Eaon adds these records to your domain itself. Check again to add any that are missing.'
                : 'Publish these records at your DNS provider, then check again. DNS can take a while to update.')
          }
        >
          <span className="bx-status" data-state={status.s}>
            <span className="bx-status__dot" aria-hidden="true" />
            {status.label}
          </span>
          {(domain.status !== 'VERIFIED' || cloudflare) && (
            <button className="btn btn--sm" disabled={busy} onClick={() => void run(() => window.api.email.verifyDomain(domain.id))}>
              {busy ? 'Checking…' : 'Check again'}
            </button>
          )}
          {!cloudflare && (
            <button className="icon-btn" aria-label={`Remove ${domain.domain}`} onClick={() => void run(() => window.api.email.removeDomain(domain.id))}>
              <Trash2 size={14} strokeWidth={1.9} />
            </button>
          )}
        </Row>
        {domain.status !== 'VERIFIED' && domain.records.length > 0 && (
          <div className="em-records">
            <table className="tr-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Name</th>
                  <th>Value</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {domain.records.map((r, i) => (
                  <tr key={`${r.type}-${r.name}-${i}`}>
                    <td>
                      {r.type}
                      {r.priority !== null ? <span className="tr-muted"> {r.priority}</span> : null}
                    </td>
                    <td className="em-mono">
                      <span className="em-cell">
                        <span className="em-cell__text">{r.name}</span>
                        <CopyButton text={r.name} label="Copy the name" />
                      </span>
                    </td>
                    <td className="em-mono">
                      <span className="em-cell">
                        <span className="em-cell__text" title={r.value}>
                          {r.value}
                        </span>
                        <CopyButton text={r.value} label="Copy the value" />
                      </span>
                    </td>
                    <td>
                      <span className="em-record" data-status={r.status}>
                        {r.status === 'VALID' ? 'Found' : r.status === 'INVALID' ? 'Wrong value' : 'Not found yet'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {domain.status === 'VERIFIED' && (
          <form
            className="row row--stack"
            onSubmit={(e) => {
              e.preventDefault()
              void run(() => window.api.email.createInbox({ username: username.trim().toLowerCase(), domain: domain.domain }))
            }}
          >
            <div className="row__body">
              <div className="row__title">Another address on {domain.domain}</div>
              <div className="row__desc">{cloudflare ? 'Routes it to Eaon and makes it the address Eaon uses.' : 'Creates the inbox and makes it the one Eaon uses.'}</div>
            </div>
            <div className="em-actions">
              <span className="em-address-input">
                <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} spellCheck={false} aria-label="Address" />
                <span className="em-address-input__domain">@{domain.domain}</span>
              </span>
              <button className="btn" type="submit" disabled={busy || !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(username.trim().toLowerCase())}>
                Create
              </button>
            </div>
          </form>
        )}
      </Card>
    </div>
  )
}

/** "Nova Research" → "nova-research". */
const slug = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'worker'

/** An address of each worker's own, on the same domain as Eaon's. */
function WorkerAddresses({ state, run, busy }: { state: EmailState; run: Run; busy: boolean }): JSX.Element {
  const [workers, setWorkers] = useState<Worker[] | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [username, setUsername] = useState('')
  useEffect(() => {
    void window.api.workers.list().then(setWorkers, () => setWorkers([]))
  }, [])
  const domain = state.cloudflare?.domain ?? state.inbox?.address.split('@')[1] ?? 'agentmail.to'
  // An older main process (updated while running) sends no workerAddresses.
  const own = new Map((state.workerAddresses ?? []).map((w) => [w.workerId, w.inbox]))
  if (workers === null) return <></>
  return (
    <Section label="Workers’ addresses">
      <Card>
        {workers.length === 0 ? (
          <Row title="No workers yet" description={`A worker can have an address of its own on ${domain}. Until then, workers use Eaon’s.`} />
        ) : (
          workers.map((worker) => {
            const inbox = own.get(worker.id)
            if (editing === worker.id) {
              return (
                <form
                  key={worker.id}
                  className="row row--stack"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void run(() => window.api.email.setWorkerAddress(worker.id, { username: username.trim().toLowerCase(), displayName: worker.name })).then(
                      (ok) => ok && setEditing(null)
                    )
                  }}
                >
                  <div className="row__body">
                    <div className="row__title">{worker.name}</div>
                    <div className="row__desc">Its own address on {domain}. Mail to it reaches this worker, and it sends as it.</div>
                  </div>
                  <div className="em-actions">
                    <span className="em-address-input">
                      <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} spellCheck={false} aria-label={`${worker.name}’s address`} autoFocus />
                      <span className="em-address-input__domain">@{domain}</span>
                    </span>
                    <button className="btn btn--primary" type="submit" disabled={busy || !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(username.trim().toLowerCase())}>
                      Create
                    </button>
                    <button type="button" className="btn btn--ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </div>
                </form>
              )
            }
            return (
              <Row
                key={worker.id}
                title={worker.name}
                description={inbox ? `Reads and sends as ${inbox.address}.` : `Uses Eaon’s address, ${state.inbox?.address ?? ''}.`}
              >
                {inbox ? (
                  <>
                    <CopyButton text={inbox.address} label="Copy the address" />
                    <button className="btn btn--sm" disabled={busy} onClick={() => void run(() => window.api.email.removeWorkerAddress(worker.id))}>
                      Remove
                    </button>
                  </>
                ) : (
                  <button
                    className="btn btn--sm"
                    disabled={busy}
                    onClick={() => {
                      setUsername(slug(worker.name))
                      setEditing(worker.id)
                    }}
                  >
                    Give it an address
                  </button>
                )}
              </Row>
            )
          })
        )}
      </Card>
      <p className="em-footnote">
        {state.provider === 'cloudflare'
          ? 'Mail to a worker’s address is kept for it on Cloudflare; removing the address stops new mail reaching it.'
          : 'Each worker address is its own AgentMail inbox; removing it here leaves the inbox at AgentMail.'}{' '}
        Workers always ask you before sending.
      </p>
    </Section>
  )
}

function Options({ state, run }: { state: EmailState; run: Run }): JSX.Element {
  const [cap, setCap] = useState<string | null>(null)
  return (
    <Section label="Options">
      <Card>
        <Row title="Tell me about new mail" description="A notification when someone emails Eaon.">
          <Switch label="Tell me about new mail" checked={state.notifyNew} onChange={(notifyNew) => void run(() => window.api.email.setOptions({ notifyNew }))} />
        </Row>
        <Row title="Check for new mail" description="While Eaon is open.">
          <Select
            value={String(state.checkEveryMinutes)}
            options={CHECK_EVERY}
            onChange={(v) => void run(() => window.api.email.setOptions({ checkEveryMinutes: Number(v) }))}
            width={170}
          />
        </Row>
        <Row title="Most emails a day" description="Eaon won’t send more than this in one day, however a task goes.">
          <input
            className="input em-number"
            type="number"
            min={1}
            max={500}
            value={cap ?? String(state.maxPerDay)}
            onChange={(e) => setCap(e.target.value)}
            onBlur={() => {
              const n = Math.round(Number(cap))
              setCap(null)
              if (Number.isFinite(n) && n >= 1 && n !== state.maxPerDay) void run(() => window.api.email.setOptions({ maxPerDay: Math.min(n, 500) }))
            }}
            aria-label="Most emails a day"
          />
        </Row>
      </Card>
    </Section>
  )
}
