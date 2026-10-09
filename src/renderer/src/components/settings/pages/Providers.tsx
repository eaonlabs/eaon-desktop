import { useEffect, useMemo, useState } from 'react'
import {
  Brain,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Star,
  Trash2,
  TriangleAlert,
  Info,
  Link2,
  Wrench
} from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { useApp } from '../../../state/store'
import { BrandIcon } from '../../../icons/brand'
import { Modal, SearchField, Switch } from '../../ui'
import type { ModelInfo, Provider } from '@shared/types'
import { checkKeyShape, customProviderId, type ModelEdit, type ModelEditFields, type ModelsRefresh, type ProviderAuthStatus, type ProviderMeta } from '@shared/providers'
import { ago, describeSource, modelCapabilities, providerReadiness, STAGE_LABEL, modelStage, OUTSIDE_PLAN_NOTE } from '@shared/modelSelection'
import { CodexEngineDetail, CodexEngineRow, CODEX_ROW_ID, useCodexEngine } from './ProviderCodexEntry'
import '../../../styles/providers.css'
import { openInAde } from '../../code/terminal/terminalStore'
import { LinkAccounts } from '../../LinkAccounts'

/** The plan's own CLI, named for the button that opens it in the ADE. */
const PLAN_CLI = { claude: 'Claude Code', antigravity: 'Antigravity', codex: 'Codex' } as const

type Category = NonNullable<Provider['category']>

/** List order. Subscriptions first: signing in is the quickest way to a working model. */
const GROUPS: { id: Category; label: string }[] = [
  { id: 'subscription', label: 'Subscriptions' },
  { id: 'local', label: 'Local' },
  { id: 'frontier', label: 'Frontier labs' },
  { id: 'gateway', label: 'Gateways' },
  { id: 'inference', label: 'Inference' },
  { id: 'regional', label: 'Regional' },
  { id: 'custom', label: 'Custom' }
]

const categoryOf = (provider: Provider): Category =>
  provider.category ?? (provider.local ? 'local' : provider.builtIn ? 'frontier' : 'custom')

/** "1M", "262K": context sizes as the model picker and pricing pages write them. */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${millions >= 10 || Math.abs(millions - Math.round(millions)) < 0.05 ? Math.round(millions) : millions.toFixed(1)}M`
  }
  return `${Math.round(tokens / 1000)}K`
}

/* ------------------------------------------------------------ templates */

const templateKeys = (template: string): string[] => [...template.matchAll(/\{([a-z_]+)\}/gi)].map((m) => m[1])

/** Reads the filled-in values back out of a URL built from `template`. */
function readTemplate(template: string, url: string): Record<string, string> {
  const keys = templateKeys(template)
  const pattern = template
    .split(/\{[a-z_]+\}/i)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('([^/]*)')
  const match = url.match(new RegExp(`^${pattern}$`))
  const values: Record<string, string> = {}
  keys.forEach((key, index) => {
    const value = match?.[index + 1] ?? ''
    // An unfilled placeholder reads back as itself.
    values[key] = value === `{${key}}` ? '' : value
  })
  return values
}

function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/gi, (whole, key: string) => values[key]?.trim() || whole)
}

/* ----------------------------------------------------- shared data hooks */

let metaCache: Record<string, ProviderMeta> | null = null

function useProviderMeta(): Record<string, ProviderMeta> {
  const [meta, setMeta] = useState<Record<string, ProviderMeta>>(metaCache ?? {})
  useEffect(() => {
    if (metaCache) return
    void window.api.providerAuth.meta().then((value) => {
      metaCache = value
      setMeta(value)
    })
  }, [])
  return meta
}

/** Sign-in state per provider, kept live by the main process's status events. */
function useAuthStatuses(): Record<string, ProviderAuthStatus> {
  const refreshProviders = useApp((s) => s.refreshProviders)
  const [statuses, setStatuses] = useState<Record<string, ProviderAuthStatus>>({})
  useEffect(() => {
    let alive = true
    void window.api.providerAuth.status().then((list) => {
      if (alive) setStatuses(Object.fromEntries(list.map((status) => [status.providerId, status])))
    })
    const off = window.api.providerAuth.onStatus((status) => {
      setStatuses((current) => ({ ...current, [status.providerId]: status }))
      // A finished sign-in changes hasKey and the model list.
      if (status.state !== 'pending') void refreshProviders()
    })
    return () => {
      alive = false
      off()
    }
  }, [refreshProviders])
  return statuses
}

/* ------------------------------------------------------------------ page */

export function ProvidersPage(): JSX.Element {
  const providers = useApp((s) => s.providers)
  const refreshProviders = useApp((s) => s.refreshProviders)
  const providerFocus = useApp((s) => s.providerFocus)
  const setProviderFocus = useApp((s) => s.setProviderFocus)
  const meta = useProviderMeta()
  const auth = useAuthStatuses()
  const codex = useCodexEngine()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [addingCustom, setAddingCustom] = useState(false)
  const [linking, setLinking] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    void refreshProviders()
  }, [refreshProviders])

  // Sent here to fix one provider (a reply's "Fix key", the composer's "Sign in again"): open on it.
  useEffect(() => {
    if (!providerFocus) return
    setSelectedId(providerFocus)
    setQuery('')
    setProviderFocus(null)
  }, [providerFocus, setProviderFocus])

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matches = (p: Provider): boolean =>
      !needle || [p.name, p.id, p.description ?? ''].some((field) => field.toLowerCase().includes(needle))
    return GROUPS.map((group) => ({
      ...group,
      // The old ChatGPT sign-in borrows the Codex CLI's client id; the official
      // Sign in with ChatGPT replaces it, so it stays only for people signed in with it.
      providers: providers.filter((p) => categoryOf(p) === group.id && matches(p) && !(p.id === 'openai-codex' && !p.signedIn))
    })).filter((group) => group.providers.length > 0)
  }, [providers, query])

  const selected = providers.find((p) => p.id === selectedId) ?? providers.find((p) => p.id === 'openai') ?? providers[0] ?? null
  // Codex runs as its own engine, not a provider: listed with the subscriptions once Eaon has checked for it.
  const codexMatches = Boolean(codex.status) && (!query.trim() || 'codex openai chatgpt'.includes(query.trim().toLowerCase()))
  const showingCodex = selectedId === CODEX_ROW_ID && Boolean(codex.status)

  return (
    <div className="providers-shell">
      <nav className="providers-list">
        <div className="providers-list__top">
          <div className="providers-list__header">
            <span className="providers-list__title">Model Providers</span>
            <button className="icon-btn" onClick={() => setLinking(true)} aria-label="Link accounts" title="Link accounts">
              <Link2 size={16} strokeWidth={2.1} />
            </button>
            <button className="icon-btn" onClick={() => setAddingCustom(true)} aria-label="Add custom provider">
              <Plus size={17} strokeWidth={2.1} />
            </button>
          </div>
          <SearchField value={query} onChange={setQuery} placeholder="Search providers" variant="sm" />
        </div>

        <div className="providers-list__scroll scroll">
          {groups.map((group) => (
            <div key={group.id}>
              <div className="providers-list__group">{group.label}</div>
              {group.id === 'subscription' && codexMatches && (
                <CodexEngineRow status={codex.status!} active={showingCodex} onClick={() => setSelectedId(CODEX_ROW_ID)} />
              )}
              {group.providers.map((provider) => (
                <ProviderRow
                  key={provider.id}
                  provider={provider}
                  pending={auth[provider.id]?.state === 'pending'}
                  active={!showingCodex && provider.id === selected?.id}
                  onClick={() => setSelectedId(provider.id)}
                />
              ))}
            </div>
          ))}
          {groups.length === 0 && <div className="providers-list__empty">No providers match “{query.trim()}”.</div>}
        </div>
      </nav>

      <div className="providers-detail scroll">
        {showingCodex ? (
          <CodexEngineDetail engine={codex} onOpenProvider={(id) => setSelectedId(id)} />
        ) : selected && (
          <ProviderDetail
            key={selected.id}
            provider={selected}
            meta={meta[selected.id] ?? { id: selected.id, listsModels: true }}
            auth={auth[selected.id]}
          />
        )}
      </div>

      <AddCustomProviderModal
        open={addingCustom}
        onClose={() => setAddingCustom(false)}
        onCreated={(id) => {
          setSelectedId(id)
          setAddingCustom(false)
        }}
      />
      <LinkAccounts open={linking} onClose={() => setLinking(false)} />
    </div>
  )
}

function ProviderRow({
  provider,
  pending,
  active,
  onClick
}: {
  provider: Provider
  pending: boolean
  active: boolean
  onClick: () => void
}): JSX.Element {
  // Ready means usable now, by the same rules as the model picker: stored
  // credentials that a check found expired or rejected need attention instead,
  // and a local runtime counts once it has served a model list.
  const readiness = providerReadiness(provider)
  const state = pending ? 'pending' : readiness.state === 'ready' ? 'ready' : readiness.state === 'attention' ? 'attention' : null
  return (
    <button className="provider-row" data-active={active || undefined} onClick={onClick} title={readiness.state === 'attention' ? `Needs attention — ${readiness.reason}` : undefined}>
      <BrandIcon id={provider.id} name={provider.name} size={24} />
      <span className="provider-row__label">{provider.name}</span>
      {state && <span className="provider-row__badge" data-state={state} aria-label={state === 'attention' ? 'Needs attention' : state === 'ready' ? 'Ready' : 'Signing in'} />}
    </button>
  )
}

/* ---------------------------------------------------------------- detail */

function ProviderDetail({
  provider,
  meta,
  auth
}: {
  provider: Provider
  meta: ProviderMeta
  auth: ProviderAuthStatus | undefined
}): JSX.Element {
  const refreshProviders = useApp((s) => s.refreshProviders)
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null)

  return (
    <>
      <div className="provider-detail__header">
        <BrandIcon id={provider.id} name={provider.name} size={40} />
        <div className="provider-detail__heading">
          <span className="provider-detail__name">{provider.name}</span>
          {provider.description && <span className="provider-detail__tagline">{provider.description}</span>}
        </div>
        <Switch
          label={`Enable ${provider.name}`}
          checked={provider.enabled}
          onChange={(on) => void window.api.providers.update(provider.id, { enabled: on }).then(() => refreshProviders())}
        />
      </div>

      <AttentionBanner provider={provider} />
      {(provider.auth === 'oauth' || meta.accountSignIn) && <AccountSection provider={provider} meta={meta} auth={auth} />}
      {meta.fields && meta.baseUrlTemplate && <UrlFieldsSection provider={provider} meta={meta} />}
      {meta.baseUrlLabel && <EndpointSection provider={provider} meta={meta} />}
      {provider.local && <LocalUrlSection provider={provider} />}
      {!provider.builtIn && <CustomConnectionSection provider={provider} />}
      {provider.auth !== 'oauth' && !provider.local && (
        <KeySection provider={provider} meta={meta} auth={auth} onStatus={setStatus} status={status} />
      )}

      <ModelsSection provider={provider} />
    </>
  )
}

/**
 * What the last check found wrong, at the top of the provider: an expired
 * sign-in, a rejected key, no credit, no models. Stored credentials alone
 * don't make a provider look connected after a check failed.
 */
function AttentionBanner({ provider }: { provider: Provider }): JSX.Element | null {
  const refreshProviders = useApp((s) => s.refreshProviders)
  const readiness = providerReadiness(provider)
  if (readiness.state !== 'attention') return null
  const checked = provider.health && !provider.health.ok ? provider.health.checkedAt : null
  const reconnect = readiness.action === 'reconnect' && (provider.auth === 'oauth' || Boolean(provider.oauthFlow))
  return (
    <div className="provider-attention" role="status">
      <TriangleAlert size={15} strokeWidth={1.9} />
      <div className="provider-attention__body">
        <span className="provider-attention__title">Needs attention</span>
        <span>
          {readiness.reason}
          {checked ? ` Checked ${ago(checked)}.` : ''}
        </span>
      </div>
      {reconnect && (
        <button className="btn btn--provider" onClick={() => void window.api.providerAuth.signIn(provider.id).finally(() => void refreshProviders())}>
          Sign in again
        </button>
      )}
      {!reconnect && provider.hasKey && (
        <button
          className="btn btn--provider-ghost"
          onClick={() => void window.api.providers.test(provider.id).finally(() => void refreshProviders())}
          title="Check the key again"
        >
          Check again
        </button>
      )}
    </div>
  )
}

/** Sign in with ChatGPT / GitHub, the device code while it runs, and the signed-in account. */
function AccountSection({
  provider,
  meta,
  auth
}: {
  provider: Provider
  meta: ProviderMeta
  auth: ProviderAuthStatus | undefined
}): JSX.Element {
  const pending = auth?.state === 'pending'
  const signedIn = (provider.auth === 'oauth' ? provider.signedIn : undefined) ?? auth?.signedIn ?? false
  const label = meta.signInLabel ?? `Sign in to ${provider.name}`

  return (
    <div className="provider-detail__section">
      <div className="provider-detail__section-title">Account</div>
      {signedIn && !pending ? (
        <div className="provider-account">
          <span className="provider-account__dot" aria-hidden="true" />
          <span className="provider-account__text">
            <span className="provider-account__label">Signed in</span>
            {auth?.account && <span className="provider-account__sub">{auth.account}</span>}
          </span>
          <button className="btn btn--provider-ghost" onClick={() => void window.api.providerAuth.signOut(provider.id)}>
            Sign out
          </button>
        </div>
      ) : (
        <>
          <p className="provider-detail__section-desc">
            {provider.id === 'github-copilot'
              ? 'Use the models in your GitHub Copilot plan. You’ll confirm a short code on github.com.'
              : provider.id === 'chatgpt'
                ? 'Use your ChatGPT plan with OpenAI’s official Sign in with ChatGPT. Usage counts against your plan’s limits, not an API bill.'
                : provider.id === 'openai-codex'
                  ? 'Use your ChatGPT Plus or Pro plan through the Codex CLI’s sign-in. The ChatGPT provider above is the official way.'
                  : provider.id === 'huggingface'
                    ? 'Sign in with your Hugging Face account and inference is billed to it — or use an access token below.'
                    : `Sign in to use ${provider.name} through your existing plan.`}
          </p>
          {pending ? (
            <SignInProgress provider={provider} auth={auth} />
          ) : auth?.needsClientId && auth.clientSetup ? (
            <ClientSetup provider={provider} auth={auth} />
          ) : (
            <div className="provider-actions" style={{ marginTop: 0 }}>
              <button className="btn btn--provider" onClick={() => void window.api.providerAuth.signIn(provider.id)}>
                {label}
              </button>
              {auth?.clientId && <ClientIdNote provider={provider} clientId={auth.clientId} />}
            </div>
          )}
        </>
      )}
      {auth?.state === 'error' && auth.error && (
        <div className="provider-status" data-tone="error">
          <TriangleAlert size={14} strokeWidth={1.9} />
          {auth.error}
        </div>
      )}
    </div>
  )
}

/**
 * Registering an OAuth app with a provider that only signs in registered apps
 * (Hugging Face, Poe): where to create it, what to register, and a field for
 * the client id it shows. Public PKCE clients have no secret to paste.
 */
function ClientSetup({ provider, auth }: { provider: Provider; auth: ProviderAuthStatus }): JSX.Element {
  const setup = auth.clientSetup!
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const save = async (): Promise<void> => {
    setError(null)
    try {
      await window.api.providerAuth.setClientId(provider.id, value.trim())
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
    }
  }
  const host = setup.registerUrl.replace(/^https?:\/\//, '').split('/')[0]
  return (
    <div className="provider-client-setup">
      <p className="provider-detail__section-desc" style={{ margin: 0 }}>
        {provider.name} signs in apps that are registered with it. Register Eaon once — it takes a minute:
      </p>
      <ol className="provider-client-setup__steps">
        <li>
          Create an app at{' '}
          <button className="provider-link" onClick={() => void window.api.app.openExternal(setup.registerUrl)}>
            {host}
            <ExternalLink size={11} strokeWidth={2} />
          </button>
          {setup.note ? ` — ${setup.note}` : ''}
        </li>
        <li>
          Add the redirect URL {setup.redirectUris.map((uri) => <code key={uri}>{uri}</code>)}
          {setup.scopes ? (
            <>
              {' '}and the scopes <code>{setup.scopes}</code>
            </>
          ) : null}
          .
        </li>
        <li>Paste the Client ID it gives you:</li>
      </ol>
      <div className="fallback-row">
        <input
          className="input"
          value={value}
          placeholder="Client ID"
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && value.trim() && void save()}
        />
        <button className="btn btn--provider" disabled={!value.trim()} onClick={() => void save()}>
          Save
        </button>
      </div>
      {error && (
        <div className="provider-status" data-tone="error">
          <TriangleAlert size={14} strokeWidth={1.9} />
          {error}
        </div>
      )}
    </div>
  )
}

/** Which registered app a sign-in uses, with a way to change it. */
function ClientIdNote({ provider, clientId }: { provider: Provider; clientId: string }): JSX.Element {
  return (
    <span className="provider-detail__hint provider-client-note">
      App {clientId.length > 14 ? `${clientId.slice(0, 6)}…${clientId.slice(-4)}` : clientId}
      <button className="provider-link" onClick={() => void window.api.providerAuth.setClientId(provider.id, null)}>
        Change
      </button>
    </span>
  )
}

/** What the user has to do right now: type a device code, or finish in the browser. */
function SignInProgress({ provider, auth }: { provider: Provider; auth: ProviderAuthStatus | undefined }): JSX.Element {
  const prompt = auth?.prompt
  const [copied, setCopied] = useState(false)
  const [manual, setManual] = useState(false)
  const [pasted, setPasted] = useState('')

  const copyAndOpen = async (): Promise<void> => {
    if (!prompt) return
    if (prompt.code) {
      await navigator.clipboard.writeText(prompt.code)
      setCopied(true)
    }
    await window.api.providerAuth.open(prompt.url)
  }

  return (
    <div className="provider-signin">
      {prompt?.code && (
        <>
          <span className="provider-detail__section-desc" style={{ margin: 0 }}>
            {prompt.message ?? 'Enter this code on the sign-in page.'}
          </span>
          <div className="provider-signin__code">
            <span className="provider-signin__code-value">{prompt.code}</span>
            <button className="icon-btn" aria-label="Copy code" onClick={() => void navigator.clipboard.writeText(prompt.code!).then(() => setCopied(true))}>
              <Copy size={15} strokeWidth={1.9} />
            </button>
          </div>
        </>
      )}
      <div className="provider-signin__waiting">
        <Loader2 size={14} strokeWidth={2} className="spinner" />
        {prompt?.code
          ? copied
            ? 'Code copied. Paste it on the page that opened, then approve.'
            : 'Waiting for you to enter the code…'
          : prompt
            ? (prompt.message ?? 'Finish signing in in your browser.')
            : 'Starting sign-in…'}
      </div>
      <div className="provider-actions" style={{ marginTop: 0 }}>
        {prompt && (
          <button className="btn btn--provider" onClick={() => void copyAndOpen()}>
            {prompt.code ? 'Copy code and open GitHub' : 'Open the sign-in page again'}
            <ExternalLink size={13} strokeWidth={2} />
          </button>
        )}
        <button className="btn btn--provider-ghost" onClick={() => void window.api.providerAuth.cancel(provider.id)}>
          Cancel
        </button>
      </div>
      {prompt && !prompt.code && (
        <>
          <button className="provider-signin__toggle" onClick={() => setManual((v) => !v)}>
            {manual ? 'Hide' : 'Browser can’t reach Eaon? Paste the redirect URL instead'}
          </button>
          {manual && (
            <div className="provider-signin__manual">
              <input
                className="input"
                value={pasted}
                placeholder="http://localhost:1455/auth/callback?code=…"
                spellCheck={false}
                onChange={(e) => setPasted(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && pasted.trim() && void window.api.providerAuth.submitCode(provider.id, pasted.trim())}
              />
              <button
                className="btn"
                disabled={!pasted.trim()}
                onClick={() => void window.api.providerAuth.submitCode(provider.id, pasted.trim())}
              >
                Continue
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** One field per `{placeholder}` in a templated URL — Cloudflare's account and gateway ids, a region. */
function UrlFieldsSection({ provider, meta }: { provider: Provider; meta: ProviderMeta }): JSX.Element {
  const refreshProviders = useApp((s) => s.refreshProviders)
  const template = meta.baseUrlTemplate!
  const [values, setValues] = useState<Record<string, string>>(() => {
    const read = readTemplate(template, provider.baseUrl)
    for (const field of meta.fields ?? []) if (!read[field.key] && field.defaultValue) read[field.key] = field.defaultValue
    return read
  })
  const url = fillTemplate(template, values)

  const save = async (): Promise<void> => {
    if (url === provider.baseUrl) return
    await window.api.providers.update(provider.id, { baseUrl: url })
    await refreshProviders()
  }

  return (
    <div className="provider-detail__section">
      <div className="provider-detail__section-title">Connection</div>
      <p className="provider-detail__section-desc">These go into the endpoint address; they’re not secret.</p>
      <div className="provider-fields">
        {(meta.fields ?? []).map((field) => (
          <div key={field.key}>
            <div className="field-label">{field.label}</div>
            <input
              className="input"
              value={values[field.key] ?? ''}
              placeholder={field.placeholder}
              spellCheck={false}
              onChange={(e) => setValues((current) => ({ ...current, [field.key]: e.target.value }))}
              onBlur={() => void save()}
              onKeyDown={(e) => e.key === 'Enter' && void save()}
            />
          </div>
        ))}
      </div>
      <div className="provider-url-preview">{url}</div>
    </div>
  )
}

/** Providers whose endpoint is the user's own resource (Azure). */
function EndpointSection({ provider, meta }: { provider: Provider; meta: ProviderMeta }): JSX.Element {
  const refreshProviders = useApp((s) => s.refreshProviders)
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl)
  const save = async (): Promise<void> => {
    if (baseUrl.trim() === provider.baseUrl) return
    const next = await window.api.providers.update(provider.id, { baseUrl: baseUrl.trim() })
    // The main process normalises resource URLs to …/openai/v1; show what it kept.
    setBaseUrl(next.find((p) => p.id === provider.id)?.baseUrl ?? baseUrl)
    await refreshProviders()
  }
  return (
    <div className="provider-detail__section">
      <div className="provider-detail__section-title">{meta.baseUrlLabel}</div>
      <p className="provider-detail__section-desc">
        Paste your resource’s endpoint in any form — it’s normalised to the <code>/openai/v1</code> API. Use each deployment’s name as its model id.
      </p>
      <input
        className="input"
        value={baseUrl}
        placeholder={meta.baseUrlPlaceholder}
        spellCheck={false}
        onChange={(e) => setBaseUrl(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => e.key === 'Enter' && void save()}
      />
    </div>
  )
}

function LocalUrlSection({ provider }: { provider: Provider }): JSX.Element {
  const refreshProviders = useApp((s) => s.refreshProviders)
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl)
  const save = async (): Promise<void> => {
    if (baseUrl === provider.baseUrl) return
    await window.api.providers.update(provider.id, { baseUrl })
    await refreshProviders()
  }
  return (
    <div className="provider-detail__section">
      <div className="provider-detail__section-title">Base URL</div>
      <div className="provider-detail__section-desc">Point this at your local {provider.name} server.</div>
      <input
        className="input"
        value={baseUrl}
        spellCheck={false}
        onChange={(e) => setBaseUrl(e.target.value)}
        onBlur={() => void save()}
        placeholder="http://127.0.0.1:8080/v1"
      />
    </div>
  )
}

function KeySection({
  provider,
  meta,
  auth,
  status,
  onStatus
}: {
  provider: Provider
  meta: ProviderMeta
  auth: ProviderAuthStatus | undefined
  status: { ok: boolean; message: string } | null
  onStatus: (status: { ok: boolean; message: string } | null) => void
}): JSX.Element {
  // Narrow: a whole-store subscription re-renders this (and every model row) per streamed token.
  const { refreshProviders, selectModel, settings } = useApp(
    useShallow((s) => ({ refreshProviders: s.refreshProviders, selectModel: s.selectModel, settings: s.settings }))
  )
  const [key, setKey] = useState('')
  const [reveal, setReveal] = useState(false)
  const [revealedSaved, setRevealedSaved] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl)
  const [fallbacks, setFallbacksList] = useState<string[]>([])
  const [newFallback, setNewFallback] = useState('')
  const [busy, setBusy] = useState(false)
  const minting = auth?.state === 'pending'

  useEffect(() => {
    void window.api.keys.getFallbacks(provider.id).then(setFallbacksList)
  }, [provider.id])

  const saveKey = async (): Promise<void> => {
    if (!key.trim()) return
    // A key with a line break in it, half a key or another provider's key
    // would only come back as a 401; say so before saving it.
    const shape = checkKeyShape(provider.id, provider.name, key)
    if (shape.problem) {
      onStatus({ ok: false, message: shape.problem })
      return
    }
    setBusy(true)
    onStatus(null)
    try {
      await window.api.keys.set(provider.id, shape.key)
      setKey('')
      setRevealedSaved(null)
      setReveal(false)
      const result = await window.api.providers.test(provider.id)
      onStatus(result)
      await refreshProviders()
      const models = useApp.getState().availableModels()
      if (result.ok && !settings?.selectedModelId && models[0]) selectModel(models[0].id, models[0].providerId)
    } finally {
      setBusy(false)
    }
  }

  const toggleReveal = async (): Promise<void> => {
    if (!reveal && provider.hasKey && !key) setRevealedSaved(await window.api.keys.reveal(provider.id))
    setReveal((v) => !v)
  }

  const copyKey = async (): Promise<void> => {
    const value = key || revealedSaved || (provider.hasKey ? await window.api.keys.reveal(provider.id) : '')
    if (value) await navigator.clipboard.writeText(value)
  }

  const saveBaseUrl = async (): Promise<void> => {
    if (baseUrl === provider.baseUrl) return
    await window.api.providers.update(provider.id, { baseUrl })
    await refreshProviders()
  }

  // The fallback keys themselves stay in main; this page holds a masked hint per key.
  const addFallback = async (): Promise<void> => {
    if (!newFallback.trim()) return
    const shape = checkKeyShape(provider.id, provider.name, newFallback)
    if (shape.problem) {
      onStatus({ ok: false, message: shape.problem })
      return
    }
    setNewFallback('')
    await window.api.keys.addFallback(provider.id, shape.key)
    setFallbacksList(await window.api.keys.getFallbacks(provider.id))
    await refreshProviders()
  }

  const removeFallback = async (index: number): Promise<void> => {
    await window.api.keys.removeFallback(provider.id, index)
    setFallbacksList(await window.api.keys.getFallbacks(provider.id))
    await refreshProviders()
  }

  // OpenRouter can mint a key instead; offered only while there is no key, so it never replaces one.
  const mintKey = async (): Promise<void> => {
    onStatus(null)
    const result = await window.api.providerAuth.signIn(provider.id)
    if (result.state === 'error') onStatus({ ok: false, message: result.error ?? 'Sign-in failed.' })
    else if (result.signedIn) onStatus(await window.api.providers.test(provider.id))
    await refreshProviders()
  }

  const keyFieldValue = key || revealedSaved || (provider.hasKey ? '•'.repeat(32) : '')
  const keyFieldReadOnly = !key && Boolean(revealedSaved || (provider.hasKey && !reveal))

  return (
    <div className="provider-detail__section">
      <div className="provider-detail__title-row">
        <div className="provider-detail__section-title">API keys</div>
        {provider.keyUrl && (
          <button className="provider-link" onClick={() => void window.api.app.openExternal(provider.keyUrl!)}>
            Get a key
            <ExternalLink size={12} strokeWidth={2} />
          </button>
        )}
      </div>
      <p className="provider-detail__section-desc">
        Enter your API key. You can add extra keys in Advanced, and Eaon will try the next one automatically if a key fails.
      </p>
      {meta.noSignInReason && (
        <div className="provider-no-signin">
          <Info size={13} strokeWidth={2} />
          <span>
            {meta.noSignInReason}
            {meta.planInAde && (
              <button className="provider-link provider-no-signin__action" onClick={() => void openInAde(meta.planInAde!)}>
                Open {PLAN_CLI[meta.planInAde]} in the ADE
              </button>
            )}
          </span>
        </div>
      )}
      {meta.planCredits && (
        <div className="provider-credits">
          <div className="provider-credits__title">{meta.planCredits.title}</div>
          <p className="provider-credits__detail">{meta.planCredits.detail}</p>
          <ol className="provider-credits__steps">
            {meta.planCredits.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <div className="provider-credits__links">
            {meta.planCredits.links.map((link) => (
              <button key={link.url} className="provider-link" onClick={() => void window.api.app.openExternal(link.url)}>
                {link.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="key-field">
        <input
          type={reveal ? 'text' : 'password'}
          value={keyFieldValue}
          readOnly={keyFieldReadOnly}
          placeholder="sk-…"
          spellCheck={false}
          onChange={(e) => {
            setKey(e.target.value)
            setRevealedSaved(null)
          }}
          onKeyDown={(e) => e.key === 'Enter' && void saveKey()}
        />
        <div className="key-field__actions">
          <button className="icon-btn" onClick={() => void toggleReveal()} aria-label="Reveal key">
            {reveal ? <EyeOff size={15} strokeWidth={1.9} /> : <Eye size={15} strokeWidth={1.9} />}
          </button>
          <button className="icon-btn" onClick={() => void copyKey()} aria-label="Copy key">
            <Copy size={15} strokeWidth={1.9} />
          </button>
        </div>
      </div>

      <div className="provider-detail__advanced-row">
        <button className="pill-btn" onClick={() => setShowAdvanced((v) => !v)}>
          Advanced
        </button>
        <span className="provider-detail__hint">
          {fallbacks.length > 0
            ? `${fallbacks.length} fallback key${fallbacks.length === 1 ? '' : 's'} configured`
            : 'Optional fallback keys are configured in Advanced.'}
        </span>
      </div>

      {showAdvanced && (
        <div className="provider-detail__advanced">
          {/* Providers with their own endpoint section (and custom ones, under Connection) already show this field up top. */}
          {!meta.baseUrlLabel && provider.builtIn && (
            <div>
              <div className="field-label">Base URL</div>
              <input className="input" value={baseUrl} spellCheck={false} onChange={(e) => setBaseUrl(e.target.value)} onBlur={() => void saveBaseUrl()} />
            </div>
          )}
          <div>
            <div className="field-label">Fallback keys — tried in order if the key above fails</div>
            {fallbacks.map((hint, index) => (
              <div className="fallback-row" key={index} style={{ marginBottom: 8 }}>
                <input className="input" style={{ fontFamily: 'var(--font-mono)' }} value={hint} readOnly aria-label={`Fallback key ${index + 1}`} />
                <button className="icon-btn" aria-label="Remove fallback key" onClick={() => void removeFallback(index)}>
                  <Trash2 size={15} strokeWidth={1.9} />
                </button>
              </div>
            ))}
            <div className="fallback-row">
              <input
                className="input"
                type="password"
                value={newFallback}
                placeholder="Paste another API key"
                spellCheck={false}
                onChange={(e) => setNewFallback(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void addFallback()}
              />
              <button className="btn" disabled={!newFallback.trim()} onClick={() => void addFallback()}>
                <Plus size={14} strokeWidth={2} />
                Add
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="provider-actions">
        <button className="btn btn--provider" disabled={busy || !key.trim()} onClick={() => void saveKey()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        {meta.keyFlow && !meta.accountSignIn && !provider.hasKey && !auth?.needsClientId && (
          <button className="btn" disabled={minting} onClick={() => void mintKey()}>
            {minting ? <Loader2 size={13} strokeWidth={2} className="spinner" /> : null}
            {minting ? 'Waiting for your browser…' : (meta.signInLabel ?? 'Sign in')}
          </button>
        )}
        {minting && (
          <button className="btn btn--provider-ghost" onClick={() => void window.api.providerAuth.cancel(provider.id)}>
            Cancel
          </button>
        )}
        {provider.hasKey && (
          <button className="btn btn--provider-ghost" onClick={() => void window.api.keys.clear(provider.id).then(() => refreshProviders())}>
            Remove key
          </button>
        )}
      </div>

      {meta.keyFlow && !meta.accountSignIn && !provider.hasKey && auth?.needsClientId && auth.clientSetup && (
        <div className="provider-client-setup--inline">
          <div className="field-label">{meta.signInLabel ?? 'Sign in'} instead</div>
          <ClientSetup provider={provider} auth={auth} />
        </div>
      )}

      {status && (
        <div className="provider-status" data-tone={status.ok ? undefined : 'error'}>
          {!status.ok && <TriangleAlert size={14} strokeWidth={1.9} />}
          {status.message}
        </div>
      )}
    </div>
  )
}

/**
 * The provider's models. The list itself is built in the main process
 * (catalog, then the provider's own listing, then models added here); this
 * section edits the user's layer on top of it. Removing hides a model rather
 * than deleting it, so "Hidden" can always bring it back, and Refresh checks
 * models.dev even before a key is added.
 */
function ModelsSection({ provider }: { provider: Provider }): JSX.Element {
  // Narrow: a whole-store subscription re-renders this (and every model row) per streamed token.
  const { refreshProviders, toggleFavorite, favorites } = useApp(
    useShallow((s) => ({ refreshProviders: s.refreshProviders, toggleFavorite: s.toggleFavorite, favorites: s.settings?.favoriteModels }))
  )
  const [addingModel, setAddingModel] = useState(false)
  const [newModelId, setNewModelId] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<ModelsRefresh | null>(null)
  const ready = provider.local || provider.hasKey
  const hidden = provider.hiddenModels ?? []
  const starred = new Set(favorites ?? [])

  const edit = async (change: ModelEdit): Promise<boolean> => {
    try {
      await window.api.providers.editModels(provider.id, change)
      return true
    } catch (error) {
      setStatus({ ok: false, added: [], message: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error) })
      return false
    } finally {
      await refreshProviders()
    }
  }

  const refresh = async (): Promise<void> => {
    setBusy(true)
    setStatus(null)
    try {
      setStatus(await window.api.providers.refresh(provider.id))
    } catch (error) {
      setStatus({ ok: false, added: [], message: error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error) })
    } finally {
      await refreshProviders()
      setBusy(false)
    }
  }

  const addModel = async (): Promise<void> => {
    const id = newModelId.trim()
    if (!id) return
    await edit({ add: id })
    setNewModelId('')
    setAddingModel(false)
    // A model added by id starts with nothing known about it: say what it can do.
    setEditing(id)
  }

  const needle = query.trim().toLowerCase()
  const shown = needle ? provider.models.filter((m) => `${m.label} ${m.id}`.toLowerCase().includes(needle)) : provider.models
  // Where the list shown came from and how old it is.
  const listed = provider.models.find((m) => m.source?.kind === 'provider-live' || m.source?.kind === 'cache')
  const freshness = listed?.source
    ? listed.source.kind === 'cache'
      ? `Showing ${provider.name}’s list from ${listed.source.retrievedAt ? ago(listed.source.retrievedAt) : 'before'}; the last refresh didn’t work.`
      : describeSource(listed.source, provider.name)
    : provider.models.length > 0 && !provider.local
      ? (describeSource(provider.models[0].source, provider.name) ?? null)
      : null

  return (
    <div className="provider-detail__section">
      <div className="provider-detail__section-head">
        <div className="provider-detail__section-title" style={{ marginBottom: 0 }}>
          Models
        </div>
        <div className="provider-detail__section-actions">
          <button className="icon-btn" aria-label="Refresh models" title="Check for new models" disabled={busy} onClick={() => void refresh()}>
            <RefreshCw size={15} strokeWidth={1.9} className={busy ? 'spinner' : undefined} />
          </button>
          <button className="icon-btn" aria-label="Add model" title="Add a model by id" onClick={() => setAddingModel((v) => !v)}>
            <Plus size={16} strokeWidth={2.1} />
          </button>
        </div>
      </div>

      {addingModel && (
        <div className="add-model-row">
          <input
            autoFocus
            className="input"
            value={newModelId}
            placeholder="Model id, e.g. llama-3.1-8b"
            spellCheck={false}
            onChange={(e) => setNewModelId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addModel()
              if (e.key === 'Escape') setAddingModel(false)
            }}
          />
          <button className="btn btn--provider" disabled={!newModelId.trim()} onClick={() => void addModel()}>
            Add
          </button>
        </div>
      )}

      {(busy || status) && (
        <div className="provider-status" data-tone={status && !status.ok ? 'error' : undefined} role="status" style={{ marginTop: 0, marginBottom: 8 }}>
          {status && !status.ok && <TriangleAlert size={14} strokeWidth={1.9} />}
          {busy ? `Checking ${provider.name} for new models…` : status?.message}
        </div>
      )}
      {!busy && !status && freshness && <div className="provider-models__freshness">{freshness}</div>}

      {provider.models.length > 12 && (
        <div className="provider-models__search">
          <SearchField value={query} onChange={setQuery} placeholder={`Search ${provider.models.length} models`} variant="sm" />
        </div>
      )}

      {provider.models.length === 0 ? (
        <div className="empty-models">
          {ready
            ? 'No models yet — refresh or add one.'
            : provider.auth === 'oauth'
              ? 'Sign in, then refresh to load your models.'
              : 'Add an API key, then refresh to load models.'}
        </div>
      ) : shown.length === 0 ? (
        <div className="empty-models">No models match “{query.trim()}”.</div>
      ) : (
        shown.map((model) => {
          const key = `${model.providerId}:${model.id}`
          const on = starred.has(key)
          const caps = modelCapabilities(model)
          const stage = modelStage(model)
          return (
            <div className="model-row" key={model.id} data-editing={editing === model.id || undefined}>
              {editing === model.id ? (
                <ModelEditor
                  model={model}
                  onCancel={() => setEditing(null)}
                  onSave={async (change) => {
                    if (await edit(change)) setEditing(null)
                  }}
                  onReset={async () => {
                    if (await edit({ reset: model.id })) setEditing(null)
                  }}
                />
              ) : (
                <>
                  <span className="model-row__name" title={[model.id, describeSource(model.source, provider.name)].filter(Boolean).join(' · ')}>
                    {model.label}
                  </span>
                  <span className="model-row__badges">
                    {/* Only what a source says: an unknown capability gets no badge. */}
                    {caps.tools === true && <Wrench size={13} strokeWidth={1.8} aria-label="Tools" />}
                    {caps.vision === true && <Eye size={14} strokeWidth={1.8} aria-label="Images" />}
                    {caps.reasoning === true && <Brain size={13} strokeWidth={1.8} aria-label="Thinking" />}
                    {stage && <span className="model-row__tag">{STAGE_LABEL[stage]}</span>}
                    {model.outsidePlan && <span className="model-row__tag" title="Your plan’s own model list doesn’t include it">{OUTSIDE_PLAN_NOTE}</span>}
                    {model.custom && <span className="model-row__tag">Added</span>}
                    {model.edited && !model.custom && <span className="model-row__tag">Edited</span>}
                  </span>
                  <span className="model-row__spacer" />
                  {model.contextWindow && <span className="model-row__meta">{formatTokens(model.contextWindow)}</span>}
                  <span className="model-row__actions">
                    <button className="icon-btn" aria-label={`Edit ${model.label}`} title="Edit name, limits and capabilities" onClick={() => setEditing(model.id)}>
                      <Pencil size={14} strokeWidth={1.8} />
                    </button>
                    <button
                      className="icon-btn"
                      aria-label={`Remove ${model.label}`}
                      title={model.custom ? 'Delete' : 'Remove (you can restore it below)'}
                      onClick={() => void edit({ remove: model.id })}
                    >
                      <Trash2 size={14} strokeWidth={1.8} />
                    </button>
                  </span>
                  <button
                    className="icon-btn model-row__star"
                    data-on={on || undefined}
                    aria-pressed={on}
                    aria-label={on ? `Unstar ${model.label}` : `Star ${model.label}`}
                    title={on ? 'Unstar' : 'Star — starred models come first in the model menu'}
                    onClick={() => toggleFavorite(model.id, model.providerId)}
                  >
                    <Star size={14} strokeWidth={1.8} fill={on ? 'currentColor' : 'none'} />
                  </button>
                </>
              )}
            </div>
          )
        })
      )}

      {hidden.length > 0 && (
        <div className="provider-models__hidden">
          <button className="provider-signin__toggle" aria-expanded={showHidden} onClick={() => setShowHidden((v) => !v)}>
            {showHidden ? 'Hide removed models' : `${hidden.length} removed model${hidden.length === 1 ? '' : 's'} — show`}
          </button>
          {showHidden && (
            <>
              {hidden.map((model) => (
                <div className="model-row model-row--hidden" key={model.id}>
                  <span className="model-row__name" title={model.id}>
                    {model.label}
                  </span>
                  <span className="model-row__spacer" />
                  <button className="btn btn--sm" onClick={() => void edit({ restore: model.id })}>
                    <RotateCcw size={13} strokeWidth={1.9} />
                    Restore
                  </button>
                </div>
              ))}
              {hidden.length > 1 && (
                <button className="btn btn--sm provider-models__restore-all" onClick={() => void edit({ restoreAll: true })}>
                  Restore all
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** "128k", "1M", "200,000" as tokens; empty is null (the catalog's value); anything else undefined. */
function parseTokens(text: string): number | null | undefined {
  const value = text.trim().toLowerCase().replace(/[,_\s]/g, '')
  if (!value) return null
  const match = /^(\d+(?:\.\d+)?)([km])?$/.exec(value)
  if (!match) return undefined
  const tokens = Math.round(parseFloat(match[1]) * (match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1000 : 1))
  return tokens > 0 ? tokens : undefined
}

const thinks = (model: ModelInfo): boolean => Boolean(model.reasoning || (model.efforts?.length ?? 0) > 0)

/**
 * Edit model, in place of its row: the name, and for a model added by hand
 * its id; its context window and output limit; and what it can do. Only what
 * changed is saved, so the catalog's later corrections still come through
 * for the rest. Enter saves, Escape cancels.
 */
function ModelEditor({
  model,
  onSave,
  onReset,
  onCancel
}: {
  model: ModelInfo
  onSave: (change: ModelEdit) => void | Promise<void>
  onReset: () => void | Promise<void>
  onCancel: () => void
}): JSX.Element {
  const [label, setLabel] = useState(model.label)
  const [modelId, setModelId] = useState(model.id)
  const [context, setContext] = useState(model.contextWindow ? String(model.contextWindow) : '')
  const [output, setOutput] = useState(model.maxOutput ? String(model.maxOutput) : '')
  // The switches show what Eaon does with the model now; where no source
  // confirmed it (`caps` is null) the switch says so, and setting it makes it known.
  const caps = modelCapabilities(model)
  const [tools, setTools] = useState(model.tools !== false)
  const [vision, setVision] = useState(Boolean(model.vision))
  const [thinking, setThinking] = useState(thinks(model))
  const [error, setError] = useState<string | null>(null)

  const save = (): void => {
    const contextWindow = parseTokens(context)
    const maxOutput = parseTokens(output)
    if (contextWindow === undefined || maxOutput === undefined) {
      setError('Write sizes in tokens, like 128000, 128k or 1M.')
      return
    }
    const fields: ModelEditFields = {}
    if (contextWindow !== (model.contextWindow ?? null)) fields.contextWindow = contextWindow
    if (maxOutput !== (model.maxOutput ?? null)) fields.maxOutput = maxOutput
    if (tools !== (model.tools !== false)) fields.tools = tools
    if (vision !== Boolean(model.vision)) fields.vision = vision
    if (thinking !== thinks(model)) fields.reasoning = thinking
    const name = label.trim()
    const id = modelId.trim()
    void onSave({
      update: model.id,
      ...(name !== model.label ? { label: name || null } : {}),
      ...(model.custom && id && id !== model.id ? { id } : {}),
      ...(Object.keys(fields).length > 0 ? { fields } : {})
    })
  }
  const keys = (event: React.KeyboardEvent): void => {
    if (event.key === 'Enter') save()
    if (event.key === 'Escape') onCancel()
  }

  return (
    <div className="model-editor" role="group" aria-label={`Edit ${model.label}`}>
      <div className="model-editor__grid">
        <label className="model-editor__field">
          <span className="field-label">Name</span>
          <input autoFocus className="input" value={label} spellCheck={false} onChange={(e) => setLabel(e.target.value)} onKeyDown={keys} />
        </label>
        <label className="model-editor__field">
          <span className="field-label">Model id{model.custom ? '' : ' (from the catalog)'}</span>
          <input
            className="input model-editor__mono"
            value={modelId}
            spellCheck={false}
            readOnly={!model.custom}
            onChange={(e) => setModelId(e.target.value)}
            onKeyDown={keys}
          />
        </label>
        <label className="model-editor__field">
          <span className="field-label">Context window</span>
          <input className="input" value={context} placeholder="e.g. 128k" spellCheck={false} onChange={(e) => setContext(e.target.value)} onKeyDown={keys} />
        </label>
        <label className="model-editor__field">
          <span className="field-label">Max output</span>
          <input className="input" value={output} placeholder="e.g. 32k" spellCheck={false} onChange={(e) => setOutput(e.target.value)} onKeyDown={keys} />
        </label>
      </div>
      <div className="model-editor__toggles">
        <div className="model-editor__toggle">
          <Switch label="Tools" checked={tools} onChange={setTools} />
          <span>
            <b>Tools</b> Files, commands, the browser and plugins{caps.tools === null && <i className="model-editor__unknown"> · not confirmed by its provider</i>}
          </span>
        </div>
        <div className="model-editor__toggle">
          <Switch label="Images" checked={vision} onChange={setVision} />
          <span>
            <b>Images</b> Reads screenshots and pictures{caps.vision === null && <i className="model-editor__unknown"> · unknown; images are sent and left out if refused</i>}
          </span>
        </div>
        <div className="model-editor__toggle">
          <Switch label="Thinking" checked={thinking} onChange={setThinking} />
          <span>
            <b>Thinking</b> Thinks before answering; shows the effort control
            {caps.reasoning === null && thinking && <i className="model-editor__unknown"> · guessed from its id</i>}
          </span>
        </div>
      </div>
      {error && (
        <div className="provider-status" data-tone="error" role="alert">
          <TriangleAlert size={14} strokeWidth={1.9} />
          {error}
        </div>
      )}
      <div className="model-editor__actions">
        {model.edited && (
          <button className="btn btn--sm" onClick={() => void onReset()} title="Back to the catalog’s name and details">
            <RotateCcw size={13} strokeWidth={1.9} />
            Reset to defaults
          </button>
        )}
        <span className="model-row__spacer" />
        <button className="btn btn--sm" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn--sm btn--provider" onClick={save}>
          Save
        </button>
      </div>
    </div>
  )
}

/**
 * A custom provider's connection, editable after it was added: its name, API
 * format and base URL, and Delete (a second click confirms, so a stray click
 * can't remove it).
 */
function CustomConnectionSection({ provider }: { provider: Provider }): JSX.Element {
  const refreshProviders = useApp((s) => s.refreshProviders)
  const [name, setName] = useState(provider.name)
  const [format, setFormat] = useState(provider.kind)
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl)
  const [confirming, setConfirming] = useState(false)
  const [saved, setSaved] = useState(false)
  const dirty = name.trim() !== provider.name || format !== provider.kind || baseUrl.trim() !== provider.baseUrl

  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), 4000)
    return () => clearTimeout(timer)
  }, [confirming])

  const save = async (): Promise<void> => {
    await window.api.providers.update(provider.id, { name: name.trim() || provider.name, kind: format, baseUrl: baseUrl.trim() })
    await refreshProviders()
    setSaved(true)
    setTimeout(() => setSaved(false), 1800)
  }
  const remove = async (): Promise<void> => {
    if (!confirming) {
      setConfirming(true)
      return
    }
    await window.api.providers.remove(provider.id)
    await refreshProviders()
  }

  return (
    <div className="provider-detail__section">
      <div className="provider-detail__section-title">Connection</div>
      <div className="field-label">Name</div>
      <input className="input" style={{ marginBottom: 14 }} value={name} spellCheck={false} onChange={(e) => setName(e.target.value)} />
      <div className="field-label">API format</div>
      <div className="radio-row" style={{ marginBottom: 14 }}>
        <RadioOption label="OpenAI chat" checked={format === 'openai-compatible'} onSelect={() => setFormat('openai-compatible')} />
        <RadioOption label="OpenAI Responses" checked={format === 'openai-responses'} onSelect={() => setFormat('openai-responses')} />
        <RadioOption label="Anthropic" checked={format === 'anthropic'} onSelect={() => setFormat('anthropic')} />
      </div>
      <div className="field-label">Base URL</div>
      <input
        className="input"
        style={{ marginBottom: 14 }}
        value={baseUrl}
        placeholder="https://your-endpoint/v1"
        spellCheck={false}
        onChange={(e) => setBaseUrl(e.target.value)}
      />
      <div className="provider-connection__actions">
        <button className="btn btn--provider" disabled={!dirty || !baseUrl.trim()} onClick={() => void save()}>
          {saved ? 'Saved' : 'Save'}
        </button>
        <span className="model-row__spacer" />
        <button className="btn btn--danger" onClick={() => void remove()}>
          <Trash2 size={14} strokeWidth={1.9} />
          {confirming ? 'Click again to delete' : 'Delete provider'}
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------- custom provider */

function AddCustomProviderModal({
  open,
  onClose,
  onCreated
}: {
  open: boolean
  onClose: () => void
  onCreated: (id: string) => void
}): JSX.Element {
  const refreshProviders = useApp((s) => s.refreshProviders)
  const providers = useApp((s) => s.providers)
  const [name, setName] = useState('')
  const [format, setFormat] = useState<'openai-compatible' | 'anthropic' | 'openai-responses'>('openai-compatible')
  const [baseUrl, setBaseUrl] = useState('')
  const [key, setKey] = useState('')

  const reset = (): void => {
    setName('')
    setFormat('openai-compatible')
    setBaseUrl('')
    setKey('')
  }

  const create = async (): Promise<void> => {
    // Never an id in use: that provider's settings and key would be overwritten.
    const id = customProviderId(name, providers.map((p) => p.id))
    if (!id) return
    await window.api.providers.update(id, { name: name.trim(), kind: format, baseUrl: baseUrl.trim(), enabled: true })
    if (key.trim()) await window.api.keys.set(id, key.trim())
    await refreshProviders()
    reset()
    onCreated(id)
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset()
        onClose()
      }}
      title="Add Custom Provider"
      width={480}
      actions={
        <>
          <button
            className="btn btn--provider-ghost"
            onClick={() => {
              reset()
              onClose()
            }}
          >
            Cancel
          </button>
          <button className="btn btn--provider" disabled={!name.trim() || !baseUrl.trim()} onClick={() => void create()}>
            Create
          </button>
        </>
      }
    >
      <input
        className="input"
        style={{ marginBottom: 20 }}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Provider name (e.g. my-llm-server)"
        spellCheck={false}
        autoFocus
      />

      <div className="field-label">API format</div>
      <div className="radio-row" style={{ marginBottom: 20 }}>
        <RadioOption label="OpenAI chat" checked={format === 'openai-compatible'} onSelect={() => setFormat('openai-compatible')} />
        <RadioOption label="OpenAI Responses" checked={format === 'openai-responses'} onSelect={() => setFormat('openai-responses')} />
        <RadioOption label="Anthropic" checked={format === 'anthropic'} onSelect={() => setFormat('anthropic')} />
      </div>

      <div className="field-label">Base URL</div>
      <input
        className="input"
        style={{ marginBottom: 20 }}
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
        placeholder="https://your-endpoint/v1"
        spellCheck={false}
      />

      <div className="field-label">API key</div>
      <input className="input" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste your API key" spellCheck={false} />
    </Modal>
  )
}

function RadioOption({ label, checked, onSelect }: { label: string; checked: boolean; onSelect: () => void }): JSX.Element {
  return (
    <button type="button" className="radio-option" onClick={onSelect}>
      <span className="radio-dot" data-on={checked || undefined}>
        <span className="radio-dot__fill" />
      </span>
      {label}
    </button>
  )
}
