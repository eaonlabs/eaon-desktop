import { Binary, Brain, Check, CircleAlert, CodeXml, Download, Eye, Loader2, Wrench, X } from 'lucide-react'
import { useApp } from '../../state/store'
import { downloadPercent } from '../../lib/format'
import { progressId, useLibrary } from './libraryStore'
import {
  FIT_LABEL,
  diskShortfall,
  fitFor,
  formatModelSize,
  runtimeGap,
  type FitLevel,
  type LibraryCapability,
  type LibraryModel,
  type LibraryVariant
} from '@shared/modelLibrary'

/** Small building blocks shared by the library's cards, rows and detail view. */

export const DEVICE = window.api.platform === 'darwin' ? 'Mac' : 'PC'

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

  const gap = runtimeGap(model, state?.runtime)
  if (gap) {
    return (
      <span className="mlib-get-note" title={gap}>
        Not supported yet
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

  const fit = state ? fitFor(variant.sizeBytes, state.ramBytes) : 'good'
  const blocked =
    state && !state.runtime.available
      ? 'This build of Eaon has no local runtime'
      : fit === 'too-big'
        ? fitExplanation(fit)
        : state
          ? diskShortfall(variant.sizeBytes, state.freeDiskBytes)
          : null

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
      Downloaded{quant ? ` · ${quant}` : ''}
    </span>
  )
}

/**
 * Shown under the tabs only when this build has no llama-server for this
 * machine (a development checkout that never ran scripts/build-llama.sh).
 * Everything else about running models is automatic.
 */
export function RuntimeBanner(): JSX.Element | null {
  const runtime = useLibrary((s) => s.state?.runtime)
  if (!runtime || runtime.available) return null
  return (
    <div className="mlib-banner" role="status">
      <div className="mlib-banner__body">
        <strong>No local runtime in this build</strong>
        <span>
          Eaon runs downloaded models with its own llama.cpp, which this copy doesn&rsquo;t include. Build it with{' '}
          <code>scripts/build-llama.sh</code>, or use a cloud model meanwhile.
        </span>
      </div>
    </div>
  )
}
