import { Binary, Brain, Check, CircleAlert, CodeXml, Download, ExternalLink, Eye, Loader2, Play, Wrench, X } from 'lucide-react'
import { useApp } from '../../state/store'
import { downloadPercent } from '../../lib/format'
import { progressId, useLibrary } from './libraryStore'
import {
  FIT_LABEL,
  fitFor,
  formatModelSize,
  type FitLevel,
  type LibraryCapability,
  type LibraryModel,
  type LibraryVariant
} from '@shared/modelLibrary'

/** Small building blocks shared by the library's cards, rows and detail view. */

export const DEVICE = window.api.platform === 'darwin' ? 'Mac' : 'PC'

export const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download'

export function FitBadge({ level, title }: { level: FitLevel; title?: string }): JSX.Element {
  return (
    <span className="mlib-fit" data-fit={level} title={title}>
      <span className="mlib-fit__dot" aria-hidden="true" />
      {FIT_LABEL[level]}
    </span>
  )
}

export function fitExplanation(level: FitLevel): string {
  if (level === 'good') return `Runs fully on this ${DEVICE}’s GPU with room to spare.`
  if (level === 'tight') return `Runs, but uses most of this ${DEVICE}’s memory — close other apps, and expect some of it to run on the CPU.`
  return `Needs more memory than this ${DEVICE} has.`
}

const CAPABILITY: Record<LibraryCapability, { label: string; icon: JSX.Element }> = {
  tools: { label: 'Tools', icon: <Wrench size={12} strokeWidth={1.9} /> },
  vision: { label: 'Vision', icon: <Eye size={12} strokeWidth={1.9} /> },
  reasoning: { label: 'Reasoning', icon: <Brain size={12} strokeWidth={1.9} /> },
  coding: { label: 'Coding', icon: <CodeXml size={12} strokeWidth={1.9} /> },
  embedding: { label: 'Embeddings', icon: <Binary size={12} strokeWidth={1.9} /> }
}

export function Capabilities({ list }: { list: LibraryCapability[] }): JSX.Element {
  return (
    <span className="mlib-caps">
      {list.map((cap) => (
        <span key={cap} className="mlib-cap">
          {CAPABILITY[cap].icon}
          {CAPABILITY[cap].label}
        </span>
      ))}
    </span>
  )
}

export function releasedLabel(date: string): string {
  const [year, month] = date.split('-').map(Number)
  return new Date(year, month - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
}

export function useVariantError(model: LibraryModel, variant: LibraryVariant): string | undefined {
  return useLibrary((s) => s.errors[progressId(model, variant)])
}

export function ErrorLine({ text }: { text: string | undefined }): JSX.Element | null {
  if (!text) return null
  return (
    <p className="mlib-error">
      <CircleAlert size={13} strokeWidth={2} />
      {text}
    </p>
  )
}

/**
 * The one action a variant offers, in whichever state it is in: Get, a live
 * percentage with Cancel while pulling, or why it can't be pulled. Installed
 * state is decided by the caller, which knows whether any variant counts.
 */
export function GetButton({
  model,
  variant,
  label = 'Get'
}: {
  model: LibraryModel
  variant: LibraryVariant
  label?: string
}): JSX.Element {
  const state = useLibrary((s) => s.state)
  const get = useLibrary((s) => s.get)
  const cancel = useLibrary((s) => s.cancel)
  const progress = useApp((s) => s.modelDownloads[progressId(model, variant)])

  if (model.unsupported) {
    return (
      <span className="mlib-get-note" title={model.unsupported}>
        Not in Ollama yet
      </span>
    )
  }

  if (progress) {
    const pct = downloadPercent(progress)
    return (
      <span className="mlib-progress" onClick={(e) => e.stopPropagation()}>
        <span className="mlib-progress__label">
          {progress.phase === 'registering' ? (
            <>
              <Loader2 size={12} strokeWidth={2.2} className="spinner" /> Finishing
            </>
          ) : (
            `${pct}%`
          )}
        </span>
        <span className="mlib-progress__track" aria-hidden="true">
          <span className="mlib-progress__fill" style={{ width: `${progress.phase === 'registering' ? 100 : pct}%` }} />
        </span>
        <button className="icon-btn icon-btn--sm" aria-label={`Cancel ${model.name} download`} title="Cancel" onClick={() => cancel(model, variant)}>
          <X size={13} strokeWidth={2} />
        </button>
      </span>
    )
  }

  const ollama = state?.ollama.state
  const fit = state ? fitFor(variant.sizeBytes, state.ramBytes) : 'good'
  const blocked = ollama === 'missing' ? 'Install Ollama to download models' : fit === 'too-big' ? fitExplanation(fit) : null

  return (
    <button
      className="btn btn--sm mlib-get"
      disabled={blocked !== null || !state}
      title={blocked ?? `Download ${variant.quant} · ${formatModelSize(variant.sizeBytes)}`}
      onClick={(e) => {
        e.stopPropagation()
        void get(model, variant)
      }}
    >
      <Download size={13} strokeWidth={2} />
      {label}
    </button>
  )
}

export function InstalledMark({ quant }: { quant?: string }): JSX.Element {
  return (
    <span className="mlib-installed">
      <Check size={13} strokeWidth={2.4} />
      Installed{quant ? ` · ${quant}` : ''}
    </span>
  )
}

/** Shown under the tabs whenever Ollama isn't answering; nothing can be pulled or run without it. */
export function OllamaBanner(): JSX.Element | null {
  const status = useLibrary((s) => s.state?.ollama)
  const starting = useLibrary((s) => s.startingOllama)
  const error = useLibrary((s) => s.errors.ollama)
  const start = useLibrary((s) => s.startOllama)
  if (!status || status.state === 'running') return null

  return (
    <div className="mlib-banner" role="status">
      <div className="mlib-banner__body">
        <strong>{status.state === 'stopped' ? 'Ollama isn’t running' : 'Ollama isn’t installed'}</strong>
        <span>
          {status.state === 'stopped'
            ? 'Models download and run through Ollama. Start it to get models and use them in chat.'
            : `Eaon runs local models through Ollama, a free app. Install it, open it once, then come back here.`}
        </span>
        <ErrorLine text={error} />
      </div>
      {status.state === 'stopped' ? (
        <button className="btn btn--primary" disabled={starting} onClick={() => void start().catch(() => {})}>
          {starting ? <Loader2 size={14} strokeWidth={2} className="spinner" /> : <Play size={14} strokeWidth={2} />}
          {starting ? 'Starting…' : 'Start Ollama'}
        </button>
      ) : (
        <button className="btn btn--primary" onClick={() => void window.api.app.openExternal(OLLAMA_DOWNLOAD_URL)}>
          Download Ollama <ExternalLink size={13} strokeWidth={2} />
        </button>
      )}
    </div>
  )
}
