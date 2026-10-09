import { useEffect, useMemo, useState } from 'react'
import { HardDrive, SquareTerminal, Trash2 } from 'lucide-react'
import { useApp } from '../../state/store'
import { openInAde } from '../code/terminal/terminalStore'
import { useLibrary } from './libraryStore'
import { ErrorLine } from './parts'
import { formatModelSize, type InstalledModel } from '@shared/modelLibrary'

/**
 * Every model on this computer — library downloads and files picked in
 * Browse Hugging Face alike. Each is one entry in the model picker's "On this
 * computer" group, and runs on Eaon's own llama.cpp.
 */
export function InstalledView(): JSX.Element {
  const state = useLibrary((s) => s.state)
  const catalog = useLibrary((s) => s.catalog)
  const refresh = useLibrary((s) => s.refresh)

  useEffect(() => {
    void refresh()
  }, [refresh])

  const names = useMemo(() => new Map(catalog.map((m) => [m.id, m.name])), [catalog])
  const models = useMemo(() => [...(state?.installed ?? [])].sort((a, b) => b.downloadedAt - a.downloadedAt), [state])
  const bytes = models.reduce((sum, m) => sum + m.sizeBytes, 0)

  if (!state) return <div className="models-empty">Loading…</div>

  return (
    <section className="mlib-section">
      <div className="mlib-section__head">
        <h2 className="mlib-section__title">On this computer</h2>
        {models.length > 0 && (
          <span className="mlib-section__actions">
            <span className="mlib-section__count">
              {models.length} model{models.length === 1 ? '' : 's'} · {formatModelSize(bytes)} on disk
            </span>
            {/* Eaon CLI, the OpenCode fork, codes with these models and no others. */}
            <button className="btn btn--sm" title="Open Eaon CLI in the ADE, coding with the models downloaded here" onClick={() => void openInAde('eaon-cli')}>
              <SquareTerminal size={13} strokeWidth={2} />
              Code with Eaon CLI
            </button>
          </span>
        )}
      </div>
      {models.length === 0 ? (
        <div className="models-empty">No models yet — get one from the Library.</div>
      ) : (
        <div className="mlib-list">
          {models.map((m) => (
            <InstalledRow key={m.id} model={m} libraryName={m.library ? names.get(m.library.modelId) : undefined} running={state.runtime.loaded?.modelId === m.id} />
          ))}
        </div>
      )}
    </section>
  )
}

function InstalledRow({ model, libraryName, running }: { model: InstalledModel; libraryName?: string; running: boolean }): JSX.Element {
  const remove = useLibrary((s) => s.remove)
  const error = useLibrary((s) => s.errors[model.id])

  return (
    <div className="mlib-row mlib-row--static">
      <span className="mlib-row__icon">
        <HardDrive size={16} strokeWidth={1.8} />
      </span>
      <div className="mlib-row__main">
        <div className="mlib-row__title">
          <span className="mlib-row__name">{model.label}</span>
          {running && <span className="mlib-tag mlib-tag--live">Loaded</span>}
          {model.vision && <span className="mlib-tag">Vision</span>}
          {model.embedding && <span className="mlib-tag">Embeddings</span>}
        </div>
        <div className="mlib-meta">
          {model.library && libraryName ? (
            <button className="mlib-link" onClick={() => useApp.getState().setModelsRepo(`library:${model.library!.modelId}`)}>
              {libraryName} in the Library
            </button>
          ) : (
            <span>{model.repoId}</span>
          )}
          <span className="mlib-mono">{model.filename}</span>
        </div>
        <ErrorLine text={error} />
      </div>
      <div className="mlib-row__side">
        <span className="mlib-row__pick">{formatModelSize(model.sizeBytes)}</span>
        <ConfirmDelete label={`Delete ${model.label}`} onConfirm={() => void remove(model.id)} />
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
