import { useEffect, useMemo, useState } from 'react'
import {
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Star,
  Trash2,
  TriangleAlert,
  Wrench
} from 'lucide-react'
import { useApp } from '../../../state/store'
import { BrandIcon } from '../../../icons/brand'
import { Modal, SearchField, Switch } from '../../ui'
import type { ModelInfo, Provider } from '@shared/types'
import type { ProviderAuthStatus, ProviderMeta } from '@shared/providers'
import '../../../styles/providers.css'

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
  const meta = useProviderMeta()
  const auth = useAuthStatuses()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [addingCustom, setAddingCustom] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    void refreshProviders()
  }, [refreshProviders])

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matches = (p: Provider): boolean =>
      !needle || [p.name, p.id, p.description ?? ''].some((field) => field.toLowerCase().includes(needle))
    return GROUPS.map((group) => ({
      ...group,
      providers: providers.filter((p) => categoryOf(p) === group.id && matches(p))
    })).filter((group) => group.providers.length > 0)
  }, [providers, query])

  const selected = providers.find((p) => p.id === selectedId) ?? providers.find((p) => p.id === 'openai') ?? providers[0] ?? null

  return (
    <div className="providers-shell">
      <nav className="providers-list">
        <div className="providers-list__top">
          <div className="providers-list__header">
            <span className="providers-list__title">Model Providers</span>
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
              {group.providers.map((provider) => (
                <ProviderRow
                  key={provider.id}
                  provider={provider}
                  pending={auth[provider.id]?.state === 'pending'}
                  active={provider.id === selected?.id}
                  onClick={() => setSelectedId(provider.id)}
                />
              ))}
            </div>
          ))}
          {groups.length === 0 && <div className="providers-list__empty">No providers match “{query.trim()}”.</div>}
        </div>
      </nav>

      <div className="providers-detail scroll">
        {selected && (
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
  // A local runtime counts as set up once it has served a model list, not merely by existing.
  const ready = (provider.local ? provider.models.length > 0 : provider.hasKey) && provider.enabled
  return (
    <button className="provider-row" data-active={active || undefined} onClick={onClick}>
      <BrandIcon id={provider.id} name={provider.name} size={24} />
      <span className="provider-row__label">{provider.name}</span>
      {(ready || pending) && <span className="provider-row__badge" data-state={pending ? 'pending' : 'ready'} />}
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
  const [busy, setBusy] = useState(false)

  const refreshModelsList = async (): Promise<void> => {
    setBusy(true)
    setStatus(null)
    try {
      setStatus(await window.api.providers.test(provider.id))
      await refreshProviders()
    } finally {
      setBusy(false)
    }
  }

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

      {provider.auth === 'oauth' && <AccountSection provider={provider} meta={meta} auth={auth} />}
      {meta.fields && meta.baseUrlTemplate && <UrlFieldsSection provider={provider} meta={meta} />}
      {meta.baseUrlLabel && <EndpointSection provider={provider} meta={meta} />}
      {provider.local && <LocalUrlSection provider={provider} />}
      {provider.auth !== 'oauth' && !provider.local && (
        <KeySection provider={provider} meta={meta} auth={auth} onStatus={setStatus} status={status} />
      )}

      <ModelsSection provider={provider} busy={busy} onRefresh={() => void refreshModelsList()} status={provider.auth === 'oauth' ? status : null} />
    </>
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
  const signedIn = provider.signedIn ?? auth?.signedIn ?? false
  const label = meta.signInLabel ?? `Sign in to ${provider.name}`

  return (
    <div className="provider-detail__section">
      <div className="provider-detail__section-title">Account</div>
      {signedIn && !pending ? (
        <div className="provider-account">
          <span className="provider-account__dot" />
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
              : provider.id === 'openai-codex'
                ? 'Use your ChatGPT Plus or Pro plan. Usage counts against your plan’s limits, not an API bill.'
                : `Sign in to use ${provider.name} through your existing plan.`}
          </p>
          {pending ? (
            <SignInProgress provider={provider} auth={auth} />
          ) : (
            <div className="provider-actions" style={{ marginTop: 0 }}>
              <button className="btn btn--provider" onClick={() => void window.api.providerAuth.signIn(provider.id)}>
                {label}
              </button>
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
  const { refreshProviders, selectModel, settings } = useApp()
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
    setBusy(true)
    onStatus(null)
    try {
      await window.api.keys.set(provider.id, key.trim())
      setKey('')
      setRevealedSaved(null)
      setReveal(false)
      const result = await window.api.providers.test(provider.id)
      onStatus(result)
      await refreshProviders()
      const models = useApp.getState().availableModels()
      if (result.ok && !settings?.selectedModelId && models[0]) selectModel(models[0].id)
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

  const addFallback = async (): Promise<void> => {
    if (!newFallback.trim()) return
    const next = [...fallbacks, newFallback.trim()]
    setFallbacksList(next)
    setNewFallback('')
    await window.api.keys.setFallbacks(provider.id, next)
    await refreshProviders()
  }

  const removeFallback = async (index: number): Promise<void> => {
    const next = fallbacks.filter((_, i) => i !== index)
    setFallbacksList(next)
    await window.api.keys.setFallbacks(provider.id, next)
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
          {/* Providers with their own endpoint section already show this field up top. */}
          {!meta.baseUrlLabel && (
            <div>
              <div className="field-label">Base URL</div>
              <input className="input" value={baseUrl} spellCheck={false} onChange={(e) => setBaseUrl(e.target.value)} onBlur={() => void saveBaseUrl()} />
            </div>
          )}
          <div>
            <div className="field-label">Fallback keys — tried in order if the key above fails</div>
            {fallbacks.map((_, index) => (
              <div className="fallback-row" key={index} style={{ marginBottom: 8 }}>
                <input className="input" style={{ fontFamily: 'var(--font-mono)' }} value={'•'.repeat(24)} readOnly />
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
        {meta.keyFlow && !provider.hasKey && (
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

      {status && (
        <div className="provider-status" data-tone={status.ok ? undefined : 'error'}>
          {!status.ok && <TriangleAlert size={14} strokeWidth={1.9} />}
          {status.message}
        </div>
      )}
    </div>
  )
}

function ModelsSection({
  provider,
  busy,
  onRefresh,
  status
}: {
  provider: Provider
  busy: boolean
  onRefresh: () => void
  status: { ok: boolean; message: string } | null
}): JSX.Element {
  const { refreshProviders, selectModel, settings } = useApp()
  const [addingModel, setAddingModel] = useState(false)
  const [newModelId, setNewModelId] = useState('')
  const ready = provider.local || provider.hasKey

  const addModel = async (): Promise<void> => {
    if (!newModelId.trim()) return
    const model: ModelInfo = { id: newModelId.trim(), label: newModelId.trim(), providerId: provider.id }
    await window.api.providers.update(provider.id, { models: [...provider.models, model] })
    await refreshProviders()
    setNewModelId('')
    setAddingModel(false)
  }

  const removeModel = async (modelId: string): Promise<void> => {
    await window.api.providers.update(provider.id, { models: provider.models.filter((m) => m.id !== modelId) })
    await refreshProviders()
  }

  const renameModel = async (model: ModelInfo): Promise<void> => {
    const next = window.prompt('Model display name', model.label)
    if (!next || !next.trim()) return
    await window.api.providers.update(provider.id, {
      models: provider.models.map((m) => (m.id === model.id ? { ...m, label: next.trim() } : m))
    })
    await refreshProviders()
  }

  return (
    <div className="provider-detail__section">
      <div className="provider-detail__section-head">
        <div className="provider-detail__section-title" style={{ marginBottom: 0 }}>
          Models
        </div>
        <div className="provider-detail__section-actions">
          <button className="icon-btn" aria-label="Refresh models" disabled={!ready} onClick={onRefresh}>
            <RefreshCw size={15} strokeWidth={1.9} className={busy ? 'spinner' : undefined} />
          </button>
          <button className="icon-btn" aria-label="Add model" onClick={() => setAddingModel((v) => !v)}>
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
            onKeyDown={(e) => e.key === 'Enter' && void addModel()}
          />
          <button className="btn btn--provider" disabled={!newModelId.trim()} onClick={() => void addModel()}>
            Add
          </button>
        </div>
      )}

      {status && (
        <div className="provider-status" data-tone={status.ok ? undefined : 'error'} style={{ marginTop: 0, marginBottom: 8 }}>
          {!status.ok && <TriangleAlert size={14} strokeWidth={1.9} />}
          {status.message}
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
      ) : (
        provider.models.map((model) => (
          <div className="model-row" key={model.id}>
            <span className="model-row__name" title={model.id}>
              {model.label}
            </span>
            <span className="model-row__badges">
              {model.tools !== false && <Wrench size={13} strokeWidth={1.8} aria-label="Tools" />}
              {model.vision && <Eye size={14} strokeWidth={1.8} aria-label="Images" />}
            </span>
            <span className="model-row__spacer" />
            {model.contextWindow && <span className="model-row__meta">{formatTokens(model.contextWindow)}</span>}
            <span className="model-row__actions">
              <button className="icon-btn" aria-label="Rename model" onClick={() => void renameModel(model)}>
                <Pencil size={14} strokeWidth={1.8} />
              </button>
              <button
                className="icon-btn model-row__star"
                data-on={settings?.selectedModelId === model.id || undefined}
                aria-label="Set as default model"
                onClick={() => selectModel(model.id)}
              >
                <Star size={14} strokeWidth={1.8} fill={settings?.selectedModelId === model.id ? 'currentColor' : 'none'} />
              </button>
              <button className="icon-btn" aria-label="Remove model" onClick={() => void removeModel(model.id)}>
                <Trash2 size={14} strokeWidth={1.8} />
              </button>
            </span>
          </div>
        ))
      )}
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
    const id = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
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
