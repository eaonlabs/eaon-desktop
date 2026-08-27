import { useEffect, useState } from 'react'
import {
  Copy,
  Eye,
  EyeOff,
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
import { Modal, Switch } from '../../ui'
import type { ModelInfo, Provider } from '@shared/types'

export function ProvidersPage(): JSX.Element {
  const providers = useApp((s) => s.providers)
  const refreshProviders = useApp((s) => s.refreshProviders)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [addingCustom, setAddingCustom] = useState(false)

  useEffect(() => {
    void refreshProviders()
  }, [refreshProviders])

  const local = providers.filter((p) => p.local)
  const remote = providers.filter((p) => !p.local)
  const selected = providers.find((p) => p.id === selectedId) ?? providers.find((p) => p.id === 'openai') ?? providers[0] ?? null

  return (
    <div className="providers-shell">
      <nav className="providers-list scroll">
        <div className="providers-list__header">
          <span className="providers-list__title">Model Providers</span>
          <button className="icon-btn" onClick={() => setAddingCustom(true)} aria-label="Add custom provider">
            <Plus size={17} strokeWidth={2.1} />
          </button>
        </div>

        {local.length > 0 && (
          <>
            <div className="providers-list__group">Local</div>
            {local.map((provider) => (
              <ProviderRow
                key={provider.id}
                provider={provider}
                active={provider.id === selected?.id}
                onClick={() => setSelectedId(provider.id)}
              />
            ))}
          </>
        )}

        <div className="providers-list__group">Remote</div>
        {remote.map((provider) => (
          <ProviderRow
            key={provider.id}
            provider={provider}
            active={provider.id === selected?.id}
            onClick={() => setSelectedId(provider.id)}
          />
        ))}
      </nav>

      <div className="providers-detail scroll">{selected && <ProviderDetail key={selected.id} provider={selected} />}</div>

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
  active,
  onClick
}: {
  provider: Provider
  active: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button className="provider-row" data-active={active || undefined} onClick={onClick}>
      <BrandIcon id={provider.id} size={26} />
      <span className="provider-row__label">{provider.name}</span>
      {(provider.hasKey || provider.local) && provider.enabled && <span className="provider-row__badge" />}
    </button>
  )
}

function ProviderDetail({ provider }: { provider: Provider }): JSX.Element {
  const { refreshProviders, selectModel, settings } = useApp()
  const [key, setKey] = useState('')
  const [reveal, setReveal] = useState(false)
  const [revealedSaved, setRevealedSaved] = useState<string | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl)
  const [fallbacks, setFallbacksList] = useState<string[]>([])
  const [newFallback, setNewFallback] = useState('')
  const [addingModel, setAddingModel] = useState(false)
  const [newModelId, setNewModelId] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null)

  useEffect(() => {
    void window.api.keys.getFallbacks(provider.id).then(setFallbacksList)
  }, [provider.id])

  const saveKey = async (): Promise<void> => {
    if (!key.trim()) return
    setBusy(true)
    setStatus(null)
    try {
      await window.api.keys.set(provider.id, key.trim())
      setKey('')
      setRevealedSaved(null)
      setReveal(false)
      const result = await window.api.providers.test(provider.id)
      setStatus(result)
      await refreshProviders()
      const models = useApp.getState().availableModels()
      if (result.ok && !settings?.selectedModelId && models[0]) selectModel(models[0].id)
    } finally {
      setBusy(false)
    }
  }

  const toggleReveal = async (): Promise<void> => {
    if (!reveal && provider.hasKey && !key) {
      setRevealedSaved(await window.api.keys.reveal(provider.id))
    }
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

  const refreshModelsList = async (): Promise<void> => {
    setBusy(true)
    setStatus(null)
    try {
      const result = await window.api.providers.test(provider.id)
      setStatus(result)
      await refreshProviders()
    } finally {
      setBusy(false)
    }
  }

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

  const keyFieldValue = key || revealedSaved || (provider.hasKey ? '•'.repeat(32) : '')
  const keyFieldReadOnly = !key && Boolean(revealedSaved || (provider.hasKey && !reveal))

  return (
    <>
      <div className="provider-detail__header">
        <span className="provider-detail__name">{provider.name}</span>
        <Switch
          label={`Enable ${provider.name}`}
          checked={provider.enabled}
          onChange={(on) =>
            void window.api.providers.update(provider.id, { enabled: on }).then(() => refreshProviders())
          }
        />
      </div>

      {provider.local ? (
        <div className="provider-detail__section">
          <div className="provider-detail__section-title">Base URL</div>
          <div className="provider-detail__section-desc">Point this at your local {provider.name} server.</div>
          <input
            className="input"
            value={baseUrl}
            spellCheck={false}
            onChange={(e) => setBaseUrl(e.target.value)}
            onBlur={() => void saveBaseUrl()}
            placeholder="http://127.0.0.1:8080/v1"
          />
        </div>
      ) : (
        <div className="provider-detail__section">
          <div className="provider-detail__section-title">API keys</div>
          <p className="provider-detail__section-desc">
            Enter your API key. You can add extra keys in Advanced, and Eaon will try the next one automatically if a
            key fails.
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
              <div>
                <div className="field-label">Base URL</div>
                <input
                  className="input"
                  value={baseUrl}
                  spellCheck={false}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  onBlur={() => void saveBaseUrl()}
                />
              </div>
              <div>
                <div className="field-label">Fallback keys — tried in order if the key above fails</div>
                {fallbacks.map((_, index) => (
                  <div className="fallback-row" key={index} style={{ marginBottom: 8 }}>
                    <input
                      className="input"
                      style={{ fontFamily: 'var(--font-mono)' }}
                      value={'•'.repeat(24)}
                      readOnly
                    />
                    <button
                      className="icon-btn"
                      aria-label="Remove fallback key"
                      onClick={() => void removeFallback(index)}
                    >
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

          <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
            <button className="btn btn--provider" disabled={busy || !key.trim()} onClick={() => void saveKey()}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            {provider.hasKey && (
              <button
                className="btn btn--provider-ghost"
                onClick={() => void window.api.keys.clear(provider.id).then(() => refreshProviders())}
              >
                Remove key
              </button>
            )}
          </div>

          {status && (
            <div
              style={{
                marginTop: 12,
                fontSize: 13,
                color: status.ok ? 'var(--text-2)' : 'var(--danger)',
                display: 'flex',
                gap: 8
              }}
            >
              {!status.ok && <TriangleAlert size={14} strokeWidth={1.9} style={{ flex: 'none', marginTop: 2 }} />}
              {status.message}
            </div>
          )}
        </div>
      )}

      <div className="provider-detail__section">
        <div className="provider-detail__section-head">
          <div className="provider-detail__section-title" style={{ marginBottom: 0 }}>
            Models
          </div>
          <div className="provider-detail__section-actions">
            <button className="icon-btn" aria-label="Refresh models" onClick={() => void refreshModelsList()}>
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

        {provider.models.length === 0 ? (
          <div className="empty-models">
            {provider.local || provider.hasKey
              ? 'No models yet — refresh or add one.'
              : 'Add an API key, then refresh to load models.'}
          </div>
        ) : (
          provider.models.map((model) => (
            <div className="model-row" key={model.id}>
              <span className="model-row__name">{model.label}</span>
              <span className="model-row__badges">
                {model.tools && <Wrench size={13} strokeWidth={1.8} />}
                {model.vision && <Eye size={14} strokeWidth={1.8} />}
              </span>
              <span className="model-row__spacer" />
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
    </>
  )
}

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
  const [format, setFormat] = useState<'openai-compatible' | 'anthropic'>('openai-compatible')
  const [baseUrl, setBaseUrl] = useState('')
  const [key, setKey] = useState('')

  const reset = (): void => {
    setName('')
    setFormat('openai-compatible')
    setBaseUrl('')
    setKey('')
  }

  const create = async (): Promise<void> => {
    const id = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    if (!id) return
    await window.api.providers.update(id, {
      name: name.trim(),
      kind: format,
      baseUrl: baseUrl.trim(),
      enabled: true
    })
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
        <RadioOption
          label="OpenAI-compatible"
          checked={format === 'openai-compatible'}
          onSelect={() => setFormat('openai-compatible')}
        />
        <RadioOption
          label="Anthropic-compatible"
          checked={format === 'anthropic'}
          onSelect={() => setFormat('anthropic')}
        />
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
      <input
        className="input"
        type="password"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="Paste your API key"
        spellCheck={false}
      />
    </Modal>
  )
}

function RadioOption({
  label,
  checked,
  onSelect
}: {
  label: string
  checked: boolean
  onSelect: () => void
}): JSX.Element {
  return (
    <button type="button" className="radio-option" onClick={onSelect}>
      <span className="radio-dot" data-on={checked || undefined}>
        <span className="radio-dot__fill" />
      </span>
      {label}
    </button>
  )
}
