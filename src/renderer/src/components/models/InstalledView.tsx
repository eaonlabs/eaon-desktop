import { useEffect, useMemo, useState } from 'react'
import { Cloud, HardDrive, Trash2 } from 'lucide-react'
import { useApp } from '../../state/store'
import { useLibrary } from './libraryStore'
import { ErrorLine } from './parts'
import { findInstalled, formatModelSize, type InstalledModel, type LibraryModel, type LibraryVariant } from '@shared/modelLibrary'

/**
 * Everything Ollama has installed — library pulls, models pulled some other
 * way, cloud aliases — plus GGUF files downloaded through "Browse Hugging
 * Face", which live on disk under Eaon's own folder.
 */
export function InstalledView(): JSX.Element {
  const state = useLibrary((s) => s.state)
  const catalog = useLibrary((s) => s.catalog)
  const downloaded = useLibrary((s) => s.downloaded)
  const refresh = useLibrary((s) => s.refresh)

  // Something may have been pulled from a terminal since the page opened.
  useEffect(() => {
    void refresh()
  }, [refresh])

  const libraryMatch = useMemo(() => {
    const byName = new Map<string, { model: LibraryModel; variant: LibraryVariant }>()
    for (const model of catalog) {
      for (const variant of model.variants) {
        const installed = state ? findInstalled(variant, state.installed) : undefined
        if (installed) byName.set(installed.name, { model, variant })
      }
    }
    return byName
  }, [catalog, state])

  const models = useMemo(
    () => [...(state?.installed ?? [])].sort((a, b) => Number(Boolean(a.cloud)) - Number(Boolean(b.cloud)) || b.modifiedAt.localeCompare(a.modifiedAt)),
    [state]
  )
  const localBytes = models.filter((m) => !m.cloud).reduce((sum, m) => sum + m.sizeBytes, 0)

  if (!state) return <div className="models-empty">Loading…</div>

  return (
    <>
      <section className="mlib-section">
        <div className="mlib-section__head">
          <h2 className="mlib-section__title">In Ollama</h2>
          {state.ollama.state === 'running' && (
            <span className="mlib-section__count">
              {models.length} model{models.length === 1 ? '' : 's'} · {formatModelSize(localBytes)} on disk
            </span>
          )}
        </div>
        {state.ollama.state !== 'running' ? (
          <div className="models-empty">Start Ollama to see the models it has installed.</div>
        ) : models.length === 0 ? (
          <div className="models-empty">No models yet — get one from the Library.</div>
        ) : (
          <div className="mlib-list">
            {models.map((m) => (
              <InstalledRow key={m.name} model={m} match={libraryMatch.get(m.name)} />
            ))}
          </div>
        )}
      </section>

      {downloaded.length > 0 && (
        <section className="mlib-section">
          <div className="mlib-section__head">
            <h2 className="mlib-section__title">Downloaded from Hugging Face</h2>
            <span className="mlib-section__count">Files in Eaon’s models folder</span>
          </div>
          <div className="mlib-list">
            {downloaded.map((d) => (
              <DownloadedRow key={`${d.repoId}::${d.filename}`} repoId={d.repoId} filename={d.filename} sizeBytes={d.sizeBytes} ollamaName={d.ollamaName} ollamaError={d.ollamaError} />
            ))}
          </div>
        </section>
      )}
    </>
  )
}

function InstalledRow({ model, match }: { model: InstalledModel; match?: { model: LibraryModel; variant: LibraryVariant } }): JSX.Element {
  const remove = useLibrary((s) => s.remove)
  const error = useLibrary((s) => s.errors[model.name])
  const details = [model.parameterSize, model.quantization, model.family].filter(Boolean).join(' · ')

  return (
    <div className="mlib-row mlib-row--static">
      <span className="mlib-row__icon">{model.cloud ? <Cloud size={16} strokeWidth={1.8} /> : <HardDrive size={16} strokeWidth={1.8} />}</span>
      <div className="mlib-row__main">
        <div className="mlib-row__title">
          <span className="mlib-row__name mlib-mono">{model.name}</span>
          {model.cloud && <span className="mlib-tag">Cloud</span>}
          {model.capabilities?.includes('embedding') && <span className="mlib-tag">Embeddings</span>}
        </div>
        <div className="mlib-meta">
          {match && (
            <button className="mlib-link" onClick={() => useApp.getState().setModelsRepo(`library:${match.model.id}`)}>
              {match.model.name} · {match.variant.quant}
            </button>
          )}
          {details && <span>{details}</span>}
          {model.cloud && <span>Runs on ollama.com</span>}
        </div>
        <ErrorLine text={error} />
      </div>
      <div className="mlib-row__side">
        <span className="mlib-row__pick">{model.cloud ? '—' : formatModelSize(model.sizeBytes)}</span>
        <ConfirmDelete label={`Delete ${model.name}`} onConfirm={() => void remove(model.name)} />
      </div>
    </div>
  )
}

function DownloadedRow({
  repoId,
  filename,
  sizeBytes,
  ollamaName,
  ollamaError
}: {
  repoId: string
  filename: string
  sizeBytes: number
  ollamaName: string | null
  ollamaError: string | null
}): JSX.Element {
  const removeDownloaded = useLibrary((s) => s.removeDownloaded)
  return (
    <div className="mlib-row mlib-row--static">
      <span className="mlib-row__icon">
        <HardDrive size={16} strokeWidth={1.8} />
      </span>
      <div className="mlib-row__main">
        <div className="mlib-row__title">
          <span className="mlib-row__name mlib-mono">{filename}</span>
        </div>
        <div className="mlib-meta">
          <span>{repoId}</span>
          {ollamaName && <span>In Ollama as {ollamaName}</span>}
        </div>
        <ErrorLine text={ollamaError ?? undefined} />
      </div>
      <div className="mlib-row__side">
        <span className="mlib-row__pick">{formatModelSize(sizeBytes)}</span>
        <ConfirmDelete label={`Delete ${filename}`} onConfirm={() => void removeDownloaded(repoId, filename)} />
      </div>
    </div>
  )
}

/**
 * Two-step delete: the trash icon turns into an explicit "Delete" so a stray
 * click can't throw away a multi-gigabyte download.
 */
export function ConfirmDelete({ label, onConfirm }: { label: string; onConfirm: () => void }): JSX.Element {
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(timer)
  }, [armed])

  if (armed) {
    return (
      <span className="mlib-confirm" onClick={(e) => e.stopPropagation()}>
        <button className="btn btn--sm btn--danger" onClick={onConfirm}>
          Delete
        </button>
        <button className="btn btn--sm btn--ghost" onClick={() => setArmed(false)}>
          Keep
        </button>
      </span>
    )
  }
  return (
    <button
      className="icon-btn"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation()
        setArmed(true)
      }}
    >
      <Trash2 size={14} strokeWidth={1.9} />
    </button>
  )
}
