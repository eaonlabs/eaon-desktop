import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Check, ChevronDown, Download, Eye, Files, Loader2, Trash2, Wrench } from 'lucide-react'
import { useApp } from '../../state/store'
import { SearchField, Select } from '../ui'
import { downloadPercent, formatBytes as formatSize } from '../../lib/format'
import { useLibrary } from './libraryStore'
import type { ModelDetail, ModelDownloadProgress, ModelSearchResult } from '@shared/types'

/**
 * "Browse Hugging Face": search any GGUF repo, pick a file, download it to
 * Eaon's models folder and register it with Ollama (modelHub.ts). Moved here
 * from ModelsPage unchanged in behaviour when the curated library became the
 * page's default; downloaded files now show on the Installed tab.
 */

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

const key = (repoId: string, filename: string): string => `${repoId}::${filename}`

function useDownloadedKeys(): Set<string> {
  const downloaded = useLibrary((s) => s.downloaded)
  return useMemo(() => new Set(downloaded.map((m) => key(m.repoId, m.filename))), [downloaded])
}

export function HubBrowser(): JSX.Element {
  const setSelectedRepo = useApp((s) => s.setModelsRepo)
  const progress = useApp((s) => s.modelDownloads)
  const errors = useLibrary((s) => s.errors)
  const downloadFile = useLibrary((s) => s.downloadFile)
  const removeDownloaded = useLibrary((s) => s.removeDownloaded)
  const downloadedKeys = useDownloadedKeys()

  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'newest' | 'downloads'>('newest')
  const [results, setResults] = useState<ModelSearchResult[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
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
  }, [query, sort])

  return (
    <>
      <div className="models-bar">
        <SearchField value={query} onChange={setQuery} placeholder="Search GGUF models on Hugging Face..." variant="pill" />
        <Select
          value={sort}
          onChange={(v) => setSort(v)}
          width={168}
          options={[
            { value: 'newest', label: 'Newest' },
            { value: 'downloads', label: 'Most downloads' }
          ]}
        />
      </div>

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
        results.map((model) => {
          const k = model.defaultVariant ? key(model.repoId, model.defaultVariant.filename) : ''
          return (
            <ModelCard
              key={model.repoId}
              model={model}
              downloaded={Boolean(k) && downloadedKeys.has(k)}
              progress={k ? progress[k] : undefined}
              error={k ? errors[k] : undefined}
              onDownload={() => model.defaultVariant && void downloadFile(model.repoId, model.defaultVariant.filename)}
              onDelete={() => model.defaultVariant && void removeDownloaded(model.repoId, model.defaultVariant.filename)}
              onOpen={() => setSelectedRepo(model.repoId)}
            />
          )
        })}
    </>
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

/** Every GGUF file in one Hugging Face repo. */
export function HubDetail({ repoId, onBack }: { repoId: string; onBack: () => void }): JSX.Element {
  const progress = useApp((s) => s.modelDownloads)
  const errors = useLibrary((s) => s.errors)
  const downloadFile = useLibrary((s) => s.downloadFile)
  const removeDownloaded = useLibrary((s) => s.removeDownloaded)
  const downloadedKeys = useDownloadedKeys()

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
    <>
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
              const err = errors[k]
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
                        <button className="icon-btn" aria-label="Delete download" onClick={() => void removeDownloaded(repoId, variant.filename)}>
                          <Trash2 size={14} strokeWidth={1.9} />
                        </button>
                      </div>
                    ) : p ? (
                      <span className="variants-table__pct">{downloadPercent(p)}%</span>
                    ) : (
                      <button className="btn btn--sm" onClick={() => void downloadFile(repoId, variant.filename)}>
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
    </>
  )
}
