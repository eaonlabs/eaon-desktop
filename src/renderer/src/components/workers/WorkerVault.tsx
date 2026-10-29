import { useEffect, useMemo, useState, type FormEvent, type JSX } from 'react'
import { ArrowLeft, Eye, EyeOff, Fingerprint, KeyRound, Plus, ShieldCheck, Trash2, Upload } from 'lucide-react'
import { findWorkerApp, WORKER_APPS, workerAppsEnabled } from '@shared/workerApps'
import { domainsFrom, hostMatches, siteFrom, type FoundLogin, type VaultLogin, type VaultState } from '@shared/workerVault'
import type { Worker } from '@shared/workers'
import { TopBar } from '../TopBar'
import { Modal, Switch } from '../ui'
import { PluginLogo } from '../plugins/PluginLogo'
import { AppMark } from './WorkerCards'
import { WorkerFace } from './WorkerFace'
import { errorText, useWorkers } from './workersStore'

/**
 * The workers' password vault, as the user manages it (shared/workerVault.ts):
 * logins, the 2FA secrets behind them, and the passkeys workers made on the
 * user's accounts. Nothing here ever holds a saved password: the page shows
 * websites and usernames, and a password goes to main once, when it is
 * typed, and stays there. Labs builds only.
 */

let cached: VaultState | null = null

export function useVault(): VaultState | null {
  const [state, setState] = useState<VaultState | null>(cached)
  useEffect(() => {
    if (!workerAppsEnabled()) return
    void window.api.workers.vault().then((s) => {
      cached = s
      setState(s)
    })
    return window.api.workers.onVaultChanged((s) => {
      cached = s
      setState(s)
    })
  }, [])
  return state
}

/** The app or known site a login is for, for its logo. */
function appFor(login: Pick<VaultLogin, 'site' | 'domains'>): ReturnType<typeof findWorkerApp> {
  return findWorkerApp(login.site) ?? WORKER_APPS.find((a) => a.domains.length > 0 && login.domains.some((d) => hostMatches(d, a.domains)))
}

function LoginLogo({ login, size = 34 }: { login: Pick<VaultLogin, 'site' | 'domains'>; size?: number }): JSX.Element {
  const app = appFor(login)
  return app ? <AppMark app={app} /> : <PluginLogo name={login.site || login.domains[0] || '?'} size={size} />
}

const when = (at: number | null): string => {
  if (!at) return 'Never used'
  const days = Math.floor((Date.now() - at) / 86_400_000)
  return days <= 0 ? 'Used today' : days === 1 ? 'Used yesterday' : days < 30 ? `Used ${days} days ago` : `Used ${new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

/* ------------------------------------------------------------ the page */

export function VaultPage(): JSX.Element {
  const vault = useVault()
  const workers = useWorkers((s) => s.workers)
  const [editing, setEditing] = useState<VaultLogin | 'new' | null>(null)
  const [imported, setImported] = useState<{ added: number; updated: number; skipped: number } | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [trashed, setTrashed] = useState(false)

  const importApple = async (): Promise<void> => {
    setImportError(null)
    setTrashed(false)
    try {
      const result = await window.api.workers.vaultImportApple('all')
      if (result) setImported(result)
    } catch (error) {
      setImportError(errorText(error))
    }
  }

  return (
    <div className="page vault-page">
      <TopBar
        variant="page__bar"
        left={
          <button className="header-btn worker-back" onClick={() => useWorkers.getState().setVaultOpen(false)}>
            <ArrowLeft size={14} strokeWidth={2} />
            <span>Team</span>
          </button>
        }
        right={
          <div className="chat-header__actions">
            <button className="header-btn" onClick={() => void importApple()} title="Import an export from Apple’s Passwords app">
              <Upload size={14} strokeWidth={2} />
              <span>Import from Passwords</span>
            </button>
            <button className="header-btn" onClick={() => setEditing('new')}>
              <Plus size={14} strokeWidth={2} />
              <span>Add login</span>
            </button>
          </div>
        }
      />
      <div className="page__scroll scroll">
        <div className="page__inner vault">
          <h1 className="page__title">Passwords</h1>
          <p className="page__subtitle">
            Logins and passkeys your workers sign in with. A worker never sees a password: when it’s on a sign-in page, Eaon types the login there itself — and only if the page is
            really that website.
          </p>

          {imported && (
            <div className="vault-note" role="status">
              <ShieldCheck size={16} strokeWidth={1.9} />
              <span>
                Imported {imported.added} login{imported.added === 1 ? '' : 's'}
                {imported.updated ? `, updated ${imported.updated}` : ''}
                {imported.skipped ? `, skipped ${imported.skipped} without a website or password` : ''}. The export file isn’t encrypted: anyone who opens it sees every password.
              </span>
              {trashed ? (
                <span className="vault-note__done">Moved to the Trash</span>
              ) : (
                <button className="btn btn--sm btn--primary" onClick={() => void window.api.workers.vaultTrashImport().then(setTrashed)}>
                  Move it to the Trash
                </button>
              )}
            </div>
          )}
          {importError && <div className="msg__error">{importError}</div>}

          <section className="vault-section">
            <div className="section-head section-head--ruled">
              <span className="section-head__title">Logins</span>
            </div>
            {!vault || vault.logins.length === 0 ? (
              <div className="vault-empty">
                <KeyRound size={22} strokeWidth={1.7} />
                <p>
                  No logins yet. Add one, import your passwords from Apple’s Passwords app, or just give a worker a password in chat — Eaon offers to keep it here instead of
                  sending it.
                </p>
              </div>
            ) : (
              <div className="vault-list">
                {vault.logins
                  .slice()
                  .sort((a, b) => a.site.localeCompare(b.site))
                  .map((login) => (
                    <button key={login.id} className="vault-row" onClick={() => setEditing(login)}>
                      <LoginLogo login={login} />
                      <span className="vault-row__text">
                        <span className="vault-row__site">{login.site}</span>
                        <span className="vault-row__user">{login.username || 'No username'}</span>
                      </span>
                      <span className="vault-row__tags">
                        {login.hasCode && <span className="vault-tag">2FA</span>}
                        {login.ask && <span className="vault-tag">Asks you</span>}
                        <Users workers={workers} value={login.workers} />
                      </span>
                      <span className="vault-row__when">{when(login.lastUsedAt)}</span>
                    </button>
                  ))}
              </div>
            )}
          </section>

          <section className="vault-section">
            <div className="section-head section-head--ruled">
              <span className="section-head__title">Passkeys</span>
            </div>
            {vault && vault.passkeys.length > 0 && (
              <div className="vault-list">
                {vault.passkeys.map((passkey) => {
                  const worker = workers.find((w) => w.id === passkey.workerId)
                  return (
                    <div key={passkey.id} className="vault-row vault-row--static">
                      <LoginLogo login={{ site: passkey.rpId, domains: [passkey.rpId] }} />
                      <span className="vault-row__text">
                        <span className="vault-row__site">{passkey.rpId}</span>
                        <span className="vault-row__user">
                          {passkey.userName || 'Account'} · {worker ? `${worker.name}’s passkey` : 'its worker was removed'}
                        </span>
                      </span>
                      <span className="vault-row__tags">{worker && <WorkerFace color={worker.color} shape={worker.shape} size={22} />}</span>
                      <span className="vault-row__when">{when(passkey.lastUsedAt)}</span>
                      <button
                        className="icon-btn"
                        aria-label={`Remove the passkey for ${passkey.rpId}`}
                        title={`Remove it here — also remove it from ${passkey.rpId}’s security settings`}
                        onClick={() => void window.api.workers.vaultRemovePasskey(passkey.id)}
                      >
                        <Trash2 size={15} strokeWidth={1.8} />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
            <div className="vault-explain">
              <Fingerprint size={20} strokeWidth={1.7} />
              <div>
                <strong>Give a worker its own passkey</strong>
                <ol>
                  <li>Sign the worker in to the site once — with a saved login, or from its Apps.</li>
                  <li>Tell it: “Add a passkey for yourself on github.com.” It opens the site’s security settings and adds one. (Or open its browser, take control and add it yourself.)</li>
                  <li>The passkey shows up here. From then on it signs in with it — no password, no codes — and you can revoke it in the site’s settings any time.</li>
                </ol>
                <p>
                  Your own passkeys in Apple’s Passwords app stay on your devices: Apple only hands them to other password-manager apps, so a worker gets a passkey of its own
                  rather than a copy of yours. Passwords and 2FA codes do come across from Passwords — use Import from Passwords (in Passwords: File → Export All Passwords to File).
                </p>
              </div>
            </div>
          </section>
        </div>
      </div>
      {editing && (
        <LoginEditor
          login={editing === 'new' ? null : editing}
          workers={workers}
          onClose={() => setEditing(null)}
          title={editing === 'new' ? 'Add login' : editing.site}
        />
      )}
    </div>
  )
}

/** Who may use a login: every worker, or the faces of the ones chosen. */
function Users({ workers, value }: { workers: Worker[]; value: 'all' | string[] }): JSX.Element {
  if (value === 'all') return <span className="vault-tag">All workers</span>
  const chosen = value.map((id) => workers.find((w) => w.id === id)).filter((w): w is Worker => Boolean(w))
  if (chosen.length === 0) return <span className="vault-tag vault-tag--warn">No worker</span>
  return (
    <span className="vault-faces" title={chosen.map((w) => w.name).join(', ')}>
      {chosen.slice(0, 4).map((w) => (
        <WorkerFace key={w.id} color={w.color} shape={w.shape} size={20} />
      ))}
    </span>
  )
}

/* ------------------------------------------------------------ add / edit */

function LoginEditor({
  login,
  workers,
  onClose,
  title
}: {
  login: VaultLogin | null
  workers: Worker[]
  onClose: () => void
  title: string
}): JSX.Element {
  const [error, setError] = useState<string | null>(null)
  return (
    <Modal open onClose={onClose} title={title} width={520}>
      <LoginForm
        initial={login ? { site: login.site, website: login.domains.join(', '), username: login.username, workers: login.workers, ask: login.ask } : undefined}
        workers={workers}
        editing={login}
        error={error}
        submitLabel={login ? 'Save' : 'Add login'}
        onSubmit={async (values) => {
          setError(null)
          try {
            await window.api.workers.vaultSave({
              ...(login ? { id: login.id } : {}),
              site: values.site,
              domains: domainsFrom(values.website),
              username: values.username,
              ...(values.password ? { password: values.password } : {}),
              ...(values.code !== null ? { code: values.code } : {}),
              workers: values.workers,
              ask: values.ask
            })
            onClose()
          } catch (e) {
            setError(errorText(e))
          }
        }}
        extra={
          login && (
            <button
              type="button"
              className="btn btn--ghost btn--danger-text"
              onClick={() => {
                void window.api.workers.vaultRemove(login.id)
                onClose()
              }}
            >
              <Trash2 size={14} strokeWidth={1.9} />
              Delete
            </button>
          )
        }
      />
    </Modal>
  )
}

export interface LoginValues {
  site: string
  website: string
  username: string
  password: string
  /** null keeps what is saved; '' removes it. */
  code: string | null
  workers: 'all' | string[]
  ask: boolean
}

/**
 * The login form, shared by the vault page and the chat's save dialog: the
 * website (its name, and the addresses it may be typed into, guessed from
 * the name), the username and password, an optional 2FA secret, who may use
 * it and whether each use waits for the user.
 */
export function LoginForm({
  initial,
  workers,
  editing,
  error,
  submitLabel,
  onSubmit,
  extra,
  secondary
}: {
  initial?: Partial<LoginValues>
  workers: Worker[]
  editing?: VaultLogin | null
  error: string | null
  submitLabel: string
  onSubmit: (values: LoginValues) => Promise<void>
  extra?: JSX.Element | null | false
  secondary?: JSX.Element
}): JSX.Element {
  const [site, setSite] = useState(initial?.site ?? '')
  const [website, setWebsite] = useState(initial?.website ?? '')
  const [websiteTouched, setWebsiteTouched] = useState(Boolean(initial?.website))
  const [username, setUsername] = useState(initial?.username ?? '')
  const [password, setPassword] = useState(initial?.password ?? '')
  const [show, setShow] = useState(false)
  const [code, setCode] = useState<string | null>(initial?.code ?? null)
  const [who, setWho] = useState<'all' | string[]>(initial?.workers ?? 'all')
  const [ask, setAsk] = useState(initial?.ask ?? false)
  const [busy, setBusy] = useState(false)

  // The websites follow the name until the user edits them: "Netflix" → netflix.com.
  const guessed = useMemo(() => (websiteTouched ? null : (domainsFrom(site)[0] ? domainsFrom(site) : (siteFrom(site)?.domains ?? []))), [site, websiteTouched])
  const shownWebsite = guessed ? guessed.join(', ') : website
  const ready = site.trim() && shownWebsite.trim() && (password || editing?.hasPassword) && (who === 'all' || who.length > 0)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    try {
      await onSubmit({ site: site.trim(), website: shownWebsite, username: username.trim(), password, code, workers: who, ask })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="login-form" onSubmit={(e) => void submit(e)}>
      <div className="login-form__row">
        <label className="login-form__field">
          <span>Website</span>
          <input className="input" value={site} placeholder="Netflix" autoFocus={!initial?.site} onChange={(e) => setSite(e.target.value)} />
        </label>
        <label className="login-form__field">
          <span>Address</span>
          <input
            className="input"
            value={shownWebsite}
            placeholder="netflix.com"
            spellCheck={false}
            onChange={(e) => {
              setWebsiteTouched(true)
              setWebsite(e.target.value)
            }}
          />
        </label>
      </div>
      <label className="login-form__field">
        <span>Username or email</span>
        <input className="input" value={username} autoComplete="off" spellCheck={false} onChange={(e) => setUsername(e.target.value)} />
      </label>
      <label className="login-form__field">
        <span>Password</span>
        <span className="login-form__secret">
          <input
            className="input"
            type={show ? 'text' : 'password'}
            value={password}
            autoComplete="new-password"
            placeholder={editing?.hasPassword ? 'Saved — type a new one to replace it' : ''}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button type="button" className="icon-btn" aria-label={show ? 'Hide password' : 'Show password'} onClick={() => setShow(!show)}>
            {show ? <EyeOff size={15} strokeWidth={1.8} /> : <Eye size={15} strokeWidth={1.8} />}
          </button>
        </span>
      </label>
      {code === null ? (
        <button type="button" className="link-btn login-form__add-code" onClick={() => setCode('')}>
          {editing?.hasCode ? 'Replace the 2FA secret' : 'Add a 2FA secret (so the worker can type the codes)'}
        </button>
      ) : (
        <label className="login-form__field">
          <span>2FA secret</span>
          <input
            className="input"
            type="password"
            value={code}
            spellCheck={false}
            placeholder="The setup key the site shows (or its otpauth:// link) — empty removes it"
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
      )}
      <div className="login-form__field">
        <span>Who can use it</span>
        <div className="login-form__who">
          <button type="button" className="app-chip" data-on={who === 'all' || undefined} onClick={() => setWho('all')}>
            All workers
          </button>
          {workers.map((w) => {
            const on = who !== 'all' && who.includes(w.id)
            return (
              <button
                key={w.id}
                type="button"
                className="app-chip"
                data-on={on || undefined}
                onClick={() => setWho(who === 'all' ? [w.id] : on ? who.filter((id) => id !== w.id) : [...who, w.id])}
              >
                <WorkerFace color={w.color} shape={w.shape} size={18} />
                {w.name}
              </button>
            )
          })}
        </div>
      </div>
      <div className="login-form__toggle">
        <Switch label="Ask me before each use" checked={ask} onChange={setAsk} />
        <span>Ask me before each use</span>
      </div>
      <p className="login-form__note">
        <ShieldCheck size={14} strokeWidth={1.9} />
        Kept encrypted on this computer. Workers never see it — Eaon types it only into {shownWebsite.split(',')[0]?.trim() || 'its website'}.
      </p>
      {error && <div className="msg__error">{error}</div>}
      <div className="login-form__actions">
        {extra}
        <span className="login-form__spacer" />
        {secondary}
        <button type="submit" className="btn btn--primary" disabled={!ready || busy}>
          {busy ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  )
}

/* ------------------------------------------------------------ chat */

/**
 * A password typed into a message to a worker: instead of sending it (to
 * the model and its provider), offer to keep it in the vault — the website
 * guessed from the message — and send the message with it taken out.
 */
export function SaveLoginDialog({
  worker,
  found,
  onSaved,
  onSendAnyway,
  onCancel
}: {
  worker: Worker
  found: FoundLogin
  onSaved: () => void
  onSendAnyway: () => void
  onCancel: () => void
}): JSX.Element {
  const workers = useWorkers((s) => s.workers)
  const [error, setError] = useState<string | null>(null)
  return (
    <Modal open onClose={onCancel} title="Keep this password in the vault?" width={520}>
      <p className="save-login__lead">
        Your message has a password in it. Saved in the vault, {worker.name} can sign in with it without ever seeing it — and it isn’t sent to the AI model. The message goes
        without it.
      </p>
      <LoginForm
        initial={{ site: found.site?.name ?? '', website: found.site?.domains.join(', ') ?? '', username: found.username, password: found.password, workers: [worker.id] }}
        workers={workers}
        error={error}
        submitLabel="Save and send"
        onSubmit={async (values) => {
          setError(null)
          try {
            await window.api.workers.vaultSave({
              site: values.site,
              domains: domainsFrom(values.website),
              username: values.username,
              password: values.password,
              ...(values.code ? { code: values.code } : {}),
              workers: values.workers,
              ask: values.ask,
              source: 'chat'
            })
            onSaved()
          } catch (e) {
            setError(errorText(e))
          }
        }}
        secondary={
          <button type="button" className="btn btn--ghost" onClick={onSendAnyway} title="The password goes to the model with the message">
            Send as typed
          </button>
        }
      />
    </Modal>
  )
}
