import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Check, ChevronDown, Download, Eye, Files, Loader2, Trash2, Wrench } from 'lucide-react'
import { useApp } from '../state/store'
import { CollapsedNav } from './CollapsedNav'
import { SearchField, Select, Switch } from './ui'
import { downloadPercent, formatBytes as formatSize, repoName } from '../lib/format'
import type { DownloadedModel, ModelDetail, ModelDownloadProgress, ModelSearchResult } from '@shared/types'

/** Local model browsing and downloads — search Hugging Face for GGUF models,
 * download them to disk, and register them with a local Ollama daemon so they
 * show up as regular models in the existing chat picker. See
 * .eaonbrain/local-model-hub.md for how the pieces fit together.
 *
 * In-flight download progress lives in the global store (`modelDownloads`),
 * not here — that's what lets the header's Downloads panel show it too. */

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

const key = (repoId: string, filename: string): string => `${repoId}::${filename}`

export function ModelsPage(): JSX.Element {
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const selectedRepo = useApp((s) => s.modelsRepo)
  const setSelectedRepo = useApp((s) => s.setModelsRepo)
  const progress = useApp((s) => s.modelDownloads)
  const downloadModel = useApp((s) => s.downloadModel)

  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'newest' | 'downloads'>('newest')
  const [downloadedOnly, setDownloadedOnly] = useState(false)
  const [results, setResults] = useState<ModelSearchResult[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [downloadedModels, setDownloadedModels] = useState<DownloadedModel[]>([])
  const [downloadErrors, setDownloadErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    void window.api.models.downloaded().then(setDownloadedModels)
  }, [])

  useEffect(() => {
    if (downloadedOnly) return
    let cancelled = false
    setLoading(true)
    setError(null)
    const handle = setTimeout(
      () => {
        void window.api.models
          .search(query, sort)
          .then((res) => {
            if (cancelled) return
            setResults(res)
            setLoading(false)
          })
          .catch((err) => {
            if (cancelled) return
            setError(err instanceof Error ? err.message : String(err))
            setLoading(false)
          })
      },
      query ? 400 : 0
    )
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [query, sort, downloadedOnly])

  const downloadedKeys = useMemo(
    () => new Set(downloadedModels.map((m) => key(m.repoId, m.filename))),
    [downloadedModels]
  )

  const downloadedCards = useMemo(() => {
    const byRepo = new Map<string, DownloadedModel[]>()
    for (const m of downloadedModels) byRepo.set(m.repoId, [...(byRepo.get(m.repoId) ?? []), m])
    return [...byRepo.entries()].map(([repoId, variants]) => ({
      repoId,
      name: repoName(repoId),
      author: repoId.split('/')[0],
      variants
    }))
  }, [downloadedModels])

  const handleDownload = async (repoId: string, filename: string): Promise<void> => {
    const k = key(repoId, filename)
    setDownloadErrors((prev) => {
      const next = { ...prev }
      delete next[k]
      return next
    })
    try {
      const model = await downloadModel(repoId, filename)
      setDownloadedModels((prev) => [...prev.filter((m) => key(m.repoId, m.filename) !== k), model])
    } catch (err) {
      setDownloadErrors((prev) => ({ ...prev, [k]: err instanceof Error ? err.message : String(err) }))
    }
  }

  const handleDelete = async (repoId: string, filename: string): Promise<void> => {
    await window.api.models.delete(repoId, filename)
    setDownloadedModels((prev) => prev.filter((m) => key(m.repoId, m.filename) !== key(repoId, filename)))
  }

  if (selectedRepo) {
    return (
      <ModelDetailView
        repoId={selectedRepo}
        onBack={() => setSelectedRepo(null)}
        downloadedKeys={downloadedKeys}
        progress={progress}
        downloadErrors={downloadErrors}
        onDownload={handleDownload}
        onDelete={handleDelete}
        sidebarOpen={sidebarOpen}
      />
    )
  }

  return (
    <div className="page">
      <div className="page__bar" data-collapsed={!sidebarOpen || undefined}>
        {!sidebarOpen && <CollapsedNav />}
      </div>
      <div className="page__scroll scroll">
        <div className="page__inner page__inner--wide">
          <h1 className="page__title">Models</h1>
          <p className="page__subtitle">Download open models from Hugging Face and run them locally with Ollama</p>

          <div className="models-bar">
            <SearchField value={query} onChange={setQuery} placeholder="Search for models on Hugging Face..." variant="pill" />
            <Select
              value={sort}
              onChange={(v) => setSort(v)}
              width={168}
              options={[
                { value: 'newest', label: 'Newest' },
                { value: 'downloads', label: 'Most downloads' }
              ]}
            />
            <div className="models-toggle">
              <Switch label="Show only downloaded models" checked={downloadedOnly} onChange={setDownloadedOnly} />
              <span onClick={() => setDownloadedOnly((v) => !v)}>Downloaded</span>
            </div>
          </div>

          {downloadedOnly ? (
            downloadedCards.length === 0 ? (
              <div className="models-empty">No downloaded models yet</div>
            ) : (
              downloadedCards.map((card) => (
                <DownloadedModelCard
                  key={card.repoId}
                  card={card}
                  onOpen={() => setSelectedRepo(card.repoId)}
                  onDelete={handleDelete}
                />
              ))
            )
          ) : (
            <>
              {loading && (
                <div className="models-empty">
                  <Loader2 size={16} strokeWidth={2} className="spinner" />
                  Searching Hugging Face…
                </div>
              )}
              {!loading && error && <div className="models-empty models-empty--error">{error}</div>}
              {!loading && !error && results.length === 0 && <div className="models-empty">No models found</div>}
              {!loading &&
                !error &&
                results.map((model) => (
                  <ModelCard
                    key={model.repoId}
                    model={model}
                    downloaded={model.defaultVariant ? downloadedKeys.has(key(model.repoId, model.defaultVariant.filename)) : false}
                    progress={model.defaultVariant ? progress[key(model.repoId, model.defaultVariant.filename)] : undefined}
                    error={model.defaultVariant ? downloadErrors[key(model.repoId, model.defaultVariant.filename)] : undefined}
                    onDownload={() => model.defaultVariant && void handleDownload(model.repoId, model.defaultVariant.filename)}
                    onDelete={() => model.defaultVariant && void handleDelete(model.repoId, model.defaultVariant.filename)}
                    onOpen={() => setSelectedRepo(model.repoId)}
                  />
                ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function ModelCard({
  model,
  downloaded,
  progress,
  error,
  onDownload,
  onDelete,
  onOpen
}: {
  model: ModelSearchResult
  downloaded: boolean
  progress: ModelDownloadProgress | undefined
  error: string | undefined
  onDownload: () => void
  onDelete: () => void
  onOpen: () => void
}): JSX.Element {
  const variant = model.defaultVariant
  const downloading = progress !== undefined

  return (
    <div className="model-card">
      <div className="model-card__head">
        <h3 className="model-card__name">{model.name}</h3>
        {variant && (
          <div className="model-card__side">
            <div className="model-card__size-row">
              <span className="model-card__size">{formatSize(variant.sizeBytes)}</span>
              <span className="model-fits" data-fits={variant.fits}>
                {variant.fits ? (
                  <>
                    <Check size={12} strokeWidth={2.4} /> Fits
                  </>
                ) : (
                  "Won't fit"
                )}
              </span>
            </div>
            {downloaded ? (
              <div className="model-card__downloaded">
                <span className="model-dl-btn model-dl-btn--done">Downloaded</span>
                <button className="icon-btn" aria-label="Delete download" onClick={onDelete}>
                  <Trash2 size={14} strokeWidth={1.9} />
                </button>
              </div>
            ) : (
              <button className="model-dl-btn" disabled={downloading} onClick={onDownload}>
                {downloading
                  ? progress.phase === 'registering'
                    ? 'Registering…'
                    : `Downloading… ${downloadPercent(progress)}%`
                  : `Download · ${variant.quant}`}
              </button>
            )}
          </div>
        )}
      </div>

      {error && <div className="model-card__error">{error}</div>}
      {model.description && <p className="model-card__desc">{model.description}</p>}

      <div className="model-card__meta">
        <span className="model-card__author">By {model.author}</span>
        <span className="model-card__stat">
          <Download size={13} strokeWidth={1.9} /> {formatCount(model.downloads)}
        </span>
        {variant && (
          <span className="model-card__stat">
            <Files size={13} strokeWidth={1.9} /> {model.fileCount}
          </span>
        )}
        {model.capabilities.includes('multimodal') && (
          <span className="model-tag">
            <Eye size={12} strokeWidth={1.9} /> Multimodal
          </span>
        )}
        {model.capabilities.includes('tools') && (
          <span className="model-tag">
            <Wrench size={12} strokeWidth={1.9} /> Tools
          </span>
        )}
        <span className="models-spacer" />
        <button className="model-variants-btn" onClick={onOpen}>
          Show variants <ChevronDown size={14} strokeWidth={2} />
        </button>
      </div>
    </div>
  )
}

function DownloadedModelCard({
  card,
  onOpen,
  onDelete
}: {
  card: { repoId: string; name: string; author: string; variants: DownloadedModel[] }
  onOpen: () => void
  onDelete: (repoId: string, filename: string) => void
}): JSX.Element {
  return (
    <div className="model-card">
      <div className="model-card__head">
        <h3 className="model-card__name">{card.name}</h3>
      </div>

      <div className="model-downloaded-list">
        {card.variants.map((v) => (
          <div className="model-downloaded-row" key={v.filename}>
            <span className="model-downloaded-row__name">{v.filename}</span>
            <span className="model-downloaded-row__size">{formatSize(v.sizeBytes)}</span>
            <button className="icon-btn" aria-label={`Delete ${v.filename}`} onClick={() => onDelete(v.repoId, v.filename)}>
              <Trash2 size={15} strokeWidth={1.9} />
            </button>
          </div>
        ))}
      </div>

      <div className="model-card__meta">
        <span className="model-card__author">By {card.author}</span>
        <span className="models-spacer" />
        <button className="model-variants-btn" onClick={onOpen}>
          Show variants <ChevronDown size={14} strokeWidth={2} />
        </button>
      </div>
    </div>
  )
}

function ModelDetailView({
  repoId,
  onBack,
  downloadedKeys,
  progress,
  downloadErrors,
  onDownload,
  onDelete,
  sidebarOpen
}: {
  repoId: string
  onBack: () => void
  downloadedKeys: Set<string>
  progress: Record<string, ModelDownloadProgress>
  downloadErrors: Record<string, string>
  onDownload: (repoId: string, filename: string) => void
  onDelete: (repoId: string, filename: string) => void
  sidebarOpen: boolean
}): JSX.Element {
  const [detail, setDetail] = useState<ModelDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setDetail(null)
    setError(null)
    void window.api.models
      .detail(repoId)
      .then((d) => {
        if (!cancelled) {
          setDetail(d)
          setLoading(false)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [repoId])

  return (
    <div className="page">
      <div className="page__bar" data-collapsed={!sidebarOpen || undefined}>
        {!sidebarOpen && <CollapsedNav />}
      </div>
      <div className="page__scroll scroll">
        <div className="page__inner page__inner--wide">
          <button className="model-detail__back" onClick={onBack}>
            <ArrowLeft size={16} strokeWidth={1.9} /> Back to Models
          </button>

          {loading && (
            <div className="models-empty">
              <Loader2 size={16} strokeWidth={2} className="spinner" />
              Loading…
            </div>
          )}
          {!loading && error && <div className="models-empty models-empty--error">{error}</div>}

          {!loading && detail && (
            <>
              <h1 className="page__title" style={{ marginBottom: 6 }}>
                {detail.name}
              </h1>
              <div className="model-detail__byline">
                <span>By {detail.author}</span>
                <span className="model-card__stat">
                  <Download size={14} strokeWidth={1.9} /> {detail.downloads.toLocaleString()} Downloads
                </span>
              </div>
              {detail.description && <p className="model-detail__desc">{detail.description}</p>}
              {detail.parameterSize && <span className="model-detail__tag">{detail.parameterSize}</span>}

              <div className="section-head section-head--ruled" style={{ marginTop: 30 }}>
                <span className="section-head__title">
                  <Files size={15} strokeWidth={1.9} /> Variants ({detail.variants.length})
                </span>
              </div>

              <div className="variants-table">
                <div className="variants-table__row variants-table__row--head">
                  <span>Version</span>
                  <span>Format</span>
                  <span>Size</span>
                  <span>Fits</span>
                  <span>Action</span>
                </div>
                {detail.variants.map((variant) => {
                  const k = key(repoId, variant.filename)
                  const isDownloaded = downloadedKeys.has(k)
                  const p = progress[k]
                  const err = downloadErrors[k]
                  return (
                    <div className="variants-table__row" key={variant.filename}>
                      <span className="variants-table__version">{variant.filename.replace(/\.gguf$/i, '')}</span>
                      <span>GGUF</span>
                      <span>{formatSize(variant.sizeBytes)}</span>
                      <span>
                        {variant.fits ? (
                          <Check size={14} strokeWidth={2.2} color="var(--toggle-on)" />
                        ) : (
                          <span className="variants-table__no-fit">—</span>
                        )}
                      </span>
                      <div className="variants-table__action">
                        {isDownloaded ? (
                          <div className="model-card__downloaded">
                            <span className="variants-table__done">Downloaded</span>
                            <button className="icon-btn" aria-label="Delete download" onClick={() => onDelete(repoId, variant.filename)}>
                              <Trash2 size={14} strokeWidth={1.9} />
                            </button>
                          </div>
                        ) : p ? (
                          <span className="variants-table__pct">{downloadPercent(p)}%</span>
                        ) : (
                          <button className="btn btn--sm" onClick={() => onDownload(repoId, variant.filename)}>
                            Download
                          </button>
                        )}
                        {err && <small className="variants-table__error">{err}</small>}
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
